import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { WebhookDelivery, WebhookKind, WebhookSubscription, WebhookTarget } from '../shared/webhooks.js'
import { SettingsValidationError, writePrivateSettings } from './connections.js'
import { type ApiRequest, boundedApiRequest, FeedHttpError } from './feed-http.js'
import { queueFull, transportTimeoutMs, type WebhookStore } from './webhook-store.js'
import { abortable } from './abort.js'
import type { EntrySource } from './backend.js'
import type { NavigationPayload } from './types.js'

interface PrivateTarget { url: string; credential: string }
interface Article { id: string; feed_id: string; title: string; url: string }

const unverified = 'Skipped delivery because Paper could not verify folder membership.'
const outsideFolder = 'The feed is outside the selected folder.'
let workerActive = false

function folderMembership(nav: NavigationPayload | undefined, folderId: string, feedId: string) {
  if (!nav) return undefined
  if (nav.folders.some(folder => folder.id === folderId && folder.feeds.some(feed => feed.id === feedId))) return true
  if (nav.uncategorized.some(feed => feed.id === feedId) || nav.folders.some(folder => folder.feeds.some(feed => feed.id === feedId))) return false
  return undefined
}

export function webhookSignature(secret: string, timestamp: string, body: string) {
  return createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex')
}

function deliveryRequest(kind: WebhookKind, id: string, event: WebhookDelivery['event'], entries: Article[], credential: string): ApiRequest {
  if (kind === 'webhook') {
    const fields = event === 'new_entries' ? { entries } : event === 'test' ? {} : { entry: entries[0] }
    const body = JSON.stringify({ event_type: event, delivery_id: id, ...fields })
    const timestamp = String(Math.floor(Date.now() / 1000))
    return { body, signature: { timestamp, digest: webhookSignature(credential, timestamp, body) } }
  }
  const message = entries.length ? [entries[0].title, entries[0].url].filter(Boolean).join('\n') : 'Paper test notification'
  if (kind === 'apprise') return { body: JSON.stringify({ body: message }) }
  return { body: Array.from(message).slice(0, 1024).join(''), contentType: 'text/plain',
    authorization: credential ? 'Bearer ' + credential : undefined }
}

function invalid(message: string): never { throw new SettingsValidationError(message) }
function subscription(input: Partial<WebhookSubscription>, kind: WebhookKind): WebhookSubscription {
  const { name, events, feedId = '', folderId = '' } = input
  if (typeof name !== 'string' || !name.trim() || name.length > 80) invalid('Give the target a name of up to 80 characters.')
  if (!Array.isArray(events) || !events.length || events.some(event => !['new_entries', 'starred_entry', 'save_entry'].includes(event)) ||
      (kind !== 'webhook' && events.includes('new_entries'))) invalid('Choose events supported by this target.')
  if (typeof feedId !== 'string' || typeof folderId !== 'string' || feedId.length > 2048 || folderId.length > 2048 || (feedId && folderId)) invalid('Choose one feed or folder.')
  return { name: name.trim(), events: [...new Set(events)], feedId, folderId }
}

export class Webhooks {
  private timer?: NodeJS.Timeout
  private running?: Promise<void>
  private readonly stopSignal = new AbortController()
  private nextPrune = 0

  constructor(readonly store: WebhookStore, private readonly directory: string, private readonly trustedOrigins: readonly string[],
    private readonly navigation: EntrySource['navigation']) {}

