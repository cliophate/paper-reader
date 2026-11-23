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
import { renameLabel } from '../src/server/greader-labels'
import { markReaderStreamRead } from '../src/server/greader-mark-read'
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
function markReadFixture(name: string) {
  const url = `https://example.test/bulk-${name}`
  const feedId = db.saveLocalSubscription(backend, { url, title: name })
  ingestFeed(db, { backendId: backend, subscriptionId: feedId, endpointGeneration: 'fixture', requestUrl: url, responseUrl: url,
    fetchedAt: new Date().toISOString(), xml: `<rss version="2.0"><channel><title>${name}</title>${[1, 2, 3].map(i =>
      `<item><guid>${i}</guid><title>Article ${i}</title><description>Synthetic bulk article.</description><pubDate>2000-01-01T00:00:00Z</pubDate></item>`).join('')}</channel></rss>` })
  const ids = db.greaderDatabase.prepare('SELECT id FROM entries WHERE feed_id = ? ORDER BY title').all(feedId).map(row => String(row.id))
  return { feedId, ids, stream: `feed/${db.linkNumber('feed', feedId)}` }
}
async function markRead(stream: string, ts?: string) {
  const response = await call('mark-all-as-read', [['s', stream], ['T', token], ...(ts === undefined ? [] : [['ts', ts] as [string, string]])], 'POST')
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('OK')
}
function addFolder(title: string, feeds: string[]) {
  const result = db.organization.apply(backend, db.organization.metadata(backend).revision, [{ type: 'create-folder', title }]).results[0]
  if (result.status !== 'applied' || !result.id) throw new Error('Fixture folder failed')
  db.organization.apply(backend, db.organization.metadata(backend).revision, feeds.map(feedId => ({ type: 'add-membership', feedId, folderId: result.id! })))
}
it('marks a feed read once, preserves stars and invalidates stale web undo after commit', async () => {
  const fixture = markReadFixture('feed'), outside = markReadFixture('outside')
  db.webhooks.add({ id: 'bulk-stars', name: 'Bulk stars', kind: 'webhook', events: ['starred_entry'], feedId: fixture.feedId, folderId: '' })
  state.editEntries([fixture.ids[0]], 'star', { undo: { token: 'bulk-undo', expiresAt: new Date(Date.now() + 60000).toISOString() } })
  const deliveries = db.webhooks.history()
  expect(deliveries).toHaveLength(1)
  const priorClock = Date.now() + 60000
  db.greaderDatabase.prepare('UPDATE entry_state SET greader_modified_ms = ? WHERE feed_id = ?').run(priorClock, fixture.feedId)
  const events = vi.fn(() => fixture.ids.every(id => db.entryState(id)!.read))
  const remove = state.onStateChanged(events)
  const before = db.greaderDatabase.prepare('SELECT count(*) n FROM activity_events').get()!.n as number
  try {
    await markRead(fixture.stream)
    expect(fixture.ids.map(id => db.entryState(id))).toEqual([
      { read: true, starred: true, revision: 2 }, { read: true, starred: false, revision: 1 }, { read: true, starred: false, revision: 1 },
    ])
    expect(outside.ids.every(id => !db.entryState(id)!.read)).toBe(true)
    expect(() => state.undo('bulk-undo')).toThrow()
    expect(events).toHaveBeenCalledExactlyOnceWith(null)
    expect(events).toHaveReturnedWith(true)
    expect(db.webhooks.history()).toEqual(deliveries)
    const clocks = db.greaderDatabase.prepare('SELECT entry_id, state_revision, greader_modified_ms FROM entry_state WHERE feed_id = ?').all(fixture.feedId)
    expect(clocks.map(row => row.greader_modified_ms)).toEqual(Array(3).fill(priorClock + 1))
    await markRead(fixture.stream)
    expect(db.greaderDatabase.prepare('SELECT entry_id, state_revision, greader_modified_ms FROM entry_state WHERE feed_id = ?').all(fixture.feedId)).toEqual(clocks)
    expect(db.greaderDatabase.prepare('SELECT count(*) n FROM activity_events').get()!.n).toBe(before + 1)
    expect(events).toHaveBeenCalledTimes(1)
  } finally { remove() }
})
it('marks a label across overlapping folder memberships without double revisions', async () => {
  const first = markReadFixture('folder-first'), shared = markReadFixture('folder-shared'), other = markReadFixture('folder-other')
  addFolder('Bulk first', [first.feedId, shared.feedId])
  addFolder('Bulk second', [shared.feedId, other.feedId])
  await markRead(`${LABEL}Bulk first`)
  for (const id of [...first.ids, ...shared.ids]) expect(db.entryState(id)).toMatchObject({ read: true, revision: 1 })
  for (const id of other.ids) expect(db.entryState(id)).toMatchObject({ read: false, revision: 0 })
})
it('resolves virtual Uncategorized as feeds with no folder memberships', async () => {
  const uncategorized = markReadFixture('uncategorized'), categorized = markReadFixture('categorized')
  addFolder('Bulk categorized', [categorized.feedId])
  await markRead(`${LABEL}Uncategorized`)
  for (const id of uncategorized.ids) expect(db.entryState(id)).toMatchObject({ read: true, revision: 1 })
  for (const id of categorized.ids) expect(db.entryState(id)).toMatchObject({ read: false, revision: 0 })
})
it('uses inclusive microsecond arrival cutoffs and exposes changes through contents, ot, nt and counts', async () => {
  const fixture = markReadFixture('cutoff'), sql = db.greaderDatabase
  fixture.ids.forEach((id, i) => sql.prepare('UPDATE entries SET first_seen_at = ? WHERE id = ?').run((i + 1) * 1000, id))
  sql.prepare('UPDATE entry_state SET greader_modified_ms = 1000 WHERE feed_id = ?').run(fixture.feedId)
  sql.prepare('UPDATE feeds SET greader_modified_ms = 1000 WHERE id = ?').run(fixture.feedId)
  const count = async () => (await (await call('unread-count')).json()).unreadcounts.find(row => row.id === fixture.stream).count
  const refs = async (filters: [string, string][]) => (await (await call('stream/items/ids', [['s', fixture.stream], ...filters])).json()).itemRefs
  expect(await count()).toBe(3)
  await markRead(fixture.stream, '1999999')
  expect(fixture.ids.map(id => db.entryState(id)!.read)).toEqual([true, false, false])
  await markRead(fixture.stream, '2000000')
  expect(fixture.ids.map(id => db.entryState(id)!.read)).toEqual([true, true, false])
  expect(await count()).toBe(1)
  expect(await refs([['ot', '4']])).toHaveLength(2)
  expect(await refs([['nt', '3']])).toHaveLength(1)
  expect(await refs([['xt', `${STATE}read`]])).toHaveLength(1)
  const contents = await (await call('stream/contents', [['s', fixture.stream], ['r', 'o']])).json()
  expect(contents.items.map(item => item.categories.includes(`${STATE}read`))).toEqual([true, true, false])
  // Above Number.MAX_SAFE_INTEGER: retain the exact microsecond boundary.
  sql.prepare('UPDATE entries SET first_seen_at = ? WHERE id = ?').run(9007199254741, fixture.ids[2])
  await markRead(fixture.stream, '9007199254740999')
  expect(db.entryState(fixture.ids[2])!.read).toBe(false)
  await markRead(fixture.stream, '9007199254741000')
  expect(db.entryState(fixture.ids[2])!.read).toBe(true)
}, 15000)
it.each(['0', '000', undefined])('uses the current time for an arrival cutoff of %s', async ts => {
  const fixture = markReadFixture('now-' + ts)
  db.greaderDatabase.prepare('UPDATE entries SET first_seen_at = ? WHERE id = ?').run(Date.now() + 86400000, fixture.ids[2])
  await markRead(fixture.stream, ts)
  expect(fixture.ids.map(id => db.entryState(id)!.read)).toEqual([true, true, false])
})

