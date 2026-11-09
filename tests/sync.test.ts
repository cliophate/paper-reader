import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { FreshRssSynchronizer, millisecondsUntilNextSync } from '../src/server/sync.js'
import type { Entry, NavigationPayload, StreamRef } from '../src/server/types.js'

let directory = ''
let database: PaperDatabase

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-sync-'))
  database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
})

afterEach(() => {
  database.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('FreshRSS synchronization', () => {
  it('compares arrival order independently of publication dates and reader sort preferences', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => entry({
      id: `tag:google.com,2005:reader/item/${index.toString(16).padStart(16, '0')}`,
      timestamp: 1000 - index,
      crawledAt: 1000 + index,
      starred: true,
    }))
    database.replaceNavigation(navigation)
    database.upsertEntries(entries)
    database.setSyncValue('backfill_complete', 'true')
    const newest = [...entries].reverse().slice(0, 80)
    const source = new FakeFreshRss(Array.from({ length: 6 }, () => ({ items: newest, continuation: '' })))
    source.navigation = async () => ({ ...navigation, unread: 100, starred: 100 })
    const sync = new FreshRssSynchronizer(database, source, true, [28, 58])

    expect((await sync.parity()).ready).toBe(true)
    for (const kind of ['all', 'starred'] as const) database.setStreamOrder({ kind, id: kind, title: kind }, 'oldest')
    expect((await sync.parity()).ready).toBe(true)
  })

  it('still reports a missing arrival when total unread and starred counts agree', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'local-only' })])
    database.setSyncValue('backfill_complete', 'true')
    const source = new FakeFreshRss([
      { items: [entry({ id: 'remote-only' })], continuation: '' },
      { items: [entry({ id: 'remote-only' })], continuation: '' },
      { items: [], continuation: '' },
    ])
    source.navigation = async () => ({ ...navigation, unread: 1 })
    const result = await new FreshRssSynchronizer(database, source, true, [28, 58]).parity()

    expect(result.unread.match).toBe(true)
    expect(result.ready).toBe(false)
    expect(result.latestAll).toMatchObject({ match: false, missingLocal: ['remote-only'], missingRemote: ['local-only'] })
  })

  it('backfills continuation pages and reconciles FreshRSS state', async () => {
    const source = new FakeFreshRss([
      { items: [entry({ id: 'one', timestamp: 20 })], continuation: '10' },
      { items: [entry({ id: 'two', timestamp: 10 })], continuation: '' },
    ])
    source.unreadIds = ['two']
    source.starredIds = ['one']
    const sync = new FreshRssSynchronizer(database, source, true, [28, 58])

    await sync.syncNow()

    expect(sync.status()).toMatchObject({ backfillComplete: true, entryCount: 2, lastError: null })
    expect(source.continuations).toEqual(['', '10'])
    expect(database.localEntry('one')).toMatchObject({ read: true, starred: true })
    expect(database.localEntry('two')).toMatchObject({ read: false, starred: false })
    expect(database.syncAudit(1)[0]).toMatchObject({ remoteUnread: 1, localUnreadAfter: 1, newEntries: 2 })
  })

  it('announces each successful synchronization', async () => {
    const source = new FakeFreshRss([{ items: [], continuation: '' }])
    const sync = new FreshRssSynchronizer(database, source, true, [28, 58])
    const completed: string[] = []
    const unsubscribe = sync.onSyncCompleted(timestamp => completed.push(timestamp))

    await sync.syncNow()
    unsubscribe()

    expect(completed).toHaveLength(1)
    expect(Number.isNaN(Date.parse(completed[0]))).toBe(false)
  })

  it('resumes a stopped backfill from its stored continuation', async () => {
    database.setSyncValue('backfill_continuation', '20')
    const source = new FakeFreshRss([{ items: [entry({ id: 'resumed' })], continuation: '' }])
    const sync = new FreshRssSynchronizer(database, source, true, [28, 58])

    await sync.syncNow()

    expect(source.continuations).toEqual(['20'])
    expect(database.localEntry('resumed')).not.toBeNull()
    expect(sync.status().backfillComplete).toBe(true)
  })

  it('updates FreshRSS before changing the local state', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'one', read: false })])
    const source = new FakeFreshRss([])
    const sync = new FreshRssSynchronizer(database, source, false, [28, 58])

    const changes: unknown[] = []
    sync.onStateChanged(change => changes.push(change))
    await sync.editEntries(['one'], 'read')
    expect(changes).toEqual([{ ids: ['one'], operation: 'read' }])

    expect(source.edits).toEqual([{ ids: ['one'], operation: 'read' }])
    expect(database.localEntry('one')?.read).toBe(true)
  })

  it('stops an incremental scan when FreshRSS returns a short filtered page', async () => {
    const now = new Date().toISOString()
    database.setSyncValue('backfill_complete', 'true')
    database.setSyncValue('last_sync_completed_at', now)
    database.setSyncValue('last_deep_sync_at', now)
    const source = new FakeFreshRss([{ items: [entry({ id: 'late', timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, crawledAt: Date.now() })], continuation: 'older' }])
    const sync = new FreshRssSynchronizer(database, source, true, [28, 58])

    await sync.syncNow()

    expect(source.continuations).toEqual([''])
    expect(database.localEntry('late')).not.toBeNull()
  })

  it('restores feed content that an older full-article cache replaced', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'one', contentHtml: '<p>Incorrect extracted page</p>' })])
    database.cacheArticle({
      url: 'https://example.test/article', title: 'An article', byline: 'Ada', excerpt: 'Incorrect',
      contentHtml: '<p>Incorrect extracted page</p>', readingMinutes: 1, fetchedAt: '2026-09-01T00:00:00.000Z',
    })
    database.setSyncValue('backfill_complete', 'true')
    const source = new FakeFreshRss([])
    source.restoredEntries = [entry({ id: 'one', contentHtml: '<p>Original feed content</p>' })]
    const sync = new FreshRssSynchronizer(database, source, true, [28, 58])

    await sync.syncNow()

    expect(source.restoredIds).toEqual(['one'])
    expect(database.localEntry('one')?.contentHtml).toBe('<p>Original feed content</p>')
    expect(database.getArticle('https://example.test/article')).toBeNull()
  })

  it('schedules imports at fixed minutes after the FreshRSS refresh window', () => {
    expect(millisecondsUntilNextSync(new Date('2026-09-02T20:21:30.000Z'), [28, 58])).toBe(6.5 * 60 * 1000)
    expect(millisecondsUntilNextSync(new Date('2026-09-02T20:28:00.000Z'), [28, 58])).toBe(30 * 60 * 1000)
    expect(millisecondsUntilNextSync(new Date('2026-09-02T20:59:00.000Z'), [28, 58])).toBe(29 * 60 * 1000)
  })
})

