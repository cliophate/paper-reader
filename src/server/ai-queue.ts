import { AiError, AI_QUEUE_WAIT_MS } from './ai-errors.js'

type Waiting = { start: () => void; cancel: () => void }

export class AiQueue {
  private active = 0
  private waiting: Waiting[] = []
  constructor(private concurrency = 2, private capacity = 16, private waitMs = AI_QUEUE_WAIT_MS) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new AiError('cancelled')
    if (this.active < this.concurrency) return this.reserve()
    if (this.waiting.length >= this.capacity) throw new AiError('busy')
    return new Promise((resolve, reject) => {
      const remove = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', entry.cancel)
        const index = this.waiting.indexOf(entry)
        if (index !== -1) this.waiting.splice(index, 1)
      }
      const entry: Waiting = {
        start: () => { remove(); resolve(this.reserve()) },
        cancel: () => { remove(); reject(new AiError('cancelled')) },
      }
      const timer = setTimeout(() => { remove(); reject(new AiError('busy')) }, this.waitMs)
      this.waiting.push(entry)
      signal.addEventListener('abort', entry.cancel, { once: true })
    })
  }

  private reserve() {
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiting[0]?.start()
    }
  }
}
