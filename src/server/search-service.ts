import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { LocalEntryPage, PageOptions, PaperDatabase, SearchSnapshot } from './db.js'
import type { StreamRef } from './types.js'

export class SearchUnavailableError extends Error {}
interface Job {
  id: number
  stream: StreamRef
  options: PageOptions
  resolve(page: LocalEntryPage): void
  reject(error: Error): void
  cleanup(): void
  cancelled: boolean
}
type WorkerMessage = { id: number; type: string; snapshot?: SearchSnapshot; page: LocalEntryPage; error: string; unavailable?: boolean }

// One worker and at most eight waiting requests, including while a cancelled
// native SQLite call finishes. Never replace a worker before its exit event.
export class SearchService {
  private worker?: Worker
  private active?: Job
  private queue: Job[] = []
  private nextId = 0
  private closed = false
  private retiring = false
  private exited: Promise<void> = Promise.resolve()

  constructor(private readonly database: PaperDatabase) {}

  search(stream: StreamRef, options: PageOptions, signal?: AbortSignal): Promise<LocalEntryPage> {
    if (this.closed) return Promise.reject(new SearchUnavailableError('Search is shutting down.'))
    if (signal?.aborted) return Promise.reject(new SearchUnavailableError('Search cancelled.'))
    if ((this.active || this.retiring) && this.queue.length >= 8) return Promise.reject(new SearchUnavailableError('Search is busy. Try again shortly.'))
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.nextId, stream, options, resolve, reject, cancelled: false, cleanup: () => signal?.removeEventListener('abort', abort) }
      const abort = () => {
        job.cancelled = true
        job.cleanup()
        reject(new SearchUnavailableError('Search cancelled.'))
        if (this.active === job) this.retire()
        else this.queue = this.queue.filter(candidate => candidate !== job)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.queue.push(job)
      this.pump()
    })
  }

  private pump() {
    if (this.closed || this.retiring || this.active || !this.queue.length) return
    const job = this.active = this.queue.shift()!
    try {
      if (!this.worker) this.startWorker()
      this.worker!.postMessage({ type: 'search', id: job.id, stream: job.stream, options: job.options })
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
      if (message.type === 'error') job.reject(message.unavailable ? new SearchUnavailableError(message.error) : new Error(message.error))
      else job.resolve(message.page)
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
    for (const job of this.queue.splice(0)) { job.cleanup(); job.reject(new SearchUnavailableError('Search is shutting down.')) }
    if (this.active) { this.active.cancelled = true; this.active.cleanup(); this.active.reject(new SearchUnavailableError('Search is shutting down.')) }
    this.retire()
    await this.exited
  }
}
