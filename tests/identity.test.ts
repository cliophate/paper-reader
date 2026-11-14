import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { freshRssIdentity, itemFingerprint, type SourceItemIdentity } from '../src/server/identity.js'
import { LocalStateService } from '../src/server/local-state.js'
import type { Entry } from '../src/server/types.js'

let directory: string
let file: string
let db: PaperDatabase
const backend = { id: 'standalone:fixture', kind: 'standalone' as const }
const all = { kind: 'all' as const, id: 'all', title: 'All' }
const date = '2026-10-01T00:00:00.000Z'
const content: Omit<Entry, 'id' | 'feedId' | 'read' | 'starred' | 'sourceOrder'> = {
  feedTitle: 'Synthetic', feedUrl: 'https://example.test/feed', title: 'An article', author: 'Ada',
  url: 'https://example.test/article', contentHtml: '<p>Original text</p>', excerpt: 'Original text',
  publishedAt: date, timestamp: 1, readingMinutes: 1, thumbnailUrl: '', kind: 'article',
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-identity-'))
  file = path.join(directory, 'paper.sqlite')
  db = new PaperDatabase(file)
})
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
function local() {
  db.bindBackend(backend)
  return db.saveLocalSubscription(backend.id, { title: 'Synthetic', url: 'https://example.test/feed' })
}
function ingest(subscription: string, identity: SourceItemIdentity, changes: Partial<typeof content> = {}) {
  const result = db.importSourceEntries(backend.id, subscription, [{ identity, entry: { ...content, ...changes } }])[0]
  if (result.status !== 'resolved') throw new Error('Expected resolved identity')
  return result.id
}
function reopen() { db.close(); db = new PaperDatabase(file) }
function sql<T>(run: (connection: DatabaseSync) => T): T {
  const connection = new DatabaseSync(file)
  connection.exec('PRAGMA foreign_keys = ON')
  try { return run(connection) } finally { connection.close() }
}

