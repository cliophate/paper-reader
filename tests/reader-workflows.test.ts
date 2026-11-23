import { parseSearch } from '../src/server/search-query.js'
import { Worker } from 'node:worker_threads'
import * as regex from '../src/server/rule-regex.js'
import { hasRegexRules, migrateRegexRules, REGEX_RULES_VERSION } from '../src/server/rule-regex.js'
import { RULES_VERSION } from '../src/server/article-rules.js'
import { DATABASE_VERSION } from '../src/server/auth-schema.js'
import { ANNOTATIONS_PER_ARTICLE } from '../src/server/annotations'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { parseFeedPreview } from '../src/server/feed-repair'
import type { Entry } from '../src/server/types'
let directory: string
let db: PaperDatabase
const all = { kind: 'all' as const, id: 'all', title: 'All articles' }
const article = (n: number, extra: Partial<Entry> = {}): Entry => ({
  id: String(n), feedId: 'feed/1', feedTitle: 'One', feedUrl: 'https://example.test/feed', title: `Compositor report ${n}`,
  author: 'Writer', url: `https://example.test/${n}`, contentHtml: '<p>A short teaser.</p>', excerpt: 'A short teaser',
  publishedAt: new Date(n * 1000).toISOString(), timestamp: n * 1000, crawledAt: n * 1000, read: false, starred: false,
  readingMinutes: 1, thumbnailUrl: '', kind: 'article', ...extra,
})

