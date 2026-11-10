import { setTimeout as delay } from 'node:timers/promises'
import type { PaperDatabase } from './db.js'
import { boundedFetch, FeedHttpError, FEED_HTTP_DEFAULTS, validLastModified, type BoundedFetchOptions } from './feed-http.js'
import type { FeedLease, FetchCompletion } from './feed-fetch-state.js'
import { ingestFeed } from './feed-ingestion.js'

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

// Internal standalone foundation. No factory or server startup activates it.
// FreshRSS continues using BackendSynchronizer and its own import schedule.
export class StandaloneFeedScheduler {
  private readonly concurrency: number
  private readonly perHost: number
  private readonly interval: number
  private readonly retryBase: number
  private readonly retryMax: number
  private readonly timeout: number
  private readonly leaseMs: number
  private running: Promise<FeedRunResult> | null = null

  constructor(private readonly db: PaperDatabase, private readonly backendId: string, private readonly options: FeedSchedulerOptions = {}) {
    this.concurrency = positive(options.concurrency ?? 4, 'feed concurrency', 64)
    this.perHost = positive(options.perHostConcurrency ?? Math.min(2, this.concurrency), 'per-host feed concurrency', this.concurrency)
    this.interval = positive(options.intervalMs ?? 15 * 60_000, 'feed interval')
    this.retryBase = positive(options.retryBaseMs ?? 60_000, 'retry base')
    this.retryMax = positive(options.retryMaxMs ?? 6 * 60 * 60_000, 'retry maximum')
    this.timeout = positive(options.http?.timeoutMs ?? FEED_HTTP_DEFAULTS.timeoutMs, 'HTTP deadline', 10 * 60_000)
    this.leaseMs = this.timeout + 5000
    // Fail before requests or timers when called for FreshRSS or another backend.
    this.db.feedFetch.get(backendId, '')
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
        const lease = this.db.feedFetch.claim(this.backendId, Date.now(), this.leaseMs)
        if (!lease) break
        summary.attempted++
        const result = await this.fetch(lease, signal)
        summary[result.kind]++
        summary.ambiguous += result.ambiguous
      }
    }))
    const failure = workers.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return summary
  }

  private async acquire(url: URL, signal: AbortSignal): Promise<() => void> {
    while (true) {
      signal.throwIfAborted()
      const token = this.db.feedFetch.reserveHttp(this.backendId, url.hostname.toLowerCase(), Date.now(), Date.now() + this.leaseMs, this.concurrency, this.perHost)
      if (token) return () => this.db.feedFetch.releaseHttp(token)
      await delay(25, undefined, { signal })
    }
  }

  private async fetch(lease: FeedLease, signal?: AbortSignal): Promise<{ kind: 'fetched' | 'notModified' | 'failed' | 'stale'; ambiguous: number }> {
    let status = 0
    let retryAfter: string | undefined
    let discardValidators = false
    try {
      const response = await boundedFetch(lease.url, { ...this.options.http, timeoutMs: this.timeout,
        trustedOrigins: this.options.trustedOrigins, signal,
        validators: { url: lease.validatorUrl, etag: lease.etag, lastModified: lease.lastModified },
        acquire: (url, signal) => this.acquire(url, signal) })
      signal?.throwIfAborted()
      status = response.status
      retryAfter = response.retryAfter
      if (status === 304 && (!response.conditional || !lease.lastSuccessAt)) {
        discardValidators = true
        throw new Error('Unexpected conditional response')
      }
      if (status !== 200 && status !== 304) throw new Error('Unsuccessful HTTP response')
      const now = Date.now()
      const update: FetchCompletion = { nextFetchAt: Math.max(now + this.interval, retryAfterTime(retryAfter, now)), failures: 0,
        lastStatus: status, lastError: '', lastSuccessAt: now,
        etag: response.etag ?? (status === 304 ? lease.etag : ''),
        lastModified: response.lastModified ?? (status === 304 ? lease.lastModified : ''), validatorUrl: response.url }
      const result = this.db.feedFetch.complete(lease, now, update, () => {
        if (status === 304) return 0
        const ingested = ingestFeed(this.db, { backendId: this.backendId, subscriptionId: lease.subscriptionId,
          endpointGeneration: lease.endpointGeneration, xml: response.text, requestUrl: lease.url,
          responseUrl: response.url, fetchedAt: new Date(now).toISOString() })
        update.ambiguous = ingested.ambiguous
        return ingested.ambiguous
      })
      return { kind: !result.committed ? 'stale' : status === 304 ? 'notModified' : 'fetched', ambiguous: result.committed ? result.value : 0 }
    } catch (error) {
      const now = Date.now()
      const failures = Math.min(lease.failures + 1, 1000)
      const backoff = Math.min(this.retryMax, this.retryBase * 2 ** Math.min(failures - 1, 30))
      // Jitter spreads recovery work without shortening the publisher's delay.
      const nextFetchAt = Math.max(now + Math.round(backoff * (0.8 + Math.random() * 0.2)), retryAfterTime(retryAfter, now))
      const lastError = error instanceof FeedHttpError ? error.code : signal?.aborted ? 'aborted' : status === 200 ? 'ingestion' : `http-${status}`
      const result = this.db.feedFetch.complete(lease, now, { nextFetchAt, failures, lastStatus: status, lastError,
        ...(discardValidators ? { etag: '', lastModified: '', validatorUrl: '' } : {}) }, () => {})
      return { kind: result.committed ? 'failed' : 'stale', ambiguous: 0 }
    }
  }
}
