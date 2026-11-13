import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { SearchService } from '../src/server/search-service.js'
import { openCoordinatedStorage } from '../src/server/storage-bootstrap.js'
import { acquireStateLock } from '../src/server/state-lock.js'
import type { Entry } from '../src/server/types.js'

const all = { kind: 'all' as const, id: 'all', title: 'All' }
let directory: string, database: PaperDatabase, service: SearchService
const entry = (n: number): Entry => ({ id: String(n), feedId: 'feed', feedTitle: 'Synthetic', feedUrl: 'https://example.test',
  title: 'The synthetic article', url: `https://example.test/${n}`, author: '', contentHtml: '<p>The searchable body.</p>',
  excerpt: 'The searchable body.', publishedAt: '2026-01-01T00:00:00Z', timestamp: n, read: false, starred: false,
  readingMinutes: 1, thumbnailUrl: '', kind: 'article' })
function sql<T>(operation: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(database.searchDatabasePath)
  try { return operation(db) } finally { db.close() }
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-search-worker-'))
  database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  database.upsertEntries(Array.from({ length: 12 }, (_, i) => entry(i)))
  service = new SearchService(database)
})
afterEach(async () => {
  await service.close(); database.close(); vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('runs the source worker and preserves full ranked snapshots, fresh eligibility and revisions', async () => {
  const options = { query: 'the', unreadOnly: true, limit: 3 }
  const expected = database.localEntriesPage(all, options)
  const persist = database.saveSearchSnapshot.bind(database)
  const save = vi.spyOn(database, 'saveSearchSnapshot').mockImplementation(snapshot => {
    persist(snapshot)
    // This runs after ranking but before final eligibility. WAL reads never
    // compete with the parent's normal writer or hold a transaction across RPC.
    sql(db => db.exec("UPDATE entries SET read=1,state_revision=1 WHERE id='11'; UPDATE entries SET starred=1,state_revision=2 WHERE id='10'"))
  })
  const page = await service.search(all, options)
  expect(expected.items.map(item => item.id)).toEqual(['11', '10', '9'])
  expect(page.items.map(item => item.id)).toEqual(['10', '9', '8'])
  expect(page.items[0]).toMatchObject({ starred: true, stateRevision: 2 })
  const cursor = JSON.parse(Buffer.from(page.continuation, 'base64url').toString())
  expect(sql(db => JSON.parse(String(db.prepare('SELECT ids_json FROM search_pages WHERE id=?').get(cursor.snapshot)?.ids_json)))).toHaveLength(12)
  save.mockImplementation(persist)
  sql(db => db.exec("UPDATE entries SET read=1,state_revision=1 WHERE id='7'"))
  database.upsertEntries([entry(99)])
  const next = await service.search(all, { ...options, continuation: page.continuation })
  expect(next.items.map(item => item.id)).toEqual(['6', '5', '4'])
  expect(next.items.every(item => typeof item.searchExcerpt === 'string')).toBe(true)
  await expect(service.search({ ...all, kind: 'starred' }, { ...options, continuation: page.continuation })).rejects.toThrow(/changed/)
  sql(db => db.prepare('UPDATE search_pages SET created_at=0').run())
  await expect(service.search(all, { ...options, continuation: page.continuation })).rejects.toThrow(/expired/)
})

it('bounds admission, removes cancelled queued jobs and resumes the queue after active cancellation', async () => {
  const active = new AbortController(), queued = new AbortController()
  const first = service.search(all, { query: 'the' }, active.signal).catch(error => error)
  const waiting = Array.from({ length: 8 }, (_, i) => service.search(all, { query: 'the' }, i === 0 ? queued.signal : undefined).catch(error => error))
  await expect(service.search(all, { query: 'the' })).rejects.toThrow(/busy/)
  queued.abort(); active.abort()
  expect(await first).toMatchObject({ message: 'Search cancelled.' })
  const results = await Promise.all(waiting)
  expect(results[0]).toMatchObject({ message: 'Search cancelled.' })
  expect(results.slice(1).every(result => result.items.length === 12)).toBe(true)
  expect((await service.search(all, { query: 'the' })).items).toHaveLength(12)
})

it('refuses old or unfinished schemas without creating backups or changing schema, and recovers after worker failure', async () => {
  const originalSchema = sql(db => db.prepare('PRAGMA schema_version').get()?.schema_version)
  sql(db => db.exec('PRAGMA user_version=10'))
  await expect(service.search(all, { query: 'the' })).rejects.toThrow(/worker/)
  expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(10)
  expect(fs.readdirSync(directory).some(file => file.includes('before-'))).toBe(false)
  sql(db => db.exec('PRAGMA user_version=12'))
  expect((await service.search(all, { query: 'the' })).items).toHaveLength(12)
  expect(sql(db => db.prepare('PRAGMA schema_version').get()?.schema_version)).toBe(originalSchema)
  await service.close()
  sql(db => db.exec("UPDATE sync_state SET value='false' WHERE key='fulltext_search_v1'"))
  expect(() => new PaperDatabase(database.searchDatabasePath, { readOnly: true })).toThrow(/current/)
  expect(() => new PaperDatabase(path.join(directory, 'missing.sqlite'), { readOnly: true })).toThrow()
  expect(fs.existsSync(path.join(directory, 'missing.sqlite'))).toBe(false)
})

it('rejects stale worker RPC after cancellation and close, settling every admitted request before storage release', async () => {
  await service.close()
  const storage = await openCoordinatedStorage(directory)
  service = new SearchService(storage.database)
  const save = vi.spyOn(storage.database, 'saveSearchSnapshot')
  const controller = new AbortController()
  const first = service.search(all, { query: 'the' }, controller.signal).catch(error => error)
  // Capture the actual worker to deliver a previously queued message after cancel.
  const worker = (service as unknown as { worker: Worker }).worker
  controller.abort()
  worker.emit('message', { type: 'snapshot', id: 1 })
  const waiting = service.search(all, { query: 'the' }).catch(error => error)
  const closed = service.close()
  expect(() => acquireStateLock(directory, 'exclusive')).toThrow(/in use/)
  await closed
  storage.close()
  worker.emit('message', { type: 'snapshot', id: 1 })
  expect(save).not.toHaveBeenCalled()
  expect(await first).toBeInstanceOf(Error)
  expect(await waiting).toBeInstanceOf(Error)
  await expect(service.search(all, { query: 'the' })).rejects.toThrow(/shutting down/)
  const exclusive = acquireStateLock(directory, 'exclusive'); exclusive.release()
})

it('keeps the waiting bound when an idle worker fails and does not expose snapshot storage errors', async () => {
  await service.search(all, { query: 'the' })
  const worker = (service as unknown as { worker: Worker }).worker
  worker.emit('error', new Error('Synthetic native failure'))
  const waiting = Array.from({ length: 8 }, () => service.search(all, { query: 'the' }))
  await expect(service.search(all, { query: 'the' })).rejects.toThrow(/busy/)
  expect((await Promise.all(waiting)).every(page => page.items.length === 12)).toBe(true)
  vi.spyOn(database, 'saveSearchSnapshot').mockImplementation(() => { throw new Error('SQLite internal fixture detail') })
  await expect(service.search(all, { query: 'the' })).rejects.toMatchObject({ message: 'Search could not complete. Try again.' })
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(() => { throw new Error('Synthetic worker dispatch internals') })
  await expect(service.search(all, { query: 'the' })).rejects.toMatchObject({ message: 'Search worker could not start. Try again.' })
})

it('limits page transfer without truncating the saved match set', async () => {
  database.upsertEntries(Array.from({ length: 300 }, (_, i) => entry(i)))
  const page = await service.search(all, { query: 'the', limit: 999 })
  expect(page.items).toHaveLength(250)
  const next = await service.search(all, { query: 'the', limit: 999, continuation: page.continuation })
  expect(next.items).toHaveLength(50)
  expect(next.continuation).toBe('')
})
