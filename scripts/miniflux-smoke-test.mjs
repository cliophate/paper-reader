import { savedViewWriteFixture } from '../tests/fixtures/saved-view-writes.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { minifluxApi } from '../tests/fixtures/miniflux-api.mjs'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-miniflux-smoke-'))
const api = minifluxApi()
const webhookPosts = []
const viewWrites = savedViewWriteFixture()
const fixture = http.createServer(async (request, response) => {
  try {
    const body = Buffer.concat(await Array.fromAsync(request)).toString()
    if (request.url.startsWith('/notify/') && request.method === 'POST') {
      webhookPosts.push({ path: request.url, article: JSON.parse(body).entry.id })
      response.writeHead(204); response.end(); return
    }
    if (request.method === 'PUT' && request.url.endsWith('/entries') && JSON.parse(body).starred === false) await viewWrites.unstar()
    const result = await api.fetch(`http://fixture${request.url}`, { method: request.method, headers: request.headers, body: body || undefined })
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch { response.writeHead(500); response.end('{}') }
})
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening')
const portProbe = http.createServer().listen(0, '127.0.0.1'); await once(portProbe, 'listening')
const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve))
const base = `http://127.0.0.1:${port}`, state = path.join(temporary, 'data')
let child, logs = ''
function environment(directory, overrides = {}) {
  return { PATH: process.env.PATH, HOME: temporary, NODE_NO_WARNINGS: '1',
    PAPER_BACKEND: 'miniflux', MINIFLUX_BASE_URL: `http://127.0.0.1:${fixture.address().port}/reader`,
    MINIFLUX_API_KEY: 'synthetic-miniflux-key', STATE_DIR: directory, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base,
    ...overrides }
}
async function request(route, body, headers = {}) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}
async function until(check) {
  for (let n = 0; n < 150; n++) { try { if (await check()) return } catch {} await delay(100) }
  throw new Error('Timed out waiting for the synthetic Miniflux Paper server')
}
async function start(directory = state, overrides = {}) {
  child = spawn(process.execPath, ['dist-server/index.js'], { env: environment(directory, overrides), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { logs += data }); child.stderr.on('data', data => { logs += data })
  await until(async () => (await request('/health')).status === 200)
  await until(async () => {
    const status = (await request('/api/status')).data
    return status.sync.lastCompletedAt && status.localReadsActive === (overrides.PAPER_LOCAL_READS !== 'false')
  })
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  child = undefined
}
async function runBriefing(directory, overrides = {}, expectedExit = 0) {
  const process = spawn(globalThis.process.execPath, ['dist-server/briefing-cli.js', 'morning'], { env: environment(directory, overrides), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  process.stdout.on('data', data => { output += data }); process.stderr.on('data', data => { output += data })
  const [code] = await once(process, 'exit')
  assert.equal(code, expectedExit, output)
  return output
}
try {
  await start()
  const status = (await request('/api/status')).data
  assert.equal(status.backend, 'miniflux'); assert.equal(status.localReadsActive, true)
  for (const key of ['discussionConfigured', 'readwiseConfigured', 'kirbyConfigured', 'briefingConfigured']) assert.equal(status[key], false)
  assert.equal((await request('/api/sync/parity')).data.ready, true)
  const { token, count } = (await request('/api/streams/preview-read', { query: 'is:unread' })).data
  assert(token && count > 0)
  // Deliver nine searches and the confirm together, before the event loop can
  // handle the worker's first reply. The last request must see a full queue.
  const socket = net.createConnection(port, '127.0.0.1')
  socket.setEncoding('utf8')
  const headers = `Host: 127.0.0.1:${port}\r\n`
  const body = JSON.stringify({ token })
  const searches = `GET /api/entries?q=absent HTTP/1.1\r\n${headers}\r\n`.repeat(9)
  socket.write(searches + `POST /api/streams/confirm-read HTTP/1.1\r\n${headers}Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`)
  const last = (await Array.fromAsync(socket)).join('').split('HTTP/1.1 ').at(-1)
  assert.match(last, /^503 /)
  assert.match(last, /Search is busy/)
  const retries = await Promise.all([1, 2].map(() => request('/api/streams/confirm-read', { token })))
  assert.deepEqual(retries.map(reply => reply.status).sort(), [200, 409])
  const confirmed = retries.find(reply => reply.status === 200).data
  assert.equal(confirmed.count, count)
  assert.equal((await request('/api/undo', { token: confirmed.undoToken })).status, 200)
  const page = (await request('/api/entries?kind=all&id=all&unread=0')).data
  assert.equal(page.items.length, 3)
  const id = page.items[0].id
  await viewWrites.check(request, id, page.items[1].id, () => {
    api.entries.find(row => row.id === Number(id.split(':').at(-1))).status = 'read'
  })
  const viewQuery = 'url:"' + page.items[0].url + '"'
  const savedView = await request('/api/views', { title: 'One synthetic article', query: viewQuery })
  assert.equal(savedView.status, 201)
  const stream = { kind: 'view', id: savedView.data.id }
  const viewPage = await request('/api/entries?kind=view&unread=0&id=' + stream.id)
  assert.deepEqual(viewPage.data.items.map(item => item.id), [id])
  const scoped = await request('/api/streams/preview-read', { stream })
  assert.equal(scoped.data.count, Number(!page.items[0].read))

  const rawId = Number(id.split(':').at(-1))
  assert.equal((await request('/api/entries/state', { ids: [id], operation: 'read' }, { Origin: 'https://untrusted.example.test' })).status, 403)
  for (const operation of ['read', 'star', 'star']) assert.equal((await request('/api/entries/state', { ids: [id], operation })).status, 200)
  assert.equal(api.entries.find(row => row.id === rawId).status, 'read')
  assert.equal(api.entries.find(row => row.id === rawId).starred, true)
  assert.equal((await request('/api/reading', { id, position: .42 })).status, 200)
  api.entries.find(row => row.id === rawId).status = 'unread'
  assert.deepEqual((await request('/api/entries/offline-state', { id })).data.state, { read: false, starred: true })
  assert.equal((await request('/api/sync', {})).status, 200)
  assert.equal((await request('/api/entries?kind=all&id=all&unread=1')).data.items.some(row => row.id === id), true)

  const organization = (await request('/api/organization')).data
  assert.equal(organization.backend, 'miniflux'); assert.equal(organization.revision, null)
  assert.equal(organization.capabilities.stableFolderIds, true)
  assert.equal(organization.capabilities.orderFolders, false)
  const source = organization.navigation.folders.find(folder => folder.feeds.length)
  const destination = organization.navigation.folders.find(folder => !folder.feeds.length)
  const feedId = source.feeds[0].id
  const command = async value => (await request('/api/organization/commands', { expectedRevision: null, commands: [value] })).data.results[0]
  assert.equal((await command({ type: 'move-feed', feedId, fromFolderId: source.id, toFolderId: destination.id })).status, 'applied')
  assert.equal(api.feeds[0].category.id, 9)
  assert.equal((await command({ type: 'rename-feed', feedId, title: 'Renamed synthetic feed' })).status, 'applied')
  assert.equal(api.feeds[0].title, 'Renamed synthetic feed')
  assert.equal((await command({ type: 'create-folder', title: 'Unsupported' })).code, 'unsupported')
  const exported = (await request('/api/subscription-tools/export')).data
  const preview = (await request('/api/subscription-tools/preview', { xml: exported.xml })).data
  assert.equal(preview.backend, 'miniflux')
  assert.equal((await request('/api/subscription-tools/apply', { token: preview.token, choices: preview.rows.map(row => ({ key: row.key, action: 'reuse', existingId: row.suggestedId, folders: null })) })).data.results[0].status, 'reused')
  const addition = (await request('/api/subscription-tools/preview-feed', { url: 'https://example.test/new.xml', title: 'Added synthetic feed' })).data
  assert.equal((await request('/api/subscription-tools/apply', { token: addition.token, choices: [{ key: addition.rows[0].key, action: 'create', folders: [] }] })).data.results[0].status, 'created')
  assert.equal(api.feeds.length, 2)
  assert.match(await runBriefing(state, {}, 1), /Briefing generation is disabled/)
  const settings = await fetch(base + '/api/settings/connections').then(response => response.json())
  const payload = JSON.stringify({ status, page, organization, exported, settings })
  for (const secret of ['synthetic-miniflux-key', 'synthetic-private-password', 'synthetic-private-cookie', 'synthetic-private-username']) assert(!payload.includes(secret))
  const secrets = await fs.readFile(path.join(state, 'secrets.json'))
  await stop()
  await start(state, { MINIFLUX_API_KEY: 'synthetic-rotated-key' })
  assert.deepEqual(await fs.readFile(path.join(state, 'secrets.json')), secrets)
  assert.equal((await request('/api/entries?kind=starred&id=starred&unread=0')).data.items[0].readingPosition, .42)
  await stop()
  const restored = path.join(temporary, 'restored')
  await fs.cp(state, restored, { recursive: true })
  const receiver = `http://127.0.0.1:${fixture.address().port}`
  await start(restored, { PAPER_LOCAL_READS: 'false', PAPER_TRUSTED_SAVE_ORIGINS: receiver })
  assert.equal((await request('/api/status')).data.localReadsActive, false)
  assert.equal((await request('/api/entries?kind=all&id=all&unread=0')).data.items.length, 3)
  const webhooks = '/api/settings/connections/webhooks'
  for (const [name, folderId] of [['old', destination.id], ['current', source.id]]) {
    assert.equal((await request(webhooks, { name, kind: 'webhook', folderId, url: receiver + '/notify/' + name, events: ['save_entry'] })).status, 200)
  }
  // Move directly in Miniflux, leaving Paper's last synced folder untouched.
  api.feeds[0].category = api.categories[0]
  assert.equal((await request('/api/entries/send-to-webhook', { id })).data.count, 1)
  await until(async () => (await request(webhooks)).data.deliveries.some(row => row.state === 'delivered'))
  assert.deepEqual(webhookPosts, [{ path: '/notify/current', article: id }])
  api.failures.push({ path: 'v1/categories', method: 'GET', remaining: 3, status: 503 })
  const unavailable = await request('/api/entries/send-to-webhook', { id })
  assert.equal(unavailable.status, 503)
  assert.match(unavailable.data.error, /verify folder membership/)
  assert.equal((await request(webhooks)).data.deliveries.filter(row => row.state === 'skipped').length, 2)
  await stop()
  api.userId = 12
  const rejection = await runBriefing(state, {}, 1)
  assert.match(rejection, /another backend/)
  api.userId = 11
  for (const secret of ['synthetic-miniflux-key', 'synthetic-rotated-key', 'synthetic-private-password', 'synthetic-private-cookie']) assert(!logs.includes(secret))
  console.log('Miniflux smoke passed: native API, two-way state, subscriptions, both entrypoints, token rotation and restore.')
} catch (error) { console.error(logs); throw error }
finally { await stop(); await new Promise(resolve => fixture.close(resolve)); await fs.rm(temporary, { recursive: true, force: true }) }