// Large preview fixtures exercise stored rows, indexes and triggers. Seed them
// directly to avoid repeating ingestion's HTML parsing and cache lookups.
function seedPreviewArticles(entries: Entry[]) {
  const sql = new DatabaseSync(path.join(directory, 'test.sqlite'))
  try {
    sql.exec('PRAGMA foreign_keys = ON; BEGIN')
    const insert = sql.prepare(`INSERT INTO entries (
      id, feed_id, feed_title, feed_url, title, author, url, canonical_url,
      source_domain, content_html, content_text, excerpt, published_at, timestamp,
      crawled_at, reading_minutes, thumbnail_url, kind, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'example.test', ?, 'A short teaser.', ?, ?, ?, ?, ?, ?, ?, '')`)
    const state = sql.prepare('UPDATE entry_state SET read=?, starred=? WHERE entry_id=?')
    for (const entry of entries) {
      insert.run(entry.id, entry.feedId, entry.feedTitle, entry.feedUrl, entry.title, entry.author,
        entry.url, entry.url, entry.contentHtml, entry.excerpt, entry.publishedAt, entry.timestamp,
        entry.crawledAt || entry.timestamp,
        entry.readingMinutes, entry.thumbnailUrl, entry.kind)
      if (entry.read || entry.starred) state.run(Number(entry.read), Number(entry.starred), entry.id)
    }
    sql.exec('COMMIT')
  } finally {
    sql.close()
  }
}

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-workflows-')); db = new PaperDatabase(path.join(directory, 'test.sqlite')) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('reading across changing lists', () => {
  it.each(['title', 'content', 'any'] as const)('uses the same Unicode mute matching for preview, backfill and ingestion in %s', async scope => {
    const fields = scope === 'title' ? { title: 'ÉCOLE' } : scope === 'content' ? { contentHtml: '<p>ÉCOLE</p>' } : { author: 'ÉCOLE' }
    db.upsertEntries([article(1, fields), article(2, { ...fields, feedId: 'feed/other' }), article(3)])
    expect((await db.previewMuteFilter('école', scope, 'feed/1')).count).toBe(1)
    const filter = await db.createMuteFilter('école', scope, 'feed/1')
    await db.backfillMuteFilters()
    expect(filter).toMatchObject({ matching: true, matchCount: 0 })
    expect(db.muteFilters()[0]).toMatchObject({ matching: false, matchCount: 1 })
    db.upsertEntries([article(4, fields)])
    expect(db.muteFilters()[0].matchCount).toBe(2)
    expect((await db.previewMuteFilter('école', scope, 'feed/1')).count).toBe(2)
    expect(db.localEntriesPage(all).items.map(item => item.id).sort()).toEqual(['2', '3'])
    expect(db.localNavigation().unread).toBe(2)
  })

  it.each(['title', 'content', 'any'] as const)('matches an ASCII phrase against the Kelvin sign in %s', async scope => {
    const fields = scope === 'title' ? { title: 'KELVIN science' } : scope === 'content' ? { contentHtml: '<p>KELVIN science</p>' } : { author: 'KELVIN science' }
    db.upsertEntries([article(1, fields)])
    expect(await db.previewMuteFilter('kelvin', scope)).toMatchObject({ count: 1, truncated: false })
    await db.createMuteFilter('kelvin', scope)
    await db.backfillMuteFilters()
    expect(db.muteFilters()[0]).toMatchObject({ matchCount: 1, matching: false })
    db.upsertEntries([article(1, fields), article(2, fields)])
    expect(db.muteFilters()[0].matchCount).toBe(2)
    expect(db.localEntriesPage(all).items).toEqual([])
  })

  it('repairs legacy ASCII filters, including checkpoints completed by the SQL matcher', async () => {
    db.upsertEntries([article(1, { title: 'KELVIN science' })])
    const legacy = new DatabaseSync(path.join(directory, 'test.sqlite'))
    legacy.exec(`INSERT INTO mute_filters VALUES ('old', 'kelvin', 'title', '', '2026-01-01');
      INSERT INTO mute_filters VALUES ('completed', 'kelvin', 'title', '', '2026-01-01');
      INSERT INTO sync_state VALUES ('mute_unicode_v1:completed', 'done')`)
    legacy.close()
    await db.backfillMuteFilters()
    expect(db.muteFilters().map(filter => [filter.matchCount, filter.matching])).toEqual([[1, false], [1, false]])
    const events = db.activity().length
    await db.backfillMuteFilters()
    expect(db.activity()).toHaveLength(events)
  })

  it('returns pending creations before scanning and shares one runner with additions between batches', async () => {
    db.upsertEntries(Array.from({ length: 700 }, (_, n) => article(n, { title: 'KELVIN science' })))
    const first = await db.createMuteFilter('kelvin', 'title')
    const running = db.backfillMuteFilters()
    expect(db.backfillMuteFilters()).toBe(running)
    expect(first).toMatchObject({ matchCount: 0, matching: true })
    expect(db.activity()).toHaveLength(0)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(db.muteFilters()[0]).toMatchObject({ matchCount: 256, matching: true })
    const second = await db.createMuteFilter('science', 'title')
    expect(second.matching).toBe(true)
    expect(db.backfillMuteFilters()).toBe(running)
    await running
    expect(db.muteFilters().map(filter => [filter.matchCount, filter.matching])).toEqual([[700, false], [700, false]])
    expect(db.activity()).toHaveLength(2)
    expect(db.activity().map(event => event.count)).toEqual([700, 700])
  })

  it.each([false, true])('deletes only the filter checkpoint, completed: %s', async completed => {
    db.upsertEntries(Array.from({ length: 700 }, (_, n) => article(n)))
    const filter = await db.createMuteFilter('report', 'title')
    const running = db.backfillMuteFilters()
    if (completed) await running
    else await new Promise<void>(resolve => setImmediate(resolve))
    expect(db.getSyncValue(`mute_unicode_v1:${filter.id}`)).not.toBe('')
    db.setSyncValue(`mute_unicode_v1:${filter.id}:other`, 'keep')
    expect(db.deleteMuteFilter(filter.id)).toBe(true)
    await running
    expect(db.getSyncValue(`mute_unicode_v1:${filter.id}`)).toBe('')
    expect(db.getSyncValue(`mute_unicode_v1:${filter.id}:other`)).toBe('keep')
    expect(db.localEntries(all, { limit: 1000 })).toHaveLength(700)
    db.close()
    db = new PaperDatabase(path.join(directory, 'test.sqlite'))
    await db.backfillMuteFilters()
    expect(db.getSyncValue(`mute_unicode_v1:${filter.id}`)).toBe('')
    expect(db.muteFilters()).toEqual([])
  })

  it('previews newest matches before the budget and applies feed scope before scanning', async () => {
    seedPreviewArticles(Array.from({ length: 11_000 }, (_, n) => article(n, {
      title: n >= 10_990 ? 'KELVIN science' : 'Older article', feedId: n >= 10_990 ? 'feed/recent' : 'feed/1',
    })))
    const preview = await db.previewMuteFilter('kelvin', 'title')
    expect(preview).toMatchObject({ count: 10, truncated: true })
    expect(preview.items.map(item => item.id)).toEqual(['10999', '10998', '10997', '10996', '10995', '10994', '10993', '10992'])
    const scoped = await db.previewMuteFilter('older', 'title', 'feed/1')
    expect(scoped.items[0].id).toBe('10989')
    // Old scoped rows must still be reached even behind more than a budget of other feeds.
    db.upsertEntries([article(-1, { title: 'KELVIN science', feedId: 'feed/old' })])
    expect(await db.previewMuteFilter('kelvin', 'title', 'feed/old')).toMatchObject({ count: 1, truncated: false, items: [expect.objectContaining({ id: '-1' })] })
    expect(await db.previewMuteFilter('kelvin', 'title', 'feed/recent')).toMatchObject({ count: 10, truncated: false })
  })

  it('uses indexed preview keysets and orders equal timestamps by id', async () => {
    db.upsertEntries(Array.from({ length: 300 }, (_, n) => article(n, { timestamp: 1000 })))
    const sql = new DatabaseSync(path.join(directory, 'test.sqlite'))
    for (const feed of [false, true]) {
      const plan = sql.prepare(`EXPLAIN QUERY PLAN SELECT id, timestamp, feed_id, title FROM entries
        WHERE ${feed ? 'feed_id = ? AND' : ''} (timestamp, id) < (?, ?)
        ORDER BY timestamp DESC, id DESC LIMIT 256`).all(...(feed ? ['feed/1'] : []), 2000, '300')
      const detail = plan.map(row => row.detail).join(' ')
      expect(detail).toContain(feed ? 'entries_feed_published_idx' : 'entries_published_idx')
      expect(detail).not.toContain('TEMP B-TREE')
    }
    sql.close()
    const preview = await db.previewMuteFilter('report', 'title')
    expect(preview).toMatchObject({ count: 300, truncated: false })
    expect(preview.items.map(item => item.id)).toEqual(Array.from({ length: 300 }, (_, n) => String(n)).sort().reverse().slice(0, 8))
  })

  it('repairs legacy Unicode matches, resumes after shutdown and is idempotent', async () => {
    db.upsertEntries(Array.from({ length: 700 }, (_, n) => article(n, { title: n % 2 ? 'ÉCOLE' : 'école' })))
    const legacy = new DatabaseSync(path.join(directory, 'test.sqlite'))
    legacy.exec(`INSERT INTO mute_filters VALUES ('legacy', 'école', 'title', '', '2026-01-01');
      INSERT INTO muted_entries SELECT 'legacy', id FROM entries WHERE instr(lower(title), lower('école')) > 0`)
    expect(db.muteFilters()[0].matchCount).toBe(350)
    const backfill = db.backfillMuteFilters()
    await new Promise<void>(resolve => setImmediate(resolve))
    const progress = db.getSyncValue('mute_unicode_v1:legacy')
    expect(JSON.parse(progress)).toMatchObject({ cursor: 256, end: 700 })
    db.close()
    await backfill
    db = new PaperDatabase(path.join(directory, 'test.sqlite'))
    await db.backfillMuteFilters()
    expect(db.muteFilters()[0].matchCount).toBe(700)
    expect(db.getSyncValue('mute_unicode_v1:legacy')).toBe('done')
    expect(db.localEntriesPage(all).items).toEqual([])
    await db.backfillMuteFilters()
    expect(db.muteFilters()[0].matchCount).toBe(700)
    legacy.close()
  })

  it('publishes a new rule before backfill and matches entries ingested between batches', async () => {
    db.upsertEntries(Array.from({ length: 600 }, (_, n) => article(n, { contentHtml: '<p>ÉCOLE</p>' })))
    const creating = db.createMuteFilter('école', 'content')
    db.upsertEntries([article(700, { contentHtml: '<p>ÉCOLE</p>' }), article(0, { contentHtml: '<p>ÉCOLE updated</p>' })])
    expect(await creating).toMatchObject({ matching: true, matchCount: 0 })
    await db.backfillMuteFilters()
    expect(db.muteFilters()[0]).toMatchObject({ matching: false, matchCount: 601 })
    expect(db.localEntriesPage(all).items).toEqual([])
  })

  it('resumes an interrupted creation after restart and logs completion once', async () => {
    db.upsertEntries(Array.from({ length: 700 }, (_, n) => article(n)))
    const filter = await db.createMuteFilter('report', 'title')
    const running = db.backfillMuteFilters()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(db.muteFilters()[0]).toMatchObject({ matchCount: 256, matching: true })
    db.close()
    await running
    db = new PaperDatabase(path.join(directory, 'test.sqlite'))
    expect(JSON.parse(db.getSyncValue(`mute_unicode_v1:${filter.id}`))).toMatchObject({ cursor: 256, end: 700 })
    await db.backfillMuteFilters()
    expect(db.muteFilters()[0]).toMatchObject({ matchCount: 700, matching: false })
    expect(db.activity().map(event => event.count)).toEqual([700])
    await db.backfillMuteFilters()
    expect(db.activity()).toHaveLength(1)
  })

  it('reports a lower bound when a preview reaches the scan limit', async () => {
    seedPreviewArticles(Array.from({ length: 10_240 }, (_, n) => article(n, { title: 'ÉCOLE' })))
    expect(await db.previewMuteFilter('école', 'title')).toMatchObject({ count: 10_240, truncated: false })
    db.upsertEntries(Array.from({ length: 60 }, (_, n) => article(10_240 + n, { title: 'ÉCOLE' })))
    const preview = await db.previewMuteFilter('école', 'title')
    expect(preview.truncated).toBe(true)
    expect(preview.count).toBeGreaterThan(0)
    expect(preview.count).toBeLessThanOrEqual(10_240)
    expect(preview.items).toHaveLength(8)
    expect(db.muteFilters()).toEqual([])
  })

  it.each(['newest', 'oldest'] as const)('pages backward from the true end with unread and mute filters, %s first', async order => {
    db.upsertEntries(Array.from({ length: 205 }, (_, n) => article(n + 1, { read: n % 2 === 0 })))
    await db.createMuteFilter('report 2', 'title')
    await db.backfillMuteFilters()
    const stream = { kind: 'feed' as const, id: 'feed/1', title: 'One' }
    db.setStreamOrder(stream, order)
    const expected = db.localEntriesPage(stream, { unreadOnly: true, limit: 250 }).items.map(item => item.id).reverse()
    const first = db.localEntriesPage(stream, { unreadOnly: true, limit: 80, reverse: true })
    expect(first.items.map(item => item.id)).toEqual(expected.slice(0, 80))
    const second = db.localEntriesPage(stream, { unreadOnly: true, limit: 80, reverse: true, continuation: first.continuation })
    expect(second.items.map(item => item.id)).toEqual(expected.slice(80))
    expect(second.continuation).toBe('')
  })

  it.each(['newest', 'oldest'] as const)('does not skip unread items after reading a page, %s first', order => {
    db.upsertEntries([1, 2, 3, 4, 5].map(n => article(n)))
    db.setStreamOrder(all, order)
    const first = db.localEntriesPage(all, { unreadOnly: true, limit: 2 })
    db.editLocalEntryState(first.items.map(item => item.id), 'read')
    db.upsertEntries([article(order === 'newest' ? 6 : 0)])
    const second = db.localEntriesPage(all, { unreadOnly: true, limit: 2, continuation: first.continuation })
    expect(second.items.map(item => item.id)).toEqual(order === 'newest' ? ['3', '2'] : ['3', '4'])
    const last = db.localEntriesPage(all, { unreadOnly: true, limit: 2, continuation: second.continuation })
    expect(last.items.map(item => item.id)).toEqual(order === 'newest' ? ['1'] : ['5'])
  })
  it('holds search ordering while entries are read, muted and added', async () => {
    db.upsertEntries([1, 2, 3, 4, 5].map(n => article(n)))
    const first = db.localEntriesPage(all, { query: 'compositor', unreadOnly: true, limit: 2 })
    db.editLocalEntryState(first.items.map(item => item.id), 'read')
    await db.createMuteFilter('report 3', 'title')
    await db.backfillMuteFilters()
    db.upsertEntries([article(6)])
    const next = db.localEntriesPage(all, { query: 'compositor', unreadOnly: true, limit: 2, continuation: first.continuation })
    expect(next.items.map(item => item.id)).toEqual(['2', '1'])
    expect(() => db.localEntriesPage(all, { query: 'other', continuation: first.continuation })).toThrow('Refresh')
  })
  it('bounds search and bulk candidates by feed, dates, unread state and mute filters', async () => {
    db.upsertEntries([article(1), article(2), article(3, { feedId: 'feed/2' }), article(4, { read: true }), article(5)])
    await db.createMuteFilter('report 5', 'title')
    await db.backfillMuteFilters()
    const scope = { kind: 'feed' as const, id: 'feed/1', title: 'One' }
    const options = { query: 'compositor', unreadOnly: true, after: new Date(2000).toISOString(), before: new Date(6000).toISOString() }
    expect(db.matchingEntryIds(scope, options)).toEqual(['2'])
    expect(db.localEntriesPage(scope, options).items.map(item => item.id)).toEqual(['2'])
  })
  it('searches extracted content after resync and restart while retaining the feed version', () => {
    db.upsertEntries([article(1)])
    db.cacheArticle({ url: article(1).url, title: 'Full report', byline: '', excerpt: '', contentHtml: '<p>A peculiar window manager.</p>', readingMinutes: 5, fetchedAt: new Date().toISOString() })
    db.upsertEntries([article(1, { contentHtml: '<p>A revised teaser.</p>' })])
    db.close(); db = new PaperDatabase(path.join(directory, 'test.sqlite'))
    const result = db.localEntriesPage(all, { query: 'peculiar' }).items[0]
    expect(result.id).toBe('1')
    expect(result.searchExcerpt).toContain('peculiar')
    expect(result.contentHtml).toContain('revised teaser')
  })
  it('keeps progress and Readwise saves independently of read state', () => {
    db.upsertEntries([article(1), article(2)])
    db.saveReadingProgress('1', 0.42)
    db.recordReadwiseSave(article(1).url)
    db.close(); db = new PaperDatabase(path.join(directory, 'test.sqlite'))
    expect(db.recentReading()[0]).toMatchObject({ id: '1', readingPosition: 0.42, read: false, readwiseSavedAt: expect.any(String) })
    expect(db.localEntry('2')?.readwiseSavedAt).toBeUndefined()
  })
  it('migrates cached text in bulk without duplicating search rows or changing article state', () => {
    db.upsertEntries(Array.from({ length: 120 }, (_, index) => article(index + 1, { read: index % 2 === 0, starred: index === 0 })))
    for (let n = 1; n <= 60; n++) db.cacheArticle({ url: article(n).url, title: 'Full report', byline: '', excerpt: '', contentHtml: '<p>Migratedword in a full article.</p>', readingMinutes: 5, fetchedAt: new Date().toISOString() })
    db.saveReadingProgress('1', 0.42)
    db.close()
    const legacy = new DatabaseSync(path.join(directory, 'test.sqlite'))
    legacy.exec("UPDATE entries SET full_content_text = ''; DELETE FROM sync_state WHERE key = 'fulltext_search_v1';")
    legacy.close()
    db = new PaperDatabase(path.join(directory, 'test.sqlite'))
    expect(db.matchingEntryIds(all, { query: 'migratedword' })).toHaveLength(60)
    expect(db.matchingEntryIds(all, { query: 'compositor' })).toHaveLength(120)
    expect(db.localEntry('1')).toMatchObject({ read: true, starred: true, readingPosition: 0.42, contentHtml: '<p>A short teaser.</p>' })
    db.upsertEntries([article(1, { title: 'Updatedword report', read: true, starred: true })])
    expect(db.matchingEntryIds(all, { query: 'updatedword' })).toEqual(['1'])
    db.close(); db = new PaperDatabase(path.join(directory, 'test.sqlite'))
    expect(db.matchingEntryIds(all, { query: 'migratedword' })).toHaveLength(60)
    expect(db.matchingEntryIds(all, { query: 'compositor' })).toHaveLength(119)
  })
  it('previews filter matches without changing visibility or read state', async () => {
    db.upsertEntries([article(1), article(2, { feedId: 'feed/2' })])
    expect(await db.previewMuteFilter('compositor', 'title', 'feed/1')).toMatchObject({ count: 1, items: [expect.objectContaining({ id: '1' })] })
    expect(db.localEntriesPage(all).items).toHaveLength(2)
    expect(db.muteFilters()).toHaveLength(0)
    expect(db.unreadCount()).toBe(2)
  })
})

