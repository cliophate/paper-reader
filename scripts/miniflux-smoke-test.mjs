import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { minifluxApi } from '../tests/fixtures/miniflux-api.mjs'
import { PaperDatabase } from '../dist-server/db.js'
import { renderBriefing } from '../dist-server/email.js'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-miniflux-smoke-'))
const api = minifluxApi()
const fixture = http.createServer(async (request, response) => {
  try {
    const body = Buffer.concat(await Array.fromAsync(request)).toString()
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
  const page = (await request('/api/entries?kind=all&id=all&unread=0')).data
  assert.equal(page.items.length, 3)
  const id = page.items[0].id
  const rawId = Number(id.split(':').at(-1))
  assert.equal((await request('/api/entries/state', { ids: [id], operation: 'read' }, { Origin: 'https://untrusted.example.test' })).status, 403)
  for (const operation of ['read', 'star', 'star']) assert.equal((await request('/api/entries/state', { ids: [id], operation })).status, 200)
  assert.equal(api.entries.find(row => row.id === rawId).status, 'read')
  assert.equal(api.entries.find(row => row.id === rawId).starred, true)
  assert.equal((await request('/api/reading', { id, position: .42 })).status, 200)
  api.entries.find(row => row.id === rawId).status = 'unread'
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
  const database = new PaperDatabase(path.join(state, 'paper.sqlite'))
  const briefingSources = page.items.slice(0, 2).map(entry => database.localEntry(entry.id))
  const background = database.localEntry(page.items[2].id)
  const selection = { news: [{ headline: 'Synthetic development', summary: 'Two reports cover the same development.',
    entryIds: briefingSources.map(entry => entry.id), backgroundEntryIds: [background.id] }], worthNoticing: [], social: [] }
  const briefingToken = 'synthetic-briefing-confirm-token'
  const now = new Date()
  const rendered = renderBriefing({ kind: 'morning', cutoff: now, selection,
    entries: new Map([...briefingSources, background].map(entry => [entry.id, entry])),
    confirmUrl: `${base}/briefings/synthetic-briefing/confirm?token=${briefingToken}` })
  database.createBriefing({ id: 'synthetic-briefing', kind: 'morning', subject: rendered.subject, html: rendered.html, text: rendered.text,
    status: 'generated', windowStart: now.toISOString(), cutoff: now.toISOString(), createdAt: now.toISOString(),
    deliveredAt: null, acknowledgedAt: null, tokenHash: crypto.createHash('sha256').update(briefingToken).digest('hex'), selection },
    briefingSources.map(entry => ({ id: entry.id, section: 'news' })))
  database.close()
  await start(state, { MINIFLUX_API_KEY: 'synthetic-rotated-key' })
  assert.deepEqual(await fs.readFile(path.join(state, 'secrets.json')), secrets)
  assert.equal((await request('/api/entries?kind=starred&id=starred&unread=0')).data.items[0].readingPosition, .42)
  const briefingRoute = '/api/briefings/synthetic-briefing'
  const initialBriefing = (await request(briefingRoute)).data
  assert.equal(initialBriefing.unreadCount, 2)
  assert.equal(initialBriefing.sourceIds.length, 2)
  assert.equal(initialBriefing.sources.length, 3)
  assert.equal((await request(briefingRoute + '/read', {}, { Origin: 'https://untrusted.example.test' })).status, 403)
  api.failures.push({ path: 'v1/entries', method: 'PUT', status: 503, remaining: 10 })
  assert((await request(briefingRoute + '/read', {}, { Origin: base })).status >= 400)
  assert.equal((await request(briefingRoute)).data.acknowledgedAt, null)
  assert.equal((await request(briefingRoute)).data.unreadCount, 2)
  api.failures.length = 0
  const marked = await request(briefingRoute + '/read', {}, { Origin: base })
  assert.equal(marked.status, 200)
  assert.equal(marked.data.briefing.unreadCount, 0)
  assert(marked.data.briefing.acknowledgedAt)
  assert.equal((await request('/api/briefings')).data[0].unreadCount, 0)
  const sourceIds = new Set(briefingSources.map(entry => Number(entry.id.split(':').at(-1))))
  for (const entry of api.entries) assert.equal(entry.status, sourceIds.has(entry.id) ? 'read' : 'unread')
  assert.equal((await request('/api/entries/state', { ids: [briefingSources[0].id], operation: 'unread' })).status, 200)
  assert.equal((await request(briefingRoute)).data.unreadCount, 1)
  const emailConfirm = `/briefings/synthetic-briefing/confirm?token=${briefingToken}`
  assert.match(await fetch(base + emailConfirm).then(response => response.text()), /Mark this briefing read\?/)
  assert.equal((await fetch(base + '/briefings/synthetic-briefing/confirm', { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=invalid' })).status, 404)
  const emailResponse = await fetch(base + '/briefings/synthetic-briefing/confirm', { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${briefingToken}` })
  assert.equal(emailResponse.status, 200)
  assert.match(await emailResponse.text(), /You are caught up/)
  assert.equal((await request(briefingRoute)).data.unreadCount, 0)
  assert.match(await fetch(base + emailConfirm).then(response => response.text()), /Already marked read/)
  for (const entry of api.entries) assert.equal(entry.status, sourceIds.has(entry.id) ? 'read' : 'unread')
  await stop()
  const restored = path.join(temporary, 'restored')
  await fs.cp(state, restored, { recursive: true })
  await start(restored, { PAPER_LOCAL_READS: 'false' })
  assert.equal((await request('/api/status')).data.localReadsActive, false)
  assert.equal((await request('/api/entries?kind=all&id=all&unread=0')).data.items.length, 3)
  await stop()
  api.userId = 12
  const rejection = await runBriefing(state, {}, 1)
  assert.match(rejection, /another backend/)
  api.userId = 11
  for (const secret of ['synthetic-miniflux-key', 'synthetic-rotated-key', 'synthetic-private-password', 'synthetic-private-cookie']) assert(!logs.includes(secret))
  console.log('Miniflux smoke passed: native API, two-way state, subscriptions, web and email briefing acknowledgement, both entrypoints, token rotation and restore.')
} catch (error) { console.error(logs); throw error }
finally { await stop(); await new Promise(resolve => fixture.close(resolve)); await fs.rm(temporary, { recursive: true, force: true }) }
