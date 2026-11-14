import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MinifluxClient } from '../src/server/miniflux.js'
import { minifluxBaseUrl } from '../src/server/miniflux-url.js'
import { PaperDatabase } from '../src/server/db.js'
import { BackendSynchronizer } from '../src/server/sync.js'
import { SubscriptionImporter } from '../src/server/subscription-import.js'
import { minifluxImportStore } from '../src/server/subscription-import-miniflux.js'
import { minifluxApi } from './fixtures/miniflux-api.mjs'

let fixture: ReturnType<typeof minifluxApi>, client: MinifluxClient
let directory = '', database: PaperDatabase | undefined
const all = { kind: 'all' as const, id: 'all', title: 'All' }
const stars = { kind: 'starred' as const, id: 'starred', title: 'Starred' }
const baseUrl = 'https://miniflux.example.test/reader/'
const id = (kind: string, n: number) => `${client.identity.id}:${kind}:${n}`
beforeEach(async () => {
  fixture = minifluxApi()
  vi.stubGlobal('fetch', vi.fn(fixture.fetch))
  client = new MinifluxClient({ baseUrl, apiKey: 'synthetic-miniflux-key' })
  await client.initialize()
})
afterEach(() => {
  database?.close(); database = undefined
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = ''; vi.unstubAllGlobals(); vi.restoreAllMocks()
})
function sync() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-miniflux-'))
  database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  return new BackendSynchronizer(database, client, true, [28, 58])
}

describe('native Miniflux connection and identity', () => {
  it('preserves subpaths, rejects secret-bearing base URLs and sends the token only to native requests', () => {
    expect(minifluxBaseUrl(baseUrl)).toBe(baseUrl.slice(0, -1))
    for (const value of ['javascript:bad', 'https://user:private@example.test/', 'https://example.test/?token=private', 'https://example.test/#fragment']) expect(() => minifluxBaseUrl(value)).toThrow(/MINIFLUX_BASE_URL/)
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/miniflux\.example\.test\/reader\/v1\//)
      expect(options?.redirect).toBe('error')
      expect(new Headers(options?.headers).get('X-Auth-Token')).toBe('synthetic-miniflux-key')
    }
  })
  it('binds to the account without binding to a key or username', async () => {
    const rotated = new MinifluxClient({ baseUrl: baseUrl.slice(0, -1), apiKey: 'synthetic-rotated-key' })
    await rotated.initialize(); expect(rotated.identity).toEqual(client.identity)
    fixture.userId = 12
    const other = new MinifluxClient({ baseUrl, apiKey: 'synthetic-rotated-key' })
    await other.initialize(); expect(other.identity.id).not.toBe(client.identity.id)
    expect((await other.entry(`${other.identity.id}:entry:1`))?.id).not.toBe(id('entry', 1))
    await expect(client.entry(`${other.identity.id}:entry:1`)).rejects.toThrow(/this Miniflux account/)
  })
  it.each(['2.3.1', '2.2.17', '1.9.9', 'development', '2.3.2-rc1'])('rejects unsupported or unverified version %s', async version => {
    fixture.version = version
    await expect(client.initialize()).rejects.toThrow(/2.3.2/)
  })
  it('redacts authentication and provider errors', async () => {
    const invalid = new MinifluxClient({ baseUrl, apiKey: 'synthetic-invalid-key' })
    await expect(invalid.initialize()).rejects.toThrow(/authentication failed/)
    fixture.failures.push({ path: 'v1/feeds', method: 'GET', remaining: 3, status: 500 })
    await expect(client.navigation()).rejects.toThrow('Miniflux request failed with HTTP 500')
    expect(fixture.calls.filter(call => call.path === 'v1/feeds')).toHaveLength(3)
  })
  it('rejects foreign IDs before any I/O, including late invalid batch members', async () => {
    const before = fixture.calls.length
    await expect(client.editEntries([id('entry', 1), 'feed/1'], 'read')).rejects.toThrow(/this Miniflux account/)
    await expect(client.entriesByIds([id('entry', 1), id('entry', Number.MAX_SAFE_INTEGER + 1)])).rejects.toThrow()
    await expect(client.removeFeed('https://elsewhere.example.test/')).rejects.toThrow()
    expect(fixture.calls).toHaveLength(before)
  })
})

