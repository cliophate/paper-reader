import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackendMigration, type MigrationBoundary } from '../src/server/backend-migration.js'
import { databaseDigest, openDatabase, settingsDigest } from '../src/server/migration-storage.js'
import { PaperDatabase } from '../src/server/db.js'
import { freshRssIdentity } from '../src/server/identity.js'
import { acquireStateLock } from '../src/server/state-lock.js'
import type { Entry, Feed } from '../src/server/types.js'

let directory: string, file: string
const source = freshRssIdentity('https://fixture.example.test', 'synthetic')
const date = '2026-11-01T00:00:00.000Z'
const entryId = 'tag:google.com,2005:reader/item/0000000000000001'
const folderId = 'user/-/label/Writers'
const feed: Feed = { id: 'feed/1', title: 'Synthetic feed', url: 'https://example.test/rss', siteUrl: 'https://example.test', iconUrl: '', categories: ['Writers'], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }
const entry: Entry = { id: entryId, feedId: feed.id, feedTitle: feed.title, feedUrl: feed.url, title: 'Synthetic history', url: 'https://example.test/article', author: 'Synthetic author', contentHtml: '<p>Retain historical content</p>', excerpt: 'Historical', publishedAt: date, timestamp: Date.parse(date), read: true, starred: true, readingMinutes: 1, thumbnailUrl: '', kind: 'article' }

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-migration-')); file = path.join(directory, 'paper.sqlite')
  const db = new PaperDatabase(file)
  db.bindBackend(source)
  db.replaceNavigation({ unread: 0, starred: 1, folders: [{ id: folderId, title: 'Writers', unread: 0, feeds: [feed] }], uncategorized: [{ ...feed, id: 'feed/2', title: 'Inactive' }] })
  db.upsertEntries([entry, { ...entry, id: 'historical-inactive', feedId: 'feed/2', url: 'https://example.test/inactive' }, { ...entry, id: 'historical-orphan', feedId: 'feed/orphan', url: 'https://example.test/orphan' }])
  db.saveReadingProgress(entryId, 0.42)
  db.saveDiscussion({ entryId, revision: 1, source: { title: entry.title, author: entry.author, url: entry.url, kind: 'feed', paragraphs: [], warning: '' }, messages: [{ id: 'msg', role: 'user', text: 'Synthetic discussion', status: 'complete' }] })
  db.savePulseBatch([{ id: 'collection', headline: 'Synthetic collection', scope: 'Fixture', entryIds: [entryId, 'historical-inactive', 'historical-orphan'] }], [entryId, 'historical-inactive', 'historical-orphan'], date)
  db.createBriefing({ id: 'briefing', kind: 'morning', windowStart: date, cutoff: date, subject: 'Synthetic briefing', html: '', text: '', status: 'generated', tokenHash: 'synthetic-hash', selection: { news: [{ headline: 'Story', summary: '', entryIds: [entryId], backgroundEntryIds: ['historical-orphan'] }], worthNoticing: [], social: [] }, createdAt: date, deliveredAt: null, acknowledgedAt: null }, [{ id: entryId, section: 'news' }])
  db.createUndo({ token: 'synthetic-undo', operation: 'unread', entryIds: [entryId], expiresAt: '2099-01-01T00:00:00Z' })
  db.setSyncValue('briefing_writers_folder_id', folderId)
  for (const [key, value] of Object.entries({ backfill_complete: 'true', state_synced_at: date, last_sync_completed_at: date, backfill_continuation: '' })) db.setSyncValue(key, value)
  db.close()
  sql(db => db.prepare('UPDATE feeds SET active = 0 WHERE id = ?').run('feed/2'))
  fs.writeFileSync(path.join(directory, 'connections.json'), JSON.stringify({ readwise: { enabled: false, token: 'synthetic-private-token' } }), { mode: 0o600 })
  fs.writeFileSync(path.join(directory, 'secrets.json'), JSON.stringify({ signingSecret: 'synthetic-signing-secret', internalSecret: 'synthetic-internal-secret' }), { mode: 0o600 })
})
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })
function sql<T>(operation: (db: DatabaseSync) => T, filename = file): T {
  const db = openDatabase(filename)
  try { return operation(db) } finally { db.close() }
}
function session<T>(operation: (migration: BackendMigration) => T, boundary?: (phase: MigrationBoundary) => void) {
  const migration = new BackendMigration(directory, boundary)
  try { return operation(migration) } finally { migration.close() }
}
const choices = { mappings: [{ subscriptionId: feed.id, externalId: 'publisher-guid', entryId, evidence: 'Operator reviewed the publisher item against the frozen source article.' }], ambiguities: [{ subscriptionId: 'feed/2', externalId: 'unresolved-publisher-id', candidateIds: ['historical-inactive'] }] }

