import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { ingestFeed, successfulFeedFetch, type FeedEndpoint } from '../src/server/feed-ingestion.js'
import { StandaloneBackend } from '../src/server/standalone-backend.js'
import { escapeHtml } from '../src/server/text.js'

let directory: string
let file: string
let db: PaperDatabase
let endpoint: FeedEndpoint
const backend = { id: 'standalone:ingestion-fixture', kind: 'standalone' as const }
const url = 'https://example.test/feed'
const fetchedAt = '2026-11-01T00:00:00.000Z'
const all = { kind: 'all' as const, id: 'all', title: 'All' }
const rss = (items = '') => `<rss version="2.0"><channel><title>Fixture</title><link>https://example.test/</link>${items}</channel></rss>`
function item(id = 'one', link = 'https://example.test/article', title = 'Original', date = '2024-01-01T00:00:00Z', body = '<p>Body</p>') {
  return `<item>${id ? `<guid isPermaLink="false">${escapeHtml(id)}</guid>` : ''}<title>${escapeHtml(title)}</title><link>${escapeHtml(link)}</link><pubDate>${escapeHtml(date)}</pubDate><description>${escapeHtml(body)}</description></item>`
}
function ingest(xml = rss(item()), changes: Partial<Parameters<typeof ingestFeed>[1]> = {}) {
  return ingestFeed(db, { ...endpoint, xml, requestUrl: url, responseUrl: url, fetchedAt, ...changes })
}
function resolvedId(result: ReturnType<typeof ingest>) {
  const resolution = result.results[0]
  if (resolution.status !== 'resolved') throw new Error('Expected resolved article')
  return resolution.id
}
function sql<T>(run: (connection: DatabaseSync) => T): T {
  const connection = new DatabaseSync(file)
  try { return run(connection) } finally { connection.close() }
}
function reopen() { db.close(); db = new PaperDatabase(file) }
function arrivals() { return sql(c => c.prepare('SELECT entry_id, sequence FROM article_arrivals ORDER BY sequence').all()) }

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-issue16-'))
  file = path.join(directory, 'paper.sqlite')
  db = new PaperDatabase(file)
  db.bindBackend(backend)
  endpoint = { backendId: backend.id, subscriptionId: db.saveLocalSubscription(backend.id, { title: 'Fixture', url }), endpointGeneration: 'generation-1' }
})
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('repeatable feed ingestion', () => {
  it('replaces an added feed URL title once and advances the organization revision', async () => {
    const standalone = new StandaloneBackend(db)
    await standalone.addFeed(url + '/untitled', '', 'Synthetic folder')
    const before = db.organization.snapshot(backend.id)
    const folder = before.navigation.folders[0]
    const subscription = folder.feeds[0]
    const schedule = db.feedFetch.get(backend.id, subscription.id)
    const ingestAdded = (xml = rss()) => ingest(xml, { subscriptionId: subscription.id, requestUrl: subscription.url })
    ingestAdded(rss().replace('<title>Fixture</title>', '<title> </title>'))
    expect(db.organization.snapshot(backend.id)).toEqual(before)
    ingestAdded()
    const after = db.organization.snapshot(backend.id)
    expect(after.revision).toBe(before.revision + 1)
    expect(after.navigation.folders[0].feeds[0]).toEqual({ ...subscription, title: 'Fixture' })
    expect(db.feedFetch.get(backend.id, subscription.id)).toEqual(schedule)
    expect(() => db.organization.apply(backend.id, before.revision, [{ type: 'rename-feed', feedId: subscription.id, title: 'Stale edit' }])).toThrow(/Organization changed/)
    ingestAdded(rss().replace('<title>Fixture</title>', '<title>Publisher renamed</title>'))
    expect(db.organization.snapshot(backend.id)).toEqual(after)
    db.organization.apply(backend.id, after.revision, [{ type: 'rename-feed', feedId: subscription.id, title: 'My title' }])
    ingestAdded()
    expect(db.organization.snapshot(backend.id).navigation.folders[0].feeds[0].title).toBe('My title')
  })
  it('keeps a chosen subscription title during ingestion', () => {
    db.saveLocalSubscription(backend.id, { id: endpoint.subscriptionId, title: 'Chosen title', url })
    const before = db.organization.snapshot(backend.id)
    ingest()
    const after = db.organization.snapshot(backend.id)
    expect(after.revision).toBe(before.revision)
    expect(after.navigation.uncategorized[0].title).toBe('Chosen title')
  })
  it('rolls back an inferred title and its revision when ingestion checkpoint persistence fails', () => {
    db.saveLocalSubscription(backend.id, { id: endpoint.subscriptionId, title: url, url })
    const before = db.organization.snapshot(backend.id)
    sql(c => c.exec("CREATE TRIGGER reject_title_checkpoint BEFORE INSERT ON backend_checkpoints BEGIN SELECT RAISE(ABORT, 'synthetic title failure'); END"))
    expect(() => ingest()).toThrow(/synthetic title/)
    expect(db.organization.snapshot(backend.id)).toEqual(before)
    expect(db.entryCount()).toBe(0)
    sql(c => c.exec('DROP TRIGGER reject_title_checkpoint'))
    ingest()
    expect(db.organization.snapshot(backend.id).navigation.uncategorized[0].title).toBe('Fixture')
  })
  it('preserves state and references through updates, redirects, disappearance, repair and restart', () => {
    const id = resolvedId(ingest())
    const related = resolvedId(ingest(rss(item('related', '/related'))))
    const third = resolvedId(ingest(rss(item('third', '/third'))))
    const initialArrivals = arrivals()
    const firstSeen = sql(c => c.prepare('SELECT first_seen_at FROM entries WHERE id = ?').get(id)?.first_seen_at)
    db.commitLocalEntryState(backend.id, [id], 'read')
    db.commitLocalEntryState(backend.id, [id], 'star')
    db.saveReadingProgress(id, 0.42)
    db.recordReadwiseSave('https://example.test/article')
    db.cacheArticle({ url: 'https://example.test/article', title: 'Original', byline: '', excerpt: '', contentHtml: '<p>Cachedfulltext</p>', readingMinutes: 1, fetchedAt })
    db.saveDiscussion({ entryId: id, revision: 1, source: { title: 'Original', author: '', url: 'https://example.test/article', kind: 'feed', paragraphs: [], warning: '' }, messages: [{ id: 'message', role: 'user', text: 'Keep this', status: 'complete' }] })
    db.savePulseBatch([{ id: 'collection', headline: 'Collection', scope: 'Related', entryIds: [id, related, third] }], [id, related, third], fetchedAt)
    db.createBriefing({ id: 'briefing', kind: 'morning', windowStart: fetchedAt, cutoff: fetchedAt, subject: 'Synthetic', html: '', text: '', status: 'generated', tokenHash: 'synthetic', selection: { news: [{ headline: 'Story', summary: '', entryIds: [id] }], worthNoticing: [], social: [] }, createdAt: fetchedAt, deliveredAt: null, acknowledgedAt: null }, [{ id, section: 'news' }])
    ingest(rss())
    expect(db.entryCount()).toBe(3)
    db.saveLocalSubscription(backend.id, { id: endpoint.subscriptionId, title: 'Repaired', url: 'https://example.test/repaired' })
    const updated = rss(item('one', '/moved', 'Updated', '2024-01-01T00:00:00Z', '<p>Changed body</p>'))
    expect(resolvedId(ingest(updated, { requestUrl: 'https://example.test/repaired', responseUrl: 'https://redirect.test/final/feed', endpointGeneration: 'generation-2' }))).toBe(id)
    reopen()
    expect(resolvedId(ingest(updated, { requestUrl: 'https://example.test/repaired', responseUrl: 'https://redirect.test/final/feed', endpointGeneration: 'generation-2' }))).toBe(id)
    expect(db.localEntry(id)).toMatchObject({ title: 'Updated', url: 'https://redirect.test/moved', read: true, starred: true, readingPosition: 0.42, readwiseSavedAt: expect.any(String) })
    expect(db.entryState(id)?.revision).toBe(2)
    expect(db.discussion(id)?.messages[0].text).toBe('Keep this')
    expect(db.entryIdsForBriefing('briefing')).toEqual([id])
    expect(db.getBriefing('briefing')?.selection.news[0].entryIds).toEqual([id])
    expect(db.pulseCollections()[0].sources.map(source => source.id)).toContain(id)
    expect(db.getArticleForEntry(id)?.contentHtml).toContain('Cachedfulltext')
    expect(arrivals()).toEqual(initialArrivals)
    expect(sql(c => c.prepare('SELECT first_seen_at FROM entries WHERE id = ?').get(id)?.first_seen_at)).toBe(firstSeen)
  })
  it('retains backdated entries and separates source dates, durable arrival and successful fetch time', () => {
    const first = resolvedId(ingest())
    const second = resolvedId(ingest(rss(item('two', '/older', 'Older', '2001-01-01T00:00:00Z')), { fetchedAt: '2026-11-02T00:00:00Z' }))
    expect(db.localEntry(second)?.publishedAt).toBe('2001-01-01T00:00:00.000Z')
    expect(arrivals().map(row => row.entry_id)).toEqual([first, second])
    expect(db.syncEntryIds(all)).toEqual([second, first])
    expect(successfulFeedFetch(db, endpoint)?.fetchedAt).toBe('2026-11-02T00:00:00.000Z')
  })
  it('sorts undated articles by their first fetch without changing dates or identity on refetch', () => {
    const xml = rss(item('', '/undated', 'Undated', ''))
    const id = resolvedId(ingest(xml))
    const firstSeen = sql(c => c.prepare('SELECT first_seen_at FROM entries WHERE id = ?').get(id)?.first_seen_at)
    const firstFetch = Date.parse(fetchedAt)
    expect(db.localEntry(id)).toMatchObject({ publishedAt: '', timestamp: firstFetch, crawledAt: firstFetch })
    const newer = resolvedId(ingest(rss(item('newer', '/newer', 'Newer', '2026-11-02T00:00:00Z'))))
    expect(db.localEntriesPage(all).items.map(entry => entry.id)).toEqual([newer, id])
    reopen()
    expect(resolvedId(ingest(xml, { fetchedAt: '2026-11-03T00:00:00Z' }))).toBe(id)
    expect(db.localEntry(id)).toMatchObject({ publishedAt: '', timestamp: firstFetch, crawledAt: firstFetch })
    expect(db.localEntriesPage(all).items.map(entry => entry.id)).toEqual([newer, id])
    expect(sql(c => c.prepare('SELECT first_seen_at FROM entries WHERE id = ?').get(id)?.first_seen_at)).toBe(firstSeen)
    expect(resolvedId(ingest(rss(item('new-guid', '/undated', 'Undated', ''))))).toBe(id)
    expect(db.localEntry(id)?.timestamp).toBe(firstFetch)
  })
  it('uses the first fetch when a previously dated article loses its source date', () => {
    const id = resolvedId(ingest())
    ingest(rss(item()), { fetchedAt: '2026-11-02T00:00:00Z' })
    expect(resolvedId(ingest(rss(item('one', '/article', 'Original', '')), { fetchedAt: '2026-11-03T00:00:00Z' }))).toBe(id)
    expect(db.localEntry(id)).toMatchObject({ publishedAt: '', timestamp: Date.parse(fetchedAt), crawledAt: Date.parse(fetchedAt) })
  })
  it('imports reused GUIDs through fingerprints and keeps their identities on refetch', () => {
    const first = item('reused', '/first', 'First')
    const second = item('reused', '/second', 'Second')
    const initial = ingest(rss(first + second + first))
    expect(initial).toMatchObject({ resolved: 2, ambiguous: 0 })
    expect(initial.feed.entries.every(entry => entry.externalId === undefined)).toBe(true)
    const ids = initial.results.map(result => result.status === 'resolved' && result.id)
    reopen()
    const later = ingest(rss(second + first), { fetchedAt: '2026-11-03T00:00:00Z' })
    expect(later.results.map(result => result.status === 'resolved' && result.id)).toEqual([...ids].reverse())
    expect(db.entryCount()).toBe(2)
    expect(successfulFeedFetch(db, endpoint)?.fetchedAt).toBe('2026-11-03T00:00:00.000Z')
  })
  it('remembers conflicting GUIDs through the A, A+B, B sequence, restart and later refetches', () => {
    const a = item('g', '/a', 'A', '2024-01-01T00:00:00Z', '<p>Content A</p>')
    const b = item('g', '/b', 'B', '2024-01-02T00:00:00Z', '<p>Content B</p>')
    const aId = resolvedId(ingest(rss(a)))
    const together = ingest(rss(a + b))
    expect(together).toMatchObject({ resolved: 2, ambiguous: 0 })
    expect(together.results[0]).toMatchObject({ id: aId, created: false })
    const bResult = together.results[1]
    if (bResult.status !== 'resolved') throw new Error('Expected B to resolve')
    const bId = bResult.id
    expect(bId).not.toBe(aId)
    reopen()
    expect(resolvedId(ingest(rss(b)))).toBe(bId)
    const assertArticles = () => {
      expect(db.entryCount()).toBe(2)
      expect(db.localEntry(aId)).toMatchObject({ title: 'A', contentHtml: '<p>Content A</p>', url: 'https://example.test/a' })
      expect(db.localEntry(bId)).toMatchObject({ title: 'B', contentHtml: '<p>Content B</p>', url: 'https://example.test/b' })
    }
    assertArticles()
    db.saveLocalSubscription(backend.id, { id: endpoint.subscriptionId, title: 'Repaired', url: url + '/repaired' })
    endpoint.endpointGeneration = 'generation-2'
    for (const [xml, id] of [[b, bId], [a, aId], [b, bId]]) {
      expect(resolvedId(ingest(rss(xml), { requestUrl: url + '/repaired' }))).toBe(id)
      assertArticles()
    }
  })
  it('scopes remembered GUID conflicts to their subscription', () => {
    ingest(rss(item('g', '/a', 'A') + item('g', '/b', 'B')))
    const subscriptionId = db.saveLocalSubscription(backend.id, { title: 'Other', url })
    const id = resolvedId(ingest(rss(item('g', '/other', 'Other')), { subscriptionId }))
    expect(resolvedId(ingest(rss(item('g', '/moved', 'Updated')), { subscriptionId }))).toBe(id)
    expect(db.localEntry(id)?.title).toBe('Updated')
    expect(db.entryCount()).toBe(3)
  })
  it('rolls back articles and fetch success when saving conflicting GUIDs fails', () => {
    const id = resolvedId(ingest(rss(item('g', '/a', 'A'))))
    const saved = successfulFeedFetch(db, endpoint)
    const initialArrivals = arrivals()
    sql(c => c.exec("CREATE TRIGGER reject_conflicting_ids BEFORE INSERT ON backend_checkpoints WHEN NEW.key LIKE 'feed-conflicting-ids:%' BEGIN SELECT RAISE(ABORT, 'synthetic conflict checkpoint failure'); END"))
    expect(() => ingest(rss(item('g', '/a', 'Changed') + item('g', '/b', 'B')), { fetchedAt: '2026-11-05T00:00:00Z' })).toThrow(/synthetic conflict checkpoint/)
    expect(db.entryCount()).toBe(1)
    expect(db.localEntry(id)?.title).toBe('A')
    expect(arrivals()).toEqual(initialArrivals)
    expect(successfulFeedFetch(db, endpoint)).toEqual(saved)
    sql(c => c.exec('DROP TRIGGER reject_conflicting_ids'))
    reopen()
    expect(resolvedId(ingest(rss(item('g', '/moved', 'Updated'))))).toBe(id)
    expect(db.entryCount()).toBe(1)
  })
  it('never infers changed GUIDs from reused URLs, even with identical date and content', () => {
    const first = resolvedId(ingest())
    const second = resolvedId(ingest(rss(item('changed-guid'))))
    expect(second).not.toBe(first)
    expect(db.entryCount()).toBe(2)
    const otherSubscription = db.saveLocalSubscription(backend.id, { title: 'Other', url })
    expect(resolvedId(ingest(rss(item()), { subscriptionId: otherSubscription }))).not.toBe(first)
  })
  it('accepts explicit prior-ID evidence and retains both aliases across URL and content changes', () => {
    const id = resolvedId(ingest())
    const updated = rss(item('new-id', '/new-url', 'Updated'))
    expect(resolvedId(ingest(updated, { verifiedAliasChanges: [{ externalId: 'new-id', previousExternalIds: ['one'], evidence: 'Synthetic publisher change confirmed by operator' }] }))).toBe(id)
    expect(resolvedId(ingest(updated))).toBe(id)
    expect(resolvedId(ingest())).toBe(id)
    expect(() => ingest(updated, { verifiedAliasChanges: [{ externalId: 'new-id', previousExternalIds: ['one'], evidence: '' }] })).toThrow(/verified/)
  })
  it('records ambiguities without reconciling state and commits unrelated items with a successful checkpoint', () => {
    const first = resolvedId(ingest())
    const second = resolvedId(ingest(rss(item('two'))))
    db.commitLocalEntryState(backend.id, [first], 'star')
    const result = ingest(rss(item('') + item('three', '/unique')), { fetchedAt: '2026-11-04T00:00:00Z' })
    expect(result).toMatchObject({ resolved: 1, ambiguous: 1 })
    expect(result.results[0]).toMatchObject({ status: 'ambiguous', candidateIds: expect.arrayContaining([first, second]) })
    expect(db.entryCount()).toBe(3)
    expect(db.entryState(first)?.starred).toBe(true)
    expect(db.identities.conflicts(backend.id)).toHaveLength(1)
    expect(successfulFeedFetch(db, endpoint)?.fetchedAt).toBe('2026-11-04T00:00:00.000Z')
  })
  it('does not merge conflicting prior aliases', () => {
    const first = resolvedId(ingest())
    const second = resolvedId(ingest(rss(item('two', '/two'))))
    const result = ingest(rss(item('two')), { verifiedAliasChanges: [{ externalId: 'two', previousExternalIds: ['one'], evidence: 'Synthetic conflicting claim' }] })
    expect(result.ambiguous).toBe(1)
    expect(db.localEntry(second)?.url).toBe('https://example.test/two')
    expect(db.localEntry(first)?.url).toBe('https://example.test/article')
  })
  it('advances empty feeds, persists across restart, and scopes checkpoints by endpoint generation and subscription', () => {
    ingest(rss())
    reopen()
    expect(successfulFeedFetch(db, endpoint)).toMatchObject({ fetchedAt, requestUrl: url, responseUrl: url })
    expect(successfulFeedFetch(db, { ...endpoint, endpointGeneration: 'generation-2' })).toBeNull()
    expect(successfulFeedFetch(db, { ...endpoint, subscriptionId: 'another' })).toBeNull()
    expect(() => ingest(rss(), { subscriptionId: 'unknown' })).toThrow(/Subscription/)
    expect(() => ingest(rss(), { backendId: 'other' })).toThrow(/active/)
    expect(() => ingest(rss(), { endpointGeneration: '' })).toThrow(/generation/)
  })
  it('rolls back entries, aliases and checkpoint on an unidentified item, then recovers', () => {
    ingest(rss())
    const saved = successfulFeedFetch(db, endpoint)
    expect(() => ingest(rss(item('new') + '<item><description>No identifying fields</description></item>'), { fetchedAt: '2026-11-05T00:00:00Z' })).toThrow(/source ID/)
    expect(db.entryCount()).toBe(0)
    expect(sql(c => c.prepare('SELECT COUNT(*) AS n FROM article_aliases').get()?.n)).toBe(0)
    expect(successfulFeedFetch(db, endpoint)).toEqual(saved)
    expect(ingest().resolved).toBe(1)
  })
  it('rolls back content updates, new aliases, arrivals and conflicts when checkpoint persistence fails', () => {
    const id = resolvedId(ingest())
    ingest(rss(item('second')))
    const saved = successfulFeedFetch(db, endpoint)
    const initialArrivals = arrivals()
    sql(c => c.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON backend_checkpoints BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END"))
    expect(() => ingest(rss(item('') + item('one', '/changed', 'Changed') + item('new', '/new')))).toThrow(/synthetic checkpoint/)
    expect(db.entryCount()).toBe(2)
    expect(db.identities.conflicts(backend.id)).toEqual([])
    expect(db.localEntry(id)?.title).toBe('Original')
    expect(sql(c => c.prepare('SELECT COUNT(*) AS n FROM article_aliases').get()?.n)).toBe(2)
    expect(arrivals()).toEqual(initialArrivals)
    expect(successfulFeedFetch(db, endpoint)).toEqual(saved)
    sql(c => c.exec('DROP TRIGGER reject_checkpoint'))
    expect(ingest(rss(item('new', '/new'))).resolved).toBe(1)
  })
  it('rejects malformed XML before changing stored content or fetch success', () => {
    const id = resolvedId(ingest())
    const saved = successfulFeedFetch(db, endpoint)
    expect(() => ingest(rss(item('one', '/changed')) + '<broken>')).toThrow(/Malformed/)
    expect(db.localEntry(id)?.url).toBe('https://example.test/article')
    expect(successfulFeedFetch(db, endpoint)).toEqual(saved)
  })
})
