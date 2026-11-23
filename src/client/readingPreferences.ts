import { choicesFor, readingChoices, type ReadingKey, type ReadingSnapshot, type ReadingValues, type ReadingWrite, type ReadingWriteResult } from '../server/reading-preference-values'
import { automaticFullTextFeeds } from './fullTextPreferences'
import { api, ApiError } from './api'

const storageKey = 'paper-reading-preferences-v1'
const legacyKeys = { font: 'paper-reader-font', spacing: 'paper-reader-spacing', width: 'paper-reader-width', markRead: 'paper-auto-read' } as const

export function legacyReadingValues(storage: Storage): ReadingValues | null {
  const values: ReadingValues = {}
  for (const [key, name] of Object.entries(legacyKeys)) {
    const value = storage.getItem(name)
    if (value && choicesFor(key).includes(value)) values[key as ReadingKey] = value
  }
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i)
    if (!name?.startsWith('paper-full-mode:')) continue
    const key = `fullText:${name.slice('paper-full-mode:'.length)}` as const
    const value = storage.getItem(name)
    if (value && choicesFor(key).includes(value)) values[key] = value
  }
  for (const feedId of automaticFullTextFeeds(storage)) {
    const key = `learned:${feedId}` as const
    if (choicesFor(key).length) values[key] = 'on'
  }
  if (!Object.keys(values).length) return null
  for (const key of Object.keys(legacyKeys) as (keyof typeof legacyKeys)[]) values[key] ??= readingChoices[key][0]
  return values
}

interface Notice { id: string; text: string }

const keptOverridesMessage = 'This browser had different reading preferences. Paper kept them as device overrides. You can change them in Reading & connections.'
const restoredMessage = 'Paper loaded the restored reading preferences.'
const dismissedKey = (notice: Notice) => storageKey + ':dismissed:' + notice.id

interface DevicePreferences {
  device: string
  sequence: number
  shared: ReadingSnapshot
  hasSnapshot: boolean
  pending: ReadingWrite[]
  // Resolve a visible pending edit if its acknowledgement committed before the click.
  acknowledged?: Partial<Record<ReadingKey, { sequence: number; token: string }>>
  overrides: ReadingValues
  legacy: ReadingValues | null
  offer: boolean
  notices: Notice[]
}

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')
}

function initialState(storage: Storage): DevicePreferences {
  return {
    device: randomId(),
    sequence: 0, hasSnapshot: false, shared: { revision: 0, generation: 0, values: {} }, pending: [], overrides: {},
    legacy: legacyReadingValues(storage), offer: false, notices: [],
  }
}

function addNotice(state: DevicePreferences, text: string): DevicePreferences {
  if (state.notices.some(notice => notice.text === text)) return state
  return { ...state, notices: [...state.notices, { id: randomId(), text }] }
}

// Browsers running the previous version stored the message text and override flag.
function migrateNotices(state: DevicePreferences & { messages?: string[]; keptOverrides?: boolean }): DevicePreferences {
  if (state.notices) return state
  const { messages = [], keptOverrides, ...rest } = state
  const texts = keptOverrides ? [...messages, keptOverridesMessage] : messages
  return { ...rest, notices: texts.map((text, i) => ({ id: state.device + '-legacy-' + i, text })) }
}

export function applyShared(state: DevicePreferences, shared: ReadingSnapshot): DevicePreferences {
  if (!Number.isSafeInteger(shared?.revision) || !Number.isSafeInteger(shared.generation) || !shared.values) throw new Error('Could not load reading preferences.')
  if (!state.legacy) return { ...state, shared }
  if (shared.revision === 0) return { ...state, shared, offer: true }
  const overrides = { ...state.overrides }
  let keptOverrides = false
  for (const key of new Set([...Object.keys(state.legacy), ...Object.keys(shared.values)]) as Set<ReadingKey>) {
    const fallback = choicesFor(key)[0]
    const previous = state.legacy[key] ?? fallback
    if (previous !== (shared.values[key]?.value ?? fallback)) {
      overrides[key] = previous
      keptOverrides = true
    }
  }
  const next = { ...state, shared, overrides, legacy: null, offer: false }
  return keptOverrides ? addNotice(next, keptOverridesMessage) : next
}