describe('replacement feed preview', () => {
  it('reads RSS and namespaced Atom titles without executing markup', () => {
    expect(parseFeedPreview('<rss version="2.0"><channel><title>Feed</title><item><title>First &amp; second</title><pubDate>2024-01-01</pubDate></item></channel></rss>', 'https://example.test/rss')).toMatchObject({ title: 'Feed', items: [{ title: 'First & second', date: '2024-01-01T00:00:00.000Z' }] })
    expect(parseFeedPreview('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>Post</title><updated>2026-09-23</updated></entry></feed>', 'https://example.test/atom').items[0].title).toBe('Post')
  })
  it('rejects website pages, malformed feeds and entity declarations', () => {
    for (const value of ['<html><title>Website</title></html>', '<rss><broken>', '<!DOCTYPE rss [<!ENTITY test SYSTEM "file:///etc/passwd">]><rss/>']) expect(() => parseFeedPreview(value, 'https://example.test/feed')).toThrow()
  })
})

it('upgrades schema v23 before adding annotations and restores highlights and notes with the database', () => {
  db.upsertEntries([article(1)])
  db.greaderDatabase.exec('DROP TABLE annotations; PRAGMA user_version = 23')
  db.close()
  const file = path.join(directory, 'test.sqlite')
  db = new PaperDatabase(file)
  expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
  const backup = file + '.before-annotations-v24'
  expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
  const previous = new DatabaseSync(backup, { readOnly: true })
  try {
    expect(previous.prepare('PRAGMA user_version').get()?.user_version).toBe(23)
    expect(previous.prepare("SELECT 1 FROM sqlite_master WHERE name = 'annotations'").get()).toBeUndefined()
    expect(previous.prepare("SELECT title FROM entries WHERE id = '1'").get()?.title).toBe(article(1).title)
  } finally { previous.close() }
  const parentId = db.annotations.create({ entryId: '1', anchor: { body: 'feed',
    quote: { exact: 'short', prefix: 'A ', suffix: ' teaser.' }, position: { start: 2, end: 7 } } })
  db.annotations.create({ entryId: '1', parentId, note: 'A synthetic note.' })
  const restoredFile = path.join(directory, 'restored.sqlite')
  db.greaderDatabase.prepare('VACUUM INTO ?').run(restoredFile)
  const restored = new PaperDatabase(restoredFile)
  try {
    expect(restored.annotations.list()).toEqual(db.annotations.list())
    expect(restored.annotations.list().items.map(item => item.parentId)).toEqual([parentId, null])
  } finally { restored.close() }
})

