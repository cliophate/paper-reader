import { DATABASE_VERSION } from '../src/server/auth-schema.js'
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
    sql(db => db.exec("UPDATE entry_state SET read=1,state_revision=1 WHERE entry_id='11'; UPDATE entry_state SET starred=1,state_revision=2 WHERE entry_id='10'"))
  })
  const page = await service.search(all, options)
  expect(expected.items.map(item => item.id)).toEqual(['11', '10', '9'])
  expect(page.items.map(item => item.id)).toEqual(['10', '9', '8'])
  expect(page.items[0]).toMatchObject({ starred: true, stateRevision: 2 })
  const cursor = JSON.parse(Buffer.from(page.continuation, 'base64url').toString())
  expect(sql(db => JSON.parse(String(db.prepare('SELECT ids_json FROM search_pages WHERE id=?').get(cursor.snapshot)?.ids_json)))).toHaveLength(12)
  save.mockImplementation(persist)
  sql(db => db.exec("UPDATE entry_state SET read=1,state_revision=1 WHERE entry_id='7'"))
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
  await expect(service.select(all, {}, { kind: 'preview', withRevisions: true })).rejects.toThrow(/busy/)
  await expect(service.search(all, { query: 'x '.repeat(257) })).rejects.toThrow(/256 search terms/)
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
  sql(db => db.exec(`PRAGMA user_version=${DATABASE_VERSION}`))
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

it('marks below an auto-read anchor using its original snapshot and current candidate eligibility', async () => {
  const options = { query: 'is:unread', unreadOnly: true, limit: 2 }
  const page = await service.search(all, options)
  const anchor = page.items[1]
  expect(anchor.id).toBe('10')
  sql(db => db.exec("UPDATE entry_state SET read=1,state_revision=1 WHERE entry_id IN ('10','8')"))
  database.upsertEntries([{ ...entry(99), timestamp: 5 }])
  const selection = { kind: 'relative', anchorId: anchor.id, direction: 'below', snapshot: anchor.searchSnapshot, withRevisions: true } as const
  const below = await service.select(all, options, selection)
  expect(below.revisions).toEqual(Object.fromEntries(below.ids.map(id => [id, 0])))
  expect(below.ids).toEqual(['9', '7', '6', '5', '4', '3', '2', '1', '0'])
  await expect(service.select(all, { ...options, query: 'is:starred' }, selection)).rejects.toThrow(/expired/)
  const refreshed = { ...selection, displayedIds: ['7', '11', '10', '99'] }
  expect((await service.select(all, options, refreshed)).ids).toEqual(['99', '9', '6', '5', '4', '3', '2', '1', '0'])
  expect((await service.select(all, options, { ...refreshed, direction: 'above' })).ids).toEqual(['7', '11'])
  const preview = await service.select(all, { query: 'url:/9' }, { kind: 'preview', withRevisions: true })
  expect(preview.revisions).toEqual({ '9': 0, '99': 0 })
  expect(preview.ids.sort()).toEqual(['9', '99'])
})

