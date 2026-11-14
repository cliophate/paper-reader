import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { OrganizationError, type OrganizationCommand } from '../src/server/organization.js'
import type { Entry, NavigationPayload } from '../src/server/types.js'

const backend = { id: 'standalone:organization-fixture', kind: 'standalone' as const }
let directory: string
let file: string
let db: PaperDatabase
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-organization-'))
  file = path.join(directory, 'paper.sqlite')
  db = new PaperDatabase(file)
  db.bindBackend(backend)
})
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
const snapshot = () => db.organization.snapshot(backend.id)
const apply = (...commands: OrganizationCommand[]) => db.organization.apply(backend.id, snapshot().revision, commands)
const feed = (title: string) => db.saveLocalSubscription(backend.id, { title, url: 'https://example.test/feed' })
function folder(title: string) {
  const item = apply({ type: 'create-folder', title }).results[0]
  if (item.status !== 'applied' || !item.id) throw new Error('Expected folder ID')
  return item.id
}
const members = (id: string) => snapshot().navigation.folders.find(folder => folder.id === id)!.feeds.map(feed => feed.id)
function sql<T>(run: (connection: DatabaseSync) => T): T {
  const connection = new DatabaseSync(file)
  connection.exec('PRAGMA foreign_keys = ON')
  try { return run(connection) } finally { connection.close() }
}
function reopen() { db.close(); db = new PaperDatabase(file) }