describe('offline backend migration', () => {
  it('reports every blocked decision through the offline CLI before creating a plan', () => {
    sql(db => {
      db.prepare('UPDATE folders SET title = ? WHERE id = ?').run('Uncategorized', folderId)
      db.prepare("INSERT INTO folders (id, title, position, synced_at) VALUES (?, ?, 0, '')").run('folder/news-a', 'News')
      db.prepare("INSERT INTO folders (id, title, position, synced_at) VALUES (?, ?, 0, '')").run('folder/news-b', 'NEWS')
      db.prepare("INSERT INTO folders (id, title, position, synced_at) VALUES (?, ?, 0, '')").run('folder/invalid', ' Trim ')
      db.prepare('UPDATE feeds SET url = ? WHERE id = ?').run('https://private-user:private-password@example.test/feed?token=private-query', feed.id)
    })
    const before = sql(databaseDigest)
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/server/migration-cli.ts', ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', STATE_DIR: directory,
        FRESHRSS_BASE_URL: 'https://fixture.example.test', FRESHRSS_USERNAME: 'synthetic' },
    })
    const rejected = cli('preview')
    expect(rejected.status).toBe(1)
    const report = JSON.parse(rejected.stderr)
    expect(report.code).toBe('migration-decisions-required')
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      { kind: 'subscription', id: feed.id, title: feed.title, reason: 'unsafe-endpoint' },
      { kind: 'folder', id: folderId, title: 'Uncategorized', reason: 'reserved-title' },
      { kind: 'folder', id: 'folder/news-a', title: 'News', reason: 'title-collision' },
      { kind: 'folder', id: 'folder/news-b', title: 'NEWS', reason: 'title-collision' },
      { kind: 'folder', id: 'folder/invalid', title: ' Trim ', reason: 'invalid-title' },
    ]))
    expect(report.diagnostics).toHaveLength(5)
    expect(rejected.stderr + rejected.stdout).not.toMatch(/private-user|private-password|private-query|synthetic-private-token/)
    expect(fs.existsSync(path.join(directory, 'migration.json'))).toBe(false)
    expect(fs.existsSync(path.join(directory, 'migrations'))).toBe(false)
    expect(cli('apply', '--digest', '0'.repeat(64)).status).toBe(1)
    expect(sql(databaseDigest)).toBe(before)
    const choiceFile = path.join(directory, 'choices.json')
    fs.writeFileSync(choiceFile, JSON.stringify({ pausedSubscriptions: [feed.id], folderTitles: {
      [folderId]: 'Old folder', 'folder/news-b': 'News 2', 'folder/invalid': 'Trim',
    } }))
    const preview = cli('preview', '--choices', choiceFile)
    expect(preview.status, preview.stderr).toBe(0)
    const frozen = JSON.parse(preview.stdout)
    expect(cli('apply', '--digest', frozen.planDigest).status).toBe(0)
    expect(sql(db => db.prepare('SELECT id, title FROM folders WHERE id = ?').get(folderId))).toEqual({ id: folderId, title: 'Old folder' })
    expect(sql(db => db.prepare('SELECT 1 FROM feed_fetch_state WHERE subscription_id = ?').get(feed.id))).toBeUndefined()
  }, 20000)

  it('runs the offline CLI through reviewed apply, stale rollback rejection and preserved rollback', () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/server/migration-cli.ts', ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', STATE_DIR: directory,
        FRESHRSS_BASE_URL: 'https://fixture.example.test', FRESHRSS_USERNAME: 'synthetic' },
    })
    const preview = cli('preview')
    expect(preview.status, preview.stderr).toBe(0)
    expect(preview.stdout).not.toContain('synthetic-private-token')
    expect(preview.stdout).not.toContain('synthetic-signing-secret')
    const frozen = JSON.parse(preview.stdout)
    expect(cli('apply', '--digest', '0'.repeat(64)).status).toBe(1)
    const applied = cli('apply', '--digest', frozen.planDigest)
    expect(applied.status, applied.stderr).toBe(0)
    expect(JSON.parse(applied.stdout).phase).toBe('active')
    expect(cli('resume', '--digest', frozen.planDigest).status).toBe(0)
    const firstRollback = JSON.parse(cli('rollback-preview').stdout)
    const db = new PaperDatabase(file)
    db.commitLocalEntryState(frozen.plan.targetBackend, [entryId], 'unread')
    db.close()
    expect(cli('rollback-apply', '--digest', firstRollback.digest, '--acknowledge-loss').status).toBe(1)
    const rollback = JSON.parse(cli('rollback-preview').stdout)
    expect(rollback.plan.changedTables).toContain('entries')
    expect(cli('rollback-apply', '--digest', rollback.digest).status).toBe(1)
    const restored = cli('rollback-apply', '--digest', rollback.digest, '--acknowledge-loss')
    expect(restored.status, restored.stderr).toBe(0)
    expect(JSON.parse(restored.stdout).phase).toBe('rolled-back')
    expect(sql(db => db.prepare('SELECT read FROM entries WHERE id = ?').get(entryId)?.read)).toBe(1)
    expect(fs.readdirSync(path.join(directory, 'migrations', frozen.plan.id)).some(name => name.startsWith('post-'))).toBe(true)
  }, 20000)

  it('preserves IDs, source aliases, references and inactive/orphan history while establishing scoped local ownership', () => {
    const original = sql(databaseDigest), originalSettings = settingsDigest(directory)
    const preview = session(migration => migration.preview(source.id, choices))
    session(migration => expect(migration.apply(preview.planDigest).phase).toBe('active'))
    const saved = path.join(directory, 'migrations', preview.plan.id, 'source.sqlite')
    expect(sql(databaseDigest, saved)).toBe(original)
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600)
    expect(settingsDigest(directory)).toEqual(originalSettings)
    expect(sql(db => db.prepare('PRAGMA foreign_key_check').all())).toEqual([])
    expect(sql(db => db.prepare('SELECT * FROM article_aliases').all())).toEqual([{ backend_id: preview.plan.targetBackend, subscription_id: feed.id, external_id: 'publisher-guid', entry_id: entryId }])
    expect(sql(db => db.prepare('SELECT COUNT(*) AS n FROM migration_provenance').get()?.n)).toBe(6)
    expect(sql(db => db.prepare('SELECT evidence FROM migration_decisions').get()?.evidence)).toBe(choices.mappings[0].evidence)
    expect(sql(db => db.prepare('SELECT backend_id FROM backend_checkpoints LIMIT 1').get()?.backend_id)).toBe(source.id)
    expect(sql(db => db.prepare('SELECT subscription_id, etag, lease_token FROM feed_fetch_state').all())).toEqual([{ subscription_id: feed.id, etag: '', lease_token: '' }])
    const db = new PaperDatabase(file)
    db.bindBackend({ id: preview.plan.targetBackend, kind: 'standalone' })
    expect(db.localEntry(entryId)).toMatchObject({ read: true, starred: true, readingPosition: 0.42 })
    expect(db.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { unreadOnly: false }).items).toHaveLength(3)
    expect(db.localEntry('historical-orphan')).not.toBeNull()
    expect(db.discussion(entryId)?.messages[0].text).toBe('Synthetic discussion')
    expect(db.entryIdsForBriefing('briefing')).toEqual([entryId])
    expect(db.getBriefing('briefing')?.selection.news[0].backgroundEntryIds).toEqual(['historical-orphan'])
    expect(db.pulseCollections()[0].sources.map(item => item.id)).toContain(entryId)
    expect(db.getSyncValue('briefing_writers_folder_id')).toBe(folderId)
    expect(db.organization.snapshot(preview.plan.targetBackend).navigation.folders[0].id).toBe(folderId)
    expect(db.identities.resolve(preview.plan.targetBackend, feed.id, { externalId: 'publisher-guid' })).toMatchObject({ id: entryId, created: false })
    expect(db.identities.resolve(preview.plan.targetBackend, 'feed/2', { externalId: 'new-guid', url: entry.url, publishedAt: date })).toMatchObject({ created: true })
    expect(() => db.bindBackend(source)).toThrow(/another backend/)
    db.close()
  })

  it.each<MigrationBoundary>(['previewed', 'staged', 'subscription', 'validated', 'activating', 'promoted'])('resumes after interruption at %s without duplicate identities or remapping', boundary => {
    let fired = false
    const crash = (point: MigrationBoundary) => { if (!fired && point === boundary) { fired = true; throw new Error('Simulated crash') } }
    let hash = ''
    expect(() => session(migration => { hash = migration.preview(source.id, choices).planDigest; migration.apply(hash) }, crash)).toThrow('Simulated crash')
    expect(fired).toBe(true)
    session(migration => { hash ||= migration.status().planDigest; expect(migration.apply(hash).phase).toBe('active') })
    expect(sql(db => db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n)).toBe(3)
    expect(sql(db => db.prepare('SELECT COUNT(*) AS n FROM migration_subscriptions').get()?.n)).toBe(3)
    expect(sql(db => db.prepare('PRAGMA foreign_key_check').all())).toEqual([])
  })

  it('rejects stale previews including local state and settings changes, but permits abort and a fresh preview', () => {
    const preview = session(migration => migration.preview(source.id))
    sql(db => db.prepare('UPDATE reading_progress SET position = 0.8').run())
    expect(() => session(migration => migration.apply(preview.planDigest))).toThrow(/stale/)
    session(migration => migration.abort())
    const second = session(migration => migration.preview(source.id))
    fs.writeFileSync(path.join(directory, 'connections.json'), '{}')
    expect(() => session(migration => migration.apply(second.planDigest))).toThrow(/stale/)
    expect(sql(db => db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value)).toBe(source.id)
  })

  it('rejects another account, cross-subscription mappings, missing evidence, duplicate mappings and incomplete sync', () => {
    expect(() => session(migration => migration.preview('freshrss:other'))).toThrow(/account/)
    expect(() => session(migration => migration.preview(source.id, { mappings: [{ ...choices.mappings[0], subscriptionId: 'feed/2' }] }))).toThrow(/subscription/)
    expect(() => session(migration => migration.preview(source.id, { mappings: [{ ...choices.mappings[0], evidence: '' }] }))).toThrow(/evidence/)
    expect(() => session(migration => migration.preview(source.id, { mappings: [choices.mappings[0], choices.mappings[0]] }))).toThrow(/one-to-one/)
    sql(db => db.prepare("UPDATE backend_checkpoints SET value = 'false' WHERE key = 'backfill_complete'").run())
    expect(() => session(migration => migration.preview(source.id))).toThrow(/successful FreshRSS/)
  })

  it.each(['subscription', 'promoted'])('recovers when the process is killed at %s with no cleanup handlers', async boundary => {
    const preview = session(migration => migration.preview(source.id, choices))
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/migration-worker.ts', directory, preview.planDigest, boundary], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
    })
    const [, signal] = await once(child, 'exit')
    expect(signal).toBe('SIGKILL')
    session(migration => expect(migration.apply(preview.planDigest).phase).toBe('active'))
    expect(sql(db => db.prepare('PRAGMA foreign_key_check').all())).toEqual([])
  })

  it('does not let migration bookkeeping invalidate its own preview and reports old reference defects', () => {
    sql(db => {
      db.prepare('INSERT INTO briefing_entries VALUES (?, ?, ?)').run('briefing', 'missing-old-reference', 'news')
      db.prepare('INSERT INTO discussions VALUES (?, ?)').run('missing-old-reference', JSON.stringify({ entryId: 'missing-old-reference' }))
    })
    const preview = session(migration => migration.preview(source.id))
    expect(preview.plan.references).toMatchObject({ 'briefing_entries.missingArticles': 1, 'discussions.missingArticles': 1, orphanFeedArticles: 1, inactiveFeedArticles: 1 })
    sql(db => db.prepare('INSERT INTO migration_runs VALUES (?, ?, ?, ?, ?, ?)').run('prior-bookkeeping', source.id, 'unused', 'unused', 'unused', 'aborted'))
    session(migration => migration.apply(preview.planDigest))
    expect(sql(db => db.prepare('SELECT entry_id FROM discussions WHERE entry_id = ?').get('missing-old-reference')?.entry_id)).toBe('missing-old-reference')
  })

  it('stages and resumes a 2,000-subscription fixture in bounded subscription transactions', () => {
    const db = new PaperDatabase(file)
    const feeds = Array.from({ length: 2000 }, (_, index) => ({ ...feed, id: `feed/scale-${index}`, title: `Synthetic ${index}`, url: `https://example.test/rss/${index}` }))
    db.replaceNavigation({ unread: 2000, starred: 1, folders: [], uncategorized: feeds })
    db.upsertEntries(feeds.map((item, index) => ({ ...entry, id: `scale-article-${index}`, feedId: item.id, read: false })))
    db.close()
    const preview = session(migration => migration.preview(source.id))
    let completed = 0
    expect(() => session(migration => migration.apply(preview.planDigest), phase => { if (phase === 'subscription' && ++completed === 1000) throw new Error('Interrupted large migration') })).toThrow('Interrupted large migration')
    session(migration => expect(migration.apply(preview.planDigest).phase).toBe('active'))
    expect(sql(db => db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n)).toBe(2003)
    expect(sql(db => db.prepare('SELECT COUNT(*) AS n FROM feed_fetch_state').get()?.n)).toBe(2000)
  }, 30000)

  it('blocks cooperating readers in both directions and releases the lock when initialization fails', () => {
    const normal = acquireStateLock(directory, 'shared')
    expect(() => new BackendMigration(directory)).toThrow(/in use/)
    normal.release()
    session(() => expect(() => acquireStateLock(directory, 'shared')).toThrow(/in use/))
    fs.renameSync(file, file + '.saved')
    expect(() => new BackendMigration(directory)).toThrow()
    acquireStateLock(directory, 'shared').release()
  }, 120000)

  it('does not accept an existing corrupt source backup or changed mapping plan', () => {
    const preview = session(migration => migration.preview(source.id))
    const base = path.join(directory, 'migrations', preview.plan.id)
    sql(db => db.prepare('UPDATE entries SET starred = 0').run(), path.join(base, 'source.sqlite'))
    expect(() => session(migration => migration.apply(preview.planDigest))).toThrow(/backup failed/)
    expect(sql(db => db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value)).toBe(source.id)
    fs.writeFileSync(path.join(base, 'plan.json'), JSON.stringify({ ...preview.plan, targetBackend: 'standalone:changed' }))
    expect(() => session(migration => migration.apply(preview.planDigest))).toThrow(/plan changed/)
  })

  it('pauses unsafe endpoints explicitly and retains old folder IDs through approved renames', () => {
    sql(db => db.exec("UPDATE feeds SET url = '' WHERE id = 'feed/1'; UPDATE folders SET title = 'Uncategorized'"))
    expect(() => session(migration => migration.preview(source.id))).toThrow(/reported subscriptions and folders/)
    expect(() => session(migration => migration.preview(source.id, { pausedSubscriptions: [feed.id] }))).toThrow(/reported subscriptions and folders/)
    const preview = session(migration => migration.preview(source.id, { pausedSubscriptions: [feed.id], folderTitles: { [folderId]: 'Old folder' } }))
    session(migration => migration.apply(preview.planDigest))
    expect(sql(db => db.prepare('SELECT id, title FROM folders').all())).toEqual([{ id: folderId, title: 'Old folder' }])
    expect(sql(db => db.prepare('SELECT COUNT(*) AS n FROM feed_fetch_state').get()?.n)).toBe(0)
    expect(sql(db => db.prepare("SELECT active FROM feeds WHERE id = 'feed/1'").get()?.active)).toBe(1)
  })
})

