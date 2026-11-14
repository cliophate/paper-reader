import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { RetentionService } from '../src/server/retention'
import { retentionRouter } from '../src/server/retention-routes'
import { defaultPolicy } from '../src/server/retention-store'
import { requireSameOrigin } from '../src/server/request-origin'
import { freshRssIdentity } from '../src/server/identity'

let directory: string, db: PaperDatabase, service: RetentionService, server: Server, base: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-retention-api-')); db = new PaperDatabase(path.join(directory, 'paper.sqlite')) })
afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await service?.stop(); db.close(); fs.rmSync(directory, { recursive: true, force: true })
})
async function mount(remote = false) {
  const backend = remote ? freshRssIdentity('https://example.test', 'synthetic') : db.bindStandalone()
  if (remote) db.bindBackend(backend)
  service = new RetentionService(db, backend)
  const app = express(); app.use(express.json()); app.use(requireSameOrigin('https://paper.example.test')); app.use('/api/retention', retentionRouter(service))
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const address = server.address(); base = `http://127.0.0.1:${typeof address === 'object' && address?.port}/api/retention`
}
async function post(route: string, body: unknown, origin = 'https://paper.example.test') {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
it('requires same-origin writes, a matching preview and current policy revision', async () => {
  await mount()
  const policy = { ...defaultPolicy(), readDays: 60 }
  expect((await post('/preview', { policy }, 'https://other.test')).status).toBe(403)
  expect((await post('', { policy, revision: 0 })).status).toBe(409)
  const preview = await post('/preview', { policy })
  expect(preview).toMatchObject({ status: 200, body: { marked: 0, deleted: 0 } })
  expect((await post('', { policy, revision: 0, token: preview.body.token })).status).toBe(200)
  await service.drain()
  expect((await post('', { policy: defaultPolicy(), revision: 0 })).status).toBe(409)
  expect((await post('/preview', { policy: { ...policy, unreadDays: -1 } })).status).toBe(400)
})
it('rejects article policies in FreshRSS while allowing cache cleanup', async () => {
  await mount(true)
  expect((await post('/preview', { policy: { ...defaultPolicy(), readDays: 60 } })).status).toBe(400)
  expect((await post('', { policy: { ...defaultPolicy(), autoReadDays: 30 }, revision: 0 })).status).toBe(409)
  expect((await post('', { policy: { ...defaultPolicy(), cacheDays: 30 }, revision: 0 })).status).toBe(200)
  await service.drain()
  expect(service.view()).toMatchObject({ backend: 'freshrss', lastRun: null, cacheRun: { deleted: 0 } })
})
