import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import * as feedContent from '../src/server/feed-content.js'
import { clusterTopics } from '../src/server/topics.js'
import type { Entry, NavigationPayload } from '../src/server/types.js'

let directory = ''
let database: PaperDatabase

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-database-'))
  database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
})

afterEach(() => {
  vi.restoreAllMocks()
  database.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('Paper read model', () => {
  it('waits for another process to commit before binding the standalone backend', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/database-write-worker.ts', path.join(directory, 'paper.sqlite')], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
    })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += chunk })
    try {
      expect((await once(child, 'message'))[0]).toBe('locked')
      const started = performance.now()
      child.send('commit')
      const backend = database.bindStandalone()
      expect(performance.now() - started).toBeGreaterThanOrEqual(150)
      expect(backend.kind).toBe('standalone')
      expect(database.getSyncValue('active_backend_id')).toBe(backend.id)
      expect(database.getSyncValue('concurrent_writer')).toBe('committed')
      expect(await exited, stderr).toEqual([0, null])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  })

  it('returns collection metadata without parsing member article bodies', () => {
    const entries = [1, 2, 3].map(n => entry({ id: String(n), url: `https://example.test/${n}`, title: `Article &amp; ${n}` }))
    database.upsertEntries(entries)
    database.savePulseBatch([{ id: 'collection-one', headline: 'A collection', scope: 'Related reporting', entryIds: entries.map(e => e.id) }], entries.map(e => e.id), '2026-10-05T10:00:00Z')
    const parse = vi.spyOn(feedContent, 'normalizeFeedContent')
    const collections = database.pulseCollections()
    expect(parse).not.toHaveBeenCalled()
    expect(collections[0].articleCount).toBe(3)
    expect(collections[0].sources.map(source => source.title)).toEqual(['Article & 3', 'Article & 2', 'Article & 1'])
    expect(collections[0].sources[0]).toMatchObject({ id: '3', feedId: 'feed/one', publication: 'One', read: false, domain: 'example.test' })
  })

  it('only parses headline candidates as they are consumed', () => {
    database.upsertEntries([1, 2, 3, 4, 5].map(n => entry({ id: String(n), timestamp: n, url: `https://androidpolice.com/${n}`, feedUrl: 'https://androidpolice.com/feed/' })))
    const parse = vi.spyOn(feedContent, 'normalizeFeedContent')
    const candidates = database.headlineCandidates()
    expect(parse).not.toHaveBeenCalled()
    expect(candidates.next().value?.id).toBe('5')
    expect(parse).toHaveBeenCalledTimes(1)
    expect(database.checkpointWalIfLarge(0)).toBe(true)
    candidates.return(undefined)
    expect(database.localEntry('1')?.id).toBe('1')
  })

  it('indexes cached full text when reopening an unfinished search migration', () => {
    database.upsertEntries([1, 2, 3].map(n => entry({ id: String(n), url: `https://example.test/${n}` })))
    for (const n of [1, 2, 3]) database.cacheArticle({ url: `https://example.test/${n}`, title: 'Cached', byline: '', excerpt: '', contentHtml: `<p>Migrationneedle${n} is in cached full text.</p>`, readingMinutes: 1, fetchedAt: '2026-10-05T10:00:00Z' })
    database.setSyncValue('fulltext_search_v1', 'false')
    database.close()
    database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    for (const n of [1, 2, 3]) expect(database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: `Migrationneedle${n}`, unreadOnly: false }).items.map(e => e.id)).toEqual([String(n)])
    expect(database.getSyncValue('fulltext_search_v1')).toBe('true')
  })

  it('remembers independent feed and folder ordering and paginates chronologically', () => {
    database.replaceNavigation(navigation)
    const folder = { kind: 'category' as const, id: 'user/-/label/Writers', title: 'Writers' }
    const stream = { kind: 'feed' as const, id: 'feed/one', title: 'One' }
    database.upsertEntries([5, 4, 3, 2, 1].map(n => entry({ id: String(n), timestamp: n * 1000, crawledAt: (6 - n) * 1000, read: n === 3 })))
    expect(database.localEntriesPage(folder).items.map(e => e.id)).toEqual(['5', '4', '3', '2', '1'])
    database.setStreamOrder(folder, 'oldest')
    expect(database.streamOrder(stream)).toBe('newest')
    let page = database.localEntriesPage(folder, { limit: 2 })
    expect(page.items.map(e => e.id)).toEqual(['1', '2'])
    page = database.localEntriesPage(folder, { limit: 2, continuation: page.continuation })
    expect(page.items.map(e => e.id)).toEqual(['3', '4'])
    page = database.localEntriesPage(folder, { limit: 2, continuation: page.continuation })
    expect(page.items.map(e => e.id)).toEqual(['5'])
    expect(page.continuation).toBe('')
    expect(database.localRelativeUnreadEntryIds(folder, '3', 'above', { unreadOnly: true })).toEqual(['1', '2'])
    expect(database.localRelativeUnreadEntryIds(folder, '3', 'below', { unreadOnly: true })).toEqual(['4', '5'])
    database.close()
    database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    expect(database.streamOrder(folder)).toBe('oldest')
    expect(database.streamOrder(stream)).toBe('newest')
    database.setStreamOrder(folder, 'newest')
    expect(database.localRelativeUnreadEntryIds(folder, '3', 'above', { unreadOnly: true })).toEqual(['5', '4'])
    expect(database.localRelativeUnreadEntryIds(folder, '3', 'below', { unreadOnly: true })).toEqual(['2', '1'])
  })

  it('builds navigation and stream counts from indexed entries', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'one', feedId: 'feed/one', read: false, starred: true, timestamp: 30 }),
      entry({ id: 'two', feedId: 'feed/one', read: true, timestamp: 20 }),
      entry({ id: 'three', feedId: 'feed/two', read: false, timestamp: 10 }),
    ])

    const result = database.localNavigation()
    expect(result.unread).toBe(2)
    expect(result.starred).toBe(1)
    expect(result.folders[0].title).toBe('Writers')
    expect(result.folders[0].unread).toBe(1)
    expect(result.folders[0].feeds[0].unread).toBe(1)
    expect(result.uncategorized.map(feed => feed.id)).toEqual(['feed/two'])
  })

  it('keeps search filters and complete paginated membership with mapped metadata lookups', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'unread', title: 'The synthetic story', contentHtml: '<p>Commonneedle</p>', timestamp: 40 }),
      entry({ id: 'read', title: 'The synthetic story', contentHtml: '<p>Commonneedle</p>', read: true, timestamp: 30 }),
      entry({ id: 'other', feedId: 'feed/two', title: 'The synthetic story', contentHtml: '<p>Commonneedle</p>', timestamp: 20 }),
      entry({ id: 'star', title: 'The muted synthetic story', contentHtml: '<p>Commonneedle</p>', starred: true, timestamp: 10 }),
    ])
    await database.createMuteFilter('muted synthetic', 'title')
    const cases = [
      { kind: 'all' as const, id: 'all', unreadOnly: false, expected: ['unread', 'read', 'other'] },
      { kind: 'all' as const, id: 'all', unreadOnly: true, expected: ['unread', 'other'] },
      { kind: 'feed' as const, id: 'feed/one', unreadOnly: false, expected: ['unread', 'read'] },
      { kind: 'category' as const, id: 'user/-/label/Writers', unreadOnly: false, expected: ['unread', 'read'] },
      { kind: 'starred' as const, id: 'starred', unreadOnly: false, expected: ['star'] },
    ]
    for (const { kind, id, unreadOnly, expected } of cases) {
      const ids: string[] = []
      let continuation = ''
      do {
        const page = database.localEntriesPage({ kind, id, title: 'Synthetic' }, {
          query: 'Commonneedle', unreadOnly, limit: 1, continuation,
          after: new Date(0).toISOString(), before: new Date(50).toISOString(),
        })
        expect(page.items).toHaveLength(1)
        expect(page.items[0].searchExcerpt).toContain('Commonneedle')
        ids.push(page.items[0].id); continuation = page.continuation
      } while (continuation && ids.length < 10)
      expect(ids.sort()).toEqual(expected.sort())
    }
  })

  it('searches the complete text and paginates without a fixed archive limit', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'one', title: 'A quiet computer', contentHtml: '<p>Bazzite changed the living room.</p>', timestamp: 30 }),
      entry({ id: 'two', title: 'A quiet handheld', contentHtml: '<p>Bazzite on a small screen.</p>', timestamp: 20 }),
      entry({ id: 'three', title: 'Unrelated', contentHtml: '<p>Nothing matching here.</p>', timestamp: 10 }),
    ])

    const first = database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: 'quiet bazzite', limit: 1 })
    const second = database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: 'quiet bazzite', limit: 1, continuation: first.continuation })
    expect(first.items).toHaveLength(1)
    expect(first.continuation).not.toBe('')
    expect(second.items).toHaveLength(1)
    expect(new Set([...first.items, ...second.items].map(item => item.id))).toEqual(new Set(['one', 'two']))
  })

  it('orders the reader stream by publication time despite delayed arrivals', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'published-later', timestamp: 30, crawledAt: 40 }),
      entry({ id: 'arrived-later', timestamp: 10, crawledAt: 50 }),
    ])

    const result = database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { unreadOnly: false })
    expect(result.items.map(item => item.id)).toEqual(['published-later', 'arrived-later'])
    expect(result.items[1].timestamp).toBe(10)
  })

  it('finds unread entries above and below an article in reader order', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'newest', read: false, crawledAt: 50, timestamp: 10 }),
      entry({ id: 'read-middle', read: true, crawledAt: 40, timestamp: 40 }),
      entry({ id: 'anchor', read: false, crawledAt: 30, timestamp: 30 }),
      entry({ id: 'older', read: false, crawledAt: 20, timestamp: 50 }),
    ])

    const stream = { kind: 'all' as const, id: 'all', title: 'All' }
    expect(database.localRelativeUnreadEntryIds(stream, 'anchor', 'above')).toEqual(['older'])
    expect(database.localRelativeUnreadEntryIds(stream, 'anchor', 'below')).toEqual(['newest'])
  })

  it('keeps relative read actions inside the selected folder and search', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'matching-above', title: 'Quiet Linux', crawledAt: 40, read: false }),
      entry({ id: 'anchor', title: 'Quiet Linux desk', crawledAt: 30, read: false }),
      entry({ id: 'not-matching', title: 'A camera', crawledAt: 20, read: false }),
      entry({ id: 'other-folder', feedId: 'feed/two', title: 'Quiet Linux elsewhere', crawledAt: 50, read: false }),
    ])

    const stream = { kind: 'category' as const, id: 'user/-/label/Writers', title: 'Writers' }
    expect(database.localRelativeUnreadEntryIds(stream, 'anchor', 'above', { query: 'quiet linux' })).toEqual(['matching-above'])
    expect(database.localRelativeUnreadEntryIds(stream, 'anchor', 'below', { query: 'quiet linux' })).toEqual([])
  })

  it('uses an already-read row as the boundary in a five-item unread list', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([5, 4, 3, 2, 1].map(n => entry({ id: String(n), crawledAt: n * 1000, read: n === 3 })))
    const stream = { kind: 'category' as const, id: 'user/-/label/Writers', title: 'Writers' }
    expect(database.localRelativeUnreadEntryIds(stream, '3', 'above', { unreadOnly: true })).toEqual(['5', '4'])
    expect(database.localRelativeUnreadEntryIds(stream, '3', 'below', { unreadOnly: true })).toEqual(['2', '1'])
    expect(database.localRelativeUnreadEntryIds(stream, '5', 'above', { unreadOnly: true })).toEqual([])
    expect(database.localRelativeUnreadEntryIds(stream, '1', 'below', { unreadOnly: true })).toEqual([])
    expect(database.localRelativeUnreadEntryIds(stream, 'missing', 'above', { unreadOnly: true })).toEqual([])
  })

  it('does not let the read anchor bypass folder or search restrictions', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'above', title: 'Quiet Linux', crawledAt: 40 }),
      entry({ id: 'anchor', title: 'Quiet Linux desk', crawledAt: 30, read: true }),
      entry({ id: 'elsewhere', feedId: 'feed/two', title: 'Quiet Linux', crawledAt: 20, read: true }),
    ])
    const stream = { kind: 'category' as const, id: 'user/-/label/Writers', title: 'Writers' }
    expect(database.localRelativeUnreadEntryIds(stream, 'anchor', 'above', { unreadOnly: true, query: 'quiet linux' })).toEqual(['above'])
    expect(database.localRelativeUnreadEntryIds(stream, 'elsewhere', 'above', { unreadOnly: true })).toEqual([])
    expect(database.localRelativeUnreadEntryIds(stream, 'anchor', 'above', { unreadOnly: true, query: 'camera' })).toEqual([])
  })

  it('decodes entities from existing indexed text when reading it back', () => {
    database.replaceNavigation({
      ...navigation,
      folders: [{ ...navigation.folders[0], feeds: [feed('feed/one', 'Audio &amp; listening')] }],
    })
    database.upsertEntries([entry({
      feedTitle: 'Audio &amp; listening',
      title: 'Speakers &amp; rooms',
      author: 'A &amp;amp; B',
      excerpt: 'Placement &amp;amp; treatment',
    })])

    expect(database.localNavigation().folders[0].feeds[0].title).toBe('Audio & listening')
    expect(database.localEntry('one')).toMatchObject({
      feedTitle: 'Audio & listening',
      title: 'Speakers & rooms',
      author: 'A & B',
      excerpt: 'Placement & treatment',
    })
  })

  it('scopes folders and reconciles canonical state', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'one', feedId: 'feed/one', read: false, starred: false, timestamp: 30 }),
      entry({ id: 'two', feedId: 'feed/two', read: false, starred: true, timestamp: 20 }),
    ])
    database.reconcileEntryState(['two'], ['one'])

    const writers = database.localEntriesPage({ kind: 'category', id: 'user/-/label/Writers', title: 'Writers' }, { unreadOnly: false })
    expect(writers.items.map(item => item.id)).toEqual(['one'])
    expect(database.localEntry('one')).toMatchObject({ read: true, starred: true })
    expect(database.localEntry('two')).toMatchObject({ read: false, starred: false })
  })

  it('does not let a content refresh overwrite reconciled read or starred state', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'one', read: false, starred: false, title: 'Original title' })])
    database.editLocalEntryState(['one'], 'read')
    database.editLocalEntryState(['one'], 'star')

    database.upsertEntries([entry({ id: 'one', read: false, starred: false, title: 'Updated title' })])

    expect(database.localEntry('one')).toMatchObject({ title: 'Updated title', read: true, starred: true })
  })

  it('keeps fetched full text separate from the source entry', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'one', contentHtml: '<p>Short teaser</p>' })])

    database.cacheArticle({
      url: 'https://example.test/article',
      title: 'An article',
      byline: 'Ada',
      excerpt: 'The full article',
      contentHtml: '<p>The full article explains a peculiar compositor.</p>',
      readingMinutes: 4,
      fetchedAt: '2026-09-01T12:00:00.000Z',
    })
    database.upsertEntries([entry({ id: 'one', contentHtml: '<p>Short teaser returned again</p>' })])

    expect(database.getArticle('https://example.test/article')).toMatchObject({ excerpt: 'The full article', readingMinutes: 4 })
    expect(database.localEntry('one')).toMatchObject({ excerpt: 'Article text', readingMinutes: 1, contentHtml: '<p>Short teaser returned again</p>' })
    expect(database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { query: 'peculiar compositor' }).items.map(item => item.id)).toEqual(['one'])
  })

  it('reports database storage and can checkpoint a large WAL', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'one' })])

    const before = database.storageStatus()
    expect(before.databaseBytes).toBeGreaterThan(0)
    expect(database.checkpointWalIfLarge(0)).toBe(true)
    expect(database.storageStatus().walBytes).toBeLessThanOrEqual(before.walBytes)
  })

  it('skips a WAL checkpoint instead of waiting for an active reader', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'one' })])
    const reader = new DatabaseSync(path.join(directory, 'paper.sqlite'), { readOnly: true })
    try {
      reader.exec('BEGIN')
      reader.prepare('SELECT COUNT(*) FROM entries').get()
      database.upsertEntries([entry({ id: 'two' })])
      const started = performance.now()
      expect(database.checkpointWalIfLarge(0)).toBe(true)
      expect(performance.now() - started).toBeLessThan(1000)
      reader.exec('COMMIT')
    } finally { reader.close() }
    database.upsertEntries([entry({ id: 'three' })])
    expect(database.localEntry('three')).toBeTruthy()
  })

  it('persists shared coverage membership while reading current article state', () => {
    const sources = [
      entry({ id: 'one', feedId: 'feed/one', title: 'Sony says digital games do not mean ownership', url: 'https://one.test/story', timestamp: 30, read: false }),
      entry({ id: 'two', feedId: 'feed/two', title: 'Sony argues digital game purchases do not mean ownership', url: 'https://two.test/story', timestamp: 20, read: false }),
      entry({ id: 'three', feedId: 'feed/three', title: 'Digital games do not mean ownership, Sony says', url: 'https://three.test/story', timestamp: 10, read: true }),
    ]
    database.upsertEntries(sources)
    const topics = clusterTopics(sources)
    database.replaceCoverageIndex(topics, '2026-09-03T10:00:00.000Z', 24)
    database.editLocalEntryState(['one'], 'read')

    const stored = database.coverageTopics({ after: new Date(0), before: new Date('2100-01-01') })
    expect(stored).toHaveLength(1)
    expect(stored[0].sources.find(source => source.id === 'one')?.read).toBe(true)
    expect(database.getSyncValue('coverage_generated_at')).toBe('2026-09-03T10:00:00.000Z')
  })

  it('hides muted matches without changing read state and keeps stars accessible', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([
      entry({ id: 'sponsor', title: 'Thanks to 1Password for sponsoring the blog', read: false }),
      entry({ id: 'podcast', title: 'New podcast episode', read: false, starred: true }),
      entry({ id: 'story', title: 'A useful Linux story', read: false }),
    ])

    const filter = await database.createMuteFilter('sponsoring the blog', 'title')
    await database.createMuteFilter('New podcast episode', 'title')

    expect(database.localNavigation().unread).toBe(1)
    expect(database.localEntry('sponsor')?.read).toBe(false)
    expect(database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { unreadOnly: true }).items.map(item => item.id)).toEqual(['story'])
    expect(database.localEntriesPage({ kind: 'starred', id: 'starred', title: 'Starred' }, { unreadOnly: false }).items.map(item => item.id)).toEqual(['podcast'])

    database.deleteMuteFilter(filter.id)
    expect(database.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { unreadOnly: true }).items.map(item => item.id)).toContain('sponsor')
  })

  it('stores activity and article reports with bounded status changes', () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry()])
    database.recordActivity({ kind: 'state', origin: 'reader', summary: 'Marked one article read', count: 1, details: { operation: 'read' } })
    const report = database.createArticleReport({ entry: database.localEntry('one')!, issue: 'media', note: 'The hero image is missing.', client: { viewport: '412x915' } })

    expect(database.activity(1)[0]).toMatchObject({ kind: 'state', origin: 'reader', count: 1 })
    expect(database.openArticleReportCount()).toBe(1)
    expect(database.articleReports(1)[0]).toMatchObject({ id: report.id, issue: 'media', note: 'The hero image is missing.' })
    expect(database.setArticleReportStatus(report.id, 'resolved')).toBe(true)
    expect(database.openArticleReportCount()).toBe(0)
  })
})

const navigation: NavigationPayload = {
  unread: 0,
  starred: 0,
  folders: [{
    id: 'user/-/label/Writers',
    title: 'Writers',
    unread: 0,
    feeds: [feed('feed/one', 'One')],
  }],
  uncategorized: [feed('feed/two', 'Two')],
}

function feed(id: string, title: string) {
  return {
    id,
    title,
    url: `https://example.test/${title.toLowerCase()}.xml`,
    siteUrl: `https://example.test/${title.toLowerCase()}`,
    iconUrl: '',
    categories: [],
    unread: 0,
    lastPublishedAt: null,
    lastCheckedAt: null,
    lastErrorAt: null,
    broken: false,
  }
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'one',
    feedId: 'feed/one',
    feedTitle: 'One',
    feedUrl: 'https://example.test',
    title: 'An article',
    author: 'Ada',
    url: 'https://example.test/article',
    contentHtml: '<p>Article text</p>',
    excerpt: 'Article text',
    publishedAt: '2026-09-01T00:00:00.000Z',
    timestamp: 1,
    read: false,
    starred: false,
    readingMinutes: 1,
    thumbnailUrl: '',
    kind: 'article',
    ...overrides,
  }
}