describe('rollback with later standalone activity', () => {
  it('preserves mapped search rows through migration snapshots, activation and rollback', () => {
    const rows = () => sql(db => db.prepare('SELECT * FROM entry_search_rows ORDER BY id').all())
    const original = rows()
    const preview = session(migration => migration.preview(source.id))
    session(migration => migration.apply(preview.planDigest))
    expect(rows()).toEqual(original)
    sql(db => db.prepare('UPDATE entries SET full_content_text=? WHERE id=?').run('Postcutoverneedle', entryId))
    let db = new PaperDatabase(file)
    expect(db.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: 'Postcutoverneedle' }).items.map(e => e.id)).toEqual([entryId])
    db.close()
    const rollback = session(migration => migration.rollbackPreview())
    session(migration => migration.rollback(rollback.digest, true))
    expect(rows()).toEqual(original)
    db = new PaperDatabase(file)
    expect(db.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: 'Postcutoverneedle' }).items).toHaveLength(0)
    expect(db.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: 'Retain' }).items.map(e => e.id)).toContain(entryId)
    db.close()
    sql(connection => connection.prepare('UPDATE entries SET content_text=? WHERE id=?').run('Afterrollbackneedle', entryId))
    expect(sql(connection => connection.prepare("SELECT count(*) n FROM entries_fts WHERE entries_fts MATCH 'Afterrollbackneedle'").get()?.n)).toBe(1)
  })

  it('recovers a killed rollback process after database replacement while retaining both settings copies', async () => {
    const original = sql(databaseDigest), settings = settingsDigest(directory)
    const preview = session(migration => migration.preview(source.id))
    session(migration => migration.apply(preview.planDigest))
    fs.writeFileSync(path.join(directory, 'secrets.json'), JSON.stringify({ signingSecret: 'synthetic-replacement-secret' }))
    const later = settingsDigest(directory)
    const rollback = session(migration => migration.rollbackPreview())
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/migration-worker.ts', directory, rollback.digest, 'rollback-promoted', 'rollback'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
    })
    const [, signal] = await once(child, 'exit')
    expect(signal).toBe('SIGKILL')
    session(migration => expect(migration.recover().phase).toBe('rolled-back'))
    expect(sql(databaseDigest)).toBe(original)
    expect(settingsDigest(directory)).toEqual(settings)
    const base = path.join(directory, 'migrations', preview.plan.id)
    const post = fs.readdirSync(base).find(name => name.startsWith('post-'))!
    expect(settingsDigest(path.join(base, post))).toEqual(later)
  })

  it.each<MigrationBoundary>(['rollback-backed-up', 'rollback-promoted'])('preserves later data and settings through interruption at %s', boundary => {
    const original = sql(databaseDigest), originalSettings = settingsDigest(directory)
    const preview = session(migration => migration.preview(source.id, choices))
    session(migration => migration.apply(preview.planDigest))
    const db = new PaperDatabase(file)
    db.commitLocalEntryState(preview.plan.targetBackend, [entryId], 'unread')
    db.saveReadingProgress(entryId, 0.9)
    db.saveLocalSubscription(preview.plan.targetBackend, { title: 'New local feed', url: 'https://example.test/new' })
    db.close()
    fs.writeFileSync(path.join(directory, 'connections.json'), JSON.stringify({ readwise: { enabled: false, token: 'synthetic-later-token' } }))
    const current = sql(databaseDigest), currentSettings = settingsDigest(directory)
    const rollback = session(migration => migration.rollbackPreview())
    expect(rollback.plan.changedTables).toEqual(expect.arrayContaining(['entries', 'feeds', 'reading_progress']))
    expect(rollback.plan.changedSettings).toEqual(['connections.json'])
    expect(() => session(migration => migration.rollback(rollback.digest, false))).toThrow(/acknowledgment/)
    expect(() => session(migration => migration.rollback(rollback.digest, true), phase => { if (phase === boundary) throw new Error('Simulated crash') })).toThrow('Simulated crash')
    session(migration => expect(migration.recover().phase).toBe('rolled-back'))
    expect(sql(databaseDigest)).toBe(original)
    expect(settingsDigest(directory)).toEqual(originalSettings)
    const base = path.join(directory, 'migrations', preview.plan.id)
    const post = fs.readdirSync(base).find(name => name.startsWith('post-'))!
    expect(sql(databaseDigest, path.join(base, post, 'paper.sqlite'))).toBe(current)
    expect(settingsDigest(path.join(base, post))).toEqual(currentSettings)
  })

  it('rejects a rollback preview after another write and does not overwrite the active database', () => {
    const preview = session(migration => migration.preview(source.id))
    session(migration => migration.apply(preview.planDigest))
    const rollback = session(migration => migration.rollbackPreview())
    expect(rollback.plan.changedTables).toEqual([])
    sql(db => db.prepare('UPDATE reading_progress SET position = 0.7').run())
    expect(() => session(migration => migration.rollback(rollback.digest, true))).toThrow(/stale/)
    expect(sql(db => db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value)).toBe(preview.plan.targetBackend)
  })
})

