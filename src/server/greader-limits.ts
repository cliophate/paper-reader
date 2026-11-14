import { ReaderError } from './greader-auth.js'

interface Bucket { tokens: number; at: number }
interface Budget { key: string; rate: number; burst: number }
interface Waiter {
  app: string; budgets: Budget[]; signal: AbortSignal; expires: number
  resolve(): void; reject(error: Error): void; cancel(): void
}
const ACCOUNT = { key: 'account', rate: 20, burst: 80 }
const WRITES = { key: 'writes', rate: 2, burst: 10 }
const DISCOVERY = { key: 'discovery', rate: 1 / 6, burst: 10 }

// Reserve all budgets together. One FIFO queue prevents later requests from
// spending tokens ahead of an admitted waiter. No worker or SQLite handle is held.
export class GreaderLimits {
  private buckets = new Map<string, Bucket>()
  private queue: Waiter[] = []
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  constructor(private appCapacity = 64, private accountCapacity = 128, private maxWait = 10_000) {}

  private ready(buckets: Map<string, Bucket>, budgets: Budget[], now: number) {
    return Math.max(now, ...budgets.map(({ key, rate, burst }) => {
      const bucket = buckets.get(key) || { tokens: burst, at: now }
      const tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * rate / 1000)
      return now + Math.max(0, 1 - tokens) * 1000 / rate
    }))
  }
  private spend(buckets: Map<string, Bucket>, budgets: Budget[], now: number) {
    for (const { key, rate, burst } of budgets) {
      const bucket = buckets.get(key) || { tokens: burst, at: now }
      buckets.set(key, { tokens: Math.max(0, Math.min(burst, bucket.tokens + (now - bucket.at) * rate / 1000) - 1), at: now })
    }
  }
  discovery() {
    const now = Date.now(), ready = this.ready(this.buckets, [DISCOVERY], now)
    if (ready > now) throw new ReaderError('Too many discovery requests.', 429, Math.ceil((ready - now) / 1000))
    this.spend(this.buckets, [DISCOVERY], now)
  }
  acquire(app: string, write: boolean, signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted) return Promise.reject(new ReaderError('Reader request cancelled.', 503))
    this.drain()
    const now = Date.now()
    // Idle app buckets can be forgotten once their full burst has replenished.
    for (const [key, value] of this.buckets) if (now - value.at > 60_000) this.buckets.delete(key)
    const budgets = [ACCOUNT, { key: app, rate: 10, burst: 40 }, ...(write ? [WRITES] : [])]
    const forecast = new Map(this.buckets)
    let ready = now
    for (const waiter of this.queue) {
      ready = this.ready(forecast, waiter.budgets, ready)
      this.spend(forecast, waiter.budgets, ready)
    }
    ready = this.ready(forecast, budgets, ready)
    if (ready - now > this.maxWait || this.queue.length >= this.accountCapacity || this.queue.filter(w => w.app === app).length >= this.appCapacity) {
      return Promise.reject(new ReaderError('Too many requests.', 429, Math.max(1, Math.ceil((ready - now) / 1000))))
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { app, budgets, signal, expires: now + this.maxWait, resolve, reject, cancel: () => {
        this.remove(waiter); reject(new ReaderError('Reader request cancelled.', 503)); this.drain()
      } }
      signal.addEventListener('abort', waiter.cancel, { once: true })
      this.queue.push(waiter); this.drain()
    })
  }
  private remove(waiter: Waiter) {
    this.queue.splice(this.queue.indexOf(waiter), 1)
    waiter.signal.removeEventListener('abort', waiter.cancel)
  }
  private drain() {
    clearTimeout(this.timer)
    while (this.queue.length) {
      const waiter = this.queue[0], now = Date.now(), ready = this.ready(this.buckets, waiter.budgets, now)
      if (ready <= now && now <= waiter.expires) {
        this.spend(this.buckets, waiter.budgets, now); this.remove(waiter); waiter.resolve()
      } else if (now >= waiter.expires) {
        this.remove(waiter); waiter.reject(new ReaderError('Reader rate wait expired.', 429, Math.max(1, Math.ceil((ready - now) / 1000))))
      } else {
        this.timer = setTimeout(() => this.drain(), Math.max(1, Math.ceil(Math.min(ready, waiter.expires) - now)))
        return
      }
    }
  }
  close() {
    this.stopped = true; clearTimeout(this.timer)
    for (const waiter of [...this.queue]) { this.remove(waiter); waiter.reject(new ReaderError('Reader service stopped.', 503)) }
  }
}