describe('Miniflux navigation and article reads', () => {
  it.each(['navigation', 'entry', 'page', 'entries', 'batch', 'state', 'import'] as const)('cancels %s before sending a request', async operation => {
    const controller = new AbortController(), reason = new Error('Synthetic cancellation')
    controller.abort(reason)
    const before = fixture.calls.length, signal = controller.signal
    const actions = {
      navigation: () => client.navigation(signal), entry: () => client.entry(id('entry', 1), signal),
      page: () => client.entriesPage(all, { signal }), entries: () => client.entries(all, { signal }),
      batch: () => client.entriesByIds([id('entry', 1)], signal), state: () => client.entryIds(stars, false, signal),
      import: () => client.importPage({ limit: 10, changedBefore: new Date(), signal }),
    }
    await expect(actions[operation]()).rejects.toBe(reason)
    expect(fixture.calls).toHaveLength(before)
  })
  it('aborts in-flight lookups without retrying or starting the next batch', async () => {
    const controller = new AbortController(), reason = new Error('Synthetic cancellation')
    const fetcher = vi.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetcher)
    const work = client.entriesByIds(Array.from({ length: 8 }, (_, index) => id('entry', index + 1)), controller.signal)
    expect(fetcher).toHaveBeenCalledTimes(4)
    controller.abort(reason)
    await expect(work).rejects.toBe(reason)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('maps every category including hidden ones, counts and safe content without upstream credentials', async () => {
    const navigation = await client.navigation()
    expect(navigation).toMatchObject({ unread: 3, starred: 0, uncategorized: [] })
    expect(navigation.folders.map(folder => folder.id)).toEqual([id('category', 7), id('category', 9)])
    const entry = await client.entry(id('entry', 1))
    expect(entry).toMatchObject({ id: id('entry', 1), feedId: id('feed', 42), read: false, starred: false, kind: 'article' })
    expect(entry?.contentHtml).toContain('<strong>reader</strong>')
    expect(entry?.contentHtml).not.toContain('<script>')
    const payload = JSON.stringify({ navigation, entry })
    for (const secret of ['synthetic-private-password', 'synthetic-private-cookie', 'synthetic-private-username', 'synthetic-miniflux-key']) expect(payload).not.toContain(secret)
  })
  it('pages deterministically and binds continuations to the account and stream', async () => {
    const first = await client.entriesPage(all, { limit: 2 })
    expect(first.items.map(entry => entry.id)).toEqual([id('entry', 3), id('entry', 2)])
    fixture.entries.push({ ...fixture.entries[0], id: 4 })
    const second = await client.entriesPage(all, { limit: 2, continuation: first.continuation })
    expect(second.items.map(entry => entry.id)).toEqual([id('entry', 1)])
    await expect(client.entriesPage(stars, { limit: 2, continuation: first.continuation })).rejects.toThrow(/continuation/)
  })
  it('keeps reader date bounds about publication, and imports about changes', async () => {
    expect((await client.entries(all, { before: new Date('2025-01-01T00:00:01Z') })).length).toBe(3)
    expect((await client.entries(all, { after: new Date('2025-01-01T00:00:01Z') })).length).toBe(0)
    fixture.entries[0].changed_at = '2026-10-01T00:00:00Z'
    expect((await client.importPage({ limit: 250, changedAfter: new Date('2026-09-01'), changedBefore: new Date('2026-11-01') })).items.map(entry => entry.id)).toEqual([id('entry', 1)])
    expect((await client.entry(id('entry', 999)))).toBeNull()
    fixture.entries[0].status = 'removed'
    expect(await client.entry(id('entry', 1))).toBeNull()
    expect((await client.entries(all)).map(entry => entry.id)).not.toContain(id('entry', 1))
  })
  it('retrieves more than 10,000 state IDs and fails closed on a truncated page', async () => {
    fixture = minifluxApi({ size: 10003 }); vi.mocked(fetch).mockImplementation(fixture.fetch)
    expect(await client.entryIds(all, true)).toHaveLength(10003)
    expect(fixture.calls.filter(call => call.path === 'v1/entries/ids').map(call => call.query.get('offset'))).toEqual(['0', '10000'])
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ total: 10003, entry_ids: [1, 2] })))
    await expect(client.entryIds(all, true)).rejects.toThrow(/truncated/)
  })
  it('rejects repeated or unordered article pages instead of completing import', async () => {
    const native = fixture.fetch
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const response = await native(url, options)
      if (String(url).includes('v1/entries?')) {
        const body = await response.json(); body.entries.reverse(); return new Response(JSON.stringify(body))
      }
      return response
    })
    await expect(client.entriesPage(all)).rejects.toThrow(/did not advance/)
  })
})

