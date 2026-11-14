import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-standalone-smoke-'))
const working = path.join(temporary, '.hidden-worktree')
await fs.mkdir(working)
await fs.cp(path.resolve('dist'), path.join(working, 'dist'), { recursive: true })
await fs.writeFile(path.join(working, 'dist/.private-fixture'), 'Synthetic hidden file')
const executable = path.resolve('dist-server/index.js')
let slowStarted = false, slowClosed = false, feedRequests = 0
const fixture = http.createServer((request, response) => {
  if (request.url === '/slow.xml') { slowStarted = true; response.on('close', () => { slowClosed = true }); return }
  feedRequests++
  response.setHeader('Content-Type', 'application/rss+xml')
  response.end(`<rss version="2.0"><channel><title>Synthetic standalone feed</title><link>https://example.test</link><description>Disposable</description>
  ${[1, 2].map(n => `<item><guid>standalone-${n}</guid><title>Standalone story ${n}</title><link>https://example.test/${n}</link><pubDate>${new Date().toUTCString()}</pubDate><description>Synthetic article content</description></item>`).join('')}</channel></rss>`)
})
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening')
const probe = http.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
const base = `http://127.0.0.1:${port}`, feedOrigin = `http://127.0.0.1:${fixture.address().port}`
const state = path.join(temporary, 'data')
const env = { PATH: process.env.PATH, HOME: temporary, NODE_NO_WARNINGS: '1', STATE_DIR: state,
  PAPER_BACKEND: 'standalone', HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: base,
  PAPER_TRUSTED_FEED_ORIGINS: feedOrigin, CODEX_ENABLED: 'false' }
let child, logs = ''
async function until(check) {
  for (let n = 0; n < 100; n++) { try { const value = await check(); if (value) return value } catch {} await delay(100) }
  throw new Error('Timed out waiting for standalone smoke fixture')
}
async function start() {
  child = spawn(process.execPath, [executable], { cwd: working, stdio: ['ignore', 'pipe', 'pipe'], env })
  child.stdout.on('data', data => { logs += data }); child.stderr.on('data', data => { logs += data })
  await until(async () => (await fetch(base + '/health')).ok)
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); assert.equal((await exited)[0], 0) }
  child = undefined
}
async function request(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json().catch(() => null) }
}
try {
  await start()
  for (const route of ['/', '/index.html']) {
    const response = await fetch(base + route)
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/)
    assert.match(await response.text(), /<div id="root">/)
  }
  assert(!(await (await fetch(base + '/.private-fixture')).text()).includes('Synthetic hidden file'))
  const initial = (await request('/api/status')).data
  assert.equal(initial.backend, 'standalone'); assert(initial.localReadsActive)
  assert(!initial.readwiseConfigured && !initial.kirbyConfigured && !initial.briefingConfigured && !initial.discussionConfigured)
  const discovery = await request('/api/subscription-tools/discover', { url: feedOrigin + '/feed.xml' })
  assert.equal(discovery.status, 200)
  const preview = (await request('/api/subscription-tools/preview-feed', { url: feedOrigin + '/feed.xml', title: 'Standalone fixture' })).data
  const applied = (await request('/api/subscription-tools/apply', { token: preview.token, choices: [{ key: preview.rows[0].key, action: 'create', folders: ['Synthetic folder'] }] })).data
  assert.equal(applied.results[0].status, 'created')
  const feedId = applied.results[0].id
  const page = await until(async () => { const value = (await request('/api/entries?kind=all&id=all&unread=0')).data; return value?.items.length === 2 && value })
  const checkView = (await request('/api/feed-checks')).data
  const checkRevision = { expectedRevision: checkView.revision, expectedOrganizationRevision: checkView.organizationRevision }
  assert(checkView.feeds[0].lastSuccessAt > 0)
  assert(checkView.feeds[0].nextFetchAt > Date.now())
  const beforeReload = feedRequests
  assert.equal((await request('/api/reload', {})).status, 200)
  assert.equal(feedRequests, beforeReload)
  const manual = await request('/api/feed-checks/now', { ...checkRevision, feedId })
  assert.equal(manual.status, 200); assert.equal(manual.data.results[0].status, 'cooldown')
  assert.equal(feedRequests, beforeReload)
  const crossSite = await fetch(base + '/api/feed-checks/now', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example.test' }, body: JSON.stringify({ ...checkRevision, feedId }) })
  assert.equal(crossSite.status, 403)
  const interval = await request('/api/feed-checks/interval', { ...checkRevision, intervalMinutes: 30 })
  assert.equal(interval.status, 200)
  assert.equal((await request('/api/feed-checks/now', { ...checkRevision, feedId })).status, 409)
  const entry = page.items[0]
  const changed = await request('/api/entries/state', { ids: [entry.id], operation: 'read', expectedRevisions: { [entry.id]: 0 }, undo: true })
  assert.equal(changed.status, 200); assert(changed.data.undoToken)
  assert.equal((await request('/api/entries/state', { ids: [entry.id], operation: 'star', expectedRevisions: { [entry.id]: 0 } })).status, 409)
  assert.equal((await request('/api/undo', { token: changed.data.undoToken })).status, 200)
  await request('/api/entries/state', { ids: [entry.id], operation: 'star' })
  await request('/api/reading', { id: entry.id, position: 0.42 })
  for (const route of ['/api/readwise', '/api/notes', '/api/discussion/message']) assert.equal((await request(route, {})).status, 503)
  const organization = (await request('/api/organization')).data
  assert.equal(organization.backend, 'standalone'); assert(organization.capabilities.multipleMemberships)
  const renamed = await request('/api/organization/commands', { expectedRevision: organization.revision, commands: [{ type: 'rename-folder', folderId: organization.navigation.folders[0].id, title: 'Renamed folder' }] })
  assert.equal(renamed.data.results[0].status, 'applied')
  await stop(); await start()
  assert.equal((await request('/api/status')).data.backendInstance, initial.backendInstance)
  assert.equal((await request('/api/feed-checks')).data.intervalMinutes, 30)
  const saved = (await request('/api/entries/item', { id: entry.id })).data.entry
  assert(saved.starred && !saved.read); assert.equal(saved.readingPosition, 0.42)
  const current = (await request('/api/organization')).data
  assert.equal((await request('/api/organization/commands', { expectedRevision: current.revision, commands: [{ type: 'unsubscribe', feedId }] })).data.results[0].status, 'applied')
  assert.equal((await request('/api/entries/item', { id: entry.id })).data.entry.id, entry.id)
  assert.equal((await request('/api/entries?kind=all&id=all&unread=0')).data.items.length, 2)
  assert.equal((await request('/api/feeds', { url: feedOrigin + '/slow.xml', title: 'Slow synthetic feed' })).status, 201)
  await until(() => slowStarted)
  await stop(); await until(() => slowClosed)
  console.log('Standalone built-server smoke passed: hidden-parent root HTML and dotfile protection, no-credential setup, discovery/import/fetch/read, CAS/undo, optional integrations off, organization, reload without collection, manual cooldown/origin/revision checks, restart intervals/identity/progress/stars, retained unsubscribe history, scheduler abort/drain.')
} catch (error) { console.error(logs.slice(-4000)); throw error }
finally {
  await stop(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true })
}
