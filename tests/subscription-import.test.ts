import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { localImportStore } from '../src/server/subscription-import-local'
import { SubscriptionImporter, type SubscriptionImportStore } from '../src/server/subscription-import'
import { exportOpml } from '../src/server/opml'
import { FRESHRSS_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
import type { ImportChoice } from '../src/shared/subscription-tools'
import type { Feed, NavigationPayload } from '../src/server/types'

const resources: Array<() => void> = []
afterEach(() => { resources.reverse().forEach(cleanup => cleanup()); resources.length = 0 })
function local() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-opml-'))
  const db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  db.bindBackend({ id: 'synthetic-standalone', kind: 'standalone' })
  resources.push(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const store = localImportStore(db, 'synthetic-standalone')
  return { db, store, importer: new SubscriptionImporter(store) }
}
const xml = '<opml><body><outline text="News"><outline text="Example" xmlUrl="https://example.test/rss"/></outline><outline text="Other" xmlUrl="https://other.test/rss"/></body></opml>'
const fakeFeed = (id: string, url: string): Feed => ({ id, title: id, url, siteUrl: '', iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false })
const choices = (keys: string[]): ImportChoice[] => keys.map(key => ({ key, action: 'create', folders: [] }))

function remote() {
  const navigation: NavigationPayload = { unread: 0, starred: 0, folders: [], uncategorized: [] }
  const store: SubscriptionImportStore = {
    backendId: 'synthetic-remote', kind: 'freshrss',
    snapshot: vi.fn(async () => ({ navigation, revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES })),
    create: vi.fn(async row => { navigation.uncategorized.push(fakeFeed(row.key, row.url)); return row.key }),
    setFolders: vi.fn(async () => {}),
  }
  return { store, navigation, importer: new SubscriptionImporter(store) }
}

describe('subscription import application', () => {
  it('initializes schedules and preserves them with subscription identity through an OPML round trip', async () => {
    const { db, store, importer } = local()
    const first = await importer.preview(xml)
    const added = await importer.apply(first.token, first.rows.map(row => ({ key: row.key, action: 'create', folders: row.folders.filter(Boolean) })))
    expect(added.results.map(result => result.status)).toEqual(['created', 'created'])
    const before = await store.snapshot()
    const schedules = added.results.map(result => db.feedFetch.get(store.backendId, result.id!))
    expect(schedules.map(schedule => schedule?.url)).toEqual(first.rows.map(row => row.url))
    for (const schedule of schedules) {
      expect(schedule).toMatchObject({ nextFetchAt: 0, availableAt: 0, failures: 0, etag: '', leaseToken: '' })
      expect(schedule?.endpointGeneration).toMatch(/^[0-9a-f-]{36}$/)
    }
    const exported = exportOpml(before.navigation, store.backendId)
    const second = await importer.preview(exported.xml)
    expect(second.rows.every(row => row.suggestedId)).toBe(true)
    const reused = await importer.apply(second.token, second.rows.map(row => ({ key: row.key, action: 'reuse', existingId: row.suggestedId, folders: row.folders.filter(Boolean) })))
    expect(reused.results.map(result => result.id)).toEqual(added.results.map(result => result.id))
    expect(await store.snapshot()).toEqual(before)
    expect(added.results.map(result => db.feedFetch.get(store.backendId, result.id!))).toEqual(schedules)
  })

  it('preserves multiple memberships and distinct same-URL subscriptions in a round trip', async () => {
    const { store, importer } = local()
    const first = await importer.preview('<opml><body><outline xmlUrl="https://same.test/rss"/><outline xmlUrl="https://same.test/rss"/></body></opml>')
    const added = await importer.apply(first.token, first.rows.map(row => ({ key: row.key, action: 'create', folders: ['A', 'B'] })))
    expect(new Set(added.results.map(row => row.id)).size).toBe(2)
    const before = await store.snapshot()
    const preview = await importer.preview(exportOpml(before.navigation, store.backendId).xml)
    expect(preview.rows).toHaveLength(2)
    const reused = await importer.apply(preview.token, preview.rows.map(row => ({ key: row.key, action: 'reuse', existingId: row.suggestedId, folders: row.folders })))
    expect(reused.results.map(row => row.id)).toEqual(added.results.map(row => row.id))
    expect((await store.snapshot()).navigation).toEqual(before.navigation)
  })

  it('rejects stale previews before writes, including remote navigation changes', async () => {
    const { importer, store, navigation } = remote()
    const preview = await importer.preview(xml)
    navigation.uncategorized.push(fakeFeed('new', 'https://new.test/rss'))
    await expect(importer.apply(preview.token, choices(preview.rows.map(row => row.key)))).rejects.toMatchObject({ code: 'conflict' })
    expect(store.create).not.toHaveBeenCalled()
  })

  it('reserves apply before awaiting navigation and never replays a consumed batch', async () => {
    const { importer, store } = remote()
    const preview = await importer.preview(xml)
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    const normalSnapshot = store.snapshot
    store.snapshot = async () => { await gate; return normalSnapshot() }
    const first = importer.apply(preview.token, choices(preview.rows.map(row => row.key)))
    await expect(importer.apply(preview.token, choices(preview.rows.map(row => row.key)))).rejects.toThrow(/Another import/)
    resume()
    await first
    await expect(importer.apply(preview.token, choices(preview.rows.map(row => row.key)))).rejects.toThrow(/already used/)
    expect(store.create).toHaveBeenCalledTimes(2)
  })

  it('reports partial remote failure without leaking backend errors or replaying successful items', async () => {
    const { importer, store } = remote()
    vi.mocked(store.create).mockRejectedValueOnce(new Error('private provider token'))
    const preview = await importer.preview(xml)
    const result = await importer.apply(preview.token, choices(preview.rows.map(row => row.key)))
    expect(result.results.map(row => row.status)).toEqual(['failed', 'created'])
    expect(result.results[0].message).toContain('partly applied')
    expect(JSON.stringify(result)).not.toContain('private provider token')
    await expect(importer.apply(preview.token, choices(preview.rows.map(row => row.key)))).rejects.toThrow(/already used/)
  })

  it('rejects unsupported memberships and same-URL creation on FreshRSS per item', async () => {
    const { importer, store } = remote()
    const preview = await importer.preview('<opml><body><outline xmlUrl="https://same.test/rss"/><outline xmlUrl="https://same.test/rss"/><outline xmlUrl="https://other.test/rss"/></body></opml>')
    const selected = choices(preview.rows.map(row => row.key)); selected[2].folders = ['A', 'B']
    const result = await importer.apply(preview.token, selected)
    expect(result.results.map(row => row.status)).toEqual(['created', 'failed', 'failed'])
    expect(result.results[1].message).toContain('distinct subscription')
    expect(result.results[2].message).toContain('only one folder')
    expect(store.create).toHaveBeenCalledOnce()
  })

  it('allows explicit reuse without changing metadata, even when ID and URL evidence conflict', async () => {
    const { importer, store, navigation } = remote()
    navigation.uncategorized.push(fakeFeed('one', 'https://original.test/rss'))
    const exported = exportOpml(navigation, store.backendId).xml
    navigation.uncategorized[0].url = 'https://changed.test/rss'
    const preview = await importer.preview(exported)
    expect(preview.rows[0].identityConflict).toBe(true)
    expect(preview.rows[0].suggestedId).toBeNull()
    const result = await importer.apply(preview.token, [{ key: preview.rows[0].key, action: 'reuse', existingId: 'one', folders: null }])
    expect(result.results[0].status).toBe('reused')
    expect(store.setFolders).not.toHaveBeenCalled()
    expect(navigation.uncategorized[0].url).toBe('https://changed.test/rss')
  })

  it('rejects forged IDs, colliding folder names, invalid choices and expired previews', async () => {
    const { importer, store } = remote()
    const preview = await importer.preview(xml)
    await expect(importer.apply(preview.token, [])).rejects.toThrow(/every preview row/)
    const result = await importer.apply(preview.token, [{ key: '1', action: 'reuse', existingId: 'forged', folders: null }, { key: '2', action: 'create', folders: ['UNCATEGORIZED'] }])
    expect(result.results.every(row => row.status === 'failed')).toBe(true)
    expect(store.create).not.toHaveBeenCalled()
    let now = 0
    const expiring = new SubscriptionImporter(store, () => now)
    const expiringPreview = await expiring.preview(xml); now = 600001
    await expect(expiring.apply(expiringPreview.token, choices(['1', '2']))).rejects.toThrow(/expired/)
  })
})