export function currentReadingValue(state: DevicePreferences, key: ReadingKey): string {
  if (state.overrides[key] !== undefined) return state.overrides[key]
  if (state.legacy) return state.legacy[key] ?? choicesFor(key)[0]
  for (let i = state.pending.length - 1; i >= 0; i--) {
    const write = state.pending[i]
    if (write.values[key] !== undefined) return write.values[key]
    if (write.action === 'reset') return choicesFor(key)[0]
  }
  return state.shared.values[key]?.value ?? choicesFor(key)[0]
}

function sameWrite(first: ReadingWrite | undefined, second: ReadingWrite) {
  return first?.device === second.device && first.writer === second.writer && first.sequence === second.sequence
}

// Only IndexedDB sees these references. Replay replaces each with its parent's receipt.
const queuedToken = (sequence: number) => `queued:${sequence}`

function advanceBase(next: ReadingWrite, saved: ReadingWrite, tokens: ReadingWrite['base']): ReadingWrite {
  if (next.generation !== saved.generation) return next
  const base = { ...next.base }
  for (const key of Object.keys(base) as ReadingKey[]) {
    const token = base[key]
    if (token === queuedToken(saved.sequence)) base[key] = tokens[key] ?? 'none'
    else if (saved.action === 'reset' && !(typeof token === 'string' && token.startsWith('queued:'))) base[key] = 'none'
  }
  const generation = saved.action === 'reset' ? saved.generation + 1 : next.generation
  return { ...next, base, generation }
}

function editBase(state: DevicePreferences, visible: DevicePreferences, key: ReadingKey) {
  const value = visible.shared.values[key]
  let token = value ? value.token ?? 'unversioned' : 'none'
  for (let i = visible.pending.length - 1; i >= 0; i--) {
    const previous = visible.pending[i]
    if (previous.values[key] !== undefined) {
      const receipt = state.acknowledged?.[key]
      token = receipt?.sequence === previous.sequence ? receipt.token : queuedToken(previous.sequence)
      break
    }
    if (previous.action === 'reset') {
      token = 'none'
      break
    }
  }
  // Include edits already queued by this device against the displayed version.
  // A committed snapshot with a different token cannot extend this chain.
  for (const queued of state.pending) {
    if (queued.action === 'reset') token = 'none'
    else if (queued.base[key] === token) token = queuedToken(queued.sequence)
  }
  return token
}

function replayBase(write: ReadingWrite): ReadingWrite['base'] {
  const base = { ...write.base }
  for (const key of Object.keys(base) as ReadingKey[]) {
    const token = base[key]
    // Old queues used zero for an absent key. Other integers and unresolved
    // local references have no server token, so refresh and show the conflict.
    if (typeof token === 'number' && token === 0) base[key] = 'none'
    else if (typeof token !== 'string' || token === 'unversioned' || token.startsWith('queued:')) {
      throw new ApiError(`A newer value from another device replaced your offline change to ${key}.`, 409, 'reading-key')
    }
  }
  return base
}

export class ReadingPreferences {
  private state: DevicePreferences
  private readonly writer = randomId()
  private listeners = new Set<() => void>()
  private syncing = false
  private active = false
  private channel?: BroadcastChannel

  constructor(private readonly storage: Storage, private readonly server: Pick<typeof api, 'readingPreferences' | 'saveReadingPreferences'> = api) {
    this.state = initialState(storage)
    const raw = storage.getItem(storageKey)
    if (!raw) return
    try {
      const old: DevicePreferences = JSON.parse(raw)
      if (!old.device || !old.shared?.values || !old.overrides || !Array.isArray(old.pending)) return
      // Old queued edits have no recorded base. Only apply them to untouched keys.
      this.state = { ...migrateNotices(old), shared: { ...old.shared, generation: 0 }, pending: old.pending.map(write => ({
        ...write, generation: 0, writer: old.device,
        base: write.action === 'edit' ? Object.fromEntries(Object.keys(write.values).map(key => [key, 'none'])) : {},
      })) }
    } catch { /* Ignore an unreadable legacy cache. */ }
  }