it('caps annotations within each article and pages through notes without duplicating the parent quote', () => {
  db.upsertEntries([article(1), article(2)])
  const anchor = { body: 'feed' as const, quote: { exact: 'short', prefix: '', suffix: '' }, position: { start: 0, end: 5 } }
  const parentId = db.annotations.create({ entryId: '1', anchor })
  for (let index = 1; index < ANNOTATIONS_PER_ARTICLE; index++)
    db.annotations.create({ entryId: '1', parentId, note: 'Note ' + index })
  expect(() => db.annotations.create({ entryId: '1', note: 'Over limit' })).toThrow(/limit of 500/)
  db.annotations.create({ entryId: '2', note: 'Separate article' })
  const first = db.annotations.list()
  expect(first.items).toHaveLength(50)
  expect(first.parents).toEqual({ [parentId]: anchor })
  expect(first.items.every(item => item.anchor === null)).toBe(true)
  const ids = first.items.map(item => item.id)
  let next = first.next
  while (next) {
    const page = db.annotations.list(undefined, next)
    ids.push(...page.items.map(item => item.id))
    next = page.next
  }
  expect(new Set(ids).size).toBe(ANNOTATIONS_PER_ARTICLE + 1)
  expect(ids).toHaveLength(ANNOTATIONS_PER_ARTICLE + 1)
  expect(db.annotations.articleIds('')).toEqual(['1', '2'])
  expect(db.annotations.articleIds('1')).toEqual(['2'])
})

