import { LocalStateService } from './local-state.js'
import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import type { PaperDatabase } from './db.js'
import type { BackendIdentity } from './identity.js'
import type { RetentionPolicy, RetentionPreview, RetentionView } from '../shared/retention.js'
import { DAY, evaluate, RETENTION_BATCH, validatePolicy } from './retention-store.js'
import { decodeHtmlText } from './text.js'

export class RetentionService {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private stopped = false
  private backupReady = false
  private previewing = false
  private previewJobs = new Set<Promise<unknown>>()
  private previews = new Map<string, { policy: string; revision: number; now: number; ceiling: number }>()
  error = ''

  constructor(private readonly db: PaperDatabase, private readonly backend: BackendIdentity,
    private readonly state = new LocalStateService(db, backend.id)) {}

  view(): RetentionView {
    // Progress polls need names and memberships, not counts over article history.
    const organization = this.backend.kind === 'standalone' ? this.db.organization.metadata(this.backend.id) : null
    const folders = (organization?.folders || []).map(row => ({ id: String(row.id), title: String(row.title) }))
    const activeFeeds = new Map((organization?.feeds || []).filter(row => Number(row.active) === 1)
      .map(row => [String(row.id), { id: String(row.id), title: decodeHtmlText(String(row.title)), folderIds: [] as string[] }]))
    const groupedFeeds: Array<{ id: string; title: string; folderIds: string[] }> = []
    for (const folder of folders) for (const member of organization?.memberships || []) {
      const feed = activeFeeds.get(String(member.feed_id))
      if (feed && member.folder_id === folder.id) { feed.folderIds.push(folder.id); groupedFeeds.push(feed) }
    }
    const feeds = [...new Map([...activeFeeds.values()].filter(feed => !feed.folderIds.length)
      .concat(groupedFeeds).map(feed => [feed.id, feed])).values()]
    const cache = this.db.getSyncValue('retention_cache_run')
    const settings = this.db.retention.settings()
    const folderIds = new Set(folders.map(folder => folder.id))
    settings.policy.folderDays = Object.fromEntries(Object.entries(settings.policy.folderDays).filter(([id]) => folderIds.has(id)))
    settings.policy.feedDays = Object.fromEntries(Object.entries(settings.policy.feedDays).filter(([id]) => activeFeeds.has(id)))
    return { backend: this.backend.kind, ...settings, folders, feeds,
      lastRun: this.backend.kind === 'standalone' ? this.db.retention.lastRun() : null,
      cacheRun: cache ? JSON.parse(cache) : null, error: this.error }
  }

  policy(input: unknown) {
    const policy = validatePolicy(input, this.backend.kind === 'standalone')
    const view = this.view()
    for (const id of Object.keys(policy.feedDays)) if (!view.feeds.some(feed => feed.id === id)) throw new Error('An overridden feed is no longer subscribed. Reload settings.')
    for (const id of Object.keys(policy.folderDays)) if (!view.folders.some(folder => folder.id === id)) throw new Error('An overridden folder no longer exists. Reload settings.')
    return policy
  }

  preview(input: unknown): Promise<RetentionPreview> {
    const job = this.createPreview(input)
    this.previewJobs.add(job)
    void job.finally(() => this.previewJobs.delete(job)).catch(() => {})
    return job
  }

  private async createPreview(input: unknown): Promise<RetentionPreview> {
    if (this.stopped || this.previewing) throw new Error('A preview is already running. Try again shortly.')
    const policy = this.policy(input), revision = this.db.retention.settings().revision
    const now = Date.now(), ceiling = this.db.retention.ceiling()
    this.previewing = true
    try {
      let cursor = 0, marked = 0, deleted = 0
      if (this.backend.kind === 'standalone') while (!this.stopped) {
        const rows = this.db.retention.candidates(cursor, ceiling, now)
        for (const row of rows) { const count = evaluate(policy, row, now); marked += count.marked; deleted += count.deleted }
        if (rows.length < RETENTION_BATCH) break
        cursor = rows.at(-1)!.sequence
        await yieldTurn()
      }
      if (this.stopped) throw new Error('Paper is stopping.')
      const token = crypto.randomUUID()
      this.previews.clear()
      this.previews.set(token, { policy: JSON.stringify(policy), revision, now, ceiling })
      return { token, marked, deleted }
    } finally { this.previewing = false }
  }

  save(input: unknown, revision: number, token?: string) {
    if (this.stopped) throw new Error('Paper is stopping.')
    const policy = this.policy(input)
    if (!Number.isSafeInteger(revision)) throw new Error('Reload retention settings before saving.')
    const preview = token ? this.previews.get(token) : undefined
    if ((policy.readDays !== null || policy.unreadDays !== null)
      && (!preview || preview.revision !== revision || preview.policy !== JSON.stringify(policy) || Date.now() - preview.now > 10 * 60_000)) {
      throw new Error('Preview this policy before saving. Previews expire after ten minutes.')
    }
    if (this.running) throw new Error('Cleanup is running. Wait for it to finish before saving.')
    this.db.transaction(() => {
      if (this.db.retention.settings().revision !== revision) throw new Error('Retention settings changed. Reload before saving.')
      const unfinished = this.db.retention.active()
      if (unfinished) {
        this.db.retention.finish(unfinished.id)
        this.db.recordActivity({ kind: 'retention', origin: 'retention', summary: 'Stopped an unfinished cleanup after a policy change.', details: { ...unfinished } })
      }
      this.db.retention.save(policy, revision)
      this.db.setSyncValue('retention_pending', 'true')
    })
    this.previews.clear()
    this.wake(true, preview)
  }