  private removeDismissed(state: DevicePreferences) {
    const notices = state.notices.filter(notice => !this.storage.getItem(dismissedKey(notice)))
    return notices.length === state.notices.length ? state : { ...state, notices }
  }

  private publish(state: DevicePreferences) {
    this.state = this.removeDismissed(state)
    for (const listener of this.listeners) listener()
  }

  // Every tab reads and replaces the same record inside one transaction. The
  // sequence, queue and acknowledgements therefore survive concurrent writers.
  private update(change: (state: DevicePreferences) => DevicePreferences) {
    if (typeof indexedDB === 'undefined') {
      this.publish(change(this.removeDismissed(this.state)))
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('paper-reading-preferences', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('preferences')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('preferences', 'readwrite')
        const records = tx.objectStore('preferences')
        const read = records.get('device')
        let next: DevicePreferences
        let dismissed: Notice[] = []
        let changed = false
        read.onsuccess = () => {
          try {
            const stored = migrateNotices(read.result ?? this.state)
            const visible = this.removeDismissed(stored)
            if (stored !== visible) dismissed = stored.notices.filter(notice => !visible.notices.includes(notice))
            next = change(visible)
            changed = next !== read.result
            if (changed) records.put(next, 'device')
          } catch { tx.abort() }
        }
        tx.oncomplete = () => {
          db.close()
          this.publish(next)
          for (const notice of dismissed) this.storage.removeItem(dismissedKey(notice))
          if (changed) this.channel?.postMessage('changed')
          resolve()
        }
        tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Could not save reading preferences.')) }
      }
    })
  }

  private async change(change: (state: DevicePreferences) => DevicePreferences, sync = false) {
    try {
      await this.update(change)
      if (sync) await this.sync()
    } catch {
      this.publish(addNotice(this.state, 'Could not save reading preferences on this device.'))
    }
  }

  value = (key: ReadingKey) => currentReadingValue(this.state, key)
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private enqueue(state: DevicePreferences, action: ReadingWrite['action'], values: ReadingValues, base: ReadingWrite['base'] = {}) {
    const sequence = state.sequence + 1
    const write = { action, values, base, generation: state.shared.generation, device: state.device, writer: this.writer, sequence }
    return { ...state, sequence, pending: [...state.pending, write] }
  }

  set(key: ReadingKey, value: string, visible = this.state) {
    if (!choicesFor(key).includes(value)) return
    return this.change(state => {
      if (state.overrides[key] !== undefined) return { ...state, overrides: { ...state.overrides, [key]: value } }
      if (state.legacy) return { ...state, legacy: { ...state.legacy, [key]: value } }
      if (visible.shared.storeId && visible.shared.storeId !== state.shared.storeId) return addNotice(state, restoredMessage)
      const base = editBase(state, visible, key)
      return this.enqueue(state, 'edit', { [key]: value }, { [key]: base })
    }, true)
  }

  override(key: ReadingKey, enabled: boolean) {
    return this.change(state => {
      const overrides = { ...state.overrides }
      if (enabled) overrides[key] = currentReadingValue(state, key)
      else delete overrides[key]
      return { ...state, overrides }
    })
  }

  migrate(upload: boolean) {
    return this.change(state => {
      if (!state.legacy || !state.offer || state.pending.some(write => write.action === 'import')) return state
      if (upload) return this.enqueue(state, 'import', state.legacy)
      return { ...state, overrides: { ...state.legacy, ...state.overrides }, legacy: null, offer: false }
    }, true)
  }

  async dismissNotice() {
    const notice = this.state.notices[0]
    if (!notice) return
    const key = dismissedKey(notice)
    const remove = (state: DevicePreferences) => state.notices.some(item => item.id === notice.id)
      ? { ...state, notices: state.notices.filter(item => item.id !== notice.id) } : state
    try { this.storage.setItem(key, '1') } catch { /* IndexedDB can still save the dismissal. */ }
    this.publish(remove(this.state))
    try {
      await this.update(remove)
      this.storage.removeItem(key)
    } catch {
      // The next transaction will retry using the dismissal saved at click time.
      if (!this.storage.getItem(key)) this.publish(addNotice(this.state, 'Could not save reading preferences on this device.'))
    }
  }

  reset() {
    return this.change(state => this.enqueue(state, 'reset', {}), true)
  }

  sync = async () => {
    if (!this.active || this.syncing) return
    this.syncing = true
    try {
      await this.update(state => state)
      let refresh = false
      do {
        const observed = this.state.shared
        const write = refresh ? undefined : this.state.pending[0]
        refresh = false
        let conflict: ApiError | undefined
        let result: ReadingWriteResult
        try {
          result = write
            ? await this.server.saveReadingPreferences({ ...write, base: replayBase(write), storeId: observed.storeId, knownRevision: observed.revision })
            : await this.server.readingPreferences()
        } catch (error) {
          if (!write || !(error instanceof ApiError) || error.status < 400 || error.status >= 500 || [408, 429].includes(error.status)) throw error
          if (!this.active) return
          if (error.status === 409) {
            conflict = error
            result = error.snapshot ?? await this.server.readingPreferences()
          } else {
            await this.update(state => {
              if (!sameWrite(state.pending[0], write)) return state
              const message = write.action === 'reset' ? 'Could not reset shared preferences.'
                : 'Could not share these preferences. Paper kept them on this device.'
              const overrides = write.action === 'edit' ? { ...state.overrides, ...write.values } : state.overrides
              return addNotice({ ...state, overrides, pending: state.pending.slice(1) }, message)
            })
            continue
          }
        }
        if (!this.active) return
        const { appliedTokens, ...shared } = result
        await this.update(state => {
          // Another tab may have committed a newer response or adopted a backup
          // while this request was in flight. Retry against its snapshot.
          if (state.shared.storeId !== observed.storeId || state.shared.revision !== observed.revision || state.shared.generation !== observed.generation) {
            refresh = true
            return state
          }
          if (conflict?.code === 'reading-restored' || (state.hasSnapshot && (shared.revision < observed.revision || shared.generation < observed.generation
            || (observed.storeId !== undefined && shared.storeId !== observed.storeId)))) {
            const next = applyShared({ ...state, hasSnapshot: true, acknowledged: undefined, pending: [] }, shared)
            return addNotice(next, state.pending.length ? restoredMessage + ' Paper discarded queued changes.' : restoredMessage)
          }
          let pending = state.pending
          let acknowledged = shared.generation === observed.generation ? state.acknowledged : undefined
          let next = state
          if (write && sameWrite(pending[0], write)) {
            pending = pending.slice(1)
            // Later local edits can build on this acknowledgement, even if
            // another device changed the server again before a retry arrived.
            if (conflict) next = addNotice(state, conflict.message)
            else if (appliedTokens !== undefined) {
              pending = pending.map(item => advanceBase(item, write, appliedTokens))
              if (write.generation === shared.generation) {
                acknowledged = { ...acknowledged }
                for (const key of Object.keys(appliedTokens) as ReadingKey[]) acknowledged[key] = { sequence: write.sequence, token: appliedTokens[key]! }
              }
            }
          }
          return applyShared({ ...next, hasSnapshot: true, pending, acknowledged }, shared)
        })
      } while (this.active && (refresh || this.state.pending.length))
    } catch { /* Keep queued edits and the last snapshot for the next connection. */ }
    finally { this.syncing = false }
  }

  connect = () => {
    this.active = true
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('paper-reading-preferences')
      this.channel.onmessage = () => { void this.change(state => state) }
    }
    const refresh = () => { if (!document.hidden || this.state.pending.length) void this.sync() }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', this.sync)
    window.addEventListener('focus', this.sync)
    const timer = window.setInterval(refresh, 30_000)
    void this.sync()
    return () => {
      this.active = false
      document.removeEventListener('visibilitychange', refresh)
      this.channel?.close()
      this.channel = undefined
      window.removeEventListener('online', this.sync)
      window.removeEventListener('focus', this.sync)
      window.clearInterval(timer)
    }
  }
}
