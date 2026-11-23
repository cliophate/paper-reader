import { cookieSafeValidator, cookieValues, extractedCookieRedactor } from './feed-cookie.js'
import { parseFeed } from './feed-parser.js'
import { EXTRACTION_TIMEOUT_MS, extractionRules, extractWithOverrides } from './feed-extraction.js'
import type { FeedCheckResult } from '../shared/feed-checks.js'
import { MANUAL_CHECK_COOLDOWN_MS } from './feed-check-settings.js'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import type { PaperDatabase } from './db.js'
import { boundedFetch, FeedHttpError, FEED_HTTP_DEFAULTS, validLastModified, type BoundedFetchOptions } from './feed-http.js'
import type { FeedLease, FetchCompletion } from './feed-fetch-state.js'
import { subscriptionUrl } from './subscription-url.js'
import { completeFeed } from './feed-completion.js'

const LEASE_MARGIN_MS = 5000

export interface FeedSchedulerOptions {
  trustedOrigins?: readonly string[]
  concurrency?: number
  perHostConcurrency?: number
  intervalMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  http?: Omit<BoundedFetchOptions, 'trustedOrigins' | 'validators' | 'signal' | 'acquire'>
}
export interface FeedRunResult { attempted: number; fetched: number; notModified: number; failed: number; stale: number; ambiguous: number }