it('yields between arrival batches and matches grouped FTS terms only on new rows', async () => {
  db.upsertEntries([article(0)])
  const id = await db.rules.save({ query: '(title:compos OR author:ada) -url:/99 is:unread', actions: ['hide'] })
  const select = vi.spyOn(StatementSync.prototype, 'all')
  let midBatchCount = 0
  setImmediate(() => { midBatchCount = db.entryCount() })
  try {
    await db.upsertEntriesInChunks(Array.from({ length: 513 }, (_, i) => article(i, { read: i % 2 === 0 })))
    const queries = select.mock.contexts.map(statement => statement.sourceSQL).filter(sql => sql.includes('rule_words MATCH'))
    expect(queries).toHaveLength(5)
    expect(queries.every(sql => sql.match(/ MATCH /g)?.length === 1)).toBe(true)
    const matchIndex = select.mock.contexts.findIndex(statement => statement.sourceSQL === queries[0])
    const plan = db.greaderDatabase.prepare('EXPLAIN QUERY PLAN ' + queries[0]).all(...select.mock.calls[matchIndex])
    expect(plan.map(row => row.detail).filter(detail => String(detail).includes('entry_state')))
      .toEqual([expect.stringMatching(/SEARCH entry_state .*\(entry_id=\?\)/)])
  } finally { select.mockRestore() }
  expect(midBatchCount).toBeGreaterThan(1)
  expect(midBatchCount).toBeLessThan(513)
  expect(db.muteFilters(id)[0].matchCount).toBe(255)
})

