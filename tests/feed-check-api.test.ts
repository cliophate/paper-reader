import type { Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { StandaloneBackend } from '../src/server/standalone-backend'
import { StandaloneRuntime } from '../src/server/standalone-runtime'
import { StandaloneFeedScheduler } from '../src/server/feed-scheduler'
import { feedMove, resolveFeedRepair } from '../src/server/feed-maintenance'
import { feedCheckRouter } from '../src/server/feed-check-routes'
import { requireSameOrigin } from '../src/server/request-origin'
import type { FeedChecksView } from '../src/shared/feed-checks'

let db: PaperDatabase, runtime: StandaloneRuntime, backend: StandaloneBackend, server: Server, base: string, feedId: string
beforeEach(() => {
  db = new PaperDatabase(':memory:'); backend = new StandaloneBackend(db)
  runtime = new StandaloneRuntime(db, backend, true, [])
  feedId = db.saveLocalSubscription(backend.identity.id, { url: 'https://example.test/fixture', title: 'Synthetic' })
  vi.spyOn(StandaloneFeedScheduler.prototype, 'runDue').mockResolvedValue({ attempted: 0, fetched: 0, notModified: 0, failed: 0, stale: 0, ambiguous: 0 })
})
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }; await runtime.stop(); db.close(); vi.restoreAllMocks() })
async function mount(remote: 'freshrss' | 'miniflux' | false = false) {
  const app = express(); app.use(express.json()); app.use(requireSameOrigin('https://paper.example.test'))
  app.use('/api/feed-checks', feedCheckRouter(db, remote ? { id: `${remote}:fixture`, kind: remote } : backend.identity, remote ? undefined : runtime))
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const address = server.address(); base = `http://127.0.0.1:${typeof address === 'object' && address?.port}/api/feed-checks`
}
async function snapshot(): Promise<FeedChecksView> { return (await fetch(base)).json() }
const revision = (view: FeedChecksView) => ({ expectedRevision: view.revision, expectedOrganizationRevision: view.organizationRevision })
async function post(action: string, body: unknown, origin = 'https://paper.example.test') {
  const response = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

it('requires origin and both revisions before saving intervals or queueing checks', async () => {
  await mount()
  const before = await snapshot()
  expect((await post('now', { ...revision(before), feedId }, 'https://other.test')).status).toBe(403)
  expect((await post('now', { feedId })).status).toBe(400)
  expect((await post('now', { ...revision(before), expectedRevision: 10, feedId })).status).toBe(409)
  const saved = await post('interval', { ...revision(before), intervalMinutes: 5 })
  expect(saved).toMatchObject({ status: 200, body: { snapshot: { revision: 1, intervalMinutes: 5 } } })
  expect(saved.body).not.toHaveProperty('results')
  expect((await post('now', { ...revision(before), feedId })).status).toBe(409)
  const current = await snapshot()
  db.organization.apply(backend.identity.id, current.organizationRevision, [{ type: 'rename-feed', feedId, title: 'New title' }])
  expect((await post('now', { ...revision(current), feedId })).status).toBe(409)
  expect(runtime.checkState(feedId)).toBe('idle')
})

it('validates interval bounds, optional overrides, and active subscriptions', async () => {
  await mount()
  for (const intervalMinutes of [null, 4, 1441, 5.5, '15']) {
    expect((await post('interval', { ...revision(await snapshot()), intervalMinutes })).status).toBe(400)
  }
  expect((await post('interval', { ...revision(await snapshot()), intervalMinutes: 1440, feedId })).status).toBe(200)
  expect((await snapshot()).feeds[0].intervalMinutes).toBe(1440)
  expect((await post('interval', { ...revision(await snapshot()), intervalMinutes: null, feedId })).status).toBe(200)
  expect((await snapshot()).feeds[0].intervalMinutes).toBeNull()
  db.organization.apply(backend.identity.id, db.organization.snapshot(backend.identity.id).revision, [{ type: 'unsubscribe', feedId }])
  expect((await post('now', { ...revision(await snapshot()), feedId })).status).toBe(400)
  expect((await post('interval', { ...revision(await snapshot()), feedId, intervalMinutes: 15 })).status).toBe(400)
})

it('hides signed destinations and rejects a repair reference after the publisher rotates its signature', async () => {
  await mount()
  const rawRedirect = 'https://publisher.test/rss?token=redirect-secret'
  const declared = 'https://publisher.test/new?sig=declared-secret'
  const save = (address: string) => db.greaderDatabase.prepare(`UPDATE feed_fetch_state
    SET redirects_json = ?, validator_url = ?, declared_url = ?, publisher_site_url = ?, last_success_at = 1
    WHERE subscription_id = ?`).run(JSON.stringify([{ status: 301, url: rawRedirect }]), rawRedirect,
      address, 'https://publisher.test/?sig=site-secret', feedId)
  save(declared)
  const view = await snapshot()
  const move = view.feeds[0].move!
  expect(move).toMatchObject({ redirects: [{ status: 301, url: 'https://publisher.test/rss' }],
    declaredUrl: 'https://publisher.test/new', suggestedUrl: 'https://publisher.test/new', repairRef: expect.any(String) })
  expect(JSON.stringify(view)).not.toMatch(/redirect-secret|declared-secret|site-secret/)
  const state = () => db.feedFetch.get(backend.identity.id, feedId)!
  expect(resolveFeedRepair(state(), move.repairRef)).toBe(declared)
  save(declared + '-rotated')
  expect(() => resolveFeedRepair(state(), move.repairRef)).toThrow(/changed/)
  expect(resolveFeedRepair(state(), (await snapshot()).feeds[0].move!.repairRef)).toBe(declared + '-rotated')
  save('')
  const permanent = (await snapshot()).feeds[0].move!
  expect(permanent.suggestedUrl).toBe('https://publisher.test/rss')
  expect(resolveFeedRepair(state(), permanent.repairRef)).toBe(rawRedirect)
})

it('expires a signed repair reference even when the same address is suggested again', () => {
  const state = db.feedFetch.get(backend.identity.id, feedId)!
  state.declaredUrl = 'https://publisher.test/new?hash=fixture'
  const start = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  const ref = feedMove(state)!.repairRef!
  clock.mockReturnValue(start + 60 * 60_000 - 1)
  expect(resolveFeedRepair(state, ref)).toBe(state.declaredUrl)
  const renewed = feedMove(state)!.repairRef!
  expect(() => resolveFeedRepair(state, renewed.split('.')[0] + '.' + ref.split('.')[1])).toThrow(/refresh/i)
  clock.mockReturnValue(start + 60 * 60_000)
  expect(() => resolveFeedRepair(state, ref)).toThrow(/expired.*refresh/i)
  expect(resolveFeedRepair(state, renewed)).toBe(state.declaredUrl)
  state.lastAttemptAt++
  expect(() => resolveFeedRepair(state, renewed)).toThrow(/changed.*refresh/i)
})

it('checks the chosen folder once per feed and returns safe schedule fields', async () => {
  await mount()
  await backend.addFeed('https://example.test/second', 'Second', 'Folder')
  const view = await snapshot()
  const folderId = view.folders[0].id
  const result = await post('now', { ...revision(view), folderId })
  expect(result.status).toBe(200)
  expect(result.body.results).toHaveLength(1)
  expect(result.body.results[0].status).toBe('queued')
  expect(result.body.results[0].feedId).not.toBe(feedId)
  expect(runtime.checkState(feedId)).toBe('idle')
  const repeated = await post('now', { ...revision(view), folderId })
  expect(repeated.body.results).toEqual(result.body.results)
  expect((await post('now', { ...revision(view), folderId: null })).body.results).toEqual([{ feedId, status: 'queued' }])
  expect((await post('now', { ...revision(view), folderId: 'missing' })).status).toBe(400)
  expect((await post('now', { ...revision(view), feedId, folderId })).status).toBe(400)
  expect(JSON.stringify(await snapshot())).not.toMatch(/leaseToken|etag|endpointGeneration|example.test/)
})

it.each(['freshrss', 'miniflux'] as const)('leaves %s feed collection with the remote reader', async remote => {
  await mount(remote)
  expect(await snapshot()).toMatchObject({ backend: remote, enabled: false, feeds: [] })
  expect((await post('now', { expectedRevision: 0, expectedOrganizationRevision: 0, feedId })).body.error).toContain(`${remote === 'miniflux' ? 'Miniflux' : 'FreshRSS'} manages`)
})

it('rejects checks when collection is disabled', async () => {
  await runtime.stop()
  runtime = new StandaloneRuntime(db, backend, false, [])
  await mount()
  const view = await snapshot()
  expect(view.enabled).toBe(false)
  expect((await post('now', { ...revision(view), feedId })).body.error).toMatch(/disabled/)
})

it.each([false, 'freshrss', 'miniflux'] as const)('stores ordered last-post bands for backend %s', async remote => {
  await mount(remote)
  const url = base + '/maintenance'
  const get = async () => (await fetch(url)).json()
  const save = (staleDays: unknown) => fetch(url, { method: 'PATCH', headers: {
    'Content-Type': 'application/json', Origin: 'https://paper.example.test',
  }, body: JSON.stringify({ staleDays }) })
  expect(await get()).toEqual({ staleDays: [90, 182, 365], articleCounts: {} })
  expect((await save([7, 30, 60])).status).toBe(200)
  for (const invalid of [null, [0, 1, 2], [1, 1, 2], [3, 2, 1], [1, 2], [1, '2', 3], [1, 2, 3.5]]) {
    expect((await save(invalid)).status).toBe(400)
  }
  expect((await get()).staleDays).toEqual([7, 30, 60])
})
