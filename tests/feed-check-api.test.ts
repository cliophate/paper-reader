import type { Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { StandaloneBackend } from '../src/server/standalone-backend'
import { StandaloneRuntime } from '../src/server/standalone-runtime'
import { StandaloneFeedScheduler } from '../src/server/feed-scheduler'
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
