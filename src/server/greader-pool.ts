import { fork, type ChildProcess } from 'node:child_process'
import { ReaderError } from './greader-auth.js'

interface Job { input: object; signal: AbortSignal; resolve(value: string): void; reject(error: Error): void; cancel(): void }
export class GreaderPool {
  private active = new Map<ChildProcess, Job>()
  private queue: Job[] = []
  private stopped = false
  constructor(private file = new URL('./greader-worker.js', import.meta.url), private concurrency = 2, private capacity = 16, private deadline = 5000) {}
  run(input: object, signal: AbortSignal): Promise<string> {
    if (this.stopped || signal.aborted || this.queue.length >= this.capacity) return Promise.reject(new ReaderError('Reader service is busy.', 503))
    return new Promise((resolve, reject) => {
      const job: Job = { input, signal, resolve, reject, cancel: () => {
        this.queue = this.queue.filter(value => value !== job)
        signal.removeEventListener('abort', job.cancel)
        for (const [child, value] of this.active) if (value === job) child.kill('SIGKILL')
        reject(new ReaderError('Reader request cancelled.', 503))
      } }
      signal.addEventListener('abort', job.cancel, { once: true })
      this.queue.push(job); this.start()
    })
  }
  private start() {
    while (!this.stopped && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!
      const file = this.file.pathname.endsWith('.js') && import.meta.url.endsWith('.ts') ? new URL(this.file.href.replace(/\.js$/, '.ts')) : this.file
      const child = fork(file, { env: {}, execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      this.active.set(child, job)
      const timer = setTimeout(() => { job.reject(new ReaderError('Reader job timed out.', 503)); child.kill('SIGKILL') }, this.deadline)
      child.once('message', (message: { body?: string; error?: string; status?: number }) => {
        if (message.error) job.reject(new ReaderError(message.error, message.status))
        else job.resolve(message.body!)
      })
      child.once('error', () => job.reject(new ReaderError('Reader worker unavailable.', 503)))
      child.once('close', () => {
        clearTimeout(timer); job.signal.removeEventListener('abort', job.cancel)
        this.active.delete(child); job.reject(new ReaderError('Reader worker stopped.', 503)); this.start()
      })
      child.send(job.input)
    }
  }
  async close() { const exited = [...this.active.keys()].map(child => new Promise<void>(resolve => child.once('close', () => resolve()))); this.stopped = true; for (const job of this.queue) { job.signal.removeEventListener('abort', job.cancel); job.reject(new ReaderError('Reader service stopped.', 503)) }; this.queue = []; for (const child of this.active.keys()) child.kill('SIGKILL'); await Promise.all(exited) }
}
