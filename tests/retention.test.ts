import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { LocalStateService } from '../src/server/local-state'
import { RetentionService } from '../src/server/retention'
import { autoReadDays, DAY, defaultPolicy, RETENTION_BATCH, validatePolicy } from '../src/server/retention-store'
import { ingestFeed } from '../src/server/feed-ingestion'
import { freshRssIdentity, type BackendIdentity } from '../src/server/identity'
import type { RetentionPolicy } from '../src/shared/retention'

let directory: string, file: string, db: PaperDatabase, sql: DatabaseSync, backend: BackendIdentity, feed: string, service: RetentionService
const now = Date.now()
const policy = (changes: Partial<RetentionPolicy> = {}): RetentionPolicy => ({ ...defaultPolicy(), ...changes })
function ingest(ids: string[], fetchedAt = now) {
  return ingestFeed(db, { backendId: backend.id, subscriptionId: feed, endpointGeneration: 'fixture',
    requestUrl: 'https://example.test/rss', responseUrl: 'https://example.test/rss', fetchedAt: new Date(fetchedAt).toISOString(),
    xml: `<rss version="2.0"><channel><title>Fixture</title>${ids.map(id => `<item><guid>${id}</guid><title>Retention ${id}</title><link>https://example.test/${id}</link><pubDate>2000-01-01T00:00:00Z</pubDate><description>retentionneedle</description></item>`).join('')}</channel></rss>` })
}
function seed(count: number) {
  const results = ingest(Array.from({ length: count }, (_, i) => `item-${i}`)).results
  const ids = results.map(result => { if (result.status !== 'resolved') throw Error('fixture'); return result.id })
  ingest([])
  sql.prepare('UPDATE entries SET first_seen_at = ?').run(now - 200 * DAY)
  return ids
}
async function save(p: RetentionPolicy) {
  const preview = await service.preview(p)
  service.save(p, db.retention.settings().revision, preview.token)
  await service.drain()
  expect(service.error).toBe('')
  return preview
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-retention-'))
  file = path.join(directory, 'paper.sqlite'); db = new PaperDatabase(file); backend = db.bindStandalone()
  feed = db.saveLocalSubscription(backend.id, { url: 'https://example.test/rss', title: 'Fixture' })
  sql = new DatabaseSync(file); sql.exec('PRAGMA foreign_keys = ON')
  service = new RetentionService(db, backend)
})
afterEach(async () => { await service.stop(); sql.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

it('defaults every limit off and validates days and FreshRSS restrictions', () => {
  expect(db.retention.settings()).toEqual({ policy: defaultPolicy(), revision: 0 })
  for (const readDays of [0, -1, 2.5, 36501, '10', undefined]) expect(() => validatePolicy({ ...policy(), readDays }, true)).toThrow()
  expect(() => validatePolicy(policy({ autoReadDays: 5 }), false)).toThrow(/FreshRSS/)
  expect(validatePolicy(policy({ cacheDays: 30 }), false).cacheDays).toBe(30)
})

it('resolves global, folder, feed and never overrides', () => {
  const p = policy({ autoReadDays: 30, folderDays: { folder: 15, never: null }, feedDays: { feed: 5, never: null } })
  expect(autoReadDays(p, 'other', null)).toBe(30)
  expect(autoReadDays(p, 'other', 'folder')).toBe(15)
  expect(autoReadDays(p, 'feed', 'folder')).toBe(5)
  expect(autoReadDays(p, 'never', 'folder')).toBeNull()
  expect(autoReadDays(p, 'other', 'never')).toBeNull()
})

it('uses first-stored age, keeps latest-feed items and protects feeds without a known snapshot', async () => {
  const ids = seed(4)
  sql.prepare('UPDATE entries SET first_seen_at = ? WHERE id = ?').run(now, ids[0])
  sql.prepare('UPDATE entries SET first_seen_at = 0 WHERE id = ?').run(ids[1])
  ingest(['item-2'])
  expect(await service.preview(policy({ unreadDays: 1 }))).toMatchObject({ deleted: 1 })
  sql.exec('DELETE FROM retention_feeds')
  expect(await service.preview(policy({ unreadDays: 1 }))).toMatchObject({ deleted: 0 })
})

it('protects every saved category but removes derived metadata with the article', async () => {
  const ids = seed(10)
  sql.prepare('UPDATE entries SET starred = 1 WHERE id = ?').run(ids[0])
  sql.prepare('INSERT INTO discussions VALUES (?, ?)').run(ids[1], '{}')
  sql.exec("INSERT INTO pulse_collections VALUES ('pulse', 'Saved', 'all', '2026-01-01')")
  sql.prepare("INSERT INTO pulse_memberships(collection_id, entry_id, added_at) VALUES ('pulse', ?, '2026-01-01')").run(ids[2])
  sql.prepare('INSERT INTO reading_progress VALUES (?, 0.5, ?)').run(ids[3], new Date(now).toISOString())
  sql.exec("INSERT INTO briefings VALUES ('brief', 'morning', '', '', '', '', '', 'saved', '', '{}', '', NULL, NULL)")
  sql.prepare("INSERT INTO briefing_entries VALUES ('brief', ?, 'section')").run(ids[4])
  sql.prepare("INSERT INTO article_reports VALUES ('report', ?, 'issue', 'note', '{}', 'open', '', NULL)").run(ids[5])
  sql.prepare('INSERT INTO reading_progress VALUES (?, 0.5, ?)').run(ids[6], new Date(now - 31 * DAY).toISOString())
  sql.exec("INSERT INTO mute_filters VALUES ('mute', 'retentionneedle', 'all', '', '')")
  sql.prepare("INSERT INTO muted_entries VALUES ('mute', ?)").run(ids[7])
  sql.prepare('INSERT INTO pulse_scanned VALUES (?, ?)').run(ids[7], '')
  sql.prepare('INSERT INTO briefing_considered VALUES (?, ?)').run(ids[7], 1)
  sql.exec("INSERT INTO coverage_clusters VALUES ('coverage', 'article', '', '', '', '', '', '')")
  sql.prepare("INSERT INTO coverage_cluster_entries VALUES ('coverage', ?, 0)").run(ids[7])
  const preview = await save(policy({ unreadDays: 180 }))
  expect(preview.deleted).toBe(3)
  expect(db.retention.lastRun()).toMatchObject({ marked: 0, deleted: 3 })
  for (const id of ids.slice(0, 7)) expect(db.entryState(id)).not.toBeNull()
  for (const id of ids.slice(7)) expect(db.entryState(id)).toBeNull()
  for (const table of ['muted_entries', 'pulse_scanned', 'briefing_considered', 'coverage_cluster_entries']) expect(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n).toBe(0)
  expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('matches preview and actual counts after auto-read and keeps FTS and revisions consistent', async () => {
  const ids = seed(205)
  const preview = await save(policy({ autoReadDays: 30, readDays: 60 }))
  expect(preview).toMatchObject({ marked: 205, deleted: 205 })
  expect(db.retention.lastRun()).toMatchObject({ marked: 205, deleted: 205, batches: 3 })
  for (const table of ['entries', 'entries_fts', 'entry_search_rows', 'article_arrivals', 'article_urls']) expect(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n).toBe(0)
  expect(sql.prepare("SELECT COUNT(*) n FROM entries_fts WHERE entries_fts MATCH 'retentionneedle'").get()?.n).toBe(0)
  expect(sql.prepare('SELECT COUNT(*) n FROM retention_tombstones').get()?.n).toBe(205)
  const backup = file + '.before-retention-first-delete'
  expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
  const saved = new DatabaseSync(backup, { readOnly: true })
  expect(saved.prepare('SELECT COUNT(*) n FROM entries').get()?.n).toBe(205)
  expect(saved.prepare('SELECT read FROM entries WHERE id = ?').get(ids[0])?.read).toBe(0)
  saved.close()
  expect(db.activity().some(event => event.kind === 'retention' && event.count === 205)).toBe(true)
})

it('auto-read increments revisions once without requiring a deletion backup', async () => {
  const [id] = seed(1)
  await save(policy({ autoReadDays: 1 }))
  expect(db.entryState(id)).toEqual({ read: true, starred: false, revision: 1 })
  expect(fs.existsSync(file + '.before-retention-first-delete')).toBe(false)
  service.wake(true); await service.drain()
  expect(db.entryState(id)?.revision).toBe(1)
})

it('suppresses reimports with aliases, verified previous aliases and fingerprints until confirmed absence expires', async () => {
  seed(1); await save(policy({ unreadDays: 1 }))
  expect(ingest(['item-0']).results[0].status).toBe('tombstoned')
  // A distinct explicit ID must not be suppressed solely by a matching fingerprint.
  const identity = { externalId: 'changed', previousExternalIds: ['item-0'], url: 'https://example.test/item-0', title: 'Retention item-0', publishedAt: '2000-01-01' }
  expect(db.identities.resolve(backend.id, feed, identity).status).toBe('tombstoned')
  expect(db.identities.resolve(backend.id, feed, { ...identity, externalId: undefined, previousExternalIds: undefined }).status).toBe('tombstoned')
  expect(db.identities.resolve(backend.id, feed, { ...identity, externalId: 'distinct', previousExternalIds: undefined }).status).toBe('resolved')
  ingest([], now + DAY)
  db.retention.expireTombstones('', now + 60 * DAY)
  expect(sql.prepare('SELECT COUNT(*) n FROM retention_tombstones').get()?.n).toBe(1)
  ingest([], now + 32 * DAY)
  db.retention.expireTombstones('', now + 32 * DAY)
  expect(sql.prepare('SELECT COUNT(*) n FROM retention_tombstones').get()?.n).toBe(0)
  expect(ingest(['item-0'], now + 33 * DAY).results[0].status).toBe('resolved')
})

it('dates tombstones by deletion time when an old unfinished run resumes', () => {
  seed(1)
  const run = db.retention.start(policy({ unreadDays: 1 }))
  sql.prepare('UPDATE retention_runs SET started_at = ? WHERE id = ?').run(now - 40 * DAY, run.id)
  expect(db.retention.batch(run, true).done).toBe(true)
  ingest([], Date.now())
  db.retention.expireTombstones('', Date.now())
  expect(sql.prepare('SELECT COUNT(*) n FROM retention_tombstones').get()?.n).toBe(1)
  expect(ingest(['item-0']).results[0].status).toBe('tombstoned')
})

it('resumes an interrupted cursor after reopening without repeating committed work', async () => {
  seed(250)
  const p = policy({ autoReadDays: 1 })
  db.retention.save(p, 0)
  const run = db.retention.start(p)
  expect(db.retention.batch(run, false)).toEqual({ done: false, needsBackup: false, changed: true })
  expect(db.retention.lastRun()).toMatchObject({ marked: RETENTION_BATCH, batches: 1 })
  db.close(); db = new PaperDatabase(file); service = new RetentionService(db, backend)
  service.wake(); await service.drain()
  expect(db.retention.lastRun()).toMatchObject({ marked: 250, batches: 3 })
  expect(sql.prepare('SELECT MAX(state_revision) n FROM entries').get()?.n).toBe(1)
})

it('rolls back a failed deletion batch including tombstones and its cursor', () => {
  seed(2)
  const run = db.retention.start(policy({ unreadDays: 1 }))
  sql.exec("CREATE TRIGGER fail_retention BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'fixture'); END")
  expect(() => db.retention.batch(run, true)).toThrow(/fixture/)
  expect(db.retention.lastRun()).toMatchObject({ cursor: 0, deleted: 0 })
  expect(sql.prepare('SELECT COUNT(*) n FROM retention_tombstones').get()?.n).toBe(0)
  sql.exec('DROP TRIGGER fail_retention')
  expect(db.retention.batch(run, true).done).toBe(true)
  expect(db.retention.lastRun()?.deleted).toBe(2)
})

it('requires a matching preview, rejects stale settings and rechecks newly protected articles', async () => {
  const [id] = seed(1), p = policy({ unreadDays: 1 })
  expect(() => service.save(p, 0)).toThrow(/Preview/)
  const preview = await service.preview(p)
  expect(() => service.save(policy({ unreadDays: 2 }), 0, preview.token)).toThrow(/Preview/)
  sql.prepare('UPDATE entries SET starred = 1 WHERE id = ?').run(id)
  service.save(p, 0, preview.token); await service.drain()
  expect(db.retention.lastRun()?.deleted).toBe(0)
  expect(() => service.save(defaultPolicy(), 0)).toThrow(/changed/)
})

it('fails closed on an invalid first-deletion backup', async () => {
  seed(1)
  fs.writeFileSync(file + '.before-retention-first-delete', 'invalid synthetic backup')
  const p = policy({ unreadDays: 1 }), preview = await service.preview(p)
  service.save(p, 0, preview.token); await service.drain()
  expect(service.error).toMatch(/could not finish/)
  expect(db.retention.active()).toBeNull()
  expect(sql.prepare('SELECT COUNT(*) n FROM entries').get()?.n).toBe(1)
})

it('cleans only the full-text cache in FreshRSS mode on its separate schedule', async () => {
  await service.stop(); sql.close(); db.close()
  file = path.join(directory, 'remote.sqlite'); db = new PaperDatabase(file)
  backend = freshRssIdentity('https://freshrss.example.test', 'synthetic'); db.bindBackend(backend)
  sql = new DatabaseSync(file); service = new RetentionService(db, backend)
  db.cacheArticle({ url: 'https://example.test/old', title: '', byline: '', excerpt: '', contentHtml: '<p>Cached text</p>', readingMinutes: 1, fetchedAt: new Date(now - 40 * DAY).toISOString() })
  db.cacheArticle({ url: 'https://example.test/new', title: '', byline: '', excerpt: '', contentHtml: '', readingMinutes: 1, fetchedAt: new Date(now).toISOString() })
  await save(policy({ cacheDays: 30 }))
  expect(db.getArticle('https://example.test/old')).toBeNull()
  expect(db.getArticle('https://example.test/new')).not.toBeNull()
  expect(service.view()).toMatchObject({ backend: 'freshrss', lastRun: null, feeds: [], cacheRun: { deleted: 1 } })
  expect(fs.existsSync(file + '.before-retention-first-delete')).toBe(false)
  service.wake(); await service.drain()
  expect(service.view().cacheRun?.deleted).toBe(1)
})

describe('schema v14', () => {
  it('backs up v13, preserves data and can reopen without DDL', async () => {
    seed(1); await service.stop(); db.close()
    for (const table of ['retention_auto_read', 'retention_removals', 'retention_settings', 'retention_runs', 'retention_feeds', 'retention_present', 'retention_tombstones', 'retention_briefing_entries']) sql.exec(`DROP TABLE ${table}`)
    for (const index of ['article_aliases_entry_idx', 'article_fingerprints_entry_idx', 'article_cache_age_idx', 'article_reports_entry_idx']) sql.exec(`DROP INDEX ${index}`)
    sql.exec('PRAGMA user_version = 13')
    db = new PaperDatabase(file); service = new RetentionService(db, backend)
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(14)
    const saved = new DatabaseSync(file + '.before-retention-v14', { readOnly: true })
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(13)
    expect(saved.prepare('SELECT COUNT(*) n FROM entries').get()?.n).toBe(1); saved.close()
    expect(fs.statSync(file + '.before-retention-v14').mode & 0o777).toBe(0o600)
    db.close(); db = new PaperDatabase(file); service = new RetentionService(db, backend)
    expect(db.retention.settings().policy).toEqual(defaultPolicy())
  })
})

it('protects serialized briefing background and image references', async () => {
  const ids = seed(3)
  db.createBriefing({ id: 'references', kind: 'morning', windowStart: '', cutoff: '', subject: '', html: '', text: '', status: 'saved', tokenHash: '',
    selection: { news: [{ entryIds: [ids[0]], backgroundEntryIds: [ids[1]], imageEntryId: ids[2] }], worthNoticing: [], social: [] } as never,
    createdAt: '', deliveredAt: null, acknowledgedAt: null }, [{ id: ids[0], section: 'news' }])
  expect(await service.preview(policy({ unreadDays: 1 }))).toMatchObject({ deleted: 0 })
  sql.prepare('DELETE FROM briefings WHERE id = ?').run('references')
  expect(await service.preview(policy({ unreadDays: 1 }))).toMatchObject({ deleted: 3 })
})

it('protects the latest 100 history rows even when old and expires older progress', async () => {
  const ids = seed(102)
  ids.forEach((id, index) => sql.prepare('INSERT INTO reading_progress VALUES (?, 0.5, ?)').run(id, new Date(now - (200 - index) * DAY).toISOString()))
  expect(await service.preview(policy({ unreadDays: 1 }))).toMatchObject({ deleted: 2 })
})

it('preserves latest-feed membership on a failed ingestion transaction', async () => {
  seed(1); ingest(['item-0'])
  sql.exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON backend_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture'); END")
  expect(() => ingest([])).toThrow(/fixture/)
  expect(await service.preview(policy({ unreadDays: 1 }))).toMatchObject({ deleted: 0 })
})

it('can disable a failed unfinished policy and records its partial counts', async () => {
  seed(1)
  fs.writeFileSync(file + '.before-retention-first-delete', 'invalid synthetic backup')
  const p = policy({ unreadDays: 1 }), preview = await service.preview(p)
  service.save(p, 0, preview.token); await service.drain()
  expect(service.error).not.toBe('')
  db.retention.start(p)
  service.save(defaultPolicy(), 1); await service.drain()
  expect(db.retention.active()).toBeNull()
  expect(service.error).toBe('')
  expect(db.activity().some(event => event.summary.includes('Stopped an unfinished cleanup'))).toBe(true)
})

it('resumes deletion after a committed batch without overwriting the original backup', async () => {
  seed(205)
  const p = policy({ unreadDays: 1 })
  // First create the real backup through the service, then interrupt at a batch boundary.
  const original = db.retention.batch.bind(db.retention)
  let interrupted = false
  db.retention.batch = (run, ready) => {
    const result = original(run, ready)
    if (ready && !interrupted) { interrupted = true; throw Error('synthetic interruption after commit') }
    return result
  }
  const preview = await service.preview(p)
  service.save(p, 0, preview.token); await service.drain()
  expect(db.retention.active()?.deleted).toBe(100)
  const bytes = fs.readFileSync(file + '.before-retention-first-delete')
  await service.stop(); db.close(); db = new PaperDatabase(file); service = new RetentionService(db, backend)
  service.wake(); await service.drain()
  expect(service.error).toBe('')
  expect(db.retention.lastRun()).toMatchObject({ deleted: 205, batches: 3 })
  expect(fs.readFileSync(file + '.before-retention-first-delete')).toEqual(bytes)
})

it('runs a policy saved just before a restart even when the previous run was today', async () => {
  seed(1); await save(policy({ autoReadDays: 1 }))
  const p = policy({ autoReadDays: 2 })
  db.retention.save(p, 1); db.setSyncValue('retention_pending', 'true')
  const previous = db.retention.lastRun()!.id
  await service.stop(); db.close(); db = new PaperDatabase(file); service = new RetentionService(db, backend)
  service.wake(); await service.drain()
  expect(db.retention.lastRun()!.id).toBe(previous + 1)
  expect(db.getSyncValue('retention_pending')).toBe('false')
})

it('rolls back a failed migration and retains the same backup on retry', async () => {
  seed(1); await service.stop(); db.close()
  for (const table of ['retention_auto_read', 'retention_removals', 'retention_settings', 'retention_runs', 'retention_feeds', 'retention_present', 'retention_tombstones', 'retention_briefing_entries']) sql.exec(`DROP TABLE ${table}`)
  sql.exec('PRAGMA user_version = 13')
  const original = DatabaseSync.prototype.exec
  const failure = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, statement: string) {
    original.call(this, statement)
    if (statement.includes('CREATE TABLE IF NOT EXISTS retention_settings')) throw Error('synthetic migration failure')
  })
  try { expect(() => new PaperDatabase(file)).toThrow(/synthetic migration failure/) } finally { failure.mockRestore() }
  expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(13)
  expect(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'retention_settings'").get()).toBeUndefined()
  const saved = fs.readFileSync(file + '.before-retention-v14')
  db = new PaperDatabase(file); service = new RetentionService(db, backend)
  expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(14)
  expect(fs.readFileSync(file + '.before-retention-v14')).toEqual(saved)
})

it('keeps the article foreign-key inventory explicit for future schema changes', () => {
  const references = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap(row => {
    const table = String(row.name)
    return sql.prepare(`PRAGMA foreign_key_list("${table.replaceAll('"', '""')}")`).all().some(key => key.table === 'entries') ? [table] : []
  }).sort()
  expect(references).toEqual(['article_arrivals', 'article_urls', 'briefing_considered', 'coverage_cluster_entries', 'entry_search_rows',
    'headline_cache', 'muted_entries', 'pulse_memberships', 'pulse_scanned', 'reading_progress', 'retention_auto_read'].sort())
})

it('backs up before earlier marking batches when deletion first occurs in a later batch', async () => {
  const ids = seed(205)
  for (const id of ids.slice(0, 100)) sql.prepare('UPDATE entries SET starred = 1 WHERE id = ?').run(id)
  await save(policy({ autoReadDays: 1, readDays: 1 }))
  expect(db.retention.lastRun()).toMatchObject({ marked: 205, deleted: 105 })
  const saved = new DatabaseSync(file + '.before-retention-first-delete', { readOnly: true })
  try { expect(saved.prepare('SELECT COUNT(*) n FROM entries WHERE read = 1').get()?.n).toBe(0) } finally { saved.close() }
})


it('keeps explicit unread choices after auto-read, including bulk and undo, across restart', async () => {
  const ids = seed(3)
  const state = new LocalStateService(db, backend.id)
  await save(policy({ autoReadDays: 1 }))
  state.editEntries([ids[0]], 'unread')
  state.editEntries(ids.slice(1), 'unread')
  const read = state.editEntries([ids[2]], 'read', { undo: { token: 'retention-undo', expiresAt: new Date(Date.now() + 60000).toISOString() } })
  state.undo(read.undoToken)
  await service.stop(); db.close(); db = new PaperDatabase(file); service = new RetentionService(db, backend)
  const p = policy({ autoReadDays: 1, readDays: 1, unreadDays: null })
  expect(await service.preview(p)).toMatchObject({ marked: 0, deleted: 0 })
  await save(p)
  expect(ids.map(id => db.entryState(id)?.read)).toEqual([false, false, false])
  // A later explicit read still qualifies for read deletion.
  db.commitLocalEntryState(backend.id, [ids[0]], 'read')
  expect(await service.preview(p)).toMatchObject({ marked: 0, deleted: 1 })
})

it('commits auto-read activity and bounded state notifications after every batch', async () => {
  seed(205)
  const state = new LocalStateService(db, backend.id)
  await service.stop(); service = new RetentionService(db, backend, state)
  const notifications: unknown[] = [], committed: number[] = []
  state.onStateChanged(change => {
    notifications.push(change)
    committed.push(Number(sql.prepare('SELECT COUNT(*) n FROM entries WHERE read = 1').get()?.n))
  })
  await save(policy({ autoReadDays: 1 }))
  expect(notifications).toEqual([null, null, null])
  expect(committed).toEqual([100, 200, 205])
  const activity = db.activity().filter(event => event.kind === 'state' && event.origin === 'retention')
  expect(activity.map(event => event.count).sort((a, b) => a - b)).toEqual([5, 100, 100])
  expect(sql.prepare('SELECT COUNT(*) n FROM entries WHERE state_revision = 1').get()?.n).toBe(205)
})

it('uses the most conservative override across every folder and honors feed priority', async () => {
  seed(1)
  const folders: string[] = []
  for (const title of ['First', 'Second', 'Third']) {
    const result = db.organization.apply(backend.id, db.organization.snapshot(backend.id).revision, [{ type: 'create-folder', title }]).results[0]
    if (result.status !== 'applied' || !result.id) throw Error('fixture')
    folders.push(result.id)
    db.organization.apply(backend.id, db.organization.snapshot(backend.id).revision, [{ type: 'add-membership', feedId: feed, folderId: result.id }])
  }
  folders.sort()
  const p = policy({ autoReadDays: 1, readDays: 1, folderDays: { [folders[0]]: 1, [folders[1]]: 300 } })
  expect(await service.preview(p)).toMatchObject({ marked: 0, deleted: 0 })
  p.folderDays[folders[1]] = 100; p.folderDays[folders[2]] = null
  expect(await service.preview(p)).toMatchObject({ marked: 0, deleted: 0 })
  await save(p)
  expect(db.retention.lastRun()).toMatchObject({ marked: 0, deleted: 0 })
  p.feedDays[feed] = 1
  expect(await service.preview(p)).toMatchObject({ marked: 1, deleted: 1 })
  p.feedDays[feed] = null
  expect(await service.preview(p)).toMatchObject({ marked: 0, deleted: 0 })
})

it('retains deleted arrival numbers independently of identity expiry and never reuses them', async () => {
  const [id] = seed(1), sequence = db.localEntry(id)!.linkNumber!
  await save(policy({ unreadDays: 1 }))
  const removal = sql.prepare('SELECT * FROM retention_removals WHERE sequence = ?').get(sequence)
  expect(removal).toMatchObject({ sequence, feed_id: feed, title: 'Retention item-0' })
  expect(Number(removal?.removed_at)).toBeGreaterThanOrEqual(now)
  ingest([], now + 40 * DAY)
  db.retention.expireTombstones('', now + 40 * DAY)
  expect(sql.prepare('SELECT COUNT(*) n FROM retention_tombstones').get()?.n).toBe(0)
  expect(sql.prepare('SELECT COUNT(*) n FROM retention_removals').get()?.n).toBe(1)
  const result = ingest(['new-item']).results[0]
  expect(result.status).toBe('resolved')
  if (result.status === 'resolved') expect(db.localEntry(result.id)!.linkNumber).toBeGreaterThan(sequence)
})


it('rolls back auto-read, activity, exemptions, removal records and cursor without notifying on failure', () => {
  const [id] = seed(1)
  const state = new LocalStateService(db, backend.id), listener = vi.fn()
  state.onStateChanged(listener)
  const run = db.retention.start(policy({ autoReadDays: 1, readDays: 1 }))
  sql.exec("CREATE TRIGGER reject_retention_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'fixture'); END")
  expect(() => state.retentionBatch(run, true)).toThrow(/fixture/)
  expect(listener).not.toHaveBeenCalled()
  expect(db.entryState(id)).toMatchObject({ read: false, revision: 0 })
  expect(db.activity().filter(event => event.kind === 'state')).toHaveLength(0)
  expect(db.retention.lastRun()).toMatchObject({ cursor: 0, marked: 0, deleted: 0 })
  for (const table of ['retention_auto_read', 'retention_removals', 'retention_tombstones']) expect(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n).toBe(0)
  sql.exec('DROP TRIGGER reject_retention_delete')
  state.retentionBatch(run, true)
  expect(listener).toHaveBeenCalledExactlyOnceWith(null)
  expect(db.entryState(id)).toBeNull()
})

it('expires removal notices after a year in bounded batches without resetting arrival numbers', async () => {
  const ids = seed(205), lastNumber = Math.max(...ids.map(id => db.localEntry(id)!.linkNumber!))
  await save(policy({ unreadDays: 1 }))
  const removedAt = db.retention.removal(lastNumber)!.removedAt
  expect(db.retention.expireRemovals(removedAt + 364 * DAY)).toBe(0)
  expect(db.retention.expireRemovals(removedAt + 366 * DAY)).toBe(100)
  expect(db.retention.expireRemovals(removedAt + 366 * DAY)).toBe(100)
  expect(db.retention.expireRemovals(removedAt + 366 * DAY)).toBe(5)
  expect(db.retention.removal(lastNumber)).toBeNull()
  const result = ingest(['new-arrival']).results[0]
  if (result.status !== 'resolved') throw Error('fixture')
  expect(db.localEntry(result.id)!.linkNumber).toBeGreaterThan(lastNumber)
})
