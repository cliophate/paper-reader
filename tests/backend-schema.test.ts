import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { openCoordinatedStorage } from '../src/server/storage-bootstrap.js'
import { acquireStateLock } from '../src/server/state-lock.js'
import { minifluxIdentity } from '../src/server/identity.js'
import type { Entry } from '../src/server/types.js'

let directory: string, file: string
const entry: Entry = { id: 'legacy-entry', feedId: 'feed/42', feedTitle: 'Synthetic', feedUrl: 'https://example.test/feed',
  title: 'Preserved article', url: 'https://example.test/article', author: '', contentHtml: '<p>Saved content</p>', excerpt: 'Saved content',
  publishedAt: '2026-01-01T00:00:00Z', timestamp: 1, read: true, starred: true, readingMinutes: 1, thumbnailUrl: '', kind: 'article' }
function sql<T>(run: (db: DatabaseSync) => T, filename = file): T {
  const db = new DatabaseSync(filename)
  try { return run(db) } finally { db.close() }
}
function legacy() {
  sql(db => db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE reader_backends_v13 (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('freshrss', 'standalone')));
    INSERT INTO reader_backends_v13 SELECT * FROM reader_backends;
    DROP TABLE reader_backends;
    ALTER TABLE reader_backends_v13 RENAME TO reader_backends;
    PRAGMA user_version = 13;
    COMMIT;
  `))
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-backend-schema-')); file = path.join(directory, 'paper.sqlite')
  const db = new PaperDatabase(file)
  db.upsertEntries([entry]); db.bindBackend({ id: 'freshrss:synthetic', kind: 'freshrss' })
  db.saveReadingProgress(entry.id, .42); db.setSyncValue('backfill_complete', 'true')
  db.close(); legacy()
})
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })

describe('backend-kind schema upgrade', () => {
  it('backs up committed WAL data, preserves referenced identities and upgrades only under exclusive access', async () => {
    const held = acquireStateLock(directory, 'shared')
    await expect(openCoordinatedStorage(directory, { timeoutMs: 0 })).rejects.toThrow(/in use/)
    held.release()
    const writer = new DatabaseSync(file)
    writer.prepare('UPDATE reading_progress SET position=.77').run()
    const identities = sql(db => db.prepare('SELECT * FROM article_aliases').all())
    const storage = await openCoordinatedStorage(directory)
    const backup = file + '.before-miniflux-v14'
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version, backup)).toBe(13)
    expect(sql(db => db.prepare('SELECT position FROM reading_progress').get()?.position, backup)).toBe(.77)
    expect(sql(db => db.prepare('SELECT * FROM article_aliases').all())).toEqual(identities)
    expect(sql(db => db.prepare('PRAGMA foreign_key_check').all())).toEqual([])
    expect(sql(db => db.prepare('PRAGMA integrity_check').get()?.integrity_check)).toBe('ok')
    expect(storage.database.localEntry(entry.id)).toMatchObject({ id: entry.id, read: true, starred: true, readingPosition: .77 })
    expect(storage.database.getSyncValue('backfill_complete')).toBe('true')
    storage.database.upsertEntries([{ ...entry, id: 'after-upgrade', title: 'Searchafterupgrade' }])
    expect(storage.database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: 'Searchafterupgrade' }).items.map(item => item.id)).toEqual(['after-upgrade'])
    expect(sql(db => db.prepare('SELECT count(*) AS n FROM entries_fts f JOIN entry_search_rows s ON s.id=f.rowid AND s.entry_id=f.entry_id').get()?.n)).toBe(2)
    storage.database.identities.registerBackend(minifluxIdentity('https://miniflux.example.test', 11))
    const schema = sql(db => db.prepare('PRAGMA schema_version').get()?.schema_version)
    const joining = await openCoordinatedStorage(directory)
    expect(sql(db => db.prepare('PRAGMA schema_version').get()?.schema_version)).toBe(schema)
    joining.close(); storage.close(); writer.close()
    const restored = new PaperDatabase(backup)
    expect(restored.localEntry(entry.id)?.readingPosition).toBe(.77)
    restored.close()
  })
  it('rolls back failed table replacement and reuses the original backup on retry', async () => {
    sql(db => db.exec('CREATE VIEW reader_backends_v14 AS SELECT 1 AS incompatible'))
    await expect(openCoordinatedStorage(directory)).rejects.toThrow()
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(13)
    expect(sql(db => db.prepare('SELECT * FROM reader_backends').all())).toEqual([{ id: 'freshrss:synthetic', kind: 'freshrss' }])
    const saved = fs.readFileSync(file + '.before-miniflux-v14')
    sql(db => db.exec('DROP VIEW reader_backends_v14'))
    const storage = await openCoordinatedStorage(directory)
    expect(fs.readFileSync(file + '.before-miniflux-v14')).toEqual(saved)
    expect(sql(db => db.prepare('PRAGMA foreign_key_check').all())).toEqual([])
    storage.close()
  })
  it('rejects Miniflux adoption of legacy or bound accounts and retains local ownership guards', () => {
    const db = new PaperDatabase(file)
    const identity = minifluxIdentity('https://miniflux.example.test', 11)
    expect(() => db.bindBackend(identity)).toThrow(/another backend/)
    db.close()
    const unboundFile = path.join(directory, 'unbound.sqlite'), unbound = new PaperDatabase(unboundFile)
    unbound.upsertEntries([entry])
    expect(() => unbound.bindBackend(identity)).toThrow(/new data directory/)
    unbound.close()
    const native = new PaperDatabase(path.join(directory, 'native.sqlite'))
    native.bindBackend(identity)
    expect(() => native.upsertEntries([entry])).toThrow(/another account/)
    const item = { ...entry, id: `${identity.id}:entry:1`, feedId: `${identity.id}:feed:42` }
    native.upsertEntries([item]); native.saveReadingProgress(item.id, .5)
    native.upsertEntries([{ ...item, read: false, starred: false, title: 'Changed' }])
    expect(native.localEntry(item.id)).toMatchObject({ title: 'Changed', read: true, starred: true, readingPosition: .5 })
    expect(() => native.commitLocalEntryState(identity.id, [item.id], 'read')).toThrow(/standalone/)
    expect(() => native.organization.apply(identity.id, 0, [])).toThrow(/standalone/)
    sql(db => db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON backend_checkpoints WHEN new.key='native_import_before' BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END"), native.searchDatabasePath)
    expect(() => native.saveRemotePage([{ ...item, id: `${identity.id}:entry:2` }], { native_import_before: 'synthetic' })).toThrow(/checkpoint/)
    expect(native.entryCount()).toBe(1)
    native.close()
  })
})
