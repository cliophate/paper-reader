import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { organizationRouter } from '../src/server/organization-routes'
import { FRESHRSS_ORGANIZATION_CAPABILITIES, LOCAL_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
import { BackendSynchronizer } from '../src/server/sync'
import type { ReaderBackend } from '../src/server/backend'
import type { NavigationPayload } from '../src/server/types'
import type { OrganizationCommand, OrganizationResponse, OrganizationView } from '../src/shared/organization'

let directory: string, db: PaperDatabase, server: Server | undefined, base: string
const local = { id: 'standalone:organization-api-test', kind: 'standalone' as const }
const remote = { id: 'freshrss:organization-api-test', kind: 'freshrss' as const }
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-organization-api-')); db = new PaperDatabase(path.join(directory, 'paper.sqlite')) })
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }; db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
async function mount(backend: Parameters<typeof organizationRouter>[0]['backend'], synchronizer?: BackendSynchronizer) {
  const app = express(); app.use(express.json()); app.use('/api/organization', organizationRouter({ database: db, backend, synchronizer }))
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const address = server.address(); base = `http://127.0.0.1:${typeof address === 'object' && address?.port}/api/organization`
}
async function snapshot(): Promise<OrganizationView> { return (await fetch(base)).json() }
async function post(body: unknown) { const response = await fetch(`${base}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
async function localSetup() { db.bindBackend(local); await mount({ identity: local, organizationCapabilities: LOCAL_ORGANIZATION_CAPABILITIES, navigation: async () => db.localNavigation() }) }
function remoteSetup() {
  let nav: NavigationPayload = { unread: 0, starred: 0, folders: [{ id: 'folder/destination', title: 'Destination', unread: 0, feeds: [] }], uncategorized: [{ id: 'feed/one', title: 'One', url: 'https://example.test/feed', siteUrl: '', iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }] }
  const backend = {
    identity: remote, organizationCapabilities: FRESHRSS_ORGANIZATION_CAPABILITIES,
    validateFeedId: vi.fn(), navigation: vi.fn(async () => structuredClone(nav)),
    editFeed: vi.fn(async (id: string, title: string, folder: string) => {
      const feed = [...nav.uncategorized, ...nav.folders.flatMap(folder => folder.feeds)].find(feed => feed.id === id)!
      nav = { ...nav, uncategorized: [], folders: nav.folders.map(folder => ({ ...folder, feeds: [] })) }
      const changed = { ...feed, title, categories: folder ? [folder] : [] }
      if (folder) nav.folders.find(item => item.title === folder)!.feeds.push(changed)
      else nav.uncategorized.push(changed)
    }), removeFeed: vi.fn(async () => { nav.uncategorized = []; nav.folders.forEach(folder => { folder.feeds = [] }) }),
  } as unknown as ReaderBackend
  const sync = new BackendSynchronizer(db, backend, true, [0])
  return { backend, sync }
}

describe('organization HTTP contract', () => {
  it('validates the whole payload before mutation and requires the current standalone revision', async () => {
    await localSetup()
    const before = await snapshot()
    expect(before).toMatchObject({ backend: 'standalone', revision: 0, capabilities: LOCAL_ORGANIZATION_CAPABILITIES })
    for (const commands of [[{ type: 'create-folder', title: 'Good' }, { type: 'rename-feed', feedId: 123, title: 'Bad' }], [{ type: 'order-folders', folderIds: 'bad' }], [{ type: '__proto__' }], []]) {
      expect((await post({ expectedRevision: 0, commands })).status).toBe(400)
    }
    expect((await post({ expectedRevision: null, commands: [{ type: 'create-folder', title: 'Empty' }] })).status).toBe(400)
    expect((await snapshot()).navigation.folders).toEqual([])
    const result = await post({ expectedRevision: 0, commands: [{ type: 'create-folder', title: 'Empty' }] })
    expect(result.body.results[0]).toMatchObject({ status: 'applied', changed: true })
    expect(result.body.snapshot.navigation.folders[0]).toMatchObject({ title: 'Empty', feeds: [] })
    const stale = await post({ expectedRevision: 0, commands: [{ type: 'create-folder', title: 'Stale' }] })
    expect(stale).toMatchObject({ status: 409, body: { code: 'conflict', currentRevision: 1 } })
    expect((await snapshot()).navigation.folders).toHaveLength(1)
  })

  it('returns indexed collision failures while committing unrelated operations', async () => {
    await localSetup()
    const result = await post({ expectedRevision: 0, commands: [{ type: 'create-folder', title: 'Essays' }, { type: 'create-folder', title: ' essays ' }, { type: 'create-folder', title: 'Empty' }] })
    expect(result.status).toBe(200)
    expect(result.body.results).toMatchObject([{ index: 0, status: 'applied' }, { index: 1, status: 'failed', code: 'collision' }, { index: 2, status: 'applied' }])
    expect(result.body.snapshot.revision).toBe(1)
  })

  it('preserves article references and multi-membership semantics through HTTP edits and restart', async () => {
    await localSetup()
    const feedId = db.saveLocalSubscription(local.id, { title: 'Feed', url: 'https://example.test/feed' })
    const imported = db.importSourceEntries(local.id, feedId, [{ identity: { externalId: 'article' }, entry: {
      title: 'Saved article', feedTitle: 'Feed', feedUrl: 'https://example.test/feed', url: 'https://example.test/article', author: '', contentHtml: '<p>Fixture</p>', excerpt: 'Fixture', publishedAt: '2026-10-01T00:00:00Z', timestamp: 1, readingMinutes: 1, thumbnailUrl: '', kind: 'article',
    } }])[0]
    if (imported.status !== 'resolved') throw new Error('Expected article')
    const id = imported.id
    db.commitLocalEntryState(local.id, [id], 'read'); db.commitLocalEntryState(local.id, [id], 'star'); db.saveReadingProgress(id, .7)
    db.saveDiscussion({ entryId: id, revision: 1, source: { title: 'Fixture', author: '', url: 'https://example.test/article', kind: 'feed', paragraphs: [], warning: '' }, messages: [] })
    const state = db.entryState(id)
    const apply = async (commands: OrganizationCommand[]) => (await post({ expectedRevision: (await snapshot()).revision, commands })).body
    const created = await apply([{ type: 'create-folder', title: 'A' }, { type: 'create-folder', title: 'B' }, { type: 'create-folder', title: 'Empty' }])
    const [a, b, empty] = created.results.map((item: { id: string }) => item.id)
    await apply([{ type: 'move-feed', feedId, fromFolderId: null, toFolderId: a }, { type: 'add-membership', feedId, folderId: b }, { type: 'order-folders', folderIds: [empty, b, a] }])
    const moved = await apply([{ type: 'move-feed', feedId, fromFolderId: a, toFolderId: null }])
    expect(moved.snapshot.navigation.uncategorized).toEqual([])
    expect(moved.snapshot.navigation.folders.find((folder: { id: string }) => folder.id === b).feeds[0].id).toBe(feedId)
    const removed = await apply([{ type: 'remove-folder', folderId: b }])
    expect(removed.snapshot.navigation.uncategorized[0].id).toBe(feedId)
    const reloaded = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    try {
      expect(reloaded.organization.snapshot(local.id).navigation.folders.map(folder => folder.id)).toEqual([empty, a])
      expect(reloaded.entryState(id)).toEqual(state)
      expect(reloaded.localEntry(id)?.readingPosition).toBe(.7)
      expect(reloaded.discussion(id)?.entryId).toBe(id)
    } finally { reloaded.close() }
    await apply([{ type: 'unsubscribe', feedId }])
    expect(db.entryState(id)).toEqual(state)
    expect(db.localEntry(id)?.readingPosition).toBe(.7)
    expect(db.discussion(id)?.entryId).toBe(id)
  })

  it('cannot silently bind a FreshRSS database to the dormant standalone route', async () => {
    db.bindBackend(remote)
    await mount({ identity: local, organizationCapabilities: LOCAL_ORGANIZATION_CAPABILITIES, navigation: async () => db.localNavigation() })
    expect((await fetch(base)).status).toBe(503)
    expect((await post({ expectedRevision: 0, commands: [{ type: 'create-folder', title: 'Unsafe' }] })).status).toBe(503)
    expect(db.localNavigation().folders).toEqual([])
  })

  it('uses actual FreshRSS capabilities, ignores forged flags and reports partial remote failures', async () => {
    const { backend, sync } = remoteSetup(); await mount(backend, sync)
    vi.mocked(backend.editFeed).mockRejectedValueOnce(new Error('private upstream error'))
    const result = await post({ expectedRevision: null, capabilities: LOCAL_ORGANIZATION_CAPABILITIES, commands: [{ type: 'create-folder', title: 'Unsupported' }, { type: 'rename-feed', feedId: 'feed/one', title: 'No' }, { type: 'rename-feed', feedId: 'feed/one', title: 'Yes' }] })
    expect(result.body.results).toMatchObject([{ status: 'failed', code: 'unsupported' }, { status: 'failed', code: 'remote-failure' }, { status: 'applied' }])
    expect(JSON.stringify(result.body)).not.toContain('private upstream')
    expect(result.body.snapshot).toMatchObject({ revision: null, backend: 'freshrss', capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES })
    expect(result.body.snapshot.navigation.uncategorized[0].title).toBe('Yes')
    expect(backend.editFeed).toHaveBeenCalledTimes(2)
    expect((await post({ expectedRevision: 0, commands: [{ type: 'unsubscribe', feedId: 'feed/one' }] })).status).toBe(400)
    expect(backend.removeFeed).not.toHaveBeenCalled()
  })

  it('retains acknowledged item outcomes when remote navigation fails after the write', async () => {
    const { backend, sync } = remoteSetup(); await mount(backend, sync)
    const original = vi.mocked(backend.editFeed).getMockImplementation()!
    vi.spyOn(backend, 'editFeed').mockImplementation(async (...args) => { await original(...args); vi.mocked(backend.navigation).mockRejectedValue(new Error('offline')) })
    const result = await post({ expectedRevision: null, commands: [{ type: 'rename-feed', feedId: 'feed/one', title: 'Confirmed' }] })
    const body = result.body as OrganizationResponse
    expect(body.results).toEqual([{ index: 0, status: 'applied', changed: true }])
    expect(body.snapshot).toBeNull()
    expect(body.refreshError).toContain('Changes were processed')
  })
})

