import { DATABASE_VERSION } from '../src/server/database-version.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import type { Entry, Feed, NavigationPayload } from '../src/server/types.js'

let directory: string, file: string
let db: PaperDatabase
const feed = { id: 'feed/synthetic', title: 'Synthetic', url: 'https://example.test/feed', siteUrl: '', iconUrl: '', categories: [], unread: 1,
  lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false } satisfies Feed
const navigation: NavigationPayload = { unread: 1, starred: 0, uncategorized: [], folders: [{ id: 'label/Synthetic', title: 'Synthetic', unread: 1, feeds: [feed] }] }
const article: Entry = { id: 'synthetic-article', feedId: feed.id, feedTitle: feed.title, feedUrl: feed.url, title: 'Synthetic story', author: '', url: 'https://example.test/story', contentHtml: '<p>Synthetic story</p>', excerpt: '', publishedAt: '2026-01-01T00:00:00Z', timestamp: 1, read: false, starred: false, readingMinutes: 1, thumbnailUrl: '', kind: 'article' }
const sql = <T>(run: (connection: DatabaseSync) => T, target = file): T => {
  const connection = new DatabaseSync(target)
  try { return run(connection) } finally { connection.close() }
}
const downgrade = () => sql(connection => connection.exec(`DROP TRIGGER feeds_link_number; DROP TRIGGER folders_link_number;
  DROP TRIGGER pulse_collections_link_number; DROP TABLE link_numbers; PRAGMA user_version=11;`))
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-link-numbers-'))
  file = path.join(directory, 'paper.sqlite')
  db = new PaperDatabase(file)
  db.replaceNavigation(navigation)
  db.upsertEntries([article, ...['two', 'three'].map(id => ({ ...article, id, url: `https://example.test/${id}` }))])
  db.savePulseBatch([{ id: 'collection-fixture', headline: 'Synthetic collection', scope: 'Synthetic scope', entryIds: [article.id, 'two', 'three'] }], [article.id, 'two', 'three'], '2026-01-01T00:00:00Z')
})
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('reader link numbers', () => {
  it('numbers remote reads without rewriting existing bodies, mute matches or search rows', () => {
    const existing = { ...article, contentHtml: '<p>Body-only mutephrase and searchneedle</p>' }
    db.upsertEntries([existing])
    db.createMuteFilter('mutephrase', 'content')
    sql(connection => connection.prepare('UPDATE entries SET synced_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', article.id))
    const snapshot = () => sql(connection => ({
      entry: connection.prepare('SELECT * FROM entries WHERE id = ?').get(article.id),
      muted: connection.prepare('SELECT rowid, * FROM muted_entries WHERE entry_id = ?').all(article.id),
      search: connection.prepare('SELECT * FROM entry_search_rows WHERE entry_id = ?').all(article.id),
      fts: connection.prepare('SELECT rowid, * FROM entries_fts WHERE entry_id = ?').all(article.id),
      results: connection.prepare("SELECT entry_id FROM entries_fts WHERE entries_fts MATCH 'searchneedle'").all(),
    }))
    const before = snapshot()
    expect(before.muted).toHaveLength(1)
    expect(before.results).toHaveLength(1)
    for (const response of [{ ...existing, contentHtml: '' }, existing]) {
      const numbered = db.numberEntries([response])
      expect(numbered[0]).toEqual({ ...response, linkNumber: db.localEntry(article.id)!.linkNumber })
      expect(snapshot()).toEqual(before)
    }
    const fresh = { ...article, id: 'tag:google.com,2005:reader/item/0000000000000004' }
    const numbered = db.numberEntries([fresh, { ...existing, contentHtml: '' }, fresh])
    expect(numbered[0].linkNumber).toBeGreaterThan(0)
    expect(numbered[2].linkNumber).toBe(numbered[0].linkNumber)
    expect(db.entryByNumber(numbered[0].linkNumber!)?.contentHtml).toBe(fresh.contentHtml)
    expect(snapshot()).toEqual(before)
  })

  it('survives navigation replacement, reimport, restart and restore without recycling numbers', () => {
    const before = db.localNavigation()
    const entry = db.localEntry(article.id)!
    const collection = db.pulseCollections()[0]
    db.replaceNavigation({ ...navigation, folders: [] })
    db.replaceNavigation(navigation)
    db.upsertEntries([{ ...article, title: 'Changed title' }])
    db.close(); db = new PaperDatabase(file)
    expect(db.localNavigation()).toEqual(before)
    expect(db.entryByNumber(entry.linkNumber!)?.id).toBe(article.id)
    expect(db.localEntry(article.id)?.linkNumber).toBe(entry.linkNumber)
    expect(db.pulseCollections()[0].linkNumber).toBe(collection.linkNumber)
    db.replaceNavigation({ ...navigation, folders: [{ ...navigation.folders[0], id: 'label/Renamed' }] })
    expect(db.localNavigation().folders[0].linkNumber).not.toBe(before.folders[0].linkNumber)
    expect(db.linkNumber('folder', navigation.folders[0].id)).toBe(before.folders[0].linkNumber)
    const restored = path.join(directory, 'restored.sqlite')
    sql(connection => connection.prepare('VACUUM INTO ?').run(restored))
    const copy = new PaperDatabase(restored)
    expect(copy.entryByNumber(entry.linkNumber!)?.id).toBe(article.id)
    expect(copy.localNavigation()).toEqual(db.localNavigation())
    copy.close()
    expect(db.entryByNumber(99999)).toBeNull()
  })

  it('preserves standalone feed and folder numbers across renames and removals', () => {
    const local = new PaperDatabase(path.join(directory, 'local.sqlite'))
    const backend = { kind: 'standalone' as const, id: 'standalone:fixture' }
    local.bindBackend(backend)
    const id = local.saveLocalSubscription(backend.id, { title: 'Original', url: feed.url })
    let snapshot = local.organization.snapshot(backend.id)
    local.organization.apply(backend.id, snapshot.revision, [{ type: 'create-folder', title: 'Original' }])
    snapshot = local.organization.snapshot(backend.id)
    const folder = snapshot.navigation.folders[0]
    const feedNumber = snapshot.navigation.uncategorized[0].linkNumber
    local.organization.apply(backend.id, snapshot.revision, [{ type: 'rename-folder', folderId: folder.id, title: 'Renamed' }, { type: 'rename-feed', feedId: id, title: 'Renamed' }])
    snapshot = local.organization.snapshot(backend.id)
    expect(snapshot.navigation.folders[0].linkNumber).toBe(folder.linkNumber)
    expect(snapshot.navigation.uncategorized[0].linkNumber).toBe(feedNumber)
    local.organization.apply(backend.id, snapshot.revision, [{ type: 'remove-folder', folderId: folder.id }])
    expect(local.linkNumber('folder', folder.id)).toBe(folder.linkNumber)
    local.close()
  })

  it('backfills v11 atomically and backs up committed WAL data for rollback', () => {
    const arrival = db.localEntry(article.id)!.linkNumber
    db.close(); downgrade()
    const before = sql(connection => connection.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all())
    const writer = new DatabaseSync(file)
    writer.exec("PRAGMA journal_mode=WAL; UPDATE feeds SET title='Committed WAL title'")
    db = new PaperDatabase(file)
    const backup = `${file}.before-link-numbers-v12`
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    expect(sql(connection => connection.prepare('PRAGMA user_version').get()?.user_version)).toBe(DATABASE_VERSION)
    expect(sql(connection => connection.prepare('SELECT kind FROM link_numbers ORDER BY number').all()).map(row => row.kind)).toEqual(['feed', 'folder', 'collection'])
    expect(sql(connection => connection.prepare('PRAGMA user_version').get()?.user_version, backup)).toBe(11)
    expect(sql(connection => connection.prepare('SELECT title FROM feeds').get()?.title, backup)).toBe('Committed WAL title')
    expect(db.localEntry(article.id)!.linkNumber).toBe(arrival)
    const after = sql(connection => connection.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'link_numbers' AND name NOT LIKE '%_link_number' ORDER BY name").all())
    expect(after).toEqual(before)
    const restored = path.join(directory, 'rollback.sqlite')
    fs.copyFileSync(backup, restored)
    expect(sql(connection => connection.prepare('PRAGMA integrity_check').get()?.integrity_check, restored)).toBe('ok')
    expect(sql(connection => connection.prepare('SELECT id FROM entries WHERE id = ?').get(article.id)?.id, restored)).toBe(article.id)
    writer.close()
  })

  it('rolls back failed backfill and reuses the verified backup on retry', () => {
    db.close(); downgrade()
    sql(connection => connection.exec(`CREATE TABLE link_numbers(number INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, target_id TEXT, UNIQUE(kind, target_id));
      CREATE TRIGGER fail_backfill BEFORE INSERT ON link_numbers WHEN new.kind='folder' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`))
    expect(() => new PaperDatabase(file)).toThrow('synthetic failure')
    expect(sql(connection => connection.prepare('PRAGMA user_version').get()?.user_version)).toBe(11)
    expect(sql(connection => connection.prepare('SELECT count(*) n FROM link_numbers').get()?.n)).toBe(0)
    const saved = fs.readFileSync(`${file}.before-link-numbers-v12`)
    sql(connection => connection.exec('DROP TRIGGER fail_backfill'))
    db = new PaperDatabase(file)
    expect(fs.readFileSync(`${file}.before-link-numbers-v12`)).toEqual(saved)
    expect(db.localNavigation().folders[0].linkNumber).toBeGreaterThan(0)
  })
})