it('upgrades literal hide rules without retokenizing their phrases or losing hidden articles', async () => {
  db.upsertEntries([article(1, { title: 'PreKelvin' }), article(2, { title: 'prekelvin', feedId: 'other' })])
  const { id } = await db.createMuteFilter('kelvin', 'title', 'feed/1')
  await db.backfillMuteFilters()
  const file = path.join(directory, 'test.sqlite')
  db.greaderDatabase.exec(`DROP TRIGGER rule_defaults; DROP TABLE rule_undo; DROP TABLE rule_remote_state; DROP TABLE article_rules; PRAGMA user_version=${RULES_VERSION - 1}`)
  db.close()
  db = new PaperDatabase(file)
  expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
  const backup = new DatabaseSync(file + '.before-article-rules-v' + RULES_VERSION, { readOnly: true })
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(RULES_VERSION - 1)
    expect(backup.prepare('SELECT filter_id FROM muted_entries').get()?.filter_id).toBe(id)
  } finally { backup.close() }
  expect(db.muteFilters()).toMatchObject([{ id, actions: ['hide'], matching: false, matchCount: 1 }])
  db.upsertEntries([article(3, { title: 'midKELVINword' })])
  expect(db.rules.hidden(id, '').items.map(item => item.id)).toEqual(['1', '3'])
})

it('combines regex and ordinary terms in preview, archive scans and arrivals', async () => {
  const query = '(title~/report (1|3)$/i OR ~/teaser/) NOT (is:read OR author~/^Lee$/)'
  const entries = [article(1), article(2, { author: 'Lee' }), article(3, { read: true }), article(4)]
  db.upsertEntries(entries)
  expect(await db.rules.previewRegex(parseSearch(query, 'rule').root)).toMatchObject({ ids: ['4', '1'], count: 2 })
  const id = await db.rules.save({ query, actions: ['hide'], applyExisting: true })
  await db.backfillMuteFilters()
  expect(db.rules.hidden(id, '').items.map(row => row.id)).toEqual(['1', '4'])
  await db.upsertEntriesInChunks([article(5), article(6, { author: 'Lee' })])
  await db.rules.drainRegex()
  expect(db.muteFilters(id)[0].matchCount).toBe(3)
  await expect(db.rules.save({ query: 'title~/(invalid/', actions: ['hide'] })).rejects.toThrow(/Invalid regular expression/)
  expect(() => db.savedViews.save({ title: 'Example', query })).toThrow(/Regex only works in hide rules/)
  expect(() => parseSearch(query)).toThrow(/Regex only works in hide rules/)
})

it('records skipped batches and disables a rule after three consecutive timeouts', async () => {
  const id = await db.rules.save({ query: 'title~/report/', actions: ['hide'] })
  // Withhold the batch after the worker signals readiness. This exercises the
  // actual deadline and termination without relying on a machine's regex speed.
  const send = Worker.prototype.postMessage
  let stall = true
  let attempts = 0
  const messages = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message) {
    if (message?.expression) { attempts++; if (stall) return }
    send.call(this, message)
  })
  try {
    await expect(db.rules.save({ query: 'url~/report/', actions: ['hide'] })).rejects.toThrow(/exceeded 50 ms/)
    expect(db.rules.count()).toBe(1)
    for (let i = 1; i <= 6; i++) {
      stall = i !== 2
      await db.upsertEntriesInChunks([article(i)])
      await db.rules.drainRegex()
    }
    expect(attempts).toBe(6)
    expect(db.muteFilters(id)[0]).toMatchObject({ disabled: true, matching: false, matchCount: 1 })
    expect(db.activity().filter(event => event.details.ruleId === id).map(event => event.details.failures)).toEqual([3, 2, 1, 1])
  } finally { messages.mockRestore() }
})