  start() {
    this.wake()
    this.timer = setInterval(() => this.wake(), 60_000)
    this.timer.unref()
  }

  wake(force = false, preview?: { now: number; ceiling: number }) {
    if (this.stopped || this.running) return
    this.running = this.run(force, preview).catch(() => {
      this.error = 'Cleanup could not finish. Check free disk space and the retention backup. Paper will retry.'
      this.db.recordActivity({ kind: 'retention', origin: 'retention', summary: this.error })
    }).finally(() => { this.running = undefined })
  }

  async drain() { await this.running }
  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    await Promise.allSettled([this.running, ...this.previewJobs])
  }

  private async ensureBackup() {
    if (this.backupReady) return
    const source = import.meta.url.endsWith('.ts')
    const url = new URL(source ? './retention-backup.ts' : './retention-backup.js', import.meta.url)
    const worker = source
      ? new Worker(`import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; await tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)});`, { eval: true, execArgv: [], workerData: { databasePath: this.db.searchDatabasePath }, env: {} })
      : new Worker(url, { execArgv: [], workerData: { databasePath: this.db.searchDatabasePath }, env: {} })
    await new Promise<void>((resolve, reject) => {
      let ready = false
      worker.on('message', message => { ready = message === 'ready' })
      worker.on('error', reject)
      worker.on('exit', code => code === 0 && ready ? resolve() : reject(new Error('Retention backup failed')))
    })
    this.backupReady = true
  }

  private async run(force: boolean, preview?: { now: number; ceiling: number }) {
    const store = this.db.retention, policy = store.settings().policy
    const now = Date.now()
    force ||= this.db.getSyncValue('retention_pending') === 'true'
    const savedCache = this.db.getSyncValue('retention_cache_run')
    const cache = savedCache ? JSON.parse(savedCache) as { at: number; deleted: number } : null
    if (policy.cacheDays !== null && (force || !cache || now - cache.at >= 6 * 60 * 60_000)) {
      let deleted = 0
      while (!this.stopped) {
        const count = store.cacheBatch(policy.cacheDays, now)
        deleted += count
        if (count < RETENTION_BATCH) break
        await yieldTurn()
      }
      if (!this.stopped) {
        this.db.transaction(() => {
          this.db.setSyncValue('retention_cache_run', JSON.stringify({ at: now, deleted }))
          this.db.recordActivity({ kind: 'retention', origin: 'retention', summary: `Removed ${deleted} cached full-text pages.`, count: deleted })
        })
      }
    }
    if (this.backend.kind === 'standalone') {
      let run = store.active()
      const last = store.lastRun()
      const enabled = policy.autoReadDays !== null || policy.readDays !== null || policy.unreadDays !== null
        || Object.values(policy.feedDays).some(days => days !== null) || Object.values(policy.folderDays).some(days => days !== null)
      if (!run && enabled && (force || !last || now - (last.finishedAt || last.startedAt) >= DAY)) {
        const startedAt = preview?.now ?? now, ceiling = preview?.ceiling ?? store.ceiling()
        // Back up before any auto-read changes in the first destructive run.
        // The batch check remains as a guard against later protection changes.
        if (!this.backupReady && (policy.readDays !== null || policy.unreadDays !== null)) {
          let cursor = 0
          while (!this.stopped) {
            const rows = store.candidates(cursor, ceiling, startedAt)
            if (rows.some(row => evaluate(policy, row, startedAt).deleted)) { await this.ensureBackup(); break }
            if (rows.length < RETENTION_BATCH) break
            cursor = rows.at(-1)!.sequence
            await yieldTurn()
          }
        }
        if (this.stopped) return
        run = store.start(policy, startedAt, ceiling)
      }
      while (run && !this.stopped) {
        const result = this.state.retentionBatch(run, this.backupReady)
        if (result.needsBackup) { await this.ensureBackup(); continue }
        if (result.done) {
          this.db.transaction(() => {
            store.finish(run!.id)
            const counts = store.lastRun()!
            this.db.recordActivity({ kind: 'retention', origin: 'retention', summary: `Marked ${counts.marked} read and deleted ${counts.deleted} articles.`, count: counts.deleted, details: { ...counts } })
          })
          break
        }
        await yieldTurn()
        run = store.active()
      }
      const lastSweep = Number(this.db.getSyncValue('retention_tombstone_sweep') || 0)
      if (force || now - lastSweep >= DAY) {
        while (!this.stopped && store.expireRemovals(now) === RETENTION_BATCH) await yieldTurn()
        let cursor = ''
        while (!this.stopped) {
          const result = store.expireTombstones(cursor, now)
          if (result.done) {
            this.db.setSyncValue('retention_tombstone_sweep', String(now))
            break
          }
          cursor = result.cursor
          await yieldTurn()
        }
      }
    }
    if (!this.stopped && this.db.getSyncValue('retention_pending') === 'true') this.db.setSyncValue('retention_pending', 'false')
    this.db.checkpointWalIfLarge(0)
    this.error = ''
  }
}