it('pages saved queries in stream order and confines searches and bulk reads to the view', async () => {
  const id = database.savedViews.save({ title: 'Short reads', query: 'title:synthetic maxminutes:1 -is:starred' })
  const view = { kind: 'view' as const, id, title: 'Short reads' }
  database.upsertEntries([{ ...entry(15), readingMinutes: 5 }, { ...entry(16), starred: true }])
  const page = await service.search(view, { limit: 3 })
  expect(page.items.map(item => item.id)).toEqual(['11', '10', '9'])
  const second = await service.search(view, { limit: 3, continuation: page.continuation })
  expect(second.items.map(item => item.id)).toEqual(['8', '7', '6'])
  expect((await service.search(view, { reverse: true, limit: 2 })).items.map(item => item.id)).toEqual(['0', '1'])
  expect((await service.search(view, { query: 'url:"/10" OR url:"/15"' })).items.map(item => item.id)).toEqual(['10'])
  expect((await service.select(view, {}, { kind: 'relative', anchorId: '9', direction: 'above', withRevisions: true })).ids).toEqual(['11', '10'])
  expect((await service.select(view, {}, { kind: 'preview', withRevisions: true })).ids.sort()).toEqual(Array.from({ length: 12 }, (_, i) => String(i)).sort())
  database.editLocalEntryState(['10'], 'star')
  expect(await service.select(view, { unreadOnly: true }, { kind: 'view-count' })).toMatchObject({ count: 11, capped: false })
  database.editLocalEntryState(['9'], 'star')
  expect((await service.select(view, {}, { kind: 'relative', anchorId: '9', direction: 'above', withRevisions: true })).ids).toEqual(['11'])
  database.savedViews.save({ title: 'Long reads', query: 'minminutes:2', revision: 1 }, id)
  await expect(service.search(view, { continuation: page.continuation })).rejects.toThrow(/changed/)
  expect(() => database.savedViews.remove(id, 1)).toThrow(/changed/)
  const other = database.savedViews.save({ title: 'Last week', query: 'after:7d' })
  database.savedViews.move(other, 'up', [id, other].join(','))
  expect(database.savedViews.list().map(view => view.id)).toEqual([other, id])
  database.savedViews.remove(id, 2)
  expect(database.savedViews.list()).toMatchObject([{ id: other, query: 'after:7d' }])
})

it('uses the current read and star state for a saved view', async () => {
  const id = database.savedViews.save({ title: 'Unread', query: 'title:synthetic is:unread' })
  const view = { kind: 'view' as const, id, title: 'Unread' }
  sql(db => db.exec(`
    UPDATE entry_state SET read=1;
    UPDATE entry_state SET read=0, starred=1, state_revision=7 WHERE entry_id='11';
  `))

  expect((await service.savedViewCounts())[id]).toEqual({ count: 1, capped: false })
  const page = await service.search(view, {})
  expect(page.items).toMatchObject([{ id: '11', read: false, starred: true, stateRevision: 7 }])
  expect((await service.search(view, { unreadOnly: true })).items.map(item => item.id)).toEqual(['11'])
  const expected = { ids: ['11'], revisions: { '11': 7 } }
  expect(await service.select(view, {}, { kind: 'preview', withRevisions: true })).toMatchObject(expected)
  expect(await service.select(view, {}, { kind: 'relative', anchorId: '10', direction: 'above', withRevisions: true })).toMatchObject(expected)
})

it('coalesces sidebar counts and gives searches and bulk previews the next worker slot', async () => {
  for (let n = 0; n < 12; n++) database.savedViews.save({ title: 'View ' + n, query: 'synthetic' })
  const dispatch = vi.spyOn(Worker.prototype, 'postMessage')
  const batches = Array.from({ length: 10 }, () => service.savedViewCounts())
  const editor = service.select(all, { query: 'synthetic' }, { kind: 'view-count' })
  const page = service.search({ kind: 'view', id: '1', title: 'View 0' }, {})
  const preview = service.select(all, {}, { kind: 'preview', withRevisions: false })
  expect((await page).items).toHaveLength(12)
  expect((await preview).ids).toHaveLength(12)
  expect((await editor).count).toBe(12)
  const results = await Promise.all(batches)
  expect(results.every(counts => Object.keys(counts).length === 12)).toBe(true)
  const jobs = () => dispatch.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'search')
  expect(jobs().slice(0, 3).map(msg => msg.selection?.kind)).toEqual(['view-count', undefined, 'preview'])
  expect(jobs().filter(msg => msg.stream.kind === 'view' && msg.selection?.kind === 'view-count')).toHaveLength(12)
  await service.savedViewCounts()
  expect(jobs()).toHaveLength(15)
  database.editLocalEntryState(['0'], 'read')
  expect((await service.savedViewCounts())['1'].count).toBe(11)
  sql(db => db.exec("UPDATE entry_state SET read=1 WHERE entry_id='1'"))
  expect((await service.savedViewCounts())['1'].count).toBe(10)
  database.savedViews.save({ title: 'Stars', query: 'is:starred', revision: 1 }, '1')
  expect((await service.savedViewCounts())['1'].count).toBe(0)
})
