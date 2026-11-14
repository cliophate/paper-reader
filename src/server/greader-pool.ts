import { fork, type ChildProcess } from 'node:child_process'
import { ReaderError } from './greader-auth.js'

interface Job {
  input: object; signal: AbortSignal; hold: boolean; exited: boolean
  resolve(value: string): void; reject(error: Error): void; cancel(): void; release?(): void
}
export class GreaderPool {
  private active = new Map<ChildProcess, Job>()
  private queue: Job[] = []
  private stopped = false
  constructor(private file = new URL('./greader-worker.js', import.meta.url), private concurrency = 2, private capacity = 16, private deadline = 5000) {}
  run(input: object, signal: AbortSignal, holdUntilResponseCloses = false): Promise<string> {
    if (this.stopped || signal.aborted || this.queue.length >= this.capacity) return Promise.reject(new ReaderError('Reader service is busy.', 503))
    return new Promise((resolve, reject) => {
      const job: Job = { input, signal, hold: holdUntilResponseCloses, exited: false, resolve, reject, cancel: () => {
        this.queue = this.queue.filter(value => value !== job)
        signal.removeEventListener('abort', job.cancel)
        for (const [child, value] of this.active) if (value === job) {
          if (job.exited) job.release?.()
          else child.kill('SIGKILL')
        }
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
      const child = fork(file, { env: {}, execArgv: ['--max-old-space-size=256', ...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [])], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      this.active.set(child, job)
      job.release = () => { job.signal.removeEventListener('abort', job.cancel); this.active.delete(child); this.start() }
      const timer = setTimeout(() => { job.reject(new ReaderError('Reader job timed out.', 503)); child.kill('SIGKILL') }, this.deadline)
      child.once('message', (message: { body?: string; error?: string; status?: number }) => {
        if (message.error) job.reject(new ReaderError(message.error, message.status))
        else job.resolve(message.body!)
      })
      child.once('error', () => job.reject(new ReaderError('Reader worker unavailable.', 503)))
      child.once('close', () => {
        clearTimeout(timer); job.exited = true
        // Keep admission occupied while a slow socket retains the bounded body.
        // SQLite is already closed, so network delivery holds no read snapshot.
        if (!job.hold || job.signal.aborted || this.stopped) job.release?.()
        job.reject(new ReaderError('Reader worker stopped.', 503))
      })
      child.send(job.input)
    }
  }
  async close() {
    this.stopped = true
    const exited = [...this.active].filter(([, job]) => !job.exited).map(([child]) => new Promise<void>(resolve => child.once('close', () => resolve())))
    for (const job of [...this.queue, ...this.active.values()]) job.cancel()
    this.queue = []
    await Promise.all(exited)
  }
}