  private target(id: string) {
    return this.store.targets().find(item => item.id === id) ?? invalid('This target no longer exists.')
  }
  private filename(target: WebhookTarget) { return path.join(this.directory, 'webhooks', target.id + '.json') }
  private privateTarget(target: WebhookTarget): PrivateTarget {
    return JSON.parse(fs.readFileSync(this.filename(target), 'utf8'))
  }
  create(raw: unknown) {
    if (!raw || typeof raw !== 'object') invalid('Enter the delivery target settings.')
    const input = raw as Record<string, unknown>
    const kind = input.kind
    if (kind !== 'webhook' && kind !== 'ntfy' && kind !== 'apprise') invalid('Choose a delivery service.')
    if (this.store.targets().length >= 32) invalid('Paper supports up to 32 delivery targets.')
    const target = { ...subscription(input, kind), id: randomUUID(), kind } satisfies WebhookTarget
    if (typeof input.url !== 'string' || input.url.length > 2048) invalid('Enter a complete target URL.')
    let url: URL
    try { url = new URL(input.url) } catch { return invalid('Enter a complete target URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid('Use an HTTP or HTTPS URL without login details or a fragment.')
    if (url.protocol === 'http:' && !this.trustedOrigins.includes(url.origin)) invalid('Use HTTPS or add the exact origin to PAPER_TRUSTED_SAVE_ORIGINS.')
    const credential = input.credential ?? ''
    if (typeof credential !== 'string' || credential.length > 4096 || /[^\x21-\x7e]/.test(credential)) invalid('Enter the credential on one line without spaces.')
    if (kind === 'apprise' && credential) {
      if (!/^[a-zA-Z0-9_-]+$/.test(credential)) invalid('Use letters, numbers, underscores or hyphens in the Apprise configuration key.')
      url.pathname = url.pathname.replace(/\/+$/, '') + '/' + credential
    }
    const secret = kind === 'webhook' ? randomBytes(32).toString('base64url') : undefined
    const filename = this.filename(target)
    writePrivateSettings(filename, JSON.stringify({ url: url.href, credential: secret ?? (kind === 'ntfy' ? credential : '') }))
    try { this.store.add(target) }
    catch (error) { fs.rmSync(filename, { force: true }); throw error }
    return { target, secret }
  }
  update(id: string, raw: unknown) {
    const target = this.target(id)
    if (!raw || typeof raw !== 'object') invalid('Enter the delivery target settings.')
    if (Object.keys(raw).some(key => !['name', 'events', 'feedId', 'folderId'].includes(key))) invalid('Add a new target to change the endpoint or credentials.')
    if (!this.store.update({ ...target, ...subscription(raw, target.kind) })) invalid('This target no longer exists.')
  }
  remove(id: string) {
    const target = this.target(id)
    this.store.remove(target.id)
    fs.rmSync(this.filename(target), { force: true })
  }
  rotate(id: string) {
    const target = this.target(id)
    if (target.kind !== 'webhook') invalid('Only signed webhooks have a signing secret.')
    const settings = this.privateTarget(target)
    const secret = randomBytes(32).toString('base64url')
    writePrivateSettings(this.filename(target), JSON.stringify({ ...settings, credential: secret }))
    return { secret }
  }
  test(id: string) {
    if (!this.store.enqueue(this.target(id), 'test', '[]')) invalid(queueFull)
  }
  private async currentNavigation() {
    const signal = AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(transportTimeoutMs)])
    try { return await abortable(() => this.navigation(signal), signal) }
    catch { return undefined }
  }
  async sendArticle(id: string, ruleTargetId?: string) {
    const event = ruleTargetId === undefined ? 'save_entry' : 'rule_entry'
    const article = this.store.article(id)
    const result = { count: 0, message: '' }
    if (!article) return result
    const targets = () => this.store.targets().filter(target =>
      (!target.feedId || target.feedId === article.feed_id) && (ruleTargetId === undefined
        ? target.events.includes('save_entry') : target.id === ruleTargetId && target.kind !== 'webhook'))
    const nav = targets().some(t => t.folderId) ? await this.currentNavigation() : undefined
    const reasons = new Set<string>()
    for (const target of targets()) {
      if (target.folderId) {
        const member = folderMembership(nav, target.folderId, article.feed_id)
        if (member === undefined) {
          this.store.recordSkip(target.id, event, unverified)
          reasons.add(unverified)
        }
        if (!member) continue
      }
      if (this.store.enqueue(target, event, article.entries)) result.count++
      else reasons.add(queueFull)
    }
    result.message = [...reasons].join(' ')
    return result
  }

  start() {
    if (this.timer) return
    this.store.finishBatch()
    this.timer = setInterval(() => {
      void this.tick().catch(() => { console.error('Paper could not process the webhook queue.') })
    }, 1000)
    this.timer.unref()
  }
  async stop() {
    clearInterval(this.timer)
    this.stopSignal.abort()
    await this.running
  }
  tick() {
    if (this.running) return this.running
    if (workerActive) return Promise.resolve()
    workerActive = true
    this.running = this.drain().finally(() => { this.running = undefined; workerActive = false })
    return this.running
  }
  private async drain() {
    if (Date.now() >= this.nextPrune) {
      this.store.prune(Date.now())
      this.nextPrune = Date.now() + 60_000
    }
    for (let i = 0; i < 32 && !this.stopSignal.signal.aborted; i++) {
      const job = this.store.claim(Date.now())
      if (!job) return
      let status: number | null = null
      let error = ''
      try {
        const target = this.target(job.target_id)
        let entries: Article[] = JSON.parse(job.entries)
        if (job.folder_id) {
          const nav = await this.currentNavigation()
          const membership = entries.map(entry => Array.from(entry.feed_id).length > 2048
            ? undefined : folderMembership(nav, job.folder_id, entry.feed_id))
          if (membership.includes(undefined) || !membership.includes(true)) {
            this.store.skip(job.id, job.attempts, membership.includes(undefined) ? unverified : outsideFolder)
            continue
          }
          entries = entries.filter((_entry, index) => membership[index])
          // A retry must never add articles excluded from an earlier POST.
          if (!this.store.saveScopedEntries(job.id, job.attempts, JSON.stringify(entries))) continue
        }
        entries = entries.map(entry => ({ ...entry, feed_id: Array.from(entry.feed_id).slice(0, 512).join('') }))
        const event = job.event
        const { url, credential } = this.privateTarget(target)
        const request = deliveryRequest(target.kind, job.id, event, entries, credential)
        const result = await boundedApiRequest(new URL(url), this.trustedOrigins,
          { ...request, discardResponse: true, signal: this.stopSignal.signal, timeoutMs: transportTimeoutMs })
        status = result.status
        if (status < 200 || status >= 300) error = `Target returned HTTP ${status}.`
      } catch (reason) {
        error = reason instanceof FeedHttpError && reason.code === 'policy' ? 'Target blocked by network policy. Check PAPER_TRUSTED_SAVE_ORIGINS.'
          : reason instanceof FeedHttpError ? reason.message : 'Delivery failed. Check the target and its connection.'
      }
      this.store.finish(job.id, job.attempts, status, error, Date.now())
    }
  }
}
