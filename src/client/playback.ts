import { ownerSignedOut } from './offlineAccess'

export interface PlaybackPosition {
  position: number
  updatedAt: number
}

interface PendingPlayback extends PlaybackPosition {
  id: string
  url: string
}

const prefix = 'paper-pending-playback:'
const articleKey = (id: string) => prefix + JSON.stringify(id) + ':'
const enclosureKey = (id: string, url: string) => articleKey(id) + JSON.stringify(url) + ':'
// A tab can acknowledge this timestamp without deleting a concurrent save in another tab.
const keyFor = (item: PendingPlayback) => enclosureKey(item.id, item.url) + item.updatedAt

export class PlaybackQueue {
  private fallback = new Map<string, PendingPlayback>()
  private writes = new Map<string, Promise<void>>()
  private listeners = new Set<(update: PendingPlayback) => void>()
  private locked = false

  constructor(private send: (pending: PendingPlayback) => Promise<PlaybackPosition>) {}

  subscribe(listener: (update: PendingPlayback) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private keys(scope = prefix) {
    const keys = new Set(this.fallback.keys())
    try {
      for (const key of Object.keys(localStorage)) keys.add(key)
    } catch { /* Storage can be disabled. */ }
    return [...keys].filter(key => key.startsWith(scope))
  }

  private read(key: string): PendingPlayback | undefined {
    const fallback = this.fallback.get(key)
    if (fallback) return fallback
    try {
      const item = JSON.parse(localStorage.getItem(key) || 'null')
      if (item && typeof item.id === 'string' && typeof item.url === 'string'
        && Number.isFinite(item.position) && item.position >= 0 && Number.isSafeInteger(item.updatedAt)
        && item.updatedAt >= 0 && key === keyFor(item)) return item
    } catch { /* Ignore unavailable storage and malformed records. */ }
  }

  private remove(key: string) {
    this.fallback.delete(key)
    try { localStorage.removeItem(key) } catch { /* Storage can be disabled. */ }
  }

  setLocked(locked: boolean) { this.locked = locked }

  clear() { for (const key of this.keys()) this.remove(key) }

  pending(id: string, url: string) {
    let latest: PendingPlayback | undefined
    for (const key of this.keys(enclosureKey(id, url))) {
      const item = this.read(key)
      if (item && (!latest || item.updatedAt > latest.updatedAt)) latest = item
    }
    return latest
  }

  async save(item: PendingPlayback) {
    if (this.locked || ownerSignedOut()) return
    const key = keyFor(item)
    try { localStorage.setItem(key, JSON.stringify(item)) }
    catch { this.fallback.set(key, item) }
    for (const other of this.keys(enclosureKey(item.id, item.url))) {
      const pending = this.read(other)
      if (pending && pending.updatedAt < item.updatedAt) this.remove(other)
      if (pending && pending.updatedAt > item.updatedAt) this.remove(key)
    }
    await this.flush(key)
  }

  retry(id?: string) {
    return Promise.all(this.keys(id ? articleKey(id) : prefix).map(key => this.flush(key)))
  }

  async waitForArticle(id: string) {
    await Promise.allSettled([...this.writes].filter(([key]) => key.startsWith(articleKey(id))).map(([, write]) => write))
  }

  private flush(key: string) {
    const running = this.writes.get(key)
    if (running) return running
    if (this.locked || ownerSignedOut() || !navigator.onLine) return
    const item = this.read(key)
    if (!item) return
    const write = this.send(item).then(stored => {
      if (this.locked || ownerSignedOut()) return
      if (stored.updatedAt >= item.updatedAt) this.remove(key)
      for (const listener of this.listeners) listener({ ...item, ...stored })
    }).finally(() => this.writes.delete(key))
    this.writes.set(key, write)
    return write
  }
}
