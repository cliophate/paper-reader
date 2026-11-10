import type { PaperDatabase } from './db.js'
import type { EntryStateOperation } from './backend.js'
import type { StandaloneBackend } from './standalone-backend.js'
import type { OrganizationCommand } from './organization.js'
import { StandaloneFeedScheduler } from './feed-scheduler.js'

export class StandaloneRuntime {
  private readonly scheduler: StandaloneFeedScheduler
  private readonly controller = new AbortController()
  private loop: Promise<void> | null = null
  private running: Promise<void> | null = null
  private readonly listeners = new Set<(completedAt: string) => void>()
  constructor(private readonly db: PaperDatabase, private readonly backend: StandaloneBackend, private readonly enabled: boolean, trustedOrigins: string[]) {
    this.scheduler = new StandaloneFeedScheduler(db, backend.identity.id, { trustedOrigins })
  }
  onStateChanged(listener: Parameters<StandaloneBackend['state']['onStateChanged']>[0]) { return this.backend.state.onStateChanged(listener) }
  onSyncCompleted(listener: (completedAt: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  start() {
    if (!this.enabled || this.loop || this.controller.signal.aborted) return
    this.loop = this.collect().catch(() => { console.error('Standalone feed collection stopped. Restart Paper to retry.') })
  }
  private async collect() {
    const { setTimeout: delay } = await import('node:timers/promises')
    while (!this.controller.signal.aborted) {
      await this.syncNow()
      try { await delay(1000, undefined, { signal: this.controller.signal }) }
      catch { if (!this.controller.signal.aborted) throw new Error('Scheduler timer failed') }
    }
  }
  syncNow(_origin = 'manual'): Promise<void> {
    if (!this.enabled || this.controller.signal.aborted) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.scheduler.runDue({ signal: this.controller.signal }).then(result => {
      if (!result.attempted || this.controller.signal.aborted) return
      const completedAt = new Date().toISOString()
      this.db.setSyncValue('last_sync_completed_at', completedAt)
      for (const listener of this.listeners) listener(completedAt)
    }).finally(() => { this.running = null })
    return this.running
  }
  async stop() { this.controller.abort(); await this.loop; await this.running }
  status() { return { ...this.db.syncStatus(this.enabled, Boolean(this.running)), backfillComplete: true, backfillContinuation: '' } }
  async refreshNavigation() {}
  async parity() { throw new Error('FreshRSS comparison is unavailable in standalone mode') }
  async editEntries(ids: string[], operation: EntryStateOperation, origin = 'reader') { this.backend.state.editEntries(ids, operation, { origin }) }
  async addFeed(url: string, title: string, folder: string): Promise<{ refreshError?: string }> { await this.backend.addFeed(url, title, folder); return {} }
  async editFeed(id: string, title: string, folder: string, currentFolder: string) { await this.backend.editFeed(id, title, folder, currentFolder) }
  async removeFeed(id: string) { await this.backend.removeFeed(id) }
  async repairFeed(_id: string, _url: string, _expectedUrl: string) { throw new Error('Use subscription discovery to add a replacement feed') }
  async applyOrganizationCommand(command: OrganizationCommand): Promise<{ refreshError?: string }> {
    const current = this.db.organization.snapshot(this.backend.identity.id)
    const result = this.db.organization.apply(this.backend.identity.id, current.revision, [command])
    if (result.results.some(item => item.status === 'failed')) throw new Error('Could not apply organization change')
    return {}
  }
}
