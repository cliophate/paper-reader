import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-workflows-')); db = new PaperDatabase(path.join(directory, 'test.sqlite')) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('reading across changing lists', () => {
  it.each(['title', 'content', 'any'] as const)('uses the same Unicode mute matching for preview, backfill and ingestion in %s', async scope => {
    const fields = scope === 'title' ? { title: 'ÉCOLE' } : scope === 'content' ? { contentHtml: '<p>ÉCOLE</p>' } : { author: 'ÉCOLE' }
    db.upsertEntries([article(1, fields), article(2, { ...fields, feedId: 'feed/other' }), article(3)])
    expect((await db.previewMuteFilter('école', scope, 'feed/1')).count).toBe(1)
    const filter = await db.createMuteFilter('école', scope, 'feed/1')
    expect(filter.matchCount).toBe(1)
    db.upsertEntries([article(4, fields)])
    expect(db.muteFilters()[0].matchCount).toBe(2)
    expect((await db.previewMuteFilter('école', scope, 'feed/1')).count).toBe(2)
    expect(db.localEntriesPage(all).items.map(item => item.id).sort()).toEqual(['2', '3'])
    expect(db.localNavigation().unread).toBe(2)
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
    expect((await creating).matchCount).toBe(601)
    expect(db.localEntriesPage(all).items).toEqual([])
  })

  it('reports a lower bound when a preview reaches the scan limit', async () => {
    db.upsertEntries(Array.from({ length: 10_300 }, (_, n) => article(n, { title: 'ÉCOLE' })))
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
    db.upsertEntries([article(6)])
    const next = db.localEntriesPage(all, { query: 'compositor', unreadOnly: true, limit: 2, continuation: first.continuation })
    expect(next.items.map(item => item.id)).toEqual(['2', '1'])
    expect(() => db.localEntriesPage(all, { query: 'other', continuation: first.continuation })).toThrow('Refresh')
  })
  it('bounds search and bulk candidates by feed, dates, unread state and mute filters', async () => {
    db.upsertEntries([article(1), article(2), article(3, { feedId: 'feed/2' }), article(4, { read: true }), article(5)])
    await db.createMuteFilter('report 5', 'title')
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
