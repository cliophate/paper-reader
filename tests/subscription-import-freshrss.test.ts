import { BackendSynchronizer } from '../src/server/sync'
import type { PaperDatabase } from '../src/server/db'
import { describe, expect, it, vi } from 'vitest'
import { freshRssImportStore } from '../src/server/subscription-import-freshrss'
import { SubscriptionImporter } from '../src/server/subscription-import'
import { FRESHRSS_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
import type { ReaderBackend } from '../src/server/backend'
import type { NavigationPayload, Feed } from '../src/server/types'
const feed: Feed = { id: 'feed/1', title: 'Current title', url: 'https://example.test/rss', siteUrl: '', iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }
const navigation: NavigationPayload = { unread: 0, starred: 0, folders: [{ id: 'destination', title: 'Reading', feeds: [], unread: 0 }], uncategorized: [feed] }
function fixture() {
  const backend = { identity: { id: 'remote', kind: 'freshrss' }, organizationCapabilities: FRESHRSS_ORGANIZATION_CAPABILITIES, navigation: vi.fn(async () => navigation) } as unknown as ReaderBackend
  const sync = { addFeed: vi.fn(async () => ({})), applyOrganizationCommand: vi.fn(async () => ({ refreshError: 'Acknowledged, but local refresh failed.' })) }
  const store = freshRssImportStore(backend, sync)
  return { backend, sync, store, importer: new SubscriptionImporter(store) }
}
describe('FreshRSS import adapter', () => {
  it('moves reused subscriptions through the queue command and preserves acknowledged refresh failures as applied', async () => {
    const { sync, importer } = fixture()
    const preview = await importer.preview('<opml><body><outline xmlUrl="https://example.test/rss"/></body></opml>')
    const result = await importer.apply(preview.token, [{ key: '1', action: 'reuse', existingId: 'feed/1', folders: ['Reading'] }])
    expect(sync.applyOrganizationCommand).toHaveBeenCalledWith({ type: 'move-feed', feedId: 'feed/1', fromFolderId: null, toFolderId: 'destination' })
    expect(result.results[0].status).toBe('reused')
    expect(result.results[0].message).toContain('Acknowledged, but local refresh failed')
  })
  it('reports acknowledged creation as created when local activity recording fails', async () => {
    const { backend } = fixture()
    backend.addFeed = vi.fn(async () => {})
    const db = { bindBackend() {}, recordActivity() { throw new Error('Synthetic cache failure') } } as unknown as PaperDatabase
    const sync = new BackendSynchronizer(db, backend, false, [])
    const importer = new SubscriptionImporter(freshRssImportStore(backend, sync))
    const preview = await importer.preview('<opml><body><outline xmlUrl="https://new.test/rss"/></body></opml>')
    const result = await importer.apply(preview.token, [{ key: '1', action: 'create', folders: [] }])
    expect(backend.addFeed).toHaveBeenCalledOnce()
    expect(result.results[0].status).toBe('created')
    expect(result.results[0].message).toContain('FreshRSS confirmed the subscription')
  })
  it('does not invent new remote folders for reuse, and calls existing addFeed for creation', async () => {
    const { store, sync, importer } = fixture()
    await expect(store.setFolders('feed/1', ['New'], null)).rejects.toThrow(/existing folder/)
    expect(sync.applyOrganizationCommand).not.toHaveBeenCalled()
    const preview = await importer.preview('<opml><body><outline text="New" xmlUrl="https://new.test/rss"/></body></opml>')
    await importer.apply(preview.token, [{ key: '1', action: 'create', folders: ['New folder'] }])
    expect(sync.addFeed).toHaveBeenCalledWith('https://new.test/rss', 'New', 'New folder')
  })
})