describe('stable article identity', () => {
  it('scopes GUIDs by subscription and backend, without deduplicating by URL', () => {
    const one = local()
    const two = db.saveLocalSubscription(backend.id, { title: 'Also synthetic', url: content.feedUrl })
    const first = ingest(one, { externalId: 'guid' })
    expect(ingest(one, { externalId: 'guid' })).toBe(first)
    const second = ingest(two, { externalId: 'guid' })
    const third = ingest(one, { externalId: 'distinct-guid' })
    expect(new Set([first, second, third]).size).toBe(3)
    const other = { id: 'standalone:other', kind: 'standalone' as const }
    db.identities.registerBackend(other)
    const subscription = db.identities.subscription(other.id, 'same-source')
    const result = db.identities.resolve(other.id, subscription, { externalId: 'guid' })
    expect(result.status === 'resolved' && result.id).not.toBe(first)
    expect(() => sql(c => c.prepare('INSERT INTO article_aliases VALUES (?, ?, ?, ?)').run(other.id, subscription, 'invalid', first))).toThrow()
    expect(() => db.upsertEntries([{ ...content, id: first, feedId: two, read: false, starred: false }])).toThrow(/ownership/)
  })

  it('keeps subscription identity through URL and title changes and restart', () => {
    const feed = local()
    const id = ingest(feed, { externalId: 'guid' })
    expect(db.saveLocalSubscription(backend.id, { id: feed, title: 'Renamed', url: 'https://example.test/new-feed' })).toBe(feed)
    reopen()
    expect(ingest(feed, { externalId: 'guid' })).toBe(id)
    expect(db.localNavigation().uncategorized[0]).toMatchObject({ id: feed, title: 'Renamed', url: 'https://example.test/new-feed' })
  })

  it('uses stable fallback fields and attaches the first GUID without changing the article ID', () => {
    const feed = local()
    const identity = { url: content.url, publishedAt: date }
    const id = ingest(feed, identity)
    expect(ingest(feed, { ...identity, title: 'Revised title' })).toBe(id)
    expect(ingest(feed, { ...identity, externalId: 'new-guid' })).toBe(id)
    expect(ingest(feed, { externalId: 'new-guid', url: 'https://example.test/moved' })).toBe(id)
    expect(itemFingerprint({ url: content.url, title: 'Title' })).toBe(itemFingerprint({ url: content.url, title: 'Title', publishedAt: 'invalid' }))
    expect(itemFingerprint({ title: 'Insufficient' })).toBeNull()
  })

  it('only treats changed GUIDs as aliases with explicit prior identity evidence', () => {
    const feed = local()
    const identity = { url: content.url, publishedAt: date }
    const first = ingest(feed, { ...identity, externalId: 'old' })
    expect(ingest(feed, { externalId: 'replacement', previousExternalIds: ['old'] })).toBe(first)
    const second = ingest(feed, { ...identity, externalId: 'different' })
    expect(second).not.toBe(first)
    const results = db.importSourceEntries(backend.id, feed, [
      { identity: { externalId: 'replacement', previousExternalIds: ['different'] }, entry: { ...content, title: 'Must not overwrite' } },
      { identity, entry: content },
    ])
    for (const result of results) expect(result).toMatchObject({ status: 'ambiguous', candidateIds: [first, second].sort() })
    expect(db.localEntry(first)?.title).toBe(content.title)
    expect(db.entryCount()).toBe(2)
    reopen()
    expect(db.identities.conflicts(backend.id)).toHaveLength(2)
    expect(ingest(feed, { externalId: 'old' })).toBe(first)
  })

  it('rolls back all identity and content writes when an import batch fails', () => {
    const feed = local()
    expect(() => db.importSourceEntries(backend.id, feed, [
      { identity: { externalId: 'first' }, entry: content },
      { identity: {}, entry: content },
    ])).toThrow(/stable identifying/)
    expect(db.entryCount()).toBe(0)
    expect(sql(c => c.prepare('SELECT COUNT(*) AS n FROM article_identities').get()?.n)).toBe(0)
    expect(ingest(feed, { externalId: 'first' })).toMatch(/^paper:article:/)
  })

  it('keeps arrival order independent of IDs, publication dates and repeated imports', () => {
    const feed = local()
    const first = ingest(feed, { externalId: 'z' }, { timestamp: 999 })
    const second = ingest(feed, { externalId: 'a' }, { timestamp: 1 })
    ingest(feed, { externalId: 'z' }, { timestamp: 1000 })
    reopen()
    expect(db.syncEntryIds(all)).toEqual([second, first])
    expect(db.localEntriesPage(all).items.map(item => item.id)).toEqual([first, second])
  })

  it('indexes late extractions through historical URLs without replacing preferred current text', () => {
    const feed = local()
    const id = ingest(feed, { externalId: 'stable' }, { url: `${content.url}#section` })
    const moved = 'https://example.test/moved'
    ingest(feed, { externalId: 'stable' }, { url: moved })
    const cache = (url: string, word: string, fetchedAt: string) => db.cacheArticle({
      url, title: 'Extraction', byline: '', excerpt: '', contentHtml: `<p>${word}</p>`, readingMinutes: 1, fetchedAt,
    })
    const search = (query: string) => db.localEntriesPage(all, { query, unreadOnly: false }).items.map(item => item.id)
    cache(content.url, 'Latehistoricaltext', date)
    expect(db.getArticleForEntry(id)?.contentHtml).toContain('Latehistoricaltext')
    expect(search('Latehistoricaltext')).toEqual([id])
    cache(moved, 'Preferredcurrenttext', date)
    cache(content.url, 'Newerhistoricaltext', '2026-11-01T00:00:00.000Z')
    reopen()
    expect(db.getArticleForEntry(id)?.contentHtml).toContain('Preferredcurrenttext')
    expect(search('Preferredcurrenttext')).toEqual([id])
    expect(search('Newerhistoricaltext')).toEqual([])
    expect(search('Latehistoricaltext')).toEqual([])
  })

  it('preserves state and references when content, GUIDs and URLs change', () => {
    const feed = local()
    const id = ingest(feed, { externalId: 'old' })
    const ids = [id, ingest(feed, { externalId: 'two' }, { url: 'https://example.test/two' }), ingest(feed, { externalId: 'three' }, { url: 'https://example.test/three' })]
    db.commitLocalEntryState(backend.id, [id], 'read')
    db.commitLocalEntryState(backend.id, [id], 'star')
    db.saveReadingProgress(id, 0.42)
    db.recordReadwiseSave(content.url)
    db.cacheArticle({ url: content.url, title: 'Extracted', byline: '', excerpt: '', contentHtml: '<p>Preservedfulltext</p>', readingMinutes: 1, fetchedAt: date })
    db.saveDiscussion({ entryId: id, revision: 1, source: { title: 'Original', author: '', url: content.url, kind: 'feed', paragraphs: [], warning: '' }, messages: [{ id: 'message', role: 'user', text: 'Keep this', status: 'complete' }] })
    db.savePulseBatch([{ id: 'collection', headline: 'A collection', scope: 'Related', entryIds: ids }], ids, date)
    db.createBriefing({ id: 'briefing', kind: 'morning', windowStart: date, cutoff: date, subject: 'Synthetic', html: '', text: '', status: 'generated', tokenHash: 'synthetic', selection: { news: [{ headline: 'Story', summary: '', entryIds: [id] }], worthNoticing: [], social: [] }, createdAt: date, deliveredAt: null, acknowledgedAt: null }, [{ id, section: 'news' }])
    const firstSeen = sql(c => c.prepare('SELECT first_seen_at FROM entries WHERE id = ?').get(id)?.first_seen_at)
    expect(ingest(feed, { externalId: 'new', previousExternalIds: ['old'] }, { url: 'https://example.test/moved', title: 'Updated' })).toBe(id)
    reopen()
    expect(db.localEntry(id)).toMatchObject({ title: 'Updated', read: true, starred: true, readingPosition: 0.42, readwiseSavedAt: expect.any(String) })
    expect(db.entryState(id)?.revision).toBe(2)
    expect(db.discussion(id)?.messages[0].text).toBe('Keep this')
    expect(db.entryIdsForBriefing('briefing')).toEqual([id])
    expect(db.getBriefing('briefing')?.selection.news[0].entryIds).toEqual([id])
    expect(db.pulseCollections()[0].sources.map(source => source.id)).toContain(id)
    expect(db.getArticleForEntry(id)?.contentHtml).toContain('Preservedfulltext')
    expect(db.localEntriesPage(all, { query: 'Preservedfulltext', unreadOnly: false }).items.map(item => item.id)).toContain(id)
    expect(sql(c => c.prepare('SELECT first_seen_at FROM entries WHERE id = ?').get(id)?.first_seen_at)).toBe(firstSeen)
  })
})

