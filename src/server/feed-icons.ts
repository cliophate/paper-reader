import { setTimeout as delay } from 'node:timers/promises'
import type { FeedIconStore } from './feed-icon-store.js'
import { discoverFeedIcon } from './feed-icon-discovery.js'
import { feedIconPath } from './feed-icon-format.js'

const POLL_MS = 2000
const BATCH_SIZE = 4
const CONCURRENCY = 2
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000

export class FeedIconService {
  private readonly controller = new AbortController()
  private readonly origin: string
  private loop?: Promise<void>
  private running?: Promise<void>

  constructor(private readonly store: FeedIconStore, private readonly backendId: string, publicUrl: string,
    private readonly trustedOrigins: readonly string[], private readonly onChanged: () => void) {
    this.origin = new URL(publicUrl).origin
  }

  start() {
    if (this.loop || this.controller.signal.aborted) return
    this.loop = this.poll().catch(() => { console.error('Feed icon scheduling stopped.') })
  }

  async stop() {
    this.controller.abort()
    await this.loop
    await this.running
  }

  private async poll() {
    const { signal } = this.controller
    let nextPrune = 0
    while (!signal.aborted) {
      try { await delay(POLL_MS, undefined, { signal, ref: false }) }
      catch (error) { if (signal.aborted) return; throw error }
      try {
        const now = Date.now()
        if (now >= nextPrune) {
          if (this.store.prune(this.backendId, now) < 100) nextPrune = now + PRUNE_INTERVAL_MS
        }
        await this.runDue()
      } catch {
        if (!signal.aborted) console.error('Could not update feed icons. Paper will retry.')
      }
    }
  }

  runDue(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve()
    this.running ??= this.runBatch().finally(() => { this.running = undefined })
    return this.running
  }

  private async runBatch() {
    const { signal } = this.controller
    const pending = this.store.due(this.backendId, Date.now(), BATCH_SIZE).values()
    let changed = false
    const workers = await Promise.allSettled(Array.from({ length: CONCURRENCY }, async () => {
      for (const attempt of pending) {
        if (signal.aborted) break
        const image = await discoverFeedIcon(attempt, { signal, trustedOrigins: this.trustedOrigins, isLocal: url => {
          const path = feedIconPath(url.pathname)
          return Boolean(path && (url.origin === this.origin || path.hash === attempt.hash))
        } })
        if (!signal.aborted && this.store.complete(this.backendId, attempt, image, this.origin, Date.now())) changed = true
      }
    }))
    if (changed && !signal.aborted) this.onChanged()
    const failure = workers.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