it('resumes a hide-only rule from its arrival cursor after restart', async () => {
  db.upsertEntries([article(1)])
  const query = 'author~/writer/i'
  for (const actions of [['star'], ['hide', 'read'], ['hide', 'notify']]) {
    await expect(db.rules.save({ query, actions })).rejects.toThrow(/only hide/)
  }
  const id = await db.rules.save({ query, actions: ['hide'] })
  db.upsertEntries([article(2, { starred: true }), article(3)])
  db.editLocalEntryState(['2'], 'unstar')
  db.close()
  db = new PaperDatabase(path.join(directory, 'test.sqlite'))
  await Promise.all([db.backfillMuteFilters(), db.rules.drainRegex()])
  expect(db.rules.hidden(id, '').items.map(row => row.id)).toEqual(['2', '3'])
  expect(db.localEntry('2')).toMatchObject({ read: false, starred: false })
  expect(db.rules.takeRemote('star', 'Synthetic').ids).toEqual([])
  expect(db.rules.takeRemote('read', 'Synthetic').ids).toEqual([])
})

it.each(['startup', 'matching'] as const)('retries worker exits during %s without another import', async phase => {
  const id = await db.rules.save({ query: 'author~/writer/i', actions: ['hide'] })
  const send = Worker.prototype.postMessage
  let exits = 0
  const messages = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message) {
    if ((phase === 'startup' ? message?.snapshot : message?.expression) && exits++ < 2) { void this.terminate(); return }
    send.call(this, message)
  })
  try {
    await db.upsertEntriesInChunks([article(1)])
    await vi.waitFor(() => expect(db.muteFilters(id)[0].matchCount).toBe(1), { timeout: 5000 })
    expect(exits).toBe(3)
  } finally { messages.mockRestore() }
})

it('disables an unavailable worker rule after bounded retries and leaves ingestion successful', async () => {
  const id = await db.rules.save({ query: 'title~/report/', actions: ['hide'] })
  const messages = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker) { void this.terminate() })
  try {
    await db.upsertEntriesInChunks([article(1)])
    await vi.waitFor(() => expect(db.muteFilters(id)[0].disabled).toBe(true), { timeout: 5000 })
    expect(messages).toHaveBeenCalledTimes(3)
    expect(db.activity()[0].details.reason).toMatch(/could not start/)
  } finally { messages.mockRestore() }
})

it('shares snapshots for overlapping rules and splits oversized batches without losing matches', async () => {
  const rules = []
  for (const query of ['title~/report|界/', 'text~/teaser|界/']) rules.push(await db.rules.save({ query, actions: ['hide'] }))
  const messages = vi.spyOn(Worker.prototype, 'postMessage')
  try {
    db.upsertEntries([article(1)])
    await db.rules.drainRegex()
    expect(messages.mock.calls.filter(([message]) => message?.snapshot)).toHaveLength(1)
    expect(rules.map(id => db.muteFilters(id)[0].matchCount)).toEqual([1, 1])
    const long = '界'.repeat(4096)
    db.upsertEntries(Array.from({ length: 128 }, (_, i) => article(i + 2, { title: long, contentHtml: long })))
    await db.rules.drainRegex()
    expect(rules.map(id => db.muteFilters(id)[0])).toMatchObject([
      { matching: false, matchCount: 129 }, { matching: false, matchCount: 129 },
    ])
    expect(db.activity().filter(event => String(event.details.reason).includes('2 MiB'))).toHaveLength(0)
    expect((await db.rules.previewRegex(parseSearch('~/界/', 'rule').root)).count).toBe(128)
  } finally { messages.mockRestore() }
})

it('defers a rule when its SQL terms would overflow the shared queue', async () => {
  const ids = []
  for (const query of ['is:unread text~/𠀀/', 'is:unread text~/^𠀀/']) {
    ids.push(await db.rules.save({ query, actions: ['hide'] }))
  }
  // These 128 rows leave room for one set of SQL term results in the 2 MiB job.
  seedPreviewArticles(Array.from({ length: 128 }, (_, i) => article(i + 1)))
  db.greaderDatabase.prepare('UPDATE entries SET content_text=?').run('𠀀'.repeat(4072))
  const messages = vi.spyOn(Worker.prototype, 'postMessage')
  try {
    await db.rules.drainRegex()
    expect(messages.mock.calls.filter(([message]) => message?.snapshot)).toHaveLength(2)
    for (const id of ids) expect(db.muteFilters(id)[0]).toMatchObject({ matching: false, matchCount: 128 })
    expect(db.activity()).toHaveLength(0)
  } finally { messages.mockRestore() }
})

