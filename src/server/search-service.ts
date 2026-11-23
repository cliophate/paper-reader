import type { ViewCount } from '../shared/saved-views.js'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { LocalEntryPage, PageOptions, PaperDatabase, SearchSnapshot } from './db.js'
import type { StreamRef } from './types.js'
import { parseSearch, SearchLimitError } from './search-query.js'

export type BulkSelection =
  | { kind: 'rule' | 'view-count' }
  | { kind: 'preview'; withRevisions: boolean; ids?: string[] }
  | { kind: 'relative'; anchorId: string; direction: 'above' | 'below'; snapshot?: string; displayedIds?: string[]; withRevisions: boolean }
type SelectionResult = { ids: string[]; count?: number; capped?: boolean; revisions?: Record<string, number> }

export class SearchSnapshotError extends Error {}
export class SearchUnavailableError extends Error {}
interface Job {
  id: number
  stream: StreamRef
  options: PageOptions
  selection?: BulkSelection
  resolve(result: LocalEntryPage | SelectionResult): void
  reject(error: Error): void
  cleanup(): void
  cancelled: boolean
}
type WorkerMessage =
  | { id: number; type: 'snapshot'; snapshot?: SearchSnapshot }
  | { id: number; type: 'result'; value: LocalEntryPage | SelectionResult }
  | { id: number; type: 'error'; error: string; failure?: 'snapshot' | 'limit' }

// Search and bulk requests have eight waiting slots. Counts use a separate queue.
// Never replace a worker before its exit event.
export class SearchService {
  private worker?: Worker
  private active?: Job
  private queue: Job[] = []
  private countQueue: Job[] = []
  private countClock = ''
  private counts = new Map<string, { key: string; value: Promise<ViewCount> }>()
  private nextId = 0
  private closed = false
  private retiring = false
  private exited: Promise<void> = Promise.resolve()

  constructor(private readonly database: PaperDatabase) {}

  search(stream: StreamRef, options: PageOptions, signal?: AbortSignal): Promise<LocalEntryPage> {
    return this.enqueue(stream, options, undefined, signal)
  }

  select(stream: StreamRef, options: PageOptions, selection: BulkSelection, signal?: AbortSignal): Promise<SelectionResult> {
    return this.enqueue(stream, options, selection, signal)
  }

  async savedViewCounts(signal?: AbortSignal) {
    const views = this.database.savedViews.list()
    const clock = this.database.dataChangeClock()
    if (clock !== this.countClock) {
      this.countClock = clock
      this.counts = new Map()
    }
    const counts = this.counts
    const result: Record<string, ViewCount> = {}
    for (const view of views) {
      if (signal?.aborted) break
      // Relative dates can change membership even while the database is idle.
      const minute = /(?:before|after):"?\d+[dwmy]/i.test(view.query) ? Math.floor(Date.now() / 60000) : 0
      const key = [view.revision, minute].join('/')
      let cached = counts.get(view.id)
      if (cached?.key !== key) {
        const stream = { kind: 'view' as const, id: view.id, title: view.title, viewQuery: view.query }
        const value = this.select(stream, { unreadOnly: true }, { kind: 'view-count' }).then(
          ({ count, capped }) => ({ count: count!, capped: capped! }))
        cached = { key, value }
        counts.set(view.id, cached)
      }
      try { result[view.id] = await cached.value }
      catch {
        if (counts.get(view.id) === cached) counts.delete(view.id)
      }
    }
    return result
  }

