import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { openCoordinatedStorage } from '../src/server/storage-bootstrap.js'
import { acquireStateLock } from '../src/server/state-lock.js'
import type { Entry } from '../src/server/types.js'

let directory: string, file: string
const all = { kind: 'all' as const, id: 'all', title: 'All' }
const entry = (id: string): Entry => ({ id, feedId: 'synthetic-feed', feedTitle: 'Synthetic', feedUrl: 'https://example.test',
  title: `Original ${id}`, url: `https://example.test/${id}`, author: 'Synthetic', contentHtml: '<p>Feedneedle</p>',
  excerpt: 'Feedneedle', publishedAt: '2026-01-01T00:00:00Z', timestamp: 1, read: true, starred: true,
  readingMinutes: 1, thumbnailUrl: '', kind: 'article' })
function sql<T>(fn: (db: DatabaseSync) => T, filename = file): T {
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA foreign_keys=ON')
  try { return fn(db) } finally { db.close() }
}
function legacy() {
  sql(db => db.exec(`
    DROP TRIGGER entries_fts_insert; DROP TRIGGER entries_fts_update; DROP TRIGGER entries_fts_delete;
    DROP TABLE entry_search_rows; DROP INDEX entries_search_scope_idx;
    DELETE FROM entries_fts;
    INSERT INTO entries_fts(rowid, entry_id, title, author, feed_title, content_text)
      SELECT 1000-rowid, id, title, author, feed_title, content_text || ' ' || full_content_text FROM entries;
    CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(entry_id,title,author,feed_title,content_text)
      VALUES(new.id,new.title,new.author,new.feed_title,new.content_text || ' ' || new.full_content_text);
    END;
    CREATE TRIGGER entries_fts_update AFTER UPDATE OF title, author, feed_title, content_text, full_content_text ON entries BEGIN
      DELETE FROM entries_fts WHERE entry_id=old.id;
      INSERT INTO entries_fts(entry_id,title,author,feed_title,content_text)
      VALUES(new.id,new.title,new.author,new.feed_title,new.content_text || ' ' || new.full_content_text);
    END;
    CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN DELETE FROM entries_fts WHERE entry_id=old.id; END;
    PRAGMA user_version=10;
  `))
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-search-schema-')); file = path.join(directory, 'paper.sqlite')
  const db = new PaperDatabase(file)
  db.upsertEntries([entry('one'), entry('two')])
  db.saveReadingProgress('one', 0.42)
  db.cacheArticle({ url: entry('one').url, title: 'Cached', byline: '', contentHtml: '<p>Historicalcacheneedle</p>', excerpt: '', readingMinutes: 1, fetchedAt: '2026-01-01T00:00:00Z' })
  db.close(); legacy()
})
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })

describe('indexed FTS row migration', () => {
  it('backs up divergent v10 FTS rows under exclusive bootstrap, preserves source rows and keeps subsequent opens DDL-free', async () => {
    const before = sql(db => db.prepare('SELECT * FROM entries ORDER BY id').all())
    const held = acquireStateLock(directory, 'shared')
    await expect(openCoordinatedStorage(directory, { timeoutMs: 0 })).rejects.toThrow(/in use/)
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(10)
    held.release()
    const writer = new DatabaseSync(file)
    writer.prepare('UPDATE reading_progress SET position=.77').run()
    const storage = await openCoordinatedStorage(directory)
    const backup = file + '.before-search-rows-v11'
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version, backup)).toBe(10)
    expect(sql(db => db.prepare('SELECT position FROM reading_progress').get()?.position, backup)).toBe(.77)
    expect(sql(db => db.prepare('SELECT * FROM entries ORDER BY id').all())).toEqual(before)
    expect(storage.database.localEntriesPage(all, { query: 'Historicalcacheneedle' }).items.map(item => item.id)).toEqual(['one'])
    expect(sql(db => db.prepare('SELECT count(*) n FROM entries_fts f JOIN entry_search_rows s ON s.id=f.rowid AND s.entry_id=f.entry_id').get()?.n)).toBe(2)
    const schema = sql(db => db.prepare('PRAGMA schema_version').get()?.schema_version)
    const joining = await openCoordinatedStorage(directory)
    expect(sql(db => db.prepare('PRAGMA schema_version').get()?.schema_version)).toBe(schema)
    joining.close(); storage.close(); writer.close()
  })

  it('preserves explicit search IDs through VACUUM INTO, changed content, no-op writes and deletion', async () => {
    const storage = await openCoordinatedStorage(directory); storage.close()
    // Force a different implicit entries.rowid so a coincidental match cannot pass.
    sql(db => db.exec('UPDATE entries SET rowid=rowid+500'))
    const mapping = sql(db => db.prepare('SELECT * FROM entry_search_rows ORDER BY id').all())
    const copy = path.join(directory, 'copy.sqlite')
    sql(db => db.prepare('VACUUM INTO ?').run(copy))
    expect(sql(db => db.prepare('SELECT * FROM entry_search_rows ORDER BY id').all(), copy)).toEqual(mapping)
    const db = new PaperDatabase(copy)
    db.upsertEntries([{ ...entry('one'), title: 'Changedneedle' }])
    expect(db.localEntriesPage(all, { query: 'Changedneedle' }).items.map(item => item.id)).toEqual(['one'])
    expect(db.localEntriesPage(all, { query: 'Historicalcacheneedle' }).items.map(item => item.id)).toEqual(['one'])
    expect(db.localEntry('one')).toMatchObject({ read: true, starred: true, readingPosition: .42 })
    sql(connection => {
      const before = connection.prepare('SELECT total_changes() n').get()?.n
      connection.prepare('UPDATE entries SET title=title WHERE id=?').run('one')
      const after = connection.prepare('SELECT total_changes() n').get()?.n
      expect(Number(after) - Number(before)).toBe(1)
      connection.prepare('DELETE FROM entries WHERE id=?').run('two')
      expect(connection.prepare('SELECT count(*) n FROM entry_search_rows').get()?.n).toBe(1)
      expect(connection.prepare('SELECT count(*) n FROM entries_fts').get()?.n).toBe(1)
    }, copy)
    expect(sql(connection => connection.prepare('SELECT * FROM entry_search_rows WHERE entry_id=?').get('one'), copy)).toEqual(mapping.find(row => row.entry_id === 'one'))
    db.close()
  })

  it('rolls back a failed mapping migration and retains the validated backup on retry', async () => {
    sql(db => db.exec('CREATE VIEW entry_search_rows AS SELECT 1 AS incompatible'))
    await expect(openCoordinatedStorage(directory)).rejects.toThrow()
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(10)
    expect(sql(db => db.prepare('SELECT count(*) n FROM entries_fts').get()?.n)).toBe(2)
    const saved = fs.readFileSync(file + '.before-search-rows-v11')
    sql(db => db.exec('DROP VIEW entry_search_rows'))
    const storage = await openCoordinatedStorage(directory)
    expect(fs.readFileSync(file + '.before-search-rows-v11')).toEqual(saved)
    expect(storage.database.localEntriesPage(all, { query: 'Historicalcacheneedle' }).items).toHaveLength(1)
    storage.close()
  })
})
