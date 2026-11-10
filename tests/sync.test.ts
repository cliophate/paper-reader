import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendPageOptions, EntryPage, EntryStateOperation, ReaderBackend } from '../src/server/backend.js'
import { FRESHRSS_ORGANIZATION_CAPABILITIES } from '../src/server/organization.js'
import { PaperDatabase } from '../src/server/db.js'
import { BackendSynchronizer, millisecondsUntilNextSync } from '../src/server/sync.js'
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

describe('Backend synchronization', () => {
  it('rejects a changed backend before making upstream requests', () => {
    const source = new FakeBackend([])
    const navigation = vi.spyOn(source, 'navigation')
    database.bindBackend({ id: 'fixture:original', kind: 'freshrss' })
    expect(() => new BackendSynchronizer(database, source, true, [28, 58])).toThrow(/another backend/)
    expect(navigation).not.toHaveBeenCalled()
  })

  it('cannot reconcile standalone state through remote snapshots', () => {
    const source = new FakeBackend([])
    const backend: ReaderBackend = { ...source, identity: { id: 'standalone:fixture', kind: 'standalone' } } as ReaderBackend
    expect(() => new BackendSynchronizer(database, backend, true, [28, 58])).toThrow(/remote snapshot/)
  })

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
    const source = new FakeBackend(Array.from({ length: 6 }, () => ({ items: newest, continuation: '' })))
    source.navigation = async () => ({ ...navigation, unread: 100, starred: 100 })
    const sync = new BackendSynchronizer(database, source, true, [28, 58])

    expect((await sync.parity()).ready).toBe(true)
    for (const kind of ['all', 'starred'] as const) database.setStreamOrder({ kind, id: kind, title: kind }, 'oldest')
    expect((await sync.parity()).ready).toBe(true)
  })

  it('still reports a missing arrival when total unread and starred counts agree', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'local-only' })])
    database.setSyncValue('backfill_complete', 'true')
    const source = new FakeBackend([
      { items: [entry({ id: 'remote-only' })], continuation: '' },
      { items: [entry({ id: 'remote-only' })], continuation: '' },
      { items: [], continuation: '' },
    ])
    source.navigation = async () => ({ ...navigation, unread: 1 })
    const result = await new BackendSynchronizer(database, source, true, [28, 58]).parity()

    expect(result.unread.match).toBe(true)
    expect(result.ready).toBe(false)
    expect(result.latestAll).toMatchObject({ match: false, missingLocal: ['remote-only'], missingRemote: ['local-only'] })
  })

  it('backfills continuation pages and reconciles backend state', async () => {
    const source = new FakeBackend([
      { items: [entry({ id: 'one', timestamp: 20 })], continuation: '10' },
      { items: [entry({ id: 'two', timestamp: 10 })], continuation: '' },
    ])
    source.unreadIds = ['two']
    source.starredIds = ['one']
    const sync = new BackendSynchronizer(database, source, true, [28, 58])

    await sync.syncNow()

    expect(sync.status()).toMatchObject({ backfillComplete: true, entryCount: 2, lastError: null })
    expect(source.continuations).toEqual(['', '10'])
    expect(database.localEntry('one')).toMatchObject({ read: true, starred: true })
    expect(database.localEntry('two')).toMatchObject({ read: false, starred: false })
    expect(database.syncAudit(1)[0]).toMatchObject({ remoteUnread: 1, localUnreadAfter: 1, newEntries: 2 })
  })

  it('announces each successful synchronization', async () => {
    const source = new FakeBackend([{ items: [], continuation: '' }])
    const sync = new BackendSynchronizer(database, source, true, [28, 58])
    const completed: string[] = []
    const unsubscribe = sync.onSyncCompleted(timestamp => completed.push(timestamp))

    await sync.syncNow()
    unsubscribe()

    expect(completed).toHaveLength(1)
    expect(Number.isNaN(Date.parse(completed[0]))).toBe(false)
  })

  it('resumes a stopped backfill from its stored continuation', async () => {
    database.setSyncValue('backfill_continuation', '20')
    const source = new FakeBackend([{ items: [entry({ id: 'resumed' })], continuation: '' }])
    const sync = new BackendSynchronizer(database, source, true, [28, 58])

    await sync.syncNow()

    expect(source.continuations).toEqual(['20'])
    expect(database.localEntry('resumed')).not.toBeNull()
    expect(sync.status().backfillComplete).toBe(true)
  })

  it('updates the backend before changing the local state', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry({ id: 'one', read: false })])
    const source = new FakeBackend([])
    const sync = new BackendSynchronizer(database, source, false, [28, 58])

    const changes: unknown[] = []
    sync.onStateChanged(change => changes.push(change))
    await sync.editEntries(['one'], 'read')
    expect(changes).toEqual([{ ids: ['one'], operation: 'read' }])

    expect(source.edits).toEqual([{ ids: ['one'], operation: 'read' }])
    expect(database.localEntry('one')?.read).toBe(true)
  })

  it.each<EntryStateOperation>(['read', 'unread', 'star', 'unstar'])('leaves local state, activity and events unchanged when %s fails upstream', async operation => {
    database.replaceNavigation(navigation)
    database.upsertEntries(['one', 'two'].map(id => entry({ id, read: operation === 'unread', starred: operation === 'unstar' })))
    database.recordActivity({ kind: 'state', origin: 'reader', summary: 'Existing activity' })
    const before = ['one', 'two'].map(id => database.localEntry(id))
    const activityBefore = database.activity()
    const backend = new FakeBackend([])
    backend.editEntries = vi.fn(async () => { throw new Error('Backend unavailable') })
    const sync = new BackendSynchronizer(database, backend, true, [28, 58])
    const changed = vi.fn()
    const completed = vi.fn()
    sync.onStateChanged(changed)
    sync.onSyncCompleted(completed)

    await expect(sync.editEntries(['one', 'two'], operation)).rejects.toThrow('Backend unavailable')

    expect(backend.editEntries).toHaveBeenCalledWith(['one', 'two'], operation)
    expect(['one', 'two'].map(id => database.localEntry(id))).toEqual(before)
    expect(database.activity()).toEqual(activityBefore)
    expect(changed).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
  })

  it('queues writes after a running sync and shares concurrent sync requests', async () => {
    const backend = new FakeBackend([])
    backend.unreadIds = ['one']
    const started = deferred()
    const release = deferred()
    backend.entriesPage = async () => {
      started.resolve()
      await release.promise
      return { items: [entry()], continuation: '' }
    }
    const edit = vi.spyOn(backend, 'editEntries')
    const sync = new BackendSynchronizer(database, backend, true, [28, 58])
    const events: string[] = []
    sync.onSyncCompleted(() => events.push('sync'))
    sync.onStateChanged(() => events.push('write'))

    const importing = sync.syncNow()
    await started.promise
    expect(sync.syncNow()).toBe(importing)
    const writing = sync.editEntries(['one'], 'read')
    expect(edit).not.toHaveBeenCalled()
    expect(events).toEqual([])
    release.resolve()
    await Promise.all([importing, writing])

    expect(events).toEqual(['sync', 'write'])
    expect(edit).toHaveBeenCalledOnce()
    expect(database.localEntry('one')).toMatchObject({ read: true })
    expect(database.activity().map(activity => activity.kind)).toEqual(['state', 'sync'])
  })

  it('queues sync after an in-flight write', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry()])
    const backend = new FakeBackend([{ items: [entry()], continuation: '' }])
    const started = deferred()
    const release = deferred()
    backend.editEntries = async () => {
      started.resolve()
      await release.promise
    }
    const navigationRequest = vi.spyOn(backend, 'navigation')
    const sync = new BackendSynchronizer(database, backend, true, [28, 58])
    const events: string[] = []
    sync.onStateChanged(() => events.push('write'))
    sync.onSyncCompleted(() => events.push('sync'))

    const writing = sync.editEntries(['one'], 'read')
    await started.promise
    const importing = sync.syncNow()
    expect(navigationRequest).not.toHaveBeenCalled()
    expect(database.localEntry('one')).toMatchObject({ read: false })
    release.resolve()
    await Promise.all([writing, importing])

    expect(events).toEqual(['write', 'sync'])
    expect(navigationRequest).toHaveBeenCalledOnce()
    expect(database.localEntry('one')).toMatchObject({ read: true })
  })

  it('continues queued writes after an operation fails', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry()])
    const backend = new FakeBackend([])
    const started = deferred()
    const release = deferred()
    backend.editEntries = vi.fn()
      .mockImplementationOnce(async () => {
        started.resolve()
        await release.promise
        throw new Error('Write rejected')
      })
      .mockResolvedValue(undefined)
    const sync = new BackendSynchronizer(database, backend, false, [28, 58])
    const changes: unknown[] = []
    sync.onStateChanged(change => changes.push(change))

    const failed = expect(sync.editEntries(['one'], 'read')).rejects.toThrow('Write rejected')
    await started.promise
    const next = sync.editEntries(['one'], 'star')
    expect(backend.editEntries).toHaveBeenCalledTimes(1)
    release.resolve()
    await failed
    await next

    expect(database.localEntry('one')).toMatchObject({ read: false, starred: true })
    expect(changes).toEqual([{ ids: ['one'], operation: 'star' }])
    expect(database.activity()).toHaveLength(1)
    expect(database.activity()[0].details).toMatchObject({ operation: 'star' })
  })

  it('keeps feed repair optional and allows later operations after unsupported repair', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries([entry()])
    const backend = new FakeBackend([])
    const sync = new BackendSynchronizer(database, backend, false, [28, 58])
    const changed = vi.fn()
    sync.onStateChanged(changed)

    await expect(sync.repairFeed('feed/one', 'https://example.test/new', 'https://example.test/feed')).rejects.toThrow('Feed repair is not available')
    expect(database.activity()).toEqual([])
    expect(changed).not.toHaveBeenCalled()
    await sync.editEntries(['one'], 'star')
    expect(database.localEntry('one')).toMatchObject({ starred: true })
  })

  it('preserves article references when navigation and imported content change', async () => {
    database.replaceNavigation(navigation)
    database.upsertEntries(['one', 'two', 'three'].map(id => entry({ id, url: `https://example.test/${id}` })))
    database.saveReadingProgress('one', 0.42)
    database.saveDiscussion({
      entryId: 'one', revision: 1, messages: [],
      source: { title: 'Fixture', author: 'Ada', url: 'https://example.test/one', kind: 'feed', paragraphs: [], warning: '' },
    })
    database.savePulseBatch([{ id: 'collection', headline: 'Fixture', scope: 'Fixture', entryIds: ['one', 'two', 'three'] }], ['one', 'two', 'three'], '2026-09-02T00:00:00.000Z')
    database.createBriefing({
      id: 'edition', kind: 'morning', windowStart: '2026-09-01T00:00:00.000Z', cutoff: '2026-09-02T00:00:00.000Z',
      subject: 'Fixture', html: '', text: '', status: 'delivered', tokenHash: '',
      selection: { news: [], worthNoticing: [], social: [] }, createdAt: '2026-09-02T00:00:00.000Z',
      deliveredAt: '2026-09-02T00:00:00.000Z', acknowledgedAt: null,
    }, [{ id: 'one', section: 'news' }])
    const backend = new FakeBackend([{ items: [entry({ title: 'Updated article', contentHtml: '<p>Updated content</p>' })], continuation: '' }])
    backend.navigation = async () => ({
      ...navigation,
      folders: [{ id: 'folder/writers', title: 'Writers', unread: 1, feeds: navigation.uncategorized }],
      uncategorized: [],
    })
    backend.unreadIds = ['one']
    const sync = new BackendSynchronizer(database, backend, true, [28, 58])

    await sync.editEntries(['one'], 'star')
    backend.starredIds = ['one']
    await sync.editFeed('feed/one', 'One', 'Writers', '')
    await sync.syncNow()

    expect(database.localNavigation().folders[0].feeds[0].id).toBe('feed/one')
    expect(database.entryIdsForBriefing('edition')).toEqual(['one'])
    expect(database.localEntry(database.entryIdsForBriefing('edition')[0])).toMatchObject({
      id: 'one', feedId: 'feed/one', title: 'Updated article', contentHtml: '<p>Updated content</p>', readingPosition: 0.42, read: false, starred: true,
    })
    expect(database.discussion('one')).toMatchObject({ entryId: 'one', revision: 1 })
    expect(database.pulseCollections()[0].sources.map(source => source.id).sort()).toEqual(['one', 'three', 'two'])

    backend.navigation = async () => ({ unread: 0, starred: 1, folders: [], uncategorized: [] })
    await sync.removeFeed('feed/one')
    expect(database.localEntry('one')).toMatchObject({ id: 'one', starred: true, readingPosition: 0.42 })
    expect(database.entryIdsForBriefing('edition')).toEqual(['one'])
    expect(database.discussion('one')).not.toBeNull()
  })

  it('stops an incremental scan when the backend returns a short filtered page', async () => {
    const now = new Date().toISOString()
    database.setSyncValue('backfill_complete', 'true')
    database.setSyncValue('last_sync_completed_at', now)
    database.setSyncValue('last_deep_sync_at', now)
    const source = new FakeBackend([{ items: [entry({ id: 'late', timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, crawledAt: Date.now() })], continuation: 'older' }])
    const sync = new BackendSynchronizer(database, source, true, [28, 58])

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
    const source = new FakeBackend([])
    source.restoredEntries = [entry({ id: 'one', contentHtml: '<p>Original feed content</p>' })]
    const sync = new BackendSynchronizer(database, source, true, [28, 58])

    await sync.syncNow()

    expect(source.restoredIds).toEqual(['one'])
    expect(database.localEntry('one')?.contentHtml).toBe('<p>Original feed content</p>')
    expect(database.getArticle('https://example.test/article')).toBeNull()
  })

  it('schedules imports at fixed minutes after the backend refresh window', () => {
    expect(millisecondsUntilNextSync(new Date('2026-09-02T20:21:30.000Z'), [28, 58])).toBe(6.5 * 60 * 1000)
    expect(millisecondsUntilNextSync(new Date('2026-09-02T20:28:00.000Z'), [28, 58])).toBe(30 * 60 * 1000)
    expect(millisecondsUntilNextSync(new Date('2026-09-02T20:59:00.000Z'), [28, 58])).toBe(29 * 60 * 1000)
  })
})

class FakeBackend implements ReaderBackend {
  readonly identity = { id: 'fixture:freshrss', kind: 'freshrss' as const }
  readonly organizationCapabilities = FRESHRSS_ORGANIZATION_CAPABILITIES
  validateFeedId() {}
  unreadIds: string[] = []
  starredIds: string[] = []
  continuations: string[] = []
  edits: Array<{ ids: string[]; operation: EntryStateOperation }> = []
  restoredEntries: Entry[] = []
  restoredIds: string[] = []

  constructor(private readonly pages: EntryPage[]) {}

  async navigation() { return navigation }

  async entries() { return [] }

  async entry() { return null }

  async entriesPage(_stream: StreamRef, options: BackendPageOptions = {}) {
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

  async editEntries(ids: string[], operation: EntryStateOperation) {
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}
