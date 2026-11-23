import { expectMatchingEntryState } from './fixtures/entry-state.js'
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

const discovery = vi.fn<import('../src/server/feed-discovery').DiscoveryTransport>(async () => { throw new Error('Synthetic discovery refuses network access') })
let state: LocalStateService
let connections: AuthConnections
let dir: string, db: PaperDatabase, auth: GreaderAuth, api: ReturnType<typeof greaderRoutes>, server: Server, base: string, backend: string, password: string, bearer: string, token: string, feed: string
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-greader-test-')); db = new PaperDatabase(path.join(dir, 'paper.sqlite'))
  backend = db.bindStandalone().id; feed = db.saveLocalSubscription(backend, { url: 'https://example.test/rss', title: 'Fixture' })
  ingestFeed(db, { backendId: backend, subscriptionId: feed, endpointGeneration: 'fixture', requestUrl: 'https://example.test/rss', responseUrl: 'https://example.test/rss', fetchedAt: new Date().toISOString(),
    xml: `<rss version="2.0"><channel><title>Fixture</title>${Array.from({ length: 260 }, (_, i) => `<item><guid>${i}</guid><enclosure url="https://media.example.test/${i}.mp3" type="audio/mpeg" length="87"/><title>Article ${i}</title><link>https://example.test/${i}</link><description>${'Synthetic body. '.repeat(200)}</description><pubDate>2000-01-01T00:00:00Z</pubDate></item>`).join('')}</channel></rss>` })
  password = (await db.auth.createApp('synthetic', null)).password
  auth = new GreaderAuth(db.greaderDatabase, db.auth, true, 'http://localhost')
  const app = express(); connections = new AuthConnections(db.auth)
  app.use(requireAllowedHost('http://localhost')); app.use(requireSameOrigin('http://localhost')); app.use(authGate(db.auth, connections))
  state = new LocalStateService(db, backend)
  api = greaderRoutes(db, auth, backend, state, connections, discovery)
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
  token = await (await call('token')).text(); expect(token).toMatch(/^[A-Za-z0-9_-]{57}\n$/)
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
  expect(data.items[0].enclosure).toEqual([{ href: expect.stringMatching(/^https:\/\/media\.example\.test\/\d+\.mp3$/), type: 'audio/mpeg', length: 87 }])
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
it('commits read and star once, preserves no-ops and rejects invalid labels atomically', async () => {
  const sql = db.greaderDatabase, id = String(sql.prepare('SELECT entry_id FROM article_arrivals WHERE sequence = 1').get()!.entry_id)
  expect((await call('edit-tag', [['i', '1'], ['a', `${STATE}read`], ['a', `${STATE}starred`], ['T', token]], 'POST')).status).toBe(200)
  expect(db.entryState(id)).toEqual({ read: true, starred: true, revision: 1 })
  expectMatchingEntryState(sql)
  const modified = sql.prepare('SELECT greader_modified_ms FROM entry_state WHERE entry_id = ?').get(id)!.greader_modified_ms
  expect((await call('edit-tag', [['i', '1'], ['a', `${STATE}read`], ['T', token]], 'POST')).status).toBe(200)
  expect(sql.prepare('SELECT greader_modified_ms FROM entry_state WHERE entry_id = ?').get(id)!.greader_modified_ms).toBe(modified)
  expect((await call('edit-tag', [['i', '1'], ['r', `${STATE}read`], ['a', LABEL], ['T', token]], 'POST')).status).toBe(400)
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
  expect((await call('subscription/import', [], 'POST')).status).toBe(403)
  expect((await call('stream/items/contents', [['i', '1'], ['T', 'x']], 'POST')).status).toBe(403)
  expect((await call('edit-tag', [['i', '1'], ['a', `${STATE}read`], ['T', token.trim()]], 'POST')).status).toBe(200)
  expect((await call('edit-tag', [['i', '1'], ['a', `${STATE}read`], ['T', `${token}\n`]], 'POST')).status).toBe(403)
  const shouting = await fetch(base.replace('/api/greader.php', '/API/GREADER.PHP') + '/reader/api/0/missing', { headers: { Authorization: `GoogleLogin auth=${bearer}` } })
  expect(shouting.status).toBe(404); expect(shouting.headers.get('content-type')).toMatch(/json/)
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
  sql.exec('UPDATE entries SET first_seen_at = 1000000; UPDATE entry_state SET greader_modified_ms = 1000000; UPDATE feeds SET greader_modified_ms = 0')
  expect(page(sql, { ...q, ot: 1000, nt: 1000 }, false).values.length).toBe(250)
  expect(page(sql, { ...q, ot: 1001 }, false).values).toHaveLength(0)
  expect(page(sql, { ...q, it: [{ kind: 'state', id: 'read' }], xt: [{ kind: 'state', id: 'read' }] }, false).values).toHaveLength(0)
})
it('omits deleted content and accepts retries for deleted state IDs', async () => {
  const sql = db.greaderDatabase
  const stateClock = sql.prepare('SELECT greader_modified_ms FROM entry_state WHERE arrival_sequence = 2')
  const before = Number(stateClock.get()!.greader_modified_ms)
  const label = sql.prepare("INSERT INTO article_labels(title, title_key) VALUES ('Temporary', 'temporary')").run()
  sql.prepare('INSERT INTO entry_labels(label_id, sequence) VALUES (?, 2)').run(label.lastInsertRowid)
  expect(Number(stateClock.get()!.greader_modified_ms)).toBeGreaterThan(before)
  sql.exec('DELETE FROM entries WHERE id IN (SELECT entry_id FROM article_arrivals WHERE sequence = 2)')
  expect(sql.prepare('SELECT 1 FROM entry_labels WHERE sequence = 2').get()).toBeUndefined()
  expect(stateClock.get()).toBeUndefined()
  sql.prepare('DELETE FROM article_labels WHERE id = ?').run(label.lastInsertRowid)
  const response = await call('stream/items/contents', [['i', '2']], 'POST'); expect(response.status).toBe(200); expect((await response.json()).items).toEqual([])
  expect((await call('edit-tag', [['i', '2'], ['a', `${STATE}read`], ['T', token]], 'POST')).status).toBe(200)
})
it.each(clients)('replays $client source-derived sync and management requests', async client => {
  async function request(endpoint: string, pairs: [string, string][] = [], method = 'GET') {
    const queryOutput = method === 'POST' && client.client !== 'NetNewsWire'
    const response = await call(queryOutput ? endpoint + (endpoint.includes('?') ? '&' : '?') + 'output=json' : endpoint, queryOutput ? pairs : [...pairs, ['output', 'json']], method)
    expect(response.status, await response.clone().text()).toBe(200)
    return response
  }
  const login = await call('/accounts/ClientLogin', [['Email', 'reader'], ['Passwd', password], ...client.loginFields as [string,string][]], 'POST')
  expect(login.status).toBe(200); expect(/Auth=(.+)/.exec(await login.text())![1]).toBe(bearer)
  for (const endpoint of client.sequence.filter(s => ['token', 'user-info', 'subscription/list', 'tag/list'].includes(s))) {
    const response = await request(endpoint)
    if (endpoint === 'token') expect(await response.text()).toMatch(/^[A-Za-z0-9_-]{57}\n$/)
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

it.each(['subscription/quickadd', 'subscription/edit'])('cancels paused %s after revocation without changing subscriptions or article state', async endpoint => {
  const app = await db.auth.createApp('Pending discovery', null)
  const credential = db.auth.apps().find(value => value.id === app.id)!
  const headers = { Authorization: `GoogleLogin auth=${auth.token(credential, 'auth')}` }
  let entered!: () => void, resume!: () => void, finished!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { resume = resolve })
  const done = new Promise<void>(resolve => { finished = resolve })
  let signal: AbortSignal | undefined
  discovery.mockImplementationOnce(async (url, requestSignal) => {
    signal = requestSignal; entered(); await gate
    finished()
    return { responseUrl: url, body: '<rss version="2.0"><channel><title>Blocked discovery</title></channel></rss>', contentType: 'application/rss+xml' }
  })
  const before = {
    organization: db.organization.metadata(backend),
    state: db.greaderDatabase.prepare('SELECT entry_id, read, starred, state_revision, greader_modified_ms FROM entry_state ORDER BY entry_id').all(),
    activity: db.greaderDatabase.prepare('SELECT count(*) n FROM activity_events').get(),
  }
  const fields: [string, string][] = endpoint.endsWith('quickadd') ? [['quickadd', 'https://example.test/pending']] : [['s', 'feed/https://example.test/pending'], ['ac', 'subscribe'], ['a', `${LABEL}Must not exist`]]
  const pending = call(endpoint, [...fields, ['T', auth.token(credential, 'T')]], 'POST', headers)
  await waiting
  db.auth.revokeApp(app.id); connections.check()
  expect((await pending).status).toBe(401)
  expect(signal?.aborted).toBe(true)
  resume(); await done; await delay(20)
  expect(db.greaderDatabase.prepare("SELECT id FROM feeds WHERE url = 'https://example.test/pending'").get()).toBeUndefined()
  expect(db.organization.metadata(backend)).toEqual(before.organization)
  expect(db.greaderDatabase.prepare('SELECT entry_id, read, starred, state_revision, greader_modified_ms FROM entry_state ORDER BY entry_id').all()).toEqual(before.state)
  expect(db.greaderDatabase.prepare('SELECT count(*) n FROM activity_events').get()).toEqual(before.activity)
})
it('rejects organization batches above 100 before discovery or metadata work', async () => {
  const snapshot = vi.spyOn(db.organization, 'metadata')
  for (const ac of ['edit', 'subscribe']) {
    const response = await call('subscription/edit', [...Array.from({ length: 101 }, (): [string, string] => ['s', 'feed/https://example.test/oversized']), ['ac', ac], ['T', token]], 'POST')
    expect(response.status).toBe(413)
  }
  expect(snapshot).not.toHaveBeenCalled()
  snapshot.mockRestore()
})
it('defers mark-all-as-read with a terminal JSON 404 and leaves state unchanged', async () => {
  const before = db.greaderDatabase.prepare('SELECT sum(read) n, sum(state_revision) revision FROM entry_state').get()
  for (const method of ['GET', 'POST']) {
    const response = await call('mark-all-as-read', [['s', READING], ['T', token]], method)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ errors: ['Not found.'] })
  }
  expect(db.greaderDatabase.prepare('SELECT sum(read) n, sum(state_revision) revision FROM entry_state').get()).toEqual(before)
})
it('invalidates web navigation after organization commits despite a failed listener', async () => {
  const transactionStates: boolean[] = []
  const events = vi.fn(() => { transactionStates.push(db.greaderDatabase.isTransaction) })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const removeBroken = state.onStateChanged(() => { throw new Error('Disconnected SSE client') })
  const removeGood = state.onStateChanged(events)
  const stream = `feed/${db.linkNumber('feed', feed)}`
  try {
    for (const [endpoint, fields] of [
      ['subscription/quickadd', { quickadd: 'https://example.test/rss' }],
      ['subscription/edit', { s: stream, ac: 'edit', t: 'Web notification', a: `${LABEL}Notify` }],
      ['rename-tag', { s: `${LABEL}Notify`, dest: `${LABEL}Notified` }],
      ['disable-tag', { s: `${LABEL}Notified` }],
      ['subscription/edit', { s: stream, ac: 'unsubscribe' }],
      ['subscription/edit', { s: stream, ac: 'subscribe' }],
    ] as [string, Record<string, string>][]) {
      const before = events.mock.calls.length
      const response = await call(endpoint, [...Object.entries(fields), ['T', token]], 'POST')
      expect(response.status, await response.text()).toBe(200)
      expect(events).toHaveBeenCalledTimes(before + 1)
      expect(events).toHaveBeenLastCalledWith(null)
    }
    const before = events.mock.calls.length
    expect((await call('rename-tag', [['s', `${LABEL}Missing`], ['dest', `${LABEL}Never`], ['T', token]], 'POST')).status).toBe(404)
    expect(events).toHaveBeenCalledTimes(before)
    expect(warning).toHaveBeenCalled()
    expect(transactionStates).toEqual(Array(6).fill(false))
  } finally { removeBroken(); removeGood(); warning.mockRestore() }
})
async function labelClient() {
  const { id } = await db.auth.createApp('Label-aware app', null, true)
  const app = db.auth.apps().find(app => app.id === id)!
  const headers = { Authorization: `GoogleLogin auth=${auth.token(app, 'auth')}` }
  const request = (endpoint: string, fields: [string, string][] = [], method = 'GET') => call(endpoint, fields, method, headers)
  const write = (endpoint: string, fields: [string, string][]) => request(endpoint, [...fields, ['T', auth.token(app, 'T')]], 'POST')
  return { request, write }
}

it('edits article labels, pages their streams and preserves their identity through a rename', async () => {
  const { request: labelCall, write } = await labelClient()
  const name = 'Keep / + Café', stream = LABEL + name, moved = LABEL + 'Later'
  const edit = (fields: [string, string][]) => write('edit-tag', fields)
  const clock = () => db.greaderDatabase.prepare('SELECT greader_modified_ms FROM entry_state WHERE arrival_sequence = 3').get()!.greader_modified_ms
  expect((await edit([['i', '3'], ['i', longId(4n)], ['a', `user/paper/label/${name}`], ['r', STATE + 'read']])).status).toBe(200)
  const modified = clock()
  expect((await edit([['i', '3'], ['a', stream]])).status).toBe(200)
  expect(clock()).toBe(modified)
  const tags = await (await labelCall('tag/list')).json()
  expect(tags.tags).toContainEqual({ id: stream, type: 'tag', unread_count: 2 })
  const counts = await (await labelCall('unread-count')).json()
  expect(counts.unreadcounts).toContainEqual({ id: stream, count: 2, newestItemTimestampUsec: expect.any(String) })
  const subscriptions = await (await labelCall('subscription/list')).json()
  expect(subscriptions.subscriptions.flatMap(feed => feed.categories).map(category => category.id)).not.toContain(stream)
  const contents = await (await labelCall('stream/contents/' + encodeURIComponent(stream))).json()
  expect(contents.items.map(item => item.id)).toEqual([longId(4n), longId(3n)])
  expect(contents.items[0].categories).toContain(stream)
  const page = await (await labelCall('stream/items/ids', [['s', stream], ['n', '1']])).json()
  expect(page.itemRefs).toEqual([{ id: '4' }])
  expect((await write('rename-tag', [['s', stream], ['dest', moved]])).status).toBe(200)
  expect(clock()).toBeGreaterThan(Number(modified))
  expect((await labelCall('stream/items/ids', [['s', stream]])).status).toBe(404)
  const next = await (await labelCall('stream/items/ids', [['s', stream], ['c', page.continuation]])).json()
  expect(next.itemRefs).toEqual([{ id: '3' }])
  expect((await edit([['i', '4'], ['r', moved]])).status).toBe(200)
  const filtered = await (await labelCall('stream/items/ids', [['s', READING], ['it', moved]])).json()
  expect(filtered.itemRefs).toEqual([{ id: '3' }])
  const before = clock()
  expect((await edit([['i', '3'], ['r', moved], ['a', LABEL + 'Uncategorized']])).status).toBe(409)
  expect(clock()).toBe(before)
  expect(db.organization.apply(backend, db.organization.revision(backend), [{ type: 'create-folder', title: 'later' }]).results[0]).toMatchObject({ status: 'failed', code: 'collision' })
  expect((await write('disable-tag', [['s', moved]])).status).toBe(200)
  expect(clock()).toBeGreaterThan(Number(before))
  expect((await labelCall('stream/items/ids', [['s', stream], ['c', page.continuation]])).status).toBe(404)
  expect((await (await labelCall('stream/items/contents', [['i', '3']], 'POST')).json()).items[0].categories).not.toContain(moved)
}, 30000)

it('hides article labels and rejects label changes for default app passwords', async () => {
  const { request, write } = await labelClient()
  const stream = LABEL + 'Hidden', moved = LABEL + 'Moved'
  expect((await write('edit-tag', [['i', '3'], ['i', '4'], ['a', stream], ['r', STATE + 'read']])).status).toBe(200)
  const page = await (await request('stream/items/ids', [['s', stream], ['n', '1']])).json()
  const counts = await (await request('unread-count')).json()
  expect(counts.unreadcounts.map(tag => tag.id)).toContain(stream)
  expect((await (await call('tag/list')).json()).tags.map(tag => tag.id)).not.toContain(stream)
  expect((await (await call('unread-count')).json()).unreadcounts.map(tag => tag.id)).not.toContain(stream)
  expect((await (await call('stream/items/contents', [['i', '3']], 'POST')).json()).items[0].categories).not.toContain(stream)
  expect((await call('stream/contents/' + encodeURIComponent(stream))).status).toBe(404)
  expect((await call('stream/items/ids', [['s', READING], ['xt', stream]])).status).toBe(404)
  expect((await call('stream/items/ids', [['s', stream], ['c', page.continuation]])).status).toBe(404)
  expect((await call('edit-tag', [['i', '3'], ['a', STATE + 'read'], ['r', stream], ['T', token]], 'POST')).status).toBe(400)
  expect((await call('disable-tag', [['s', stream], ['T', token]], 'POST')).status).toBe(404)
  expect((await call('rename-tag', [['s', stream], ['dest', moved], ['T', token]], 'POST')).status).toBe(404)
  const items = await (await request('stream/contents/' + encodeURIComponent(stream))).json()
  expect(items.items.map(item => item.id)).toEqual([longId(4n), longId(3n)])
  expect(items.items.find(item => item.id === longId(3n)).categories).not.toContain(STATE + 'read')
}, 30000)

it('rejects stale label renames and deletes after a folder takes the name', async () => {
  const { write } = await labelClient()
  const stream = LABEL + 'Later'
  expect((await write('edit-tag', [['i', '3'], ['a', stream]])).status).toBe(200)
  expect((await write('disable-tag', [['s', stream]])).status).toBe(200)
  expect(db.organization.apply(backend, db.organization.revision(backend), [{ type: 'create-folder', title: 'Later' }]).results[0].status).toBe('applied')
  expect((await write('disable-tag', [['s', stream]])).status).toBe(404)
  expect((await write('rename-tag', [['s', stream], ['dest', LABEL + 'Other']])).status).toBe(404)
  expect(db.organization.metadata(backend).folders.map(folder => folder.title)).toContain('Later')
}, 30000)

it('imports raw OPML with app credentials, rolls back invalid files and keeps existing subscriptions on retry', async () => {
  const post = (xml: string, t?: string, authorization = `GoogleLogin auth=${bearer}`, origin = 'http://localhost') => fetch(
    base + '/reader/api/0/subscription/import?' + new URLSearchParams(t === undefined ? {} : { T: t }),
    { method: 'POST', headers: { 'Content-Type': 'text/xml', Authorization: authorization, Origin: origin }, body: xml })
  const wrap = (body: string) => `<opml version="2.0" xmlns:paper="https://paper-reader.app/ns/opml"><body>${body}</body></opml>`
  const outline = '<outline text="Imported feed" xmlUrl="https://example.test/imported"/>'
  const count = () => db.greaderDatabase.prepare("SELECT count(*) n FROM feeds WHERE url = 'https://example.test/imported'").get()!.n
  expect((await post(wrap(outline), undefined, '')).status).toBe(401)
  expect((await post(wrap(outline), undefined, undefined, 'https://other.test')).status).toBe(403)
  expect((await post(wrap(outline), '')).status).toBe(403)
  expect((await post('x'.repeat(1024 * 1024 + 1))).status).toBe(413)
  expect((await post('<opml>')).status).toBe(400)
  expect((await post(wrap(outline.repeat(1001)))).status).toBe(400)
  expect((await post(wrap(outline.repeat(2)))).status).toBe(409)
  expect((await post(wrap(outline + '<outline type="rss" xmlUrl="file:///invalid"/>'))).status).toBe(400)
  const hinted = (url: string) => `<outline paper:id="${'a'.repeat(64)}" xmlUrl="https://example.test/${url}"/>`
  const before = db.organization.snapshot(backend)
  expect((await post(wrap(outline + hinted('first') + hinted('second')))).status).toBe(409)
  expect(db.organization.snapshot(backend)).toEqual(before)
  expect(count()).toBe(0)
  const xml = wrap(`<outline text="From OPML"><outline text="News">${outline}</outline></outline>`)
  const response = await post(xml)
  expect(await response.text()).toBe('OK')
  expect((await post(wrap(outline), token)).status).toBe(200)
  expect(count()).toBe(1)
  const { subscriptions } = await (await call('subscription/list')).json()
  expect(subscriptions.find(feed => feed.url === 'https://example.test/imported').categories)
    .toEqual([{ id: LABEL + 'From OPML / News', label: 'From OPML / News' }])
}, 30000)

it('limits authenticated traffic and rejects the owner password as an app password', async () => {
  await db.auth.setup(db.auth.setupCode(), 'reader', 'synthetic owner password')
  const rejected = await call('/accounts/ClientLogin', [['Email', 'reader'], ['Passwd', 'synthetic owner password']], 'POST')
  expect(rejected.status).toBe(401)
  const responses = await Promise.all(Array.from({ length: 150 }, () => call('token')))
  expect(responses.some(response => response.status === 429)).toBe(true)
  for (const response of responses) { if (response.status === 429) expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1); await response.text() }
}, 15000)
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
