import { ownerSignedOut } from './offlineAccess'
import { api, ApiError } from './api'
import type { OfflineEdit, OfflineReceipt } from '../shared/offline'
import type { Entry } from './types'

interface Confirmed { version: string; edit: OfflineEdit; receipt: OfflineReceipt }
interface Pending { key: string; version: string; edit: OfflineEdit; writing?: boolean; confirmed?: Confirmed }
const storeName = 'edits'
let locked = false
let generation = 0
export const articleEditsLocked = () => locked || ownerSignedOut()

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (result: T) => void) => void): Promise<T> {
  if (typeof indexedDB === 'undefined') throw new Error('This browser cannot store offline changes.')
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('paper-offline-edits', 1)
    open.onupgradeneeded = () => open.result.createObjectStore(storeName, { keyPath: 'key' })
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(storeName, mode)
      let result: T
      tx.oncomplete = () => { db.close(); resolve(result) }
      tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not store offline changes.')) }
      run(tx.objectStore(storeName), value => { result = value })
    }
  })
}

export function lockArticleEdits(value: boolean) {
  if (locked !== value) generation++
  locked = value
}

export async function clearArticleEdits() {
  if (typeof indexedDB !== 'undefined') await transaction('readwrite', store => { store.clear() })
}

async function pending() {
  if (typeof indexedDB === 'undefined' || articleEditsLocked()) return []
  return transaction<Pending[]>('readonly', (store, done) => {
    const read = store.getAll()
    read.onsuccess = () => done(read.result)
  })
}

function editPatch(edit: OfflineEdit): Partial<Entry> {
  return edit.kind === 'progress' ? { readingPosition: edit.position } : { [edit.field]: edit.to }
}

export async function overlayQueuedEdits(entries: Entry[]) {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  for (const { edit, version, confirmed } of await pending()) {
    const entry = byId.get(edit.id)
    if (entry) Object.assign(entry, confirmed && confirmed.version === version ? confirmed.receipt.current : editPatch(edit))
  }
  return entries
}

function changeRecord<T>(key: string, change: (current: Pending | undefined, store: IDBObjectStore) => T) {
  const started = generation
  return transaction<T>('readwrite', (store, done) => {
    const read = store.get(key)
    read.onsuccess = () => {
      if (articleEditsLocked() || started !== generation) { store.transaction.abort(); return }
      done(change(read.result, store))
    }
  })
}

export async function queueArticleEdit(edit: OfflineEdit) {
  if (articleEditsLocked()) throw new Error('Sign in before changing articles.')
  const key = JSON.stringify([edit.id, edit.kind === 'state' ? edit.field : edit.kind])
  const accepted = await changeRecord(key, (previous, store) => {
    const old = previous?.edit
    if (edit.kind === 'progress' && old?.kind === 'progress' && (edit.base || '') < (old.base || '')) return false
    if (edit.kind === 'state' && old?.kind === 'state') {
      // A write with no receipt may already be visible upstream. An undo of
      // that write starts at its target, even if the writing tab has closed.
      const confirmed = previous?.confirmed
      const from = confirmed && confirmed.version === previous.version ? confirmed.receipt.current[edit.field] : undefined
      edit = { ...edit, from: from ?? (previous?.writing && old.to !== edit.to ? old.to : old.from) }
    }
    store.put({ key, version: crypto.randomUUID(), edit, writing: previous?.writing, confirmed: previous?.confirmed })
    return true
  })
  if (!accepted) throw new Error('Another tab already has a newer change to this article.')
  window.dispatchEvent(new Event('paper-offline-edits'))
}

export interface ArticleSyncEvent { id: string; patch: Partial<Entry>; queued?: Partial<Entry>; notice?: string }

let localLock = Promise.resolve()
export async function withReplayLock<T>(work: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request('paper-offline-replay', work)
  const result = localLock.then(work)
  localLock = result.then(() => {}, () => {})
  return result
}

async function replayState(item: Pending, edit: Extract<OfflineEdit, { kind: 'state' }>): Promise<OfflineReceipt | undefined> {
  const { id, field, from, to } = edit
  for (let attempt = 0; ; attempt++) {
    const live = await api.offlineState(id)
    if (!live) return { outcome: 'removed', current: {} }
    const current = { [field]: live[field], stateRevision: live.stateRevision, modifiedAtMs: live.modifiedAtMs }
    if (live[field] === to) return { outcome: 'done', current }
    if (live[field] !== from) return { outcome: 'superseded', current }

    const claimed = await changeRecord(item.key, (record, store) => {
      if (record?.version !== item.version) return false
      store.put({ ...record, writing: true })
      return true
    })
    if (!claimed) return
    const operation = field === 'read' ? (to ? 'read' : 'unread') : (to ? 'star' : 'unstar')
    try {
      const expectedRevisions = live.stateRevision === undefined ? undefined : { [id]: live.stateRevision }
      const saved = await api.editState([id], operation, 'reader', { expectedRevisions })
      return { outcome: 'saved', current: { [field]: to, stateRevision: saved.revisions[id], modifiedAtMs: saved.modifiedAtMs } }
    } catch (error) {
      if (attempt || !(error instanceof ApiError && error.code === 'state-conflict')) throw error
    }
  }
}

let running: Promise<void> | undefined
export function replayArticleEdits(patchCopy: (id: string, patch: Partial<Entry>) => Promise<void>, apply: (event: ArticleSyncEvent) => void) {
  if (running || articleEditsLocked() || !navigator.onLine) return running
  const started = generation
  const stopped = () => !navigator.onLine || articleEditsLocked() || started !== generation
  running = withReplayLock(async () => {
    for (const item of await pending()) {
      if (stopped()) return
      let confirmed = item.confirmed
      if (!confirmed) {
        const { edit, version } = item
        const receipt = edit.kind === 'state' ? await replayState(item, edit) : await api.reconcileOffline(edit)
        if (stopped()) return
        if (!receipt) continue
        // A newer edit can share this key while the server write is in flight.
        confirmed = await changeRecord(item.key, (current, store) => {
          if (!current || current.confirmed) return current?.confirmed
          const result = { edit, version, receipt }
          store.put({ ...current, confirmed: result })
          return result
        })
        if (!confirmed) continue
      }
      const { edit, version, receipt } = confirmed
      try { await patchCopy(edit.id, receipt.current) }
      catch {
        apply({ id: edit.id, patch: {}, notice: 'The server synced. Paper will retry updating the offline copy.' })
        continue
      }
      if (stopped()) return
      let notice: string | undefined
      if (receipt.outcome === 'removed') notice = 'The server no longer has this article.'
      if (receipt.outcome === 'superseded' && (edit.kind === 'state' || edit.position !== receipt.current.readingPosition)) {
        notice = 'A newer server change replaced your offline ' + (edit.kind === 'progress' ? 'reading position.' : 'article state.')
      }
      const queued = await changeRecord(item.key, (current, store) => {
        if (!current || current.confirmed?.version !== version) return
        if (current.version === version) { store.delete(item.key); return }
        if (edit.kind === 'progress' && current.edit.kind === 'progress' && receipt.outcome === 'saved' && current.edit.base === edit.base) {
          current.edit.base = receipt.current.lastReadAt ?? null
        } else if (edit.kind === 'state' && current.edit.kind === 'state' && current.writing) {
          current.edit.from = receipt.current[edit.field] ?? current.edit.from
          current.writing = false
        }
        delete current.confirmed
        store.put(current)
        return editPatch(current.edit)
      })
      apply({ id: edit.id, patch: receipt.current, queued, notice })
    }
  }).finally(() => { running = undefined })
  return running
}