describe('standalone organization', () => {
  it('persists empty folders and opaque identities through rename, ordering and reopen', () => {
    const a = folder('Writers')
    const b = folder('Empty')
    expect(a).toMatch(/^paper:folder:/)
    const one = feed('Z')
    const two = feed('A')
    apply({ type: 'add-membership', feedId: one, folderId: a }, { type: 'add-membership', feedId: two, folderId: a })
    apply({ type: 'rename-folder', folderId: a, title: 'Essays' }, { type: 'move-folder', folderId: b, beforeId: a })
    apply({ type: 'order-feeds', folderId: a, feedIds: [two, one] }, { type: 'rename-feed', feedId: two, title: 'Duplicate titles are allowed' })
    const revision = snapshot().revision
    reopen()
    expect(snapshot().revision).toBe(revision)
    expect(snapshot().navigation.folders.map(f => [f.id, f.title])).toEqual([[b, 'Empty'], [a, 'Essays']])
    expect(members(a)).toEqual([two, one])
    expect(members(b)).toEqual([])
    expect(snapshot().navigation.folders[1].feeds[0].categories).toEqual(['Essays'])
    apply({ type: 'order-folders', folderIds: [a, b] }, { type: 'rename-feed', feedId: one, title: 'Duplicate titles are allowed' })
    expect(snapshot().navigation.folders.map(f => f.id)).toEqual([a, b])
    expect(new Set(members(a)).size).toBe(2)
  })

  it('rejects normalized name collisions and reserved or empty names without changing the revision', () => {
    const a = folder('Café')
    const b = folder('Other')
    const revision = snapshot().revision
    const result = apply(
      { type: 'create-folder', title: ' CAFE\u0301 ' },
      { type: 'rename-folder', folderId: b, title: 'CAFÉ' },
      { type: 'create-folder', title: 'uncategorized' },
      { type: 'create-folder', title: '  ' },
    )
    expect(result.revision).toBe(revision)
    expect(result.results.map(r => r.status === 'failed' && r.code)).toEqual(['collision', 'collision', 'collision', 'invalid'])
    expect(apply({ type: 'rename-folder', folderId: a, title: ' Café ' }).revision).toBe(revision)
  })

  it('merges with destination order first, source order next, and one membership per pair', () => {
    const source = folder('Source')
    const destination = folder('Destination')
    const other = folder('Other')
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(feed)
    for (const id of [c, b, d]) apply({ type: 'add-membership', feedId: id, folderId: source })
    for (const id of [b, a]) apply({ type: 'add-membership', feedId: id, folderId: destination })
    apply({ type: 'add-membership', feedId: c, folderId: other })
    apply({ type: 'merge-folders', sourceId: source, destinationId: destination })
    expect(members(destination)).toEqual([b, a, c, d])
    expect(members(other)).toEqual([c])
    expect(snapshot().navigation.folders.some(f => f.id === source)).toBe(false)
    expect(apply({ type: 'merge-folders', sourceId: destination, destinationId: destination }).results[0]).toMatchObject({ status: 'failed', code: 'invalid' })
    const revision = snapshot().revision
    apply({ type: 'add-membership', feedId: c, folderId: destination })
    expect(snapshot().revision).toBe(revision)
    reopen()
    expect(members(destination)).toEqual([b, a, c, d])
  })

  it('rolls back a failed merge and all earlier batch successes on storage failure', () => {
    const source = folder('Source')
    const destination = folder('Destination')
    const a = feed('A')
    const b = feed('B')
    apply({ type: 'add-membership', feedId: a, folderId: source }, { type: 'add-membership', feedId: b, folderId: source })
    const before = snapshot()
    sql(c => c.prepare(`CREATE TRIGGER reject_second_merge BEFORE INSERT ON feed_folders
      WHEN NEW.feed_id = '${b}' AND NEW.folder_id = '${destination}'
      BEGIN SELECT RAISE(ABORT, 'synthetic merge failure'); END`).run())
    expect(() => apply({ type: 'rename-folder', folderId: source, title: 'Changed' }, { type: 'merge-folders', sourceId: source, destinationId: destination })).toThrow(/synthetic merge failure/)
    expect(snapshot()).toEqual(before)
    reopen()
    expect(snapshot()).toEqual(before)
  })

  it('keeps memberships outside a move and only shows feeds with no memberships in Uncategorized', () => {
    const a = folder('A')
    const b = folder('B')
    const f = feed('Feed')
    apply({ type: 'move-feed', feedId: f, fromFolderId: null, toFolderId: a }, { type: 'add-membership', feedId: f, folderId: b })
    apply({ type: 'move-feed', feedId: f, fromFolderId: a, toFolderId: null })
    expect(members(a)).toEqual([])
    expect(members(b)).toEqual([f])
    expect(snapshot().navigation.uncategorized).toEqual([])
    apply({ type: 'remove-folder', folderId: b })
    expect(snapshot().navigation.uncategorized.map(f => f.id)).toEqual([f])
    const g = feed('Another')
    apply({ type: 'order-feeds', folderId: null, feedIds: [g, f] })
    reopen()
    expect(snapshot().navigation.uncategorized.map(f => f.id)).toEqual([g, f])
    apply({ type: 'move-feed', feedId: f, fromFolderId: null, toFolderId: a })
    apply({ type: 'remove-membership', feedId: f, folderId: a })
    expect(members(a)).toEqual([])
    expect(snapshot().navigation.uncategorized).toHaveLength(2)
  })

  it('retains article history and subscription identity on folder removal and explicit unsubscribe', () => {
    const f = feed('Feed')
    const a = folder('A')
    apply({ type: 'add-membership', feedId: f, folderId: a })
    const content: Omit<Entry, 'id' | 'feedId' | 'read' | 'starred' | 'sourceOrder'> = {
      title: 'Fixture article', feedTitle: 'Feed', feedUrl: 'https://example.test/feed', url: 'https://example.test/article',
      author: '', contentHtml: '<p>Fixture</p>', excerpt: 'Fixture', publishedAt: '2026-10-01T00:00:00Z',
      timestamp: 1, readingMinutes: 1, thumbnailUrl: '', kind: 'article',
    }
    const organizationRevision = snapshot().revision
    const imported = db.importSourceEntries(backend.id, f, [{ identity: { externalId: 'fixture' }, entry: content }])[0]
    expect(snapshot().revision).toBe(organizationRevision)
    if (imported.status !== 'resolved') throw new Error('Expected article')
    const id = imported.id
    db.commitLocalEntryState(backend.id, [id], 'star')
    db.commitLocalEntryState(backend.id, [id], 'read')
    db.saveReadingProgress(id, 0.7)
    db.saveDiscussion({ entryId: id, revision: 1, source: { title: '', author: '', url: content.url, kind: 'feed', paragraphs: [], warning: '' }, messages: [] })
    db.createUndo({ token: 'fixture-undo', operation: 'read', entryIds: [id], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const date = '2026-10-01T00:00:00Z'
    db.createBriefing({ id: 'fixture-briefing', kind: 'morning', windowStart: date, cutoff: date, subject: 'Fixture', html: '', text: '', status: 'generated', tokenHash: 'synthetic', selection: { news: [{ headline: 'Fixture', summary: '', entryIds: [id] }], worthNoticing: [], social: [] }, createdAt: date, deliveredAt: null, acknowledgedAt: null }, [{ id, section: 'news' }])
    db.recordReadwiseSave(content.url)
    const article = db.localEntry(id)
    const state = db.entryState(id)
    apply({ type: 'remove-folder', folderId: a })
    expect(snapshot().navigation.uncategorized.map(f => f.id)).toEqual([f])
    expect(db.localEntry(id)).toEqual(article)
    apply({ type: 'unsubscribe', feedId: f })
    reopen()
    expect(snapshot().navigation.uncategorized).toEqual([])
    expect(db.localEntry(id)).toEqual(article)
    expect(db.entryState(id)).toEqual(state)
    expect(db.discussion(id)?.entryId).toBe(id)
    expect(db.entryIdsForBriefing('fixture-briefing')).toEqual([id])
    expect(db.getBriefing('fixture-briefing')?.selection.news[0].entryIds).toEqual([id])
    expect(db.identities.article(id)?.subscriptionId).toBe(f)
    expect(sql(c => c.prepare('SELECT entry_ids_json FROM undo_actions WHERE token = ?').get('fixture-undo')?.entry_ids_json)).toBe(JSON.stringify([id]))
  })

  it('checks revisions before bulk writes and returns each expected failure alongside committed successes', () => {
    const f = feed('Feed')
    const a = folder('A')
    const old = snapshot().revision
    const otherDevice = new PaperDatabase(file)
    try {
      otherDevice.organization.apply(backend.id, old, [{ type: 'rename-folder', folderId: a, title: 'Changed elsewhere' }])
      try {
        db.organization.apply(backend.id, old, [{ type: 'unsubscribe', feedId: f }])
        throw new Error('Expected conflict')
      } catch (error) {
        expect(error).toBeInstanceOf(OrganizationError)
        expect(error).toMatchObject({ code: 'conflict', currentRevision: old + 1 })
      }
      expect(snapshot().navigation.uncategorized).toHaveLength(1)
      const result = apply(
        { type: 'move-feed', feedId: f, fromFolderId: null, toFolderId: a },
        { type: 'move-feed', feedId: 'unknown', fromFolderId: null, toFolderId: a },
        { type: 'rename-folder', folderId: a, title: 'Final name' },
      )
      expect(result.results.map(r => [r.index, r.status])).toEqual([[0, 'applied'], [1, 'failed'], [2, 'applied']])
      expect(result.revision).toBe(old + 2)
      expect(members(a)).toEqual([f])
      expect(otherDevice.organization.snapshot(backend.id)).toEqual(snapshot())
    } finally { otherDevice.close() }
  })

  it('does not advance revisions for identical saves, imports, no-ops or failed ordering', () => {
    const f = feed('Feed')
    const a = folder('Empty')
    const revision = snapshot().revision
    db.saveLocalSubscription(backend.id, { id: f, title: 'Feed', url: 'https://example.test/feed' })
    db.importSourceEntries(backend.id, f, [])
    expect(snapshot().revision).toBe(revision)
    const result = apply(
      { type: 'rename-feed', feedId: f, title: 'Feed' },
      { type: 'order-folders', folderIds: [a] },
      { type: 'order-feeds', folderId: null, feedIds: [f] },
      { type: 'move-folder', folderId: a, beforeId: null },
      { type: 'order-folders', folderIds: [a, a] },
      { type: 'order-feeds', folderId: null, feedIds: [] },
    )
    expect(result.revision).toBe(revision)
    expect(result.results.slice(0, 4)).toEqual([0, 1, 2, 3].map(index => ({ index, status: 'applied', changed: false })))
    expect(result.results.slice(4).every(r => r.status === 'failed')).toBe(true)
    db.saveLocalSubscription(backend.id, { id: f, title: 'Renamed', url: 'https://example.test/new' })
    expect(snapshot().revision).toBe(revision + 1)
    expect(() => db.organization.apply(backend.id, revision, [])).toThrow(/Reload/)
    expect(() => db.organization.apply(backend.id, NaN, [])).toThrow(/valid organization revision/)
  })

  it('rejects another backend and prevents organization mutations of FreshRSS snapshots', () => {
    expect(() => db.organization.apply('other', 0, [])).toThrow(/active standalone/)
    db.close()
    file = path.join(directory, 'fresh.sqlite')
    db = new PaperDatabase(file)
    db.bindBackend({ id: 'freshrss:fixture', kind: 'freshrss' })
    expect(db.organizationCapabilities).toMatchObject({ stableFolderIds: false, conditionalWrites: false, orderFolders: false })
    expect(() => db.organization.apply('freshrss:fixture', 0, [{ type: 'create-folder', title: 'Unsupported' }])).toThrow(/active standalone/)
  })
})

describe('v8 migration and FreshRSS snapshots', () => {
  function remoteFixture(): NavigationPayload {
    db.close()
    file = path.join(directory, 'fresh.sqlite')
    db = new PaperDatabase(file)
    db.bindBackend({ id: 'freshrss:fixture', kind: 'freshrss' })
    const f = (id: string, title: string) => ({ id, title, url: 'https://example.test/feed', siteUrl: '', iconUrl: '', unread: 0, categories: ['Writers'], lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false })
    const navigation = { unread: 0, starred: 0, folders: [
      { id: 'remote/writers', title: 'Writers', unread: 0, feeds: [f('feed/2', 'A'), f('feed/1', 'Z')] },
      { id: 'remote/empty', title: 'Empty', unread: 0, feeds: [] },
    ], uncategorized: [] }
    db.replaceNavigation(navigation)
    return navigation
  }
  function downgrade() {
    sql(c => c.exec(`DROP TABLE organization_revisions;
      ALTER TABLE feeds DROP COLUMN position;
      ALTER TABLE feed_folders DROP COLUMN position;
      PRAGMA user_version = 7`))
  }

  it('backs up v7 with WAL data, preserves FreshRSS IDs and ordering, and reopens without another migration', () => {
    const navigation = remoteFixture()
    downgrade()
    const identityBackup = `${file}.before-identity-v7`
    sql(c => c.prepare('VACUUM INTO ?').run(identityBackup))
    const older = new DatabaseSync(identityBackup)
    older.exec('PRAGMA user_version = 6')
    older.close()
    const identityBytes = fs.readFileSync(identityBackup)
    const migrated = new PaperDatabase(file)
    expect(migrated.localNavigation()).toEqual(db.numberNavigation(navigation))
    migrated.close()
    const backup = `${file}.before-organization-v8`
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    const saved = new DatabaseSync(backup, { readOnly: true })
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(7)
    expect(saved.prepare('SELECT COUNT(*) AS n FROM feed_folders').get()?.n).toBe(2)
    saved.close()
    const bytes = fs.readFileSync(backup)
    reopen()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(15)
    expect(db.localNavigation()).toEqual(db.numberNavigation(navigation))
    db.replaceNavigation(navigation)
    expect(db.localNavigation()).toEqual(db.numberNavigation(navigation))
    expect(fs.readFileSync(backup)).toEqual(bytes)
    expect(fs.readFileSync(identityBackup)).toEqual(identityBytes)
  })

  it('rolls back a failed v8 migration and retries with the original backup', () => {
    remoteFixture()
    downgrade()
    sql(c => c.exec('CREATE VIEW organization_revisions AS SELECT 1 AS broken'))
    expect(() => new PaperDatabase(file)).toThrow()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(7)
    expect(sql(c => c.prepare('PRAGMA table_info(feeds)').all().map(r => r.name))).not.toContain('position')
    const backup = fs.readFileSync(`${file}.before-organization-v8`)
    sql(c => c.exec('DROP VIEW organization_revisions'))
    reopen()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(15)
    expect(fs.readFileSync(`${file}.before-organization-v8`)).toEqual(backup)
  })

  it('rejects newer schemas and corrupt pre-upgrade backups', () => {
    remoteFixture()
    sql(c => c.exec('PRAGMA user_version = 16'))
    expect(() => new PaperDatabase(file)).toThrow(/newer Paper/)
    sql(c => c.exec('PRAGMA user_version = 7'))
    fs.writeFileSync(`${file}.before-organization-v8`, 'not a database')
    expect(() => new PaperDatabase(file)).toThrow()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(7)
  })
})
