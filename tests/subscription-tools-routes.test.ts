import { createServer, type Server } from 'node:http'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireSameOrigin } from '../src/server/request-origin'
import { subscriptionToolsRoutes } from '../src/server/subscription-tools-routes'
import { FRESHRSS_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
import type { SubscriptionImportStore } from '../src/server/subscription-import'
import type { NavigationPayload } from '../src/server/types'
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))) })
async function fixture() {
  const navigation: NavigationPayload = { unread: 0, starred: 0, folders: [], uncategorized: [{ id: 'feed/1', title: 'Example', url: 'https://example.test/rss', siteUrl: '', iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }] }
  const store: SubscriptionImportStore = {
    backendId: 'fixture', kind: 'freshrss', snapshot: async () => ({ navigation, revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES }),
    create: vi.fn(async () => undefined), setFolders: vi.fn(async () => {}),
  }
  const transport = vi.fn(async () => ({ body: '<rss version="2.0"><channel><title>Example</title></channel></rss>', responseUrl: 'https://example.test/rss', contentType: 'text/xml' }))
  const app = express(); app.use(requireSameOrigin('https://paper.test')); app.use('/api/subscription-tools', subscriptionToolsRoutes(store, transport))
  const server = createServer(app); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/subscription-tools/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') }
  }
  return { request, navigation, store, transport, origin: `http://127.0.0.1:${address.port}` }
}
describe('subscription tools HTTP routes', () => {
  it('exports, previews and applies existing subscriptions with unchanged stable IDs', async () => {
    const { request, store } = await fixture()
    const exported = await request('export')
    expect(exported.status).toBe(200); expect(exported.cache).toBe('no-store')
    const preview = await request('preview', { xml: exported.data.xml })
    expect(preview.data.rows[0].suggestedId).toBe('feed/1')
    const apply = await request('apply', { token: preview.data.token, choices: [{ key: '1', action: 'reuse', existingId: 'feed/1', folders: null }] })
    expect(apply.data.results[0]).toMatchObject({ status: 'reused', id: 'feed/1' })
    expect(store.create).not.toHaveBeenCalled()
    expect((await request('apply', { token: preview.data.token, choices: [] })).status).toBe(409)
  })
  it('returns conflict metadata on stale navigation and validates candidate preview input', async () => {
    const { request, navigation } = await fixture()
    const preview = await request('preview-feed', { url: 'https://example.test/rss', title: 'A & B' })
    expect(preview.data.rows[0].title).toBe('A & B')
    navigation.uncategorized[0].title = 'Changed'
    const response = await request('apply', { token: preview.data.token, choices: [{ key: '1', action: 'skip', folders: [] }] })
    expect(response.status).toBe(409)
    expect(response.data).toMatchObject({ code: 'conflict', currentRevision: null })
    expect((await request('preview-feed', { url: 'https://user:password@example.test/rss', title: 'Bad' })).status).toBe(400)
  })
  it('rejects cross-origin requests before parsing or side effects and sanitizes oversized JSON', async () => {
    const { origin, store, transport } = await fixture()
    const cross = await fetch(origin + '/api/subscription-tools/discover', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.test' }, body: '{invalid private content' })
    expect(cross.status).toBe(403)
    expect(transport).not.toHaveBeenCalled(); expect(store.create).not.toHaveBeenCalled()
    const oversized = await fetch(origin + '/api/subscription-tools/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xml: 'private-input'.repeat(650000) }) })
    expect(oversized.status).toBe(413)
    expect(await oversized.text()).not.toContain('private-input')
  })
  it('rejects malformed/oversized XML and JSON without returning input or provider errors', async () => {
    const { request, transport, origin } = await fixture()
    expect((await request('preview', { xml: '<!DOCTYPE opml [<!ENTITY x "secret">]><opml><body/></opml>' })).status).toBe(400)
    expect((await request('preview', { xml: ' '.repeat(1024 * 1024 + 1) })).status).toBe(400)
    const bad = await fetch(origin + '/api/subscription-tools/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"private-token": secret}' })
    expect(bad.status).toBe(400); expect(await bad.text()).not.toContain('private-token')
    transport.mockRejectedValueOnce(new Error('private provider details'))
    const failed = await request('discover', { url: 'https://example.test/' })
    expect(failed.status).toBe(502); expect(JSON.stringify(failed.data)).not.toContain('private provider')
  })
})