  private enqueue(stream: StreamRef, options: PageOptions, selection: undefined, signal?: AbortSignal): Promise<LocalEntryPage>
  private enqueue(stream: StreamRef, options: PageOptions, selection: BulkSelection, signal?: AbortSignal): Promise<SelectionResult>
  private async enqueue(stream: StreamRef, options: PageOptions, selection?: BulkSelection, signal?: AbortSignal): Promise<LocalEntryPage | SelectionResult> {
    if (options.query) parseSearch(options.query)
    if (this.closed) return Promise.reject(new SearchUnavailableError('Search is shutting down.'))
    if (signal?.aborted) return Promise.reject(new SearchUnavailableError('Search cancelled.'))
    const queue = selection?.kind === 'view-count' ? this.countQueue : this.queue
    if ((this.active || this.retiring) && queue.length >= 8 && !(stream.kind === 'view' && selection?.kind === 'view-count')) return Promise.reject(new SearchUnavailableError('Search is busy. Try again shortly.'))
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.nextId, stream, options, selection, resolve, reject, cancelled: false, cleanup: () => signal?.removeEventListener('abort', abort) }
      const abort = () => {
        job.cancelled = true
        job.cleanup()
        reject(new SearchUnavailableError('Search cancelled.'))
        if (this.active === job) this.retire()
        else {
          const index = queue.indexOf(job)
          if (index >= 0) queue.splice(index, 1)
        }
      }
      signal?.addEventListener('abort', abort, { once: true })
      queue.push(job)
      this.pump()
    })
  }

  private pump() {
    if (this.closed || this.retiring || this.active) return
    const job = this.queue.shift() ?? this.countQueue.shift()
    if (!job) return
    this.active = job
    try {
      if (!this.worker) this.startWorker()
      this.worker!.postMessage({ type: 'search', id: job.id, stream: job.stream, options: job.options, selection: job.selection })
    } catch {
      job.cleanup(); job.reject(new SearchUnavailableError('Search worker could not start. Try again.'))
      if (this.worker) this.retire()
      else { this.active = undefined; this.pump() }
    }
  }

  private startWorker() {
    const source = import.meta.url.endsWith('.ts')
    const url = new URL(source ? './search-worker.ts' : './search-worker.js', import.meta.url)
    // tsx's explicit API also works in test runners whose loader isn't inherited.
    const worker = this.worker = source
      ? new Worker(`import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; await tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)});`, { eval: true, execArgv: [], workerData: { databasePath: this.database.searchDatabasePath }, env: {} })
      : new Worker(url, { execArgv: [], workerData: { databasePath: this.database.searchDatabasePath }, env: {} })
    this.exited = new Promise(resolve => worker.once('exit', () => {
      if (this.worker === worker) {
        const job = this.active
        if (job) { job.cleanup(); job.reject(new SearchUnavailableError('Search worker stopped. Try again.')) }
        this.worker = undefined; this.active = undefined; this.retiring = false
        this.pump()
      }
      resolve()
    }))
    worker.on('error', () => {
      if (this.worker !== worker) return
      this.active?.reject(new SearchUnavailableError('Search worker failed. Try again.'))
      this.retire()
    })
    worker.on('message', (message: WorkerMessage) => {
      const job = this.active
      // Ignore messages queued before cancellation or from a retired generation.
      if (this.closed || this.retiring || this.worker !== worker || !job || job.cancelled || message.id !== job.id) return
      if (message.type === 'snapshot') {
        let error: string | undefined
        try { this.database.saveSearchSnapshot(message.snapshot) }
        catch { error = 'Search could not save its snapshot. Try again.' }
        worker.postMessage({ type: 'saved', id: job.id, error })
        return
      }
      if (message.type !== 'result' && message.type !== 'error') return
      job.cleanup(); this.active = undefined
      if (message.type === 'error') {
        const ErrorType = message.failure === 'snapshot' ? SearchSnapshotError : message.failure === 'limit' ? SearchLimitError : SearchUnavailableError
        job.reject(new ErrorType(message.error))
      } else job.resolve(message.value)
      this.pump()
    })
  }

  private retire() {
    if (!this.worker || this.retiring) return
    this.retiring = true
    // terminate waits for an in-flight native SQLite statement to return.
    void this.worker.terminate()
  }

  async close() {
    this.closed = true
    for (const job of [...this.queue.splice(0), ...this.countQueue.splice(0)]) { job.cleanup(); job.reject(new SearchUnavailableError('Search is shutting down.')) }
    if (this.active) { this.active.cancelled = true; this.active.cleanup(); this.active.reject(new SearchUnavailableError('Search is shutting down.')) }
    this.retire()
    await this.exited
  }
}
