import clients from './fixtures/greader/clients.json'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { request as httpRequest, type Server } from 'node:http'
import { PaperDatabase } from '../src/server/db'
import { ingestFeed } from '../src/server/feed-ingestion'
import { GreaderAuth } from '../src/server/greader-auth'
import { greaderRoutes } from '../src/server/greader-routes'
import { GreaderPool } from '../src/server/greader-pool'
import { AuthConnections } from '../src/server/auth-connections'
import { LocalStateService } from '../src/server/local-state'
import { itemNumber, longId, MAX_ID, READING, STATE, LABEL, page } from '../src/server/greader-query'
import { requireAllowedHost, requireSameOrigin } from '../src/server/request-origin'
import { authGate } from '../src/server/auth-routes'

let connections: AuthConnections
let dir: string, db: PaperDatabase, auth: GreaderAuth, api: ReturnType<typeof greaderRoutes>, server: Server, base: string, backend: string, password: string, bearer: string, token: string, feed: string
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-greader-test-')); db = new PaperDatabase(path.join(dir, 'paper.sqlite'))
  backend = db.bindStandalone().id; feed = db.saveLocalSubscription(backend, { url: 'https://example.test/rss', title: 'Fixture' })
  ingestFeed(db, { backendId: backend, subscriptionId: feed, endpointGeneration: 'fixture', requestUrl: 'https://example.test/rss', responseUrl: 'https://example.test/rss', fetchedAt: new Date().toISOString(),
    xml: `<rss version="2.0"><channel><title>Fixture</title>${Array.from({ length: 260 }, (_, i) => `<item><guid>${i}</guid><title>Article ${i}</title><link>https://example.test/${i}</link><description>${'Synthetic body. '.repeat(200)}</description><pubDate>2000-01-01T00:00:00Z</pubDate></item>`).join('')}</channel></rss>` })
  password = (await db.auth.createApp('synthetic', null)).password
  auth = new GreaderAuth(db.greaderDatabase, db.auth, true, 'http://localhost')
  const app = express(); connections = new AuthConnections(db.auth)
  app.use(requireAllowedHost('http://localhost')); app.use(requireSameOrigin('http://localhost')); app.use(authGate(db.auth, connections))
  api = greaderRoutes(db, auth, backend, new LocalStateService(db, backend), connections, async () => { throw new Error('Synthetic discovery refuses network access') })
  app.use(api.handler)
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/greader.php`
}, 15000)
afterAll(async () => { await api?.close(); if (server) await new Promise<void>(r => server.close(() => r())); db?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }) })
async function call(endpoint: string, pairs: [string, string][] = [], method = 'GET', headers: Record<string, string> = {}) {
  const p = new URLSearchParams(pairs)
  const response = await fetch(base + (endpoint.startsWith('/') ? endpoint : '/reader/api/0/' + endpoint) + (method === 'GET' ? '?' + p : ''), { method,
    headers: { ...(bearer ? { Authorization: `GoogleLogin auth=${bearer}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers }, body: method === 'POST' ? p.toString() : undefined })
  return response
}
it('defaults to disabled, supports administrator credentials without owner login, and uses stable separate tokens', async () => {
  expect((await call('token')).status).toBe(404)
  auth.configure(true, 'reader')
  const response = await call('/accounts/ClientLogin', [['Email', 'reader'], ['Passwd', password], ['output', 'json']], 'POST')
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull()
  bearer = /Auth=(.+)/.exec(await response.text())![1]
  token = (await (await call('token')).text()).trim(); expect(token).toHaveLength(57)
  expect((await call('user-info')).headers.get('cache-control')).toBe('no-store')
  const info = await (await call('user-info')).json(); expect(info).toEqual({ userId: 'paper', userName: 'reader', userProfileId: 'paper', userEmail: '' })
  const reopened = new PaperDatabase(db.searchDatabasePath)
  expect(new GreaderAuth(reopened.greaderDatabase, reopened.auth, true, 'http://localhost').token(reopened.auth.apps()[0], 'auth')).toBe(bearer); reopened.close()
})
it('round-trips positive signed 64-bit IDs without floating-point conversion', () => {
  for (const n of [1n, 42n, 9007199254740993n, MAX_ID]) expect(itemNumber(longId(n))).toBe(n)
  for (const id of ['0', '-1', '9223372036854775808', '1.2', 'tag:google.com,2005:reader/item/ffffffffffffffff']) expect(() => itemNumber(id)).toThrow()
})
it('clamps pages, binds signed continuations and freezes arrival high water', async () => {
  const p: [string, string][] = [['s', READING], ['n', '10000']]
  const first = await (await call('stream/items/ids', p)).json(); expect(first.itemRefs).toHaveLength(250); expect(first.continuation).toBeTypeOf('string')
  const second = await (await call('stream/items/ids', [...p, ['c', first.continuation]])).json(); expect(second.itemRefs).toHaveLength(10); expect(second.continuation).toBeUndefined()
  expect(new Set([...first.itemRefs, ...second.itemRefs].map(i => i.id)).size).toBe(260)
  expect((await call('stream/items/ids', [...p, ['c', first.continuation + 'x']])).status).toBe(400)
  expect((await call('stream/items/ids', [['s', `${STATE}starred`], ['c', first.continuation]])).status).toBe(400)
  const data = await (await call('stream/items/contents', [['i', first.itemRefs[0].id], ['i', longId(BigInt(first.itemRefs[0].id))]], 'POST')).json()
  expect(data.items).toHaveLength(1)
  expect(data.items[0]).toMatchObject({ id: longId(BigInt(first.itemRefs[0].id)), title: expect.any(String), author: expect.any(String), published: expect.any(Number), crawlTimeMsec: expect.any(String), timestampUsec: expect.any(String), summary: { content: expect.any(String) }, origin: { streamId: expect.stringMatching(/^feed\/\d+$/) }, categories: expect.any(Array) })
})
it('rejects expired continuations and keeps their signing key across restart', async () => {
  const fields: [string,string][] = [['s',READING],['n','2']]
  const data = await (await call('stream/items/ids',fields)).json()
  const [payload,signature] = data.continuation.split('.')
  const reopened = new PaperDatabase(db.searchDatabasePath)
  const restarted = new GreaderAuth(reopened.greaderDatabase,reopened.auth,true,'http://localhost')
  expect(restarted.sign('cursor',payload)).toBe(signature)
  reopened.close()
  const saved = JSON.parse(Buffer.from(payload,'base64url').toString()); saved.expires=Date.now()-1
  const expired = Buffer.from(JSON.stringify(saved)).toString('base64url')
  expect((await call('stream/items/ids',[...fields,['c',`${expired}.${auth.sign('cursor',expired)}`]])).status).toBe(400)
  expect((await call('stream/items/ids',[...fields,['c',data.continuation]])).status).toBe(200)
})
it('serves encoded folder contents and keeps continuation identity through rename', async () => {
  const name = 'Path / + % Café', stream = `${LABEL}${name}`
  const created = db.organization.apply(backend,db.organization.snapshot(backend).revision,[{type:'create-folder',title:name}]).results[0]
  if (created.status !== 'applied') throw new Error('Fixture folder failed')
  const folderId = created.id!
  db.organization.apply(backend,db.organization.snapshot(backend).revision,[{type:'add-membership',feedId:feed,folderId}])
  const fields: [string,string][] = [['s',stream],['n','2'],['r','o']]
  const first = await (await call('stream/contents',fields)).json()
  const encoded = await (await call(`stream/contents/${encodeURIComponent(stream)}`,[['n','2'],['r','o']])).json()
  expect(encoded.items).toEqual(first.items)
  expect(first.items[0].id).toBe(longId(1n))
  db.organization.apply(backend,db.organization.snapshot(backend).revision,[{type:'rename-folder',folderId,title:'Renamed path'}])
  const next = await (await call('stream/contents',[...fields,['c',first.continuation]])).json()
  expect(next.items[0].id).toBe(longId(3n))
  expect((await call('stream/contents',fields)).status).toBe(404)
  db.organization.apply(backend,db.organization.snapshot(backend).revision,[{type:'remove-folder',folderId}])
  expect((await call('stream/contents',[...fields,['c',first.continuation]])).status).toBe(404)
})
it('commits read and star once, preserves no-ops and rejects labels atomically', async () => {
  const sql = db.greaderDatabase, id = String(sql.prepare('SELECT entry_id FROM article_arrivals WHERE sequence = 1').get()!.entry_id)
  expect((await call('edit-tag', [['i', '1'], ['a', `${STATE}read`], ['a', `${STATE}starred`], ['T', token]], 'POST')).status).toBe(200)
  expect(db.entryState(id)).toEqual({ read: true, starred: true, revision: 1 })
  const modified = sql.prepare('SELECT greader_modified_ms FROM entries WHERE id = ?').get(id)!.greader_modified_ms
  expect((await call('edit-tag', [['i', '1'], ['a', `${STATE}read`], ['T', token]], 'POST')).status).toBe(200)
  expect(sql.prepare('SELECT greader_modified_ms FROM entries WHERE id = ?').get(id)!.greader_modified_ms).toBe(modified)
  expect((await call('edit-tag', [['i', '1'], ['r', `${STATE}read`], ['a', `${LABEL}Bad`], ['T', token]], 'POST')).status).toBe(400)
  expect(db.entryState(id)!.revision).toBe(1)
  expect(() => db.commitLocalEntryState(backend, [id], 'unread', { expectedRevisions: { [id]: 0 } })).toThrow()
})
it('enforces Auth, T, origin, host, methods and body bounds', async () => {
  expect((await call('token', [], 'GET', { Authorization: '' })).status).toBe(401)
  expect((await call('token', [], 'GET', { Origin: 'https://evil.test' })).status).toBe(403)
  const bad = await call('edit-tag', [['i', '1'], ['a', `${STATE}read`]], 'POST'); expect(bad.status).toBe(403); expect(bad.headers.get('X-Reader-Google-Bad-Token')).toBe('true')
  expect((await call('edit-tag', [], 'GET')).status).toBe(404)
  expect((await call('edit-tag', [['T', token]], 'POST', { Origin: 'https://evil.test' })).status).toBe(403)
  expect(await new Promise(resolve => { const req = httpRequest(base + '/reader/api/0/token', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode) }); req.end() })).toBe(421)
  expect((await call('subscription/import', [], 'POST')).status).toBe(404)
  expect((await call('stream/items/contents', [['i', '1'], ['T', 'x']], 'POST')).status).toBe(403)
  expect((await call('stream/items/contents', [['i', '1'], ['r', 'o'], ['r', 'd']], 'POST')).status).toBe(400)
})
it('rejects oversized batches and login bodies without accepting cookie-only authority', async () => {
  expect((await call('stream/items/contents',Array.from({length:251},(_,i)=>['i',String(i+1)]),'POST')).status).toBe(413)
  expect((await call('edit-tag',[...Array.from({length:1001},(_,i):[string,string]=>['i',String(i+1)]),['a',`${STATE}read`],['T',token]],'POST')).status).toBe(413)
  expect((await call('/accounts/ClientLogin',[['Email','reader'],['Passwd','x'.repeat(8192)]],'POST')).status).toBe(413)
  expect((await call('token',[],'GET',{Authorization:'',Cookie:'paper_session=synthetic'})).status).toBe(401)
  expect((await call('stream/contents/%E0%A4%A')).status).toBe(400)
})
it('filters arrival and modification times with inclusive boundaries and intersecting states', () => {
  const sql = db.greaderDatabase
  const q = { backend, stream: { kind: 'state' as const, id: 'reading-list' }, it: [], xt: [], ot: 0, nt: 0, order: 'DESC' as const, n: 250 }
  sql.exec('UPDATE entries SET first_seen_at = 1000000, greader_modified_ms = 1000000')
  expect(page(sql, { ...q, ot: 1000, nt: 1000 }, false).values.length).toBe(250)
  expect(page(sql, { ...q, ot: 1001 }, false).values).toHaveLength(0)
  expect(page(sql, { ...q, it: [{ kind: 'state', id: 'read' }], xt: [{ kind: 'state', id: 'read' }] }, false).values).toHaveLength(0)
})
it('omits deleted content and accepts retries for deleted state IDs', async () => {
  db.greaderDatabase.exec('DELETE FROM entries WHERE id IN (SELECT entry_id FROM article_arrivals WHERE sequence = 2)')
  const response = await call('stream/items/contents', [['i', '2']], 'POST'); expect(response.status).toBe(200); expect((await response.json()).items).toEqual([])
  expect((await call('edit-tag', [['i', '2'], ['a', `${STATE}read`], ['T', token]], 'POST')).status).toBe(200)
})
it.each(clients)('replays $client source-derived sync and management requests', async client => {
  async function request(endpoint: string, pairs: [string, string][] = [], method = 'GET') {
    for (;;) {
      const queryOutput = method === 'POST' && client.client !== 'NetNewsWire'
      const response = await call(queryOutput ? endpoint + (endpoint.includes('?') ? '&' : '?') + 'output=json' : endpoint, queryOutput ? pairs : [...pairs, ['output', 'json']], method)
      if (response.status === 429) { await response.text(); await delay(1000); continue }
      expect(response.status, await response.clone().text()).toBe(200)
      return response
    }
  }
  const login = await call('/accounts/ClientLogin', [['Email', 'reader'], ['Passwd', password], ...client.loginFields as [string,string][]], 'POST')
  expect(login.status).toBe(200); expect(/Auth=(.+)/.exec(await login.text())![1]).toBe(bearer)
  for (const endpoint of client.sequence.filter(s => ['token', 'user-info', 'subscription/list', 'tag/list'].includes(s))) {
    const response = await request(endpoint)
    if (endpoint === 'token') expect((await response.text()).trim()).toHaveLength(57)
    else {
      const dto = await response.json()
      if (endpoint === 'subscription/list') for (const feed of dto.subscriptions) {
        for (const key of ['id','title','url','htmlUrl','iconUrl']) expect(feed[key]).toBeTypeOf('string')
        expect(Array.isArray(feed.categories)).toBe(true)
        for (const category of feed.categories) { expect(category.id).toBeTypeOf('string'); expect(category.label).toBeTypeOf('string') }
      }
    }
  }
  for (const stream of ['unread', 'starred', 'read', 'history']) {
    const fields: [string,string][] = [['s', stream === 'starred' ? `${STATE}starred` : READING], ['n', String(client.pageSize)]]
    if (stream === 'unread') fields.push(['xt', `${STATE}read`])
    if (stream === 'read') { if (client.client === 'Read You') fields.push(['it', `${STATE}read`]); else fields[0] = ['s', `${STATE}read`] }
    if (stream === 'history') fields.push(['ot', '1'])
    const dto = await (await request('stream/items/ids', fields)).json()
    for (const ref of dto.itemRefs) expect(ref.id).toMatch(/^[0-9]+$/)
    if (dto.continuation !== undefined) expect(dto.continuation).toBeTypeOf('string')
  }
  const fields: [string,string][] = Array.from({ length: client.contentBatch }, (_, i) => ['i', client.idForm === 'long' ? longId(BigInt(i + 1)) : String(i + 1)])
  await Promise.all(Array.from({ length: client.concurrentContent }, async () => {
    const dto = await (await request('stream/items/contents', [...fields, ['T', token]], 'POST')).json()
    expect(dto.id).toBeTypeOf('string'); expect(Number.isInteger(dto.updated)).toBe(true)
    for (const item of dto.items) {
      expect(item.id).toMatch(/^tag:google.com,2005:reader\/item\/[0-9a-f]{16}$/)
      for (const key of ['title', 'author', 'crawlTimeMsec', 'timestampUsec']) expect(item[key]).toBeTypeOf('string')
      expect(Number.isInteger(item.published)).toBe(true); expect(item.summary.content).toBeTypeOf('string')
      expect(item.categories.every((tag: unknown) => typeof tag === 'string')).toBe(true)
      for (const key of ['streamId','title','htmlUrl']) expect(item.origin[key]).toBeTypeOf('string')
      for (const link of [...item.canonical, ...item.alternate]) expect(link.href).toBeTypeOf('string')
    }
  }))
  const ids: [string,string][] = Array.from({ length: client.stateBatch }, (_, i) => ['i', client.idForm === 'long' ? longId(BigInt(i + 1)) : String(i + 1)])
  expect(await (await request('edit-tag', [...ids, ['a', `${STATE}read`], ['T', token]], 'POST')).text()).toBe('OK')
  const quick = await (await request(client.quickaddQueryAndBody ? 'subscription/quickadd?quickadd=https%3A%2F%2Fexample.test%2Frss' : 'subscription/quickadd', [['quickadd', 'https://example.test/rss'], ['T', token]], 'POST')).json()
  expect(quick.numResults).toBe(1)
  await request('subscription/edit', [['s', quick.streamId], ['ac','edit'], ['a', `${LABEL}Unicode / + % Café`], ['t','Renamed'], ['T',token]], 'POST')
  await request('rename-tag', [['s', `${LABEL}Unicode / + % Café`], ['dest', `${LABEL}Moved / + % Café`], ['T', token]], 'POST')
  await request('disable-tag', [['s', `${LABEL}Moved / + % Café`], ['T', token]], 'POST')
}, 30000)
it('limits authenticated traffic and rejects the owner password as an app password', async () => {
  await db.auth.setup(db.auth.setupCode(), 'reader', 'synthetic owner password')
  const rejected = await call('/accounts/ClientLogin', [['Email', 'reader'], ['Passwd', 'synthetic owner password']], 'POST')
  expect(rejected.status).toBe(401)
  const responses = await Promise.all(Array.from({ length: 45 }, () => call('token')))
  expect(responses.some(response => response.status === 429)).toBe(true)
  for (const response of responses) { if (response.status === 429) expect(response.headers.get('retry-after')).toBeTruthy(); await response.text() }
})
it('revokes persistent bearer credentials and disables FreshRSS', async () => {
  expect(new GreaderAuth(db.greaderDatabase, db.auth, false, 'http://localhost').enabled()).toBe(false)
  await delay(1100)
  let entered!: () => void
  const running = new Promise<void>(resolve => { entered=resolve })
  const blocked = vi.spyOn(GreaderPool.prototype,'run').mockImplementationOnce((_input,signal) => {
    entered(); return new Promise((_resolve,reject) => signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))
  })
  const pending = call('stream/items/ids',[['s',READING]])
  await running
  db.auth.revokeAllApps(); connections.check()
  const closed = await pending
  expect(closed.status).toBe(401); expect(await closed.json()).toEqual({errors:['Unauthorized.']})
  blocked.mockRestore()
  expect((await call('token')).status).toBe(401)
  await db.auth.recover('disable'); expect(auth.enabled()).toBe(false)
})