it('accepts the Reeder T=x token only for authenticated same-origin mark-all-as-read', async () => {
  const fixture = markReadFixture('reeder')
  const fields: [string, string][] = [['s', fixture.stream], ['T', 'x']]
  expect((await call('mark-all-as-read', fields, 'POST', { Authorization: '' })).status).toBe(401)
  expect((await call('mark-all-as-read', fields, 'POST', { Origin: 'https://other.test' })).status).toBe(403)
  expect((await call('edit-tag', [['i', '1'], ['a', STATE + 'read'], ['T', 'x']], 'POST')).status).toBe(403)
  expect(fixture.ids.every(id => !db.entryState(id)!.read)).toBe(true)
  const response = await call('mark-all-as-read', fields, 'POST')
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('OK')
  expect(fixture.ids.every(id => db.entryState(id)!.read)).toBe(true)
})

it('rejects unknown streams, malformed cutoffs, GET, missing Auth, bad T and cross-site writes without changes', async () => {
  const sql = db.greaderDatabase
  const before = sql.prepare('SELECT sum(read) n, sum(state_revision) revision FROM entry_state').get()
  for (const stream of ['feed/99999999', `${LABEL}Missing bulk folder`, '']) {
    const response = await call('mark-all-as-read', [['s', stream], ['T', token]], 'POST')
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ errors: ['Unknown stream.'] })
  }
  expect((await call('mark-all-as-read', [['s', STATE + 'starred'], ['T', token]], 'POST')).status).toBe(400)
  for (const ts of ['', '-1', '1.5', 'NaN', '9223372036854775808']) {
    expect((await call('mark-all-as-read', [['s', READING], ['ts', ts], ['T', token]], 'POST')).status).toBe(400)
  }
  expect((await call('mark-all-as-read', [['s', READING], ['T', token]], 'GET')).status).toBe(404)
  expect((await call('mark-all-as-read', [['s', READING], ['T', token]], 'POST', { Authorization: '' })).status).toBe(401)
  for (const fields of [[], [['T', 'bad']]] as [string, string][][]) {
    const response = await call('mark-all-as-read', [['s', READING], ...fields], 'POST')
    expect(response.status).toBe(403); expect(response.headers.get('x-reader-google-bad-token')).toBe('true')
  }
  expect((await call('mark-all-as-read', [['s', READING], ['T', token]], 'POST', { Origin: 'https://other.test' })).status).toBe(403)
  expect(sql.prepare('SELECT sum(read) n, sum(state_revision) revision FROM entry_state').get()).toEqual(before)
}, 15000)
it('rolls back articles, clocks and activity when bookkeeping fails after the bulk update', async () => {
  const fixture = markReadFixture('rollback'), sql = db.greaderDatabase
  const snapshot = () => ({ articles: sql.prepare('SELECT entry_id, read, starred, state_revision, greader_modified_ms FROM entry_state').all(), activity: db.activity() })
  const before = snapshot(), events = vi.fn(), remove = state.onStateChanged(events)
  sql.exec(`CREATE TRIGGER fail_bulk_activity BEFORE INSERT ON activity_events WHEN new.origin = 'greader'
    BEGIN SELECT RAISE(ABORT, 'Synthetic activity failure'); END`)
  try {
    const response = await call('mark-all-as-read', [['s', fixture.stream], ['T', token]], 'POST')
    expect(response.status).toBe(503)
    expect(snapshot()).toEqual(before)
    expect(events).not.toHaveBeenCalled()
  } finally { sql.exec('DROP TRIGGER fail_bulk_activity'); remove() }
  await markRead(fixture.stream)
  expect(fixture.ids.every(id => db.entryState(id)!.read)).toBe(true)
})
it('marks the reading list while preserving tombstones, hidden articles, stars and derived library state', async () => {
  const fixture = markReadFixture('reading-list'), inactive = markReadFixture('inactive'), sql = db.greaderDatabase
  sql.prepare('UPDATE feeds SET active = 0 WHERE id = ?').run(inactive.feedId)
  sql.prepare('UPDATE entry_state SET starred = 1 WHERE entry_id = ?').run(fixture.ids[0])
  sql.exec("INSERT INTO mute_filters(id, phrase, scope, created_at) VALUES ('bulk-mute', 'Hidden bulk fixture', 'all', '')")
  sql.prepare("INSERT INTO muted_entries VALUES ('bulk-mute', ?)").run(fixture.ids[1])
  db.transaction(() => {
    sql.prepare('INSERT INTO retention_tombstones VALUES (?, ?, 1, 1)').run(fixture.ids[2], fixture.feedId)
    sql.prepare('DELETE FROM entries WHERE id = ?').run(fixture.ids[2])
  })
  sql.exec(`INSERT INTO briefings(id, kind, window_start, cutoff, subject, html, text, status, token_hash, selection_json, created_at)
    VALUES ('bulk-briefing', 'morning', '', '', 'Synthetic', '', '', 'ready', '', '{}', '');
    INSERT INTO pulse_collections(id, headline, scope, created_at) VALUES ('bulk-pulse', 'Synthetic', 'all', '')`)
  sql.prepare("INSERT INTO briefing_entries VALUES ('bulk-briefing', ?, 'news')").run(fixture.ids[0])
  sql.prepare("INSERT INTO pulse_memberships(collection_id, entry_id, added_at) VALUES ('bulk-pulse', ?, '')").run(fixture.ids[0])
  expect(db.briefingReadCounts('bulk-briefing').unreadCount).toBe(1)
  expect(db.pulseCollections().find(c => c.id === 'bulk-pulse')!.sources[0].read).toBe(false)
  const tombstones = sql.prepare('SELECT * FROM retention_tombstones').all()
  await markRead(READING)
  expect(db.entryState(fixture.ids[0])).toMatchObject({ read: true, starred: true, revision: 1 })
  expect(db.entryState(fixture.ids[1])!.read).toBe(false)
  expect(db.entryState(fixture.ids[2])).toBeNull()
  expect(sql.prepare('SELECT * FROM retention_tombstones').all()).toEqual(tombstones)
  expect(inactive.ids.every(id => !db.entryState(id)!.read)).toBe(true)
  expect(db.briefingReadCounts('bulk-briefing').unreadCount).toBe(0)
  expect(db.getBriefing('bulk-briefing')!.status).toBe('ready')
  expect(db.pulseCollections().find(c => c.id === 'bulk-pulse')!.sources[0]).toMatchObject({ read: true, stateRevision: 1 })
})
it('rechecks app and global generations and API enablement inside the bulk transaction', () => {
  const fixture = markReadFixture('revocation'), credential = db.auth.apps()[0]
  const before = fixture.ids.map(id => db.entryState(id))
  for (const change of [
    'UPDATE auth_apps SET generation = generation + 1',
    'UPDATE auth_meta SET generation = generation + 1',
    'UPDATE greader_settings SET enabled = 0',
  ]) {
    expect(() => db.transaction(() => {
      db.greaderDatabase.exec(change)
      markReaderStreamRead(db, backend, { kind: 'feed', id: fixture.feedId }, undefined, credential)
    })).toThrow(expect.objectContaining({ status: 401 }))
  }
  expect(fixture.ids.map(id => db.entryState(id))).toEqual(before)
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

it('marks only members of an article label read with a label-enabled app password', async () => {
  const { write } = await labelClient()
  const fixture = markReadFixture('labeled'), label = LABEL + 'Bulk article label'
  const number = db.greaderDatabase.prepare('SELECT arrival_sequence FROM entry_state WHERE entry_id = ?').get(fixture.ids[0])!.arrival_sequence
  expect((await write('edit-tag', [['i', String(number)], ['a', label]])).status).toBe(200)
  const denied = await call('mark-all-as-read', [['s', label], ['T', token]], 'POST')
  expect(denied.status).toBe(404)
  expect(await denied.json()).toEqual({ errors: ['Unknown stream.'] })
  expect((await write('mark-all-as-read', [['s', label]])).status).toBe(200)
  expect(fixture.ids.map(id => db.entryState(id))).toEqual([
    { read: true, starred: false, revision: 1 },
    { read: false, starred: false, revision: 0 },
    { read: false, starred: false, revision: 0 },
  ])
})

it.each(['rename', 'delete', 'disable labels'])('keeps the queued mark-read label identity across %s', async change => {
  const { write } = await labelClient()
  const fixture = markReadFixture('queued-' + change.replace(' ', '-')), sql = db.greaderDatabase
  const name = 'Queued label ' + change, stream = LABEL + name
  const number = sql.prepare('SELECT arrival_sequence FROM entry_state WHERE entry_id = ?').get(fixture.ids[0])!.arrival_sequence
  expect((await write('edit-tag', [['i', String(number)], ['a', stream]])).status).toBe(200)
  const id = String(sql.prepare('SELECT id FROM article_labels WHERE title = ?').get(name)!.id)
  const run = GreaderPool.prototype.run
  const queued = vi.spyOn(GreaderPool.prototype, 'run').mockImplementationOnce(function (this: GreaderPool, job, signal) {
    if (change === 'delete') sql.prepare('DELETE FROM article_labels WHERE id = ?').run(id)
    else renameLabel(sql, id, name + ' renamed')
    addFolder(name, [fixture.feedId])
    if (change === 'disable labels') sql.prepare('UPDATE auth_apps SET article_labels = 0 WHERE id = ?').run((job as { app: { id: string } }).app.id)
    return run.call(this, job, signal)
  })
  try {
    const response = await write('mark-all-as-read', [['s', stream]])
    if (change === 'rename') {
      expect(response.status).toBe(200)
    } else {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ errors: ['Unknown stream.'] })
    }
    expect(fixture.ids.map(id => db.entryState(id)!.read)).toEqual([change === 'rename', false, false])
  } finally { queued.mockRestore() }
})

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