describe('Miniflux state and subscriptions', () => {
  it.each(['read', 'unread', 'star', 'unstar'] as const)('sets %s explicitly and safely repeats it', async operation => {
    await client.editEntries([id('entry', 1)], operation)
    await client.editEntries([id('entry', 1)], operation)
    const changes = fixture.calls.filter(call => call.path === 'v1/entries' && call.method === 'PUT')
    expect(changes).toHaveLength(2)
    expect(changes[0].body).toEqual(operation === 'read' || operation === 'unread' ? { entry_ids: [1], status: operation } : { entry_ids: [1], starred: operation === 'star' })
    expect(fixture.calls.some(call => call.path.includes('bookmark'))).toBe(false)
  })
  it('retries an explicit state write after a lost acknowledgement without toggling', async () => {
    let lost = true
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const response = await fixture.fetch(url, options)
      if (options?.method === 'PUT' && lost) { lost = false; throw new Error('Synthetic dropped acknowledgement') }
      return response
    })
    await client.editEntries([id('entry', 1)], 'star')
    expect(fixture.entries[0].starred).toBe(true)
    expect(fixture.calls.filter(call => call.method === 'PUT')).toHaveLength(2)
    await expect(client.editEntries([id('entry', 999)], 'star')).rejects.toThrow(/no longer available/)
  })
  it('adds a category with a new subscription, moves by ID and never blindly replays creation', async () => {
    await client.addFeed('https://example.test/new.xml', 'New title', 'New category')
    expect(fixture.feeds[1]).toMatchObject({ title: 'New title', category: { title: 'New category' } })
    await client.applyFeedCommand({ type: 'move-feed', feedId: id('feed', 42), fromFolderId: id('category', 7), toFolderId: id('category', 9) })
    expect(fixture.feeds[0].category.id).toBe(9)
    await expect(client.applyFeedCommand({ type: 'move-feed', feedId: id('feed', 42), fromFolderId: id('category', 7), toFolderId: id('category', 9) })).rejects.toThrow(/moved/)
    await expect(client.applyFeedCommand({ type: 'move-feed', feedId: id('feed', 42), fromFolderId: id('category', 9), toFolderId: null })).rejects.toThrow(/category/)
    fixture.failures.push({ path: 'v1/feeds', method: 'POST', remaining: 3, status: 500 })
    await expect(client.addFeed('https://example.test/failure.xml')).rejects.toThrow(/HTTP 500/)
    expect(fixture.calls.filter(call => call.path === 'v1/feeds' && call.method === 'POST')).toHaveLength(2)
    await client.removeFeed(id('feed', 43)); expect(fixture.feeds).toHaveLength(1)
  })
  it('supports OPML choices, duplicate policy and existing category moves', async () => {
    const synchronizer = sync()
    const importer = new SubscriptionImporter(minifluxImportStore(client, synchronizer))
    const xml = '<opml version="2.0"><body><outline text="New" xmlUrl="https://example.test/new.xml" type="rss"/></body></opml>'
    let preview = await importer.preview(xml)
    expect(preview.backend).toBe('miniflux'); expect(preview.warnings.join(' ')).toContain('Miniflux')
    let result = await importer.apply(preview.token, [{ key: '1', action: 'create', folders: [] }])
    expect(result.results[0].status).toBe('created')
    preview = await importer.preview(xml)
    result = await importer.apply(preview.token, [{ key: '1', action: 'create', folders: [] }])
    expect(result.results[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('Miniflux cannot create') })
    preview = await importer.preview(xml)
    result = await importer.apply(preview.token, [{ key: '1', action: 'reuse', existingId: id('feed', 43), folders: ['Writers'] }])
    expect(result.results[0].status).toBe('reused')
    expect(fixture.feeds[1].category.id).toBe(9)
  })
})