export function retryAfterTime(value: string | undefined, now: number): number {
  if (!value) return 0
  if (/^\d+$/.test(value)) {
    const time = now + Number(value) * 1000
    return Number.isSafeInteger(time) && time <= 8.64e15 ? time : 0
  }
  if (!validLastModified(value)) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) && time > now ? time : 0
}
function positive(value: number, name: string, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`)
  return value
}

// StandaloneRuntime owns startup, abort and drain. FreshRSS keeps its separate
// BackendSynchronizer and import schedule.
export class StandaloneFeedScheduler {
  private readonly concurrency: number
  private readonly perHost: number
  private readonly interval: number | undefined
  private readonly retryBase: number
  private readonly retryMax: number
  private readonly timeout: number
  private readonly leaseMs: number
  private readonly queued = new Set<string>()
  private readonly active = new Set<string>()
  private running: Promise<FeedRunResult> | null = null

  constructor(private readonly db: PaperDatabase, private readonly backendId: string, private readonly options: FeedSchedulerOptions = {}) {
    this.concurrency = positive(options.concurrency ?? 4, 'feed concurrency', 64)
    this.perHost = positive(options.perHostConcurrency ?? Math.min(2, this.concurrency), 'per-host feed concurrency', this.concurrency)
    this.interval = options.intervalMs === undefined ? undefined : positive(options.intervalMs, 'feed interval')
    this.retryBase = positive(options.retryBaseMs ?? 60_000, 'retry base')
    this.retryMax = positive(options.retryMaxMs ?? 6 * 60 * 60_000, 'retry maximum')
    this.timeout = positive(options.http?.timeoutMs ?? FEED_HTTP_DEFAULTS.timeoutMs, 'HTTP deadline', 10 * 60_000)
    this.leaseMs = this.timeout + 2 * EXTRACTION_TIMEOUT_MS + LEASE_MARGIN_MS
    // Fail before requests or timers when called for FreshRSS or another backend.
    this.db.feedFetch.get(backendId, '')
  }

  checkState(feedId: string): 'queued' | 'running' | 'idle' {
    if (this.active.has(feedId)) return 'running'
    return this.queued.has(feedId) ? 'queued' : 'idle'
  }

  queueChecks(feedIds: string[], now = Date.now()): FeedCheckResult[] {
    return [...new Set(feedIds)].map(feedId => {
      const state = this.db.feedFetch.get(this.backendId, feedId)
      if (!state) return { feedId, status: 'unavailable' }
      if (this.active.has(feedId) || state.leaseUntil > now) return { feedId, status: 'running' }
      if (this.queued.has(feedId)) return { feedId, status: 'queued' }
      if (state.retryAfterUntil > now) return { feedId, status: 'retry-after', until: state.retryAfterUntil }
      const until = state.lastAttemptAt + MANUAL_CHECK_COOLDOWN_MS
      if (state.lastAttemptAt && until > now) return { feedId, status: 'cooldown', until }
      if (this.queued.size >= 1000) return { feedId, status: 'queue-full' }
      this.queued.add(feedId)
      return { feedId, status: 'queued' }
    })
  }

  runDue(options: { signal?: AbortSignal; maxFeeds?: number } = {}): Promise<FeedRunResult> {
    if (this.running) return this.running
    const maximum = positive(options.maxFeeds ?? 1000, 'fetch batch size', 100_000)
    this.running = this.collect(maximum, options.signal).finally(() => { this.running = null })
    return this.running
  }

  async run(signal: AbortSignal, pollMs = 1000): Promise<void> {
    positive(pollMs, 'scheduler poll interval')
    while (!signal.aborted) {
      await this.runDue({ signal })
      try { await delay(pollMs, undefined, { signal }) } catch { if (!signal.aborted) throw new Error('Scheduler timer failed') }
    }
  }

  private async collect(maximum: number, signal?: AbortSignal): Promise<FeedRunResult> {
    const summary: FeedRunResult = { attempted: 0, fetched: 0, notModified: 0, failed: 0, stale: 0, ambiguous: 0 }
    const workers = await Promise.allSettled(Array.from({ length: this.concurrency }, async () => {
      while (!signal?.aborted && summary.attempted < maximum) {
        let lease: FeedLease | null = null
        while (this.queued.size && !lease) {
          const feedId = this.queued.values().next().value!
          this.queued.delete(feedId)
          lease = this.db.feedFetch.claim(this.backendId, Date.now(), this.leaseMs, feedId)
        }
        lease ??= this.db.feedFetch.claim(this.backendId, Date.now(), this.leaseMs)
        if (!lease) break
        summary.attempted++
        this.active.add(lease.subscriptionId)
        try {
          const result = await this.fetch(lease, signal)
          summary[result.kind]++
          summary.ambiguous += result.ambiguous
        } finally { this.active.delete(lease.subscriptionId) }
      }
    }))
    const failure = workers.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return summary
  }

  private async acquire(url: URL, signal: AbortSignal): Promise<() => void> {
    while (true) {
      signal.throwIfAborted()
      const token = this.db.feedFetch.reserveHttp(this.backendId, url.hostname.toLowerCase(), Date.now(), Date.now() + this.timeout + LEASE_MARGIN_MS, this.concurrency, this.perHost)
      if (token) return () => this.db.feedFetch.releaseHttp(token)
      await delay(25, undefined, { signal })
    }
  }

  private async fetch(lease: FeedLease, signal?: AbortSignal): Promise<{ kind: 'fetched' | 'notModified' | 'failed' | 'stale'; ambiguous: number }> {
    let status = 0
    let retryAfter: string | undefined
    let redirectsJson: string | undefined
    let discardValidators = false
    try {
      const rules = this.db.feedOverrides.get(lease.subscriptionId)
      if (rules?.cookie) {
        // Older checks may already have stored a reflected validator. A 304 or
        // failed check retains the lease's validators at completion.
        const secrets = cookieValues(rules.cookie)
        lease.etag = cookieSafeValidator(lease.etag, secrets) ?? ''
        lease.lastModified = cookieSafeValidator(lease.lastModified, secrets) ?? ''
      }
      const response = await boundedFetch(lease.url, { ...this.options.http, timeoutMs: this.timeout,
        trustedOrigins: this.options.trustedOrigins, signal,
        ...(rules?.userAgent ? { userAgent: rules.userAgent } : {}),
        cookie: rules?.cookie ? { origin: rules.cookieOrigin, value: rules.cookie } : undefined,
        validators: { url: lease.validatorUrl, etag: lease.etag, lastModified: lease.lastModified },
        acquire: (url, signal) => this.acquire(url, signal) })
      signal?.throwIfAborted()
      redirectsJson = JSON.stringify(response.redirects.map(hop => ({ status: hop.status, url: subscriptionUrl(hop.url) })))
      status = response.status
      retryAfter = response.retryAfter
      if (status === 304 && (!response.conditional || !lease.lastSuccessAt)) {
        discardValidators = true
        throw new Error('Unexpected conditional response')
      }
      if (status !== 200 && status !== 304) throw new Error('Unsuccessful HTTP response')
      const extraction = rules && extractionRules(rules, 'feed')
      let parsed: ReturnType<typeof parseFeed> | undefined
      if (status === 200) {
        parsed = rules && extraction
          ? await extractWithOverrides({ kind: 'feed', body: response.text, url: response.url }, extraction,
            reason => this.db.feedOverrides.warn(rules.revision, reason), signal)
          : parseFeed(response.text, response.url)
        const redact = rules?.cookie && extractedCookieRedactor(rules.cookie)
        if (redact) {
          parsed.title = redact.text(parsed.title)
          parsed.siteUrl = redact.text(parsed.siteUrl)
          if (parsed.declaredUrl) parsed.declaredUrl = redact.text(parsed.declaredUrl)
          parsed.conflictingExternalIds = parsed.conflictingExternalIds.map(redact.text)
          for (const entry of parsed.entries) {
            for (const key of ['title', 'author', 'url', 'thumbnailUrl'] as const) entry[key] = redact.text(entry[key])
            if (redact.text(entry.publishedAt) !== entry.publishedAt) entry.publishedAt = ''
            if (entry.externalId) entry.externalId = redact.text(entry.externalId)
            entry.contentHtml = redact.html(entry.contentHtml)
            entry.enclosures = entry.enclosures.filter(file => redact.text(file.url) === file.url)
          }
        }
        // Service pending requests between parsing and the synchronous ingestion transaction.
        await setImmediate(undefined, { signal })
      }
      signal?.throwIfAborted()
      const now = Date.now()
      const interval = this.interval ?? ((this.db.feedFetch.get(this.backendId, lease.subscriptionId)?.intervalMinutes
        ?? this.db.feedFetch.settings(this.backendId).intervalMinutes) * 60_000)
      const update: FetchCompletion = { nextFetchAt: Math.max(now + interval, retryAfterTime(retryAfter, now)),
        retryAfterUntil: retryAfterTime(retryAfter, now), failures: 0,
        redirectsJson, lastStatus: status, lastError: '', lastSuccessAt: now,
        etag: response.etag ?? (status === 304 ? lease.etag : ''),
        lastModified: response.lastModified ?? (status === 304 ? lease.lastModified : ''), validatorUrl: response.url }
      const result = await completeFeed(this.db, { lease, now, update, parsed, responseUrl: response.url })
      return { kind: !result.committed ? 'stale' : status === 304 ? 'notModified' : 'fetched', ambiguous: result.committed ? result.value : 0 }
    } catch (error) {
      const now = Date.now()
      const failures = Math.min(lease.failures + 1, 1000)
      const backoff = Math.min(this.retryMax, this.retryBase * 2 ** Math.min(failures - 1, 30))
      // Jitter spreads recovery work without shortening the publisher's delay.
      const nextFetchAt = Math.max(now + Math.round(backoff * (0.8 + Math.random() * 0.2)), retryAfterTime(retryAfter, now))
      const lastError = error instanceof FeedHttpError ? error.code : signal?.aborted ? 'aborted' : status === 200 ? 'ingestion' : `http-${status}`
      const result = this.db.feedFetch.complete(lease, now, { nextFetchAt, failures, redirectsJson, lastStatus: status, lastError, retryAfterUntil: retryAfterTime(retryAfter, now),
        ...(discardValidators ? { etag: '', lastModified: '' } : {}) }, () => {})
      return { kind: result.committed ? 'failed' : 'stale', ambiguous: 0 }
    }
  }
}