class FakeFreshRss {
  unreadIds: string[] = []
  starredIds: string[] = []
  continuations: string[] = []
  edits: Array<{ ids: string[]; operation: 'read' | 'unread' | 'star' | 'unstar' }> = []
  restoredEntries: Entry[] = []
  restoredIds: string[] = []

  constructor(private readonly pages: Array<{ items: Entry[]; continuation: string }>) {}

  async navigation() { return navigation }

  async entriesPage(_stream: StreamRef, options: { continuation?: string } = {}) {
    this.continuations.push(options.continuation || '')
    return this.pages.shift() || { items: [], continuation: '' }
  }

  async entryIds(stream: StreamRef, unreadOnly = false) {
    return stream.kind === 'starred' ? this.starredIds : unreadOnly ? this.unreadIds : []
  }

  async entriesByIds(ids: string[]) {
    this.restoredIds.push(...ids)
    const wanted = new Set(ids)
    return this.restoredEntries.filter(item => wanted.has(item.id))
  }

  async editEntries(ids: string[], operation: 'read' | 'unread' | 'star' | 'unstar') {
    this.edits.push({ ids, operation })
  }

  async addFeed() {}
  async editFeed() {}
  async removeFeed() {}
}

const navigation: NavigationPayload = {
  unread: 0,
  starred: 0,
  folders: [],
  uncategorized: [{
    id: 'feed/one', title: 'One', url: 'https://example.test/feed', siteUrl: 'https://example.test',
    iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null,
    lastErrorAt: null, broken: false,
  }],
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'one', feedId: 'feed/one', feedTitle: 'One', feedUrl: 'https://example.test',
    title: 'An article', author: 'Ada', url: 'https://example.test/article',
    contentHtml: '<p>Article text</p>', excerpt: 'Article text', publishedAt: '2026-09-01T00:00:00.000Z',
    timestamp: 1, read: false, starred: false, readingMinutes: 1, thumbnailUrl: '', kind: 'article',
    ...overrides,
  }
}
