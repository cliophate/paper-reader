import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { FRESHRSS_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
import { BackendSynchronizer } from '../src/server/sync'
import type { ReaderBackend } from '../src/server/backend'
import type { NavigationPayload } from '../src/server/types'
import type { OrganizationCommand } from '../src/shared/organization'

let directory: string, db: PaperDatabase
const remote = { id: 'freshrss:organization-queue-test', kind: 'freshrss' as const }
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-organization-queue-')); db = new PaperDatabase(path.join(directory, 'paper.sqlite')) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
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

describe('remote organization queue', () => {
  it('resolves metadata within the queue so a rename followed by a move keeps the new title', async () => {
    const { backend, sync } = remoteSetup()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = vi.mocked(backend.editFeed).getMockImplementation()!
    vi.spyOn(backend, 'editFeed').mockImplementationOnce(async (...args) => { await gate; await original(...args) })
    const rename = sync.applyOrganizationCommand({ type: 'rename-feed', feedId: 'feed/one', title: 'Renamed' })
    const move = sync.applyOrganizationCommand({ type: 'move-feed', feedId: 'feed/one', fromFolderId: null, toFolderId: 'folder/destination' })
    await Promise.resolve(); await Promise.resolve()
    expect(backend.navigation).toHaveBeenCalledTimes(1)
    release(); await Promise.all([rename, move])
    expect(backend.editFeed).toHaveBeenLastCalledWith('feed/one', 'Renamed', 'Destination', '')
    expect(db.localNavigation().folders[0].feeds[0].title).toBe('Renamed')
    await expect(sync.applyOrganizationCommand({ type: 'move-feed', feedId: 'feed/one', fromFolderId: null, toFolderId: null })).rejects.toMatchObject({ code: 'conflict' })
    expect(backend.editFeed).toHaveBeenCalledTimes(2)
  })

  it('reports a cache refresh failure after acknowledgement without rejecting the remote write', async () => {
    const { backend, sync } = remoteSetup()
    const original = vi.mocked(backend.editFeed).getMockImplementation()!
    vi.mocked(backend.editFeed).mockImplementation(async (...args) => { await original(...args); vi.mocked(backend.navigation).mockRejectedValue(new Error('offline')) })
    const result = await sync.applyOrganizationCommand({ type: 'rename-feed', feedId: 'feed/one', title: 'Confirmed' })
    expect(result.refreshError).toContain('FreshRSS confirmed the change')
    expect(backend.editFeed).toHaveBeenCalledOnce()
  })

  it('keeps local navigation unchanged on rejected writes and recovers the queue', async () => {
    const { backend, sync } = remoteSetup(); await sync.refreshNavigation()
    vi.mocked(backend.editFeed).mockRejectedValueOnce(new Error('offline'))
    await expect(sync.applyOrganizationCommand({ type: 'rename-feed', feedId: 'feed/one', title: 'Rejected' })).rejects.toThrow('offline')
    expect(db.localNavigation().uncategorized[0].title).toBe('One')
    await sync.applyOrganizationCommand({ type: 'rename-feed', feedId: 'feed/one', title: 'Recovered' })
    expect(db.localNavigation().uncategorized[0].title).toBe('Recovered')
    await expect(sync.applyOrganizationCommand({ type: 'create-folder', title: 'No' } as OrganizationCommand)).rejects.toThrow('does not support')
  })
})