it('logs only the individual arrival that cannot fit the worker budget', async () => {
  const id = await db.rules.save({ query: 'title~/report/', actions: ['hide'] })
  const snapshot = regex.regexSnapshot
  // The production field caps currently keep a single article below 2 MiB.
  const size = vi.spyOn(regex, 'regexSnapshot').mockImplementation((db, sequences, fields) => {
    const result = snapshot(db, sequences, fields)
    if (JSON.parse(sequences).includes(2)) result.bytes = regex.REGEX_QUEUE_BYTES + 1
    return result
  })
  try {
    db.upsertEntries([article(1), article(2), article(3)])
    await db.rules.drainRegex()
    expect(db.rules.hidden(id, '').items.map(item => item.id)).toEqual(['1', '3'])
    expect(db.muteFilters(id)[0].matching).toBe(false)
    expect(db.activity()).toMatchObject([{ details: { ruleId: id, article: 2, reason: expect.stringContaining('2 MiB') } }])
  } finally { size.mockRestore() }
})

it('finishes ordinary archive work saved while the shared runner is matching regex rules', async () => {
  db.upsertEntries([article(1)])
  const id = await db.rules.save({ query: 'title~/report/', actions: ['hide'], applyExisting: true })
  let ordinary: string | undefined
  const match = regex.RuleRegexWorker.prototype.match
  const worker = vi.spyOn(regex.RuleRegexWorker.prototype, 'match').mockImplementationOnce(async function (this: regex.RuleRegexWorker, snapshot, job) {
    ordinary = await db.rules.save({ query: 'title:report', actions: ['hide'], applyExisting: true })
    expect(db.backfillMuteFilters()).toBe(running)
    return match.call(this, snapshot, job)
  })
  const running = db.backfillMuteFilters()
  try {
    await running
    expect(ordinary).toBeDefined()
    for (const rule of [id, ordinary]) expect(db.muteFilters(rule)[0]).toMatchObject({ matching: false, matchCount: 1 })
  } finally { worker.mockRestore() }
})

it('caps each regex field independently and preserves literal paths', async () => {
  db.upsertEntries([article(1, { title: 'x'.repeat(4096) + 'needle', url: 'https://example.test/news/1' })])
  for (const [query, count] of [['title~/needle/', 0], ['url~/news/', 1], ['url:/news/', 1], ['text~/teaser/', 1], ['text~/^x/', 0], ['url:"/news/"', 1],
    ['url:/news', 1], ['title~/^x{4096}$/', 1], ['title~/report/ OR author:writer', 1]] as const) {
    const id = await db.rules.save({ query, actions: ['hide'], applyExisting: true })
    await db.backfillMuteFilters()
    expect(db.muteFilters(id)[0].matchCount, query).toBe(count)
  }
  for (const query of ['title~/week/g', 'feed~/week/', 'title~/broken', 'text~/[unclosed/', 'author~/' + 'w'.repeat(257) + '/']) {
    await expect(db.rules.save({ query, actions: ['hide'] })).rejects.toThrow()
  }
})

it('keeps slash-delimited URL fragments literal in rules and views saved before the upgrade', async () => {
  const sql = db.greaderDatabase
  sql.exec(`DROP TABLE regex_rules;
    INSERT INTO mute_filters(id,phrase,scope,created_at) VALUES ('old','url:/news/local','query','');
    INSERT INTO saved_views(title,query,position) VALUES ('News','url:/news/local',1);
    PRAGMA user_version=${REGEX_RULES_VERSION - 1}`)
  db.close()
  const file = path.join(directory, 'test.sqlite')
  db = new PaperDatabase(file)
  expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
  const backup = new DatabaseSync(file + '.before-regex-rules-v' + REGEX_RULES_VERSION, { readOnly: true })
  try { expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(REGEX_RULES_VERSION - 1) }
  finally { backup.close() }
  await db.upsertEntriesInChunks([article(1, { url: 'https://example.test/news/local/1' }), article(2, { url: 'https://news.example.test' })])
  expect(db.rules.hidden('old', '').items.map(row => row.id)).toEqual(['1'])
  const view = db.savedViews.list()[0]
  expect(db.savedViews.save({ ...view, title: 'Renamed' }, view.id)).toBe(view.id)
  expect(db.matchingEntryIds({ kind: 'view', id: view.id, title: view.title }, { includeMuted: true })).toEqual(['1'])
})

it('repairs a missing regex table at the current schema version', () => {
  db.greaderDatabase.exec('DROP TABLE regex_rules')
  db.close()
  db = new PaperDatabase(path.join(directory, 'test.sqlite'))
  expect(hasRegexRules(db.greaderDatabase)).toBe(true)
})

it('keeps a higher prerelease version when installing the regex table', () => {
  const sql = db.greaderDatabase
  const version = REGEX_RULES_VERSION + 1
  sql.exec(`DROP TABLE regex_rules; PRAGMA user_version = ${version}`)
  migrateRegexRules(sql)
  expect(hasRegexRules(sql)).toBe(true)
  expect(sql.prepare('PRAGMA user_version').get()!.user_version).toBe(version)
})