describe('local state ownership', () => {
  it('commits before events, survives restart, and makes repeated explicit writes idempotent', () => {
    const id = ingest(local(), { externalId: 'one' })
    const service = new LocalStateService(db, backend.id)
    const listener = vi.fn(() => expect(sql(c => c.prepare('SELECT read FROM entries WHERE id = ?').get(id)?.read)).toBe(1))
    service.onStateChanged(listener)
    expect(service.editEntries([id, id], 'read', { expectedRevisions: { [id]: 0 } })).toMatchObject({ ids: [id], revisions: { [id]: 1 } })
    expect(service.editEntries([id], 'read').ids).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(db.activity().filter(event => event.kind === 'state')).toHaveLength(1)
    reopen()
    expect(db.entryState(id)).toEqual({ read: true, starred: false, revision: 1 })
    db.commitLocalEntryState(backend.id, [id], 'unread', { expectedRevisions: { [id]: 1 } })
    db.commitLocalEntryState(backend.id, [id], 'star')
    db.commitLocalEntryState(backend.id, [id], 'unstar')
    expect(db.entryState(id)).toEqual({ read: false, starred: false, revision: 4 })
  })

  it('rejects stale, unknown and foreign batches before changing any row', () => {
    const feed = local()
    const first = ingest(feed, { externalId: 'one' })
    const second = ingest(feed, { externalId: 'two' })
    db.commitLocalEntryState(backend.id, [second], 'star')
    expect(() => db.commitLocalEntryState(backend.id, [first, second], 'read', { expectedRevisions: { [first]: 0, [second]: 0 } })).toThrow(/Refresh/)
    expect(() => db.commitLocalEntryState(backend.id, [first, 'missing'], 'read')).toThrow(/belong/)
    expect(() => db.commitLocalEntryState('standalone:other', [first], 'read')).toThrow(/active/)
    expect(db.entryState(first)).toEqual({ read: false, starred: false, revision: 0 })
    expect(db.entryState(second)).toEqual({ read: false, starred: true, revision: 1 })
    expect(() => db.reconcileEntryState([], [])).toThrow()
    expect(() => db.editLocalEntryState([first], 'read')).toThrow()
  })

  it('rolls back state and activity on failure and emits no event', () => {
    const id = ingest(local(), { externalId: 'one' })
    const service = new LocalStateService(db, backend.id)
    const listener = vi.fn()
    service.onStateChanged(listener)
    sql(c => c.exec("CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"))
    expect(() => service.editEntries([id], 'read')).toThrow(/synthetic failure/)
    expect(db.entryState(id)?.revision).toBe(0)
    expect(db.entryState(id)?.read).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    sql(c => c.exec('DROP TRIGGER reject_activity'))
    service.editEntries([id], 'read')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('commits undo with state and consumes it only after revision-checked restoration', () => {
    const id = ingest(local(), { externalId: 'undo' })
    const service = new LocalStateService(db, backend.id)
    const events = vi.fn()
    service.onStateChanged(events)
    const undo = { token: 'synthetic-undo', expiresAt: new Date(Date.now() + 60000).toISOString() }
    service.editEntries([id], 'read', { undo })
    expect(db.getUndo(undo.token)).toMatchObject({ backendId: backend.id, expectedRevisions: { [id]: 1 } })
    expect(events).toHaveBeenCalledOnce()
    service.editEntries([id], 'star')
    expect(() => service.undo(undo.token)).toThrow(/state changed/)
    expect(db.getUndo(undo.token)).not.toBeNull()
    expect(db.entryState(id)).toMatchObject({ read: true, starred: true })
    service.editEntries([id], 'unread', { undo: { ...undo, token: 'second' } })
    expect(service.undo('second').ids).toEqual([id])
    expect(db.getUndo('second')).toBeNull()
    expect(() => service.undo('second')).toThrow(/expired/)
    db.createUndo({ ...undo, token: 'legacy', operation: 'unread', entryIds: [id] })
    expect(() => service.undo('legacy')).toThrow(/another backend/)
  })

  it('rolls back state, activity and events when undo persistence fails', () => {
    const id = ingest(local(), { externalId: 'undo-failure' })
    const service = new LocalStateService(db, backend.id), listener = vi.fn()
    service.onStateChanged(listener)
    const undo = { token: 'duplicate', expiresAt: new Date(Date.now() + 60000).toISOString() }
    db.createUndo({ ...undo, operation: 'unread', entryIds: [] })
    expect(() => service.editEntries([id], 'read', { undo })).toThrow()
    expect(db.entryState(id)).toEqual({ read: false, starred: false, revision: 0 })
    expect(db.activity().filter(event => event.kind === 'state')).toHaveLength(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not report a committed write as failed when a listener throws', () => {
    const id = ingest(local(), { externalId: 'one' })
    const service = new LocalStateService(db, backend.id)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    service.onStateChanged(() => { throw new Error('Listener failed') })
    const listener = vi.fn()
    service.onStateChanged(listener)
    expect(() => service.editEntries([id], 'read')).not.toThrow()
    expect(warning).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledOnce()
    expect(db.entryState(id)?.read).toBe(true)
  })
})

describe('FreshRSS identity binding', () => {
  it('keeps credentials out of identity and refuses account changes after restart', () => {
    const source = freshRssIdentity('https://example.test/rss/', 'fixture')
    expect(freshRssIdentity('https://user:synthetic-password@example.test/rss#fragment', 'fixture')).toEqual(source)
    db.bindBackend(source)
    db.setSyncValue('backfill_continuation', 'opaque-cursor')
    reopen()
    expect(db.getSyncValue('backfill_continuation')).toBe('opaque-cursor')
    expect(() => db.bindBackend(freshRssIdentity('https://other.test/rss', 'fixture'))).toThrow(/another backend/)
    expect(() => db.bindBackend(freshRssIdentity('https://example.test/rss', 'someone-else'))).toThrow(/another backend/)
    expect(() => db.bindBackend(backend)).toThrow(/another backend/)
    expect(db.identities.checkpoint(source.id, 'backfill_continuation')).toBe('opaque-cursor')
    db.identities.registerBackend(backend)
    expect(db.identities.checkpoint(backend.id, 'backfill_continuation')).toBe('')
  })

  it('adopts legacy IDs including orphan feeds without changing references or parity order', () => {
    const ids = ['tag:google.com,2005:reader/item/0000000000000002', 'tag:google.com,2005:reader/item/0000000000000001']
    db.upsertEntries(ids.map(id => ({ ...content, id, feedId: 'feed/orphan', read: true, starred: true })))
    db.saveReadingProgress(ids[0], 0.5)
    db.setSyncValue('backfill_complete', 'true')
    const source = freshRssIdentity('https://example.test', 'fixture')
    db.bindBackend(source)
    expect(db.syncEntryIds(all)).toEqual(ids)
    expect(db.localEntry(ids[0])).toMatchObject({ readingPosition: 0.5, read: true, starred: true })
    expect(db.identities.article(ids[0])).toEqual({ backendId: source.id, subscriptionId: 'feed/orphan' })
    expect(db.identities.resolve(source.id, 'feed/orphan', { externalId: ids[0] })).toMatchObject({ status: 'resolved', id: ids[0], created: false })
    expect(db.identities.checkpoint(source.id, 'backfill_complete')).toBe('true')
    reopen()
    db.bindBackend(source)
    expect(db.entryCount()).toBe(2)
    expect(db.syncEntryIds(all)).toEqual(ids)
  })

  it('does not silently adopt existing FreshRSS content as standalone', () => {
    db.upsertEntries([{ ...content, id: 'legacy', feedId: 'feed/legacy', read: false, starred: false }])
    expect(() => db.bindBackend(backend)).toThrow(/requires FreshRSS mode/)
    expect(() => db.identities.backend(backend.id)).toThrow(/Unknown/)
  })
})

// Start with the shared pre-v7 schema and synthetic references, then remove only
// v7 additions. This fixture does not depend on Git or a checked-out old release.
function downgradeFixtureToV6() {
  sql(c => c.exec(`
    DROP TRIGGER entry_arrival;
    DROP TRIGGER entry_url_insert;
    DROP TRIGGER entry_url_update;
    DROP TABLE article_urls;
    DROP TABLE article_arrivals;
    DROP TABLE identity_conflicts;
    DROP TABLE article_fingerprints;
    DROP TABLE article_aliases;
    DROP TABLE article_identities;
    DROP TABLE subscription_aliases;
    DROP TABLE subscription_identities;
    DROP TABLE backend_checkpoints;
    DROP TABLE organization_revisions;
    ALTER TABLE feeds DROP COLUMN position;
    ALTER TABLE feed_folders DROP COLUMN position;
    DROP TABLE reader_backends;
    ALTER TABLE entries DROP COLUMN state_revision;
    ALTER TABLE entries DROP COLUMN source_order;
    PRAGMA user_version = 6;
  `))
}

describe('v7 migration recovery', () => {
  it('backs up a v6 database including WAL data, preserves references, and migrates once', () => {
    const id = 'tag:google.com,2005:reader/item/0000000000000001'
    db.upsertEntries([{ ...content, id, feedId: 'feed/legacy', read: true, starred: true }])
    db.saveReadingProgress(id, 0.6)
    db.saveDiscussion({ entryId: id, revision: 1, source: { title: '', author: '', url: content.url, kind: 'feed', paragraphs: [], warning: '' }, messages: [] })
    db.recordReadwiseSave(content.url)
    downgradeFixtureToV6()
    // Leave the original handle open so migration must account for its WAL.
    const migrated = new PaperDatabase(file)
    migrated.close()
    const backup = `${file}.before-identity-v7`
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    const saved = new DatabaseSync(backup, { readOnly: true })
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(6)
    expect(saved.prepare('SELECT read FROM entries WHERE id = ?').get(id)?.read).toBe(1)
    expect(saved.prepare('SELECT position FROM reading_progress WHERE entry_id = ?').get(id)?.position).toBe(0.6)
    saved.close()
    const before = fs.readFileSync(backup)
    const organizationBackup = `${file}.before-organization-v8`
    expect(fs.statSync(organizationBackup).mode & 0o777).toBe(0o600)
    const savedOrganization = new DatabaseSync(organizationBackup, { readOnly: true })
    expect(savedOrganization.prepare('PRAGMA user_version').get()?.user_version).toBe(6)
    savedOrganization.close()
    const organizationBefore = fs.readFileSync(organizationBackup)
    reopen()
    const source = freshRssIdentity('https://example.test', 'fixture')
    db.bindBackend(source)
    expect(db.localEntry(id)).toMatchObject({ read: true, starred: true, readingPosition: 0.6, readwiseSavedAt: expect.any(String) })
    expect(db.discussion(id)?.entryId).toBe(id)
    expect(db.syncEntryIds(all)).toEqual([id])
    reopen()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(13)
    expect(sql(c => c.prepare('SELECT COUNT(*) AS n FROM article_arrivals').get()?.n)).toBe(1)
    expect(fs.readFileSync(backup)).toEqual(before)
    expect(fs.readFileSync(organizationBackup)).toEqual(organizationBefore)
  })

  it('rolls back interrupted schema migration and can retry against the same backup', () => {
    downgradeFixtureToV6()
    sql(c => c.exec('CREATE VIEW article_arrivals AS SELECT 1 AS broken'))
    expect(() => new PaperDatabase(file)).toThrow()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(6)
    expect(sql(c => c.prepare('PRAGMA table_info(entries)').all().map(row => row.name))).not.toContain('state_revision')
    sql(c => c.exec('DROP VIEW article_arrivals'))
    reopen()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(13)
  })

  it('rolls back interrupted source adoption without leaving aliases or completion markers', () => {
    db.upsertEntries([{ ...content, id: 'legacy', feedId: 'feed/legacy', read: false, starred: false }])
    sql(c => c.exec("CREATE TRIGGER reject_adoption BEFORE INSERT ON article_aliases BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"))
    const source = freshRssIdentity('https://example.test', 'fixture')
    expect(() => db.bindBackend(source)).toThrow(/synthetic failure/)
    expect(db.identities.article('legacy')).toBeNull()
    expect(db.getSyncValue('active_backend_id')).toBe('')
    expect(sql(c => c.prepare('SELECT COUNT(*) AS n FROM subscription_identities').get()?.n)).toBe(0)
    sql(c => c.exec('DROP TRIGGER reject_adoption'))
    reopen()
    db.bindBackend(source)
    expect(db.identities.article('legacy')?.backendId).toBe(source.id)
    expect(db.localEntry('legacy')?.id).toBe('legacy')
  })
})
