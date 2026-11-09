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
  it('holds search ordering while entries are read, muted and added', () => {
    db.upsertEntries([1, 2, 3, 4, 5].map(n => article(n)))
    const first = db.localEntriesPage(all, { query: 'compositor', unreadOnly: true, limit: 2 })
    db.editLocalEntryState(first.items.map(item => item.id), 'read')
    db.createMuteFilter('report 3', 'title')
    db.upsertEntries([article(6)])
    const next = db.localEntriesPage(all, { query: 'compositor', unreadOnly: true, limit: 2, continuation: first.continuation })
    expect(next.items.map(item => item.id)).toEqual(['2', '1'])
    expect(() => db.localEntriesPage(all, { query: 'other', continuation: first.continuation })).toThrow('Refresh')
  })
  it('bounds search and bulk candidates by feed, dates, unread state and mute filters', () => {
    db.upsertEntries([article(1), article(2), article(3, { feedId: 'feed/2' }), article(4, { read: true }), article(5)])
    db.createMuteFilter('report 5', 'title')
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
  it('previews filter matches without changing visibility or read state', () => {
    db.upsertEntries([article(1), article(2, { feedId: 'feed/2' })])
    expect(db.previewMuteFilter('compositor', 'title', 'feed/1')).toMatchObject({ count: 1, items: [expect.objectContaining({ id: '1' })] })
    expect(db.localEntriesPage(all).items).toHaveLength(2)
    expect(db.muteFilters()).toHaveLength(0)
    expect(db.unreadCount()).toBe(2)
  })
})

describe('replacement feed preview', () => {
  it('reads RSS and namespaced Atom titles without executing markup', () => {
    expect(parseFeedPreview('<rss><channel><title>Feed</title><item><title>First &amp; second</title><pubDate>Today</pubDate></item></channel></rss>', 'https://example.test/rss')).toMatchObject({ title: 'Feed', items: [{ title: 'First & second', date: 'Today' }] })
    expect(parseFeedPreview('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>Post</title><updated>2026-09-23</updated></entry></feed>', 'https://example.test/atom').items[0].title).toBe('Post')
  })
  it('rejects website pages, malformed feeds and entity declarations', () => {
    for (const value of ['<html><title>Website</title></html>', '<rss><broken>', '<!DOCTYPE rss [<!ENTITY test SYSTEM "file:///etc/passwd">]><rss/>']) expect(() => parseFeedPreview(value, 'https://example.test/feed')).toThrow()
  })
})