describe('schema 10 upgrade ordering', () => {
  function downgrade() {
    sql(db => db.exec(`DROP TABLE migration_decisions; DROP TABLE migration_subscriptions; DROP TABLE migration_provenance; DROP TABLE migration_runs;
      ALTER TABLE undo_actions DROP COLUMN backend_id; ALTER TABLE undo_actions DROP COLUMN expected_revisions_json; PRAGMA user_version = 9`))
  }
  it('backs up committed WAL and the original undo format before schema upgrade and preview', () => {
    downgrade()
    const writer = openDatabase(file)
    writer.prepare('UPDATE reading_progress SET position = 0.77').run()
    session(migration => migration.preview(source.id))
    const saved = file + '.before-standalone-setup-v10'
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version, saved)).toBe(9)
    expect(sql(db => db.prepare('SELECT position FROM reading_progress').get()?.position, saved)).toBe(0.77)
    expect(sql(db => db.prepare('PRAGMA table_info(undo_actions)').all().map(row => row.name), saved)).not.toContain('backend_id')
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600)
    writer.close()
  })
  it('rolls back schema failure and validates its existing backup before retry', () => {
    downgrade()
    sql(db => db.exec('CREATE VIEW migration_runs AS SELECT 1 AS broken'))
    expect(() => session(() => {})).toThrow()
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(9)
    expect(sql(db => db.prepare('PRAGMA table_info(undo_actions)').all().map(row => row.name))).not.toContain('backend_id')
    sql(db => db.exec('DROP VIEW migration_runs'))
    const saved = fs.readFileSync(file + '.before-standalone-setup-v10')
    session(() => {})
    expect(fs.readFileSync(file + '.before-standalone-setup-v10')).toEqual(saved)
    expect(sql(db => db.prepare('PRAGMA user_version').get()?.user_version)).toBe(11)
  })
})