describe('native change synchronization', () => {
  it('imports backdated arrivals, updates old content, preserves progress and reconciles remote state', async () => {
    const synchronizer = sync()
    await synchronizer.syncNow()
    expect(database!.entryCount()).toBe(3)
    expect(database!.getSyncValue('backfill_complete')).toBe('true')
    expect((await synchronizer.parity()).ready).toBe(true)
    database!.saveReadingProgress(id('entry', 1), .42)
    await synchronizer.editEntries([id('entry', 1)], 'star')
    database!.setSyncValue('native_changed_until', new Date(Date.now() - 3600000).toISOString())
    fixture.entries[0].title = 'Updated old article'; fixture.entries[0].status = 'read'
    fixture.entries[0].changed_at = new Date(Date.now() - 1000).toISOString()
    fixture.entries.push({ ...fixture.entries[1], id: 4, published_at: '2001-01-01T00:00:00Z', changed_at: new Date(Date.now() - 1000).toISOString() })
    await synchronizer.syncNow()
    expect(database!.localEntry(id('entry', 1))).toMatchObject({ title: 'Updated old article', read: true, starred: true, readingPosition: .42 })
    expect(database!.localEntry(id('entry', 4))?.publishedAt).toBe('2001-01-01T00:00:00.000Z')
    expect(database!.organizationCapabilities.stableFolderIds).toBe(true)
    fixture.failures.push({ path: 'v1/entries/ids', method: 'GET', remaining: 3, status: 500 })
    await expect(synchronizer.syncNow()).rejects.toThrow(/HTTP 500/)
    expect(database!.localEntry(id('entry', 1))?.starred).toBe(true)
  })
  it('persists the import page and cursor together and resumes a failed backfill', async () => {
    fixture = minifluxApi({ size: 251 }); vi.mocked(fetch).mockImplementation(fixture.fetch)
    const synchronizer = sync()
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      if (new URL(String(url)).searchParams.has('after_entry_id')) return new Response('{}', { status: 400 })
      return fixture.fetch(url, options)
    })
    await expect(synchronizer.syncNow()).rejects.toThrow(/HTTP 400/)
    expect(database!.entryCount()).toBe(250)
    expect(database!.getSyncValue('backfill_complete')).not.toBe('true')
    expect(database!.getSyncValue('native_import_continuation')).not.toBe('')
    const before = database!.getSyncValue('native_import_before')
    database!.close(); database = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    vi.mocked(fetch).mockImplementation(fixture.fetch)
    await new BackendSynchronizer(database, client, true, [28, 58]).syncNow()
    expect(database.entryCount()).toBe(251)
    expect(database.getSyncValue('native_changed_until')).toBe(before)
    expect(database.getSyncValue('backfill_complete')).toBe('true')
  })
  it('does not mark a repeated cursor complete or overwrite local state after a rejected write', async () => {
    const synchronizer = sync()
    const page = await client.importPage({ limit: 1, changedBefore: new Date() })
    vi.spyOn(client, 'importPage').mockResolvedValue(page)
    await expect(synchronizer.syncNow()).rejects.toThrow(/did not advance/)
    expect(database!.getSyncValue('backfill_complete')).not.toBe('true')
    const previous = database!.localEntry(id('entry', 1))?.read
    fixture.failures.push({ path: 'v1/entries', method: 'PUT', remaining: 3, status: 500 })
    await expect(synchronizer.editEntries([id('entry', 1)], 'read')).rejects.toThrow(/HTTP 500/)
    expect(database!.localEntry(id('entry', 1))?.read).toBe(previous)
  })
})
