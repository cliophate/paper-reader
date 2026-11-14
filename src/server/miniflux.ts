import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BackendValidationError, type ReaderBackend, type BackendPageOptions, type EntryOptions, type EntryPage, type EntryStateOperation, type FeedOperation, type ImportPageOptions } from './backend.js'
import { minifluxIdentity, type BackendIdentity } from './identity.js'
import { minifluxBaseUrl } from './miniflux-url.js'
import { MINIFLUX_ORGANIZATION_CAPABILITIES } from './organization.js'
import type { OrganizationCommand } from '../shared/organization.js'
import { portableUrl, subscriptionUrl } from './opml.js'
import { cleanArticleHtml, decodeHtmlText, excerpt, firstImage, readingMinutes } from './text.js'
import { normalizeFeedContent, normalizeFeedThumbnail } from './feed-content.js'
import { detectKind } from './entry-kind.js'
import type { Entry, Feed, Folder, NavigationPayload, StreamRef } from './types.js'

type JsonObject = Record<string, unknown>
type FeedCommand = Extract<OrganizationCommand, { type: 'rename-feed' | 'move-feed' | 'unsubscribe' }>
const MAX_SNAPSHOT = 1_000_000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Miniflux returned invalid data')
  return value as JsonObject
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Miniflux returned invalid data')
  return value
}
function numericId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Miniflux returned an invalid numeric ID')
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Miniflux returned an invalid count')
  return value
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function date(value: unknown): string | null {
  const raw = text(value)
  return raw && !raw.startsWith('0001-') && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null
}

export class MinifluxClient implements ReaderBackend {
  readonly organizationCapabilities = MINIFLUX_ORGANIZATION_CAPABILITIES
  private account: BackendIdentity | null = null
  private readonly baseUrl: string

  constructor(private readonly config: { baseUrl: string; apiKey: string }) {
    this.baseUrl = minifluxBaseUrl(config.baseUrl)
    if (!config.apiKey || /[\r\n]/.test(config.apiKey)) throw new Error('MINIFLUX_API_KEY must contain one nonempty token')
  }

  get identity(): BackendIdentity {
    if (!this.account) throw new Error('Verify the Miniflux connection before using this backend')
    return this.account
  }

  async initialize() {
    const version = text(object(await this.request('v1/version')).version)
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(version)
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 3 || Number(match[2]) === 3 && Number(match[3]) < 2))) {
      throw new Error('Miniflux 2.3.2 or newer is required for explicit starred-state updates')
    }
    const me = object(await this.request('v1/me'))
    this.account = minifluxIdentity(this.baseUrl, numericId(me.id))
  }

  private async request(path: string, method = 'GET', body?: JsonObject, missing = false, signal?: AbortSignal): Promise<unknown> {
    const retryable = method === 'GET' || method === 'PUT' && path === 'v1/entries'
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/${path}`, {
          method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
          headers: { 'X-Auth-Token': this.config.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        })
      } catch {
        signal?.throwIfAborted()
        if (retryable && attempt < 2) { await delay(100 * (attempt + 1), undefined, { signal }); continue }
        throw new Error('Miniflux request could not be confirmed. Check the connection and refresh before retrying changes.')
      }
      if ([429, 500, 502, 503, 504].includes(response.status) && retryable && attempt < 2) {
        await response.body?.cancel(); await delay(100 * (attempt + 1), undefined, { signal }); continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 404 && missing) return null
        if (response.status === 401 || response.status === 403) throw new Error('Miniflux authentication failed. Check MINIFLUX_API_KEY and account access.')
        throw new Error(`Miniflux request failed with HTTP ${response.status}. Refresh before retrying changes.`)
      }
      if (response.status === 204) return null
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel(); throw new Error('Miniflux response exceeds the size limit')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Miniflux returned an empty response')
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_RESPONSE_BYTES) throw new Error('Miniflux response exceeds the size limit')
          chunks.push(value)
        }
      } catch {
        await reader.cancel().catch(() => undefined)
        signal?.throwIfAborted()
        throw new Error('Miniflux response was incomplete or exceeded the size limit')
      } finally { reader.releaseLock() }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
      catch { throw new Error('Miniflux returned invalid JSON') }
    }
  }

  private id(kind: 'entry' | 'feed' | 'category', value: unknown): string {
    return `${this.identity.id}:${kind}:${numericId(value)}`
  }

  private upstreamId(id: string, kind: 'entry' | 'feed' | 'category'): number {
    const prefix = `${this.identity.id}:${kind}:`
    const raw = id.startsWith(prefix) ? id.slice(prefix.length) : ''
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new BackendValidationError(`A ${kind} from this Miniflux account is required`)
    return Number(raw)
  }

  validateFeedId(id: string, operation: FeedOperation) {
    this.upstreamId(id, 'feed')
    if (operation === 'repair') throw new BackendValidationError('Feed URL repair is not available for Miniflux')
  }

  private mapFeed(value: unknown, unread = 0): Feed {
    const row = object(value), category = object(row.category)
    const checked = date(row.checked_at)
    return {
      id: this.id('feed', row.id), title: decodeHtmlText(text(row.title)),
      url: portableUrl(text(row.feed_url)), siteUrl: portableUrl(text(row.site_url)), iconUrl: '',
      categories: [text(category.title)], unread, lastPublishedAt: null, lastCheckedAt: checked,
      broken: count(row.parsing_error_count ?? 0) > 0,
      lastErrorAt: count(row.parsing_error_count ?? 0) > 0 ? checked : null,
    }
  }

  async navigation(signal?: AbortSignal): Promise<NavigationPayload> {
    const [categories, feeds, counters, starred] = await Promise.all([
      this.request('v1/categories', 'GET', undefined, false, signal), this.request('v1/feeds', 'GET', undefined, false, signal), this.request('v1/feeds/counters', 'GET', undefined, false, signal),
      this.entryIds({ kind: 'starred', id: 'starred', title: 'Starred' }, false, signal),
    ])
    const unreads = object(object(counters).unreads)
    const folders: Folder[] = array(categories).map(value => {
      const row = object(value)
      return { id: this.id('category', row.id), title: text(row.title), unread: 0, feeds: [] }
    })
    const byId = new Map(folders.map(folder => [folder.id, folder]))
    for (const value of array(feeds)) {
      const row = object(value), rawId = numericId(row.id)
      const folder = byId.get(this.id('category', object(row.category).id))
      if (!folder) throw new Error('Miniflux categories changed while loading navigation. Refresh again.')
      const feed = this.mapFeed(row, count(unreads[String(rawId)] ?? 0))
      folder.feeds.push(feed); folder.unread += feed.unread
    }
    folders.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    for (const folder of folders) folder.feeds.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    return { unread: folders.reduce((sum, folder) => sum + folder.unread, 0), starred: starred.length, folders, uncategorized: [] }
  }

  private mapEntry(value: unknown): Entry {
    const row = object(value), feedRow = object(row.feed), feed = this.mapFeed(feedRow)
    if (numericId(row.feed_id) !== numericId(feedRow.id) || !['read', 'unread'].includes(text(row.status)) || typeof row.starred !== 'boolean') throw new Error('Miniflux returned invalid article state')
    const publishedAt = date(row.published_at), createdAt = date(row.created_at)
    if (!publishedAt || !createdAt) throw new Error('Miniflux returned invalid article dates')
    const url = portableUrl(text(row.url)), title = decodeHtmlText(text(row.title))
    const html = cleanArticleHtml(text(row.content))
    const kind = detectKind(feed.title, url, feed.url)
    const contentHtml = normalizeFeedContent({ contentHtml: html, feedTitle: feed.title, url, title })
    return {
      id: this.id('entry', row.id), feedId: feed.id, feedTitle: feed.title, feedUrl: feed.url,
      title, author: decodeHtmlText(text(row.author)), url, contentHtml, excerpt: excerpt(contentHtml, 260),
      publishedAt, timestamp: Date.parse(publishedAt), crawledAt: Date.parse(createdAt),
      sourceOrder: String(numericId(row.id)).padStart(20, '0'),
      read: row.status === 'read', starred: row.starred,
      readingMinutes: readingMinutes(contentHtml), thumbnailUrl: normalizeFeedThumbnail({ url, thumbnailUrl: firstImage(contentHtml), contentHtml, originalContentHtml: html }), kind,
    }
  }

  private scope(stream: StreamRef): { path: string; params: URLSearchParams } {
    const params = new URLSearchParams()
    if (stream.kind === 'feed') return { path: `v1/feeds/${this.upstreamId(stream.id, 'feed')}/entries`, params }
    if (stream.kind === 'category') return { path: `v1/categories/${this.upstreamId(stream.id, 'category')}/entries`, params }
    if (stream.kind === 'starred') params.set('starred', 'true')
    else if (stream.kind !== 'all') throw new BackendValidationError('Choose a valid article stream')
    return { path: 'v1/entries', params }
  }

  private async page(path: string, params: URLSearchParams, limit: number, continuation = '', ascending = false, signal?: AbortSignal): Promise<EntryPage> {
    const scope = crypto.createHash('sha256').update(this.identity.id + path + '?' + params.toString() + ascending).digest('hex')
    let boundary = 0
    if (continuation) {
      try {
        const cursor = object(JSON.parse(Buffer.from(continuation, 'base64url').toString('utf8')))
        if (continuation.length > 1024 || cursor.scope !== scope) throw new Error()
        boundary = numericId(cursor.id)
      } catch { throw new BackendValidationError('Invalid Miniflux page continuation. Reload this view.') }
    }
    params.set('order', 'id'); params.set('direction', ascending ? 'asc' : 'desc'); params.set('limit', String(limit))
    if (boundary) params.set(ascending ? 'after_entry_id' : 'before_entry_id', String(boundary))
    const result = object(await this.request(`${path}?${params}`, 'GET', undefined, false, signal))
    const rows = array(result.entries)
    if (rows.length > limit || count(result.total) < rows.length || rows.length < limit && count(result.total) > rows.length) throw new Error('Miniflux returned an incomplete article page')
    let previous = boundary
    for (const row of rows) {
      const id = numericId(object(row).id)
      if (previous && (ascending ? id <= previous : id >= previous)) throw new Error('Miniflux article pagination did not advance')
      previous = id
    }
    return { items: rows.map(row => this.mapEntry(row)), continuation: rows.length === limit ? Buffer.from(JSON.stringify({ scope, id: previous })).toString('base64url') : '' }
  }

  async entriesPage(stream: StreamRef, options: BackendPageOptions = {}): Promise<EntryPage> {
    const { path, params } = this.scope(stream)
    params.append('status', 'unread')
    if (!options.unreadOnly) params.append('status', 'read')
    if (options.after) params.set('published_after', String(Math.floor(options.after.getTime() / 1000)))
    if (options.before) params.set('published_before', String(Math.floor(options.before.getTime() / 1000)))
    if (options.query) params.set('search', options.query)
    return this.page(path, params, Math.min(1000, Math.max(1, options.limit || 100)), options.continuation, false, options.signal)
  }

  async importPage(options: ImportPageOptions): Promise<EntryPage> {
    const params = new URLSearchParams([['status', 'unread'], ['status', 'read']])
    if (options.changedAfter) params.set('changed_after', String(Math.floor(options.changedAfter.getTime() / 1000)))
    params.set('changed_before', String(Math.ceil(options.changedBefore.getTime() / 1000)))
    return this.page('v1/entries', params, options.limit, options.continuation, true, options.signal)
  }

  async entries(stream: StreamRef, options: EntryOptions = {}): Promise<Entry[]> {
    const result: Entry[] = []
    const limit = Math.min(1000, Math.max(1, options.limit || 200))
    let continuation = ''
    do {
      const page = await this.entriesPage(stream, { ...options, limit: Math.min(250, limit - result.length), continuation })
      result.push(...page.items); continuation = page.continuation
    } while (continuation && result.length < limit)
    return result
  }

  async entry(id: string, signal?: AbortSignal): Promise<Entry | null> {
    const rawId = this.upstreamId(id, 'entry')
    const value = await this.request(`v1/entries/${rawId}`, 'GET', undefined, true, signal)
    if (value === null || object(value).status === 'removed') return null
    if (numericId(object(value).id) !== rawId) throw new Error('Miniflux returned a different article')
    return this.mapEntry(value)
  }

  async entriesByIds(ids: string[], signal?: AbortSignal): Promise<Entry[]> {
    signal?.throwIfAborted()
    ids.forEach(id => this.upstreamId(id, 'entry'))
    const entries: Entry[] = []
    for (let offset = 0; offset < ids.length; offset += 4) {
      entries.push(...(await Promise.all(ids.slice(offset, offset + 4).map(id => this.entry(id, signal)))).filter((entry): entry is Entry => entry !== null))
    }
    return entries
  }

  private async stateIds(status: 'read' | 'unread', starred: boolean, signal?: AbortSignal): Promise<string[]> {
    const result = new Set<string>()
    let total: number | undefined
    while (true) {
      const params = new URLSearchParams({ status, limit: '10000', offset: String(result.size) })
      if (starred) params.set('starred', 'true')
      const page = object(await this.request(`v1/entries/ids?${params}`, 'GET', undefined, false, signal)), ids = array(page.entry_ids)
      const currentTotal = count(page.total)
      if (currentTotal > MAX_SNAPSHOT || total !== undefined && total !== currentTotal || ids.length !== Math.min(10000, currentTotal - result.size)) throw new Error('Miniflux state changed or was truncated during pagination. Retry sync.')
      total = currentTotal
      for (const id of ids) {
        const mapped = this.id('entry', id)
        if (result.has(mapped)) throw new Error('Miniflux state pagination returned duplicate IDs. Retry sync.')
        result.add(mapped)
      }
      if (result.size === total) return [...result]
    }
  }

  async entryIds(stream: StreamRef, unreadOnly = false, signal?: AbortSignal): Promise<string[]> {
    if (stream.kind === 'all' && unreadOnly) return this.stateIds('unread', false, signal)
    if (stream.kind === 'starred') {
      const unread = await this.stateIds('unread', true, signal)
      if (unreadOnly) return unread
      const read = await this.stateIds('read', true, signal)
      if (new Set([...read, ...unread]).size !== read.length + unread.length) throw new Error('Miniflux starred state changed during pagination. Retry sync.')
      return [...unread, ...read]
    }
    const result: string[] = []
    let continuation = ''
    do {
      const page = await this.entriesPage(stream, { unreadOnly, limit: 1000, continuation, signal })
      result.push(...page.items.map(entry => entry.id)); continuation = page.continuation
      if (result.length > MAX_SNAPSHOT) throw new Error('Miniflux state exceeds the snapshot limit')
    } while (continuation)
    return result
  }

  async editEntries(ids: string[], operation: EntryStateOperation) {
    const unique = [...new Set(ids)], upstreamIds = unique.map(id => this.upstreamId(id, 'entry'))
    if (!['read', 'unread', 'star', 'unstar'].includes(operation)) throw new BackendValidationError('Choose a valid state operation')
    // The native update endpoint silently ignores missing IDs. Reject them
    // before writing so a successful local operation cannot hide that failure.
    if ((await this.entriesByIds(unique)).length !== unique.length) throw new BackendValidationError('An article is no longer available in Miniflux. Refresh before changing it.')
    for (let offset = 0; offset < upstreamIds.length; offset += 500) {
      const body: JsonObject = { entry_ids: upstreamIds.slice(offset, offset + 500) }
      if (operation === 'read' || operation === 'unread') body.status = operation
      else body.starred = operation === 'star'
      await this.request('v1/entries', 'PUT', body)
    }
  }

  async addFeed(url: string, title = '', folder = '') {
    const safe = subscriptionUrl(url)
    if (!safe) throw new BackendValidationError('A complete feed URL without embedded credentials is required')
    const body: JsonObject = { feed_url: safe }
    if (folder) {
      const categories = array(await this.request('v1/categories')).map(object)
      const matches = categories.filter(category => text(category.title) === folder)
      if (matches.length > 1) throw new BackendValidationError('Choose an unambiguous category')
      const category = matches[0] || object(await this.request('v1/categories', 'POST', { title: folder }))
      body.category_id = numericId(category.id)
    }
    // Omitting category_id lets Miniflux choose the account's first category.
    const result = object(await this.request('v1/feeds', 'POST', body))
    if (title) await this.request(`v1/feeds/${numericId(result.feed_id)}`, 'PUT', { title })
  }

  async applyFeedCommand(command: FeedCommand) {
    const id = this.upstreamId(command.feedId, 'feed')
    const destination = command.type === 'move-feed' && command.toFolderId !== null ? this.upstreamId(command.toFolderId, 'category') : null
    if (command.type === 'move-feed' && command.fromFolderId !== null) this.upstreamId(command.fromFolderId, 'category')
    if (command.type === 'move-feed' && destination === null) throw new BackendValidationError('Choose a Miniflux category as the destination')
    if (command.type === 'unsubscribe') { await this.request(`v1/feeds/${id}`, 'DELETE'); return }
    const feed = object(await this.request(`v1/feeds/${id}`))
    if (command.type === 'rename-feed') {
      if (!command.title.trim()) throw new BackendValidationError('A feed title is required')
      await this.request(`v1/feeds/${id}`, 'PUT', { title: command.title.trim() })
    } else {
      if (this.id('category', object(feed.category).id) !== command.fromFolderId) throw new BackendValidationError('This feed moved. Reload organization before moving it again.')
      await this.request(`v1/feeds/${id}`, 'PUT', { category_id: destination })
    }
  }

  async editFeed(id: string, title: string, folder: string, currentFolder: string) {
    this.validateFeedId(id, 'edit')
    const navigation = await this.navigation()
    const source = navigation.folders.find(category => category.feeds.some(feed => feed.id === id))
    if (!source || source.title !== currentFolder) throw new BackendValidationError('This feed moved. Reload subscriptions.')
    const matches = navigation.folders.filter(category => category.title === folder)
    if (matches.length !== 1) throw new BackendValidationError('Choose an existing Miniflux category')
    const feedId = this.upstreamId(id, 'feed')
    await this.request(`v1/feeds/${feedId}`, 'PUT', { title, category_id: this.upstreamId(matches[0].id, 'category') })
  }

  async removeFeed(id: string) { await this.applyFeedCommand({ type: 'unsubscribe', feedId: id }) }
}
