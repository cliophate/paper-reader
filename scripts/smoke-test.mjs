import assert from 'node:assert/strict'
import { startOpenaiFixture } from '../tests/fixtures/openai-provider.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Exercise the built server with an isolated Google Reader protocol fixture.
// No production environment, credentials, database, feeds, or model accounts.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-smoke-'))
const readTag = 'user/-/state/com.google/read'
const starTag = 'user/-/state/com.google/starred'
const rows = [1, 2].map(n => ({
  id: `tag:google.com,2005:reader/item/${String(n).padStart(16, '0')}`,
  title: `Synthetic compositor article ${n}`, published: Math.floor(Date.now() / 1000) - n,
  categories: [], author: 'Synthetic writer',
  canonical: [{ href: `https://example.test/${n}` }],
  origin: { streamId: 'feed/1', title: 'Synthetic feed', htmlUrl: 'https://example.test/' },
  summary: { content: '<p>A compositor and its synthetic integration fixture.</p>' },
}))
const fixture = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture')
  const body = new URLSearchParams(await Array.fromAsync(req).then(chunks => Buffer.concat(chunks).toString()))
  const send = value => { res.setHeader('Content-Type', typeof value === 'string' ? 'text/plain' : 'application/json'); res.end(typeof value === 'string' ? value : JSON.stringify(value)) }
  if (url.pathname.endsWith('/accounts/ClientLogin')) return send('Auth=fixture/synthetic-token\n')
  if (req.headers.authorization !== 'GoogleLogin auth=fixture/synthetic-token') { res.statusCode = 401; return send('Unauthorized') }
  const selected = () => rows.filter(row => (!url.searchParams.get('xt') || !row.categories.includes(readTag)) && (!`${url.pathname} ${url.searchParams.get('s')}`.includes('starred') || row.categories.includes(starTag)))
  if (url.pathname.endsWith('/subscription/list')) return send({ subscriptions: [{ id: 'feed/1', title: 'Synthetic feed', url: 'https://example.test/feed.xml', htmlUrl: 'https://example.test/', categories: [] }] })
  if (url.pathname.endsWith('/unread-count')) return send({ unreadcounts: ['feed/1', 'user/-/state/com.google/reading-list'].map(id => ({ id, count: rows.filter(row => !row.categories.includes(readTag)).length })) })
  if (url.pathname.includes('/stream/items/ids')) return send({ itemRefs: selected().map(row => ({ id: String(parseInt(row.id.split('/').at(-1), 16)) })) })
  if (url.pathname.includes('/stream/contents/')) return send({ items: selected() })
  if (url.pathname.includes('/stream/items/contents')) return send({ items: rows.filter(row => body.getAll('i').includes(row.id)) })
  if (url.pathname.endsWith('/token')) return send('synthetic-edit-token')
  if (url.pathname.endsWith('/edit-tag')) {
    for (const row of rows.filter(row => body.getAll('i').includes(row.id))) {
      if (body.get('a') && !row.categories.includes(body.get('a'))) row.categories.push(body.get('a'))
      if (body.get('r')) row.categories = row.categories.filter(tag => tag !== body.get('r'))
    }
    return send('OK')
  }
  res.statusCode = 404; send({ error: 'Optional helper is not installed in this fixture' })
})
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening')
const openai = await startOpenaiFixture()
let child, logs = ''
async function availablePort() {
  const server = http.createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
const port = await availablePort(), base = `http://127.0.0.1:${port}`
const request = async (route, body, headers = {}) => {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json().catch(() => null) }
}
async function until(check) {
  for (let n = 0; n < 100; n++) { try { if (await check()) return } catch {} await delay(100) }
  throw new Error('Timed out waiting for synthetic Paper instance')
}
async function start(state, localReads = true) {
  child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: temporary, NODE_ENV: 'test',
      HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: base, STATE_DIR: state, TZ: 'UTC',
      FRESHRSS_BASE_URL: `http://127.0.0.1:${fixture.address().port}`,
      FRESHRSS_USERNAME: 'fixture', FRESHRSS_API_PASSWORD: 'synthetic-password',
      PAPER_INTERNAL_SECRET: 'synthetic-internal-secret-only-for-tests', PAPER_SIGNING_SECRET: 'synthetic-signing-secret-only-for-tests',
      PAPER_SYNC_MINUTES: '28,58', PAPER_SYNC_ENABLED: 'true', PAPER_LOCAL_READS: String(localReads),
      CODEX_ENABLED: 'false', PAPER_TRUSTED_AI_ORIGINS: openai.origin,
    },
  })
  child.stdout.on('data', chunk => { logs += chunk }); child.stderr.on('data', chunk => { logs += chunk })
  await until(async () => (await request('/health')).status === 200)
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  child = undefined
}
try {
  await start(path.join(temporary, 'data'))
  const rootPage = await fetch(base + '/')
  assert.equal(rootPage.status, 200); assert.match(rootPage.headers.get('content-type'), /text\/html/)
  assert.match(await rootPage.text(), /<div id="root">/)
  await until(async () => (await request('/api/status')).data.localReadsActive === true)
  const status = (await request('/api/status')).data
  assert.equal(status.readwiseConfigured, false); assert.equal(status.kirbyConfigured, false)
  assert.equal(status.briefingConfigured, false); assert.equal(status.discussionConfigured, false)
  assert.equal((await request('/api/sync/parity')).data.ready, true)
  const organization = (await request('/api/organization')).data
  assert.equal(organization.backend, 'freshrss'); assert.equal(organization.revision, null)
  assert.equal(organization.capabilities.renameFeed, true); assert.equal(organization.capabilities.orderFolders, false)
  const commands = { expectedRevision: null, commands: [{ type: 'create-folder', title: 'Unsupported' }] }
  assert.equal((await request('/api/organization/commands', commands, { Origin: 'https://untrusted.example' })).status, 403)
  assert.equal((await request('/api/organization/commands', commands)).data.results[0].code, 'unsupported')
  const exportedSubscriptions = await request('/api/subscription-tools/export')
  assert.equal(exportedSubscriptions.status, 200)
  assert.equal(exportedSubscriptions.data.omitted, 0)
  assert.ok(!exportedSubscriptions.data.xml.includes('synthetic-token'))
  const subscriptionPreview = await request('/api/subscription-tools/preview', { xml: exportedSubscriptions.data.xml })
  assert.equal(subscriptionPreview.status, 200)
  assert.equal(subscriptionPreview.data.rows[0].suggestedId, 'feed/1')
  const subscriptionChoices = [{ key: subscriptionPreview.data.rows[0].key, action: 'reuse', existingId: 'feed/1', folders: null }]
  assert.equal((await request('/api/subscription-tools/apply', { token: subscriptionPreview.data.token, choices: subscriptionChoices }, { Origin: 'https://untrusted.example' })).status, 403)
  const subscriptionImport = await request('/api/subscription-tools/apply', { token: subscriptionPreview.data.token, choices: subscriptionChoices })
  assert.equal(subscriptionImport.data.results[0].status, 'reused')
  assert.equal(subscriptionImport.data.results[0].id, 'feed/1')
  assert.equal((await request('/api/subscription-tools/apply', { token: subscriptionPreview.data.token, choices: subscriptionChoices })).status, 409)
  const page = (await request('/api/entries?kind=all&id=all&unread=0&q=compositor')).data
  assert.equal(page.items.length, 2)
  const id = page.items[0].id
  const articleNumber = page.items[0].linkNumber
  assert(Number.isSafeInteger(articleNumber) && articleNumber > 0)
  assert.equal((await request(`/api/entries/number/${articleNumber}`)).data.entry.id, id)
  assert.equal((await request('/api/entries/number/999999999')).status, 404)
  assert.equal((await request('/api/entries/number/not-a-number')).status, 400)
  const numberedNavigation = (await request('/api/navigation')).data
  for (const folder of numberedNavigation.folders) assert(Number.isSafeInteger(folder.linkNumber))
  for (const feed of [...numberedNavigation.uncategorized, ...numberedNavigation.folders.flatMap(folder => folder.feeds)]) assert(Number.isSafeInteger(feed.linkNumber))
  assert.equal((await request('/api/entries/state', { ids: [id], operation: 'read' }, { Origin: 'https://untrusted.example' })).status, 403)
  assert.equal((await request('/api/entries/state', { ids: [id], operation: 'read' })).status, 200)
  assert.equal((await request('/api/entries/state', { ids: [id], operation: 'star' })).status, 200)
  assert(rows.find(row => row.id === id).categories.includes(readTag))
  assert(rows.find(row => row.id === id).categories.includes(starTag))
  assert.equal((await request('/api/reading', { id, position: 0.37 })).status, 200)
  assert.equal((await request('/api/readwise', { id })).status, 503)
  assert.equal((await request('/api/notes', {})).status, 503)
  assert.equal((await request('/api/discussion/message', {})).status, 503)
  assert.equal((await request('/api/internal/briefings/generate', { kind: 'morning' })).status, 401)
  assert.equal((await request('/api/internal/briefings/generate', { kind: 'morning' }, { 'x-paper-secret': 'synthetic-internal-secret-only-for-tests' })).status, 503)
  const settingsUrl = `${base}/api/settings/connections`
  const patchSettings = async (value, origin = base) => {
    const response = await fetch(settingsUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) })
    return { status: response.status, data: await response.json() }
  }
  const initialSettings = await fetch(settingsUrl)
  assert.equal(initialSettings.headers.get('cache-control'), 'no-store')
  assert.equal((await initialSettings.json()).ai.enabled, false)
  assert.equal((await patchSettings({ readwise: { enabled: true, token: 'synthetic-smoke-reader-token' } }, 'https://untrusted.example')).status, 403)
  assert.equal((await patchSettings({ kirby: { publishUrl: 'https://example.test/?token=synthetic-smoke-secret' } })).status, 400)
  const malformed = await fetch(settingsUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"readwise":{"token":"synthetic-smoke-secret"}, broken}' })
  assert.equal(malformed.status, 400)
  assert(!(await malformed.text()).includes('synthetic-smoke-secret'))
  const saved = await patchSettings({ readwise: { enabled: true, token: 'synthetic-smoke-reader-token', location: 'archive' }, kirby: { enabled: false, publishUrl: 'https://example.test/publish', token: 'synthetic-smoke-kirby-token' } })
  assert.equal(saved.status, 200)
  assert(!JSON.stringify(saved.data).includes('synthetic-smoke-'))
  assert.equal(saved.data.readwise.tokenConfigured, true)
  assert.equal((await request('/api/status')).data.readwiseConfigured, true)
  await patchSettings({ readwise: { enabled: false }, ai: { enabled: false, briefingsEnabled: false } })
  assert.equal((await request('/api/readwise', { url: 'https://example.test/', title: 'Fixture' })).status, 503)
  assert.equal((await request('/api/status')).data.readwiseConfigured, false)
  assert.equal((await fs.stat(path.join(temporary, 'data', 'connections.json'))).mode & 0o777, 0o600)
  const probe = await request('/api/settings/connections/test-ai', { openai: { baseUrl: `${openai.origin}/v1`, token: 'synthetic-smoke-api-key', discussionModel: 'probe' } })
  assert.equal(probe.data.available, true)
  assert.equal(openai.requests.length, 1)
  assert.equal((await request('/api/status')).data.discussionConfigured, false)
  assert.equal((await fetch(settingsUrl).then(response => response.json())).openai.tokenConfigured, false)
  const apiSettings = await patchSettings({ ai: { enabled: true, provider: 'openai', discussionEnabled: true, headlinesEnabled: false, collectionsEnabled: false },
    openai: { baseUrl: `${openai.origin}/v1`, token: 'synthetic-smoke-api-key', discussionModel: 'stream' } })
  assert.equal(apiSettings.status, 200)
  assert.equal(apiSettings.data.openai.tokenConfigured, true)
  assert(!JSON.stringify(apiSettings.data).includes('synthetic-smoke-api-key'))
  assert.equal((await request('/api/status')).data.discussionConfigured, true)
  assert.equal((await request('/api/settings/connections/test-ai', {}, { Origin: 'https://untrusted.example' })).status, 403)
  assert.equal(openai.requests.length, 1)
  const tested = await request('/api/settings/connections/test-ai', {})
  assert.equal(tested.data.available, true)
  assert.equal(openai.requests.length, 2)
  assert.equal(openai.requests[0].body.max_tokens, 8)
  assert.equal(openai.requests[0].authorization, 'Bearer synthetic-smoke-api-key')
  await patchSettings({ openai: { discussionModel: 'status-401' } })
  const rejectedKey = await request('/api/settings/connections/test-ai', {})
  assert.equal(rejectedKey.data.available, false)
  assert(!JSON.stringify(rejectedKey).includes('synthetic-smoke-api-key'))
  await patchSettings({ ai: { enabled: false } })
  assert.equal((await request('/api/status')).data.discussionConfigured, false)
  const manifest = await fetch(`${base}/offline-assets.json`).then(response => response.json())
  for (const asset of manifest) assert.equal((await fetch(`${base}${asset}`)).status, 200)
  assert((await fetch(`${base}/sw.js`).then(response => response.text())).includes('paper-shell-v3-'))
  await stop()
  await fs.cp(path.join(temporary, 'data'), path.join(temporary, 'restored'), { recursive: true })
  await start(path.join(temporary, 'restored'))
  const restoredSettings = await fetch(settingsUrl).then(response => response.json())
  assert.equal(restoredSettings.readwise.enabled, false)
  assert.equal(restoredSettings.readwise.location, 'archive')
  assert.equal(restoredSettings.readwise.tokenConfigured, true)
  assert.equal(restoredSettings.ai.briefingsEnabled, false)
  assert.equal(restoredSettings.ai.provider, 'openai')
  assert.equal(restoredSettings.openai.tokenConfigured, true)
  assert(!JSON.stringify(restoredSettings).includes('synthetic-smoke-api-key'))
  await patchSettings({ readwise: { enabled: true, token: '' } })
  assert.equal((await request('/api/status')).data.readwiseConfigured, true)
  await patchSettings({ readwise: { token: null }, kirby: { token: null }, openai: { token: null } })
  assert.equal((await fetch(settingsUrl).then(response => response.json())).openai.tokenConfigured, false)
  assert.equal((await request('/api/status')).data.readwiseConfigured, false)
  assert.equal((await fetch(settingsUrl).then(response => response.json())).kirby.tokenConfigured, false)
  const restored = (await request('/api/entries/item', { id })).data.entry
  assert.equal(restored.read, true); assert.equal(restored.starred, true)
  assert.equal(restored.readingPosition, 0.37)
  assert.equal((await request('/api/sync/parity')).data.ready, true)
  await stop()
  // Exercise the same factory and routes with remote reads explicitly selected.
  await start(path.join(temporary, 'restored'), false)
  assert.equal((await request('/api/status')).data.localReadsActive, false)
  const remotePage = (await request('/api/entries?kind=all&id=all&unread=0')).data
  assert.equal(remotePage.items.length, rows.length)
  assert.equal(remotePage.items.find(entry => entry.id === id).linkNumber, articleNumber)
  assert.equal((await request(`/api/entries/number/${articleNumber}`)).data.entry.id, id)
  const remoteNavigation = (await request('/api/navigation')).data
  assert.deepEqual(remoteNavigation.folders.map(folder => folder.linkNumber), numberedNavigation.folders.map(folder => folder.linkNumber))
  const remoteSearch = (await request('/api/entries?kind=all&id=all&unread=0&q=compositor')).data
  assert.equal(remoteSearch.items.length, 2)
  assert.equal((await request('/api/entries/item', { id })).data.entry.id, id)
  const preview = await request('/api/streams/preview-read', { stream: { kind: 'all', id: 'all' } })
  assert.equal(preview.data.count, rows.filter(row => !row.categories.includes(readTag)).length)
  for (const method of ['PATCH', 'DELETE']) {
    const invalid = await fetch(`${base}/api/feeds`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'invalid', title: 'Fixture' }) })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error, 'A FreshRSS feed ID is required')
  }
  const invalidRepair = await request('/api/feeds/repair', { id: 'feed/not-numeric', url: 'https://example.test/feed.xml' })
  assert.equal(invalidRepair.status, 400)
  assert.equal(invalidRepair.data.error, 'Choose a FreshRSS feed')
  const invalidFilter = await request('/api/filters', { phrase: 'fixture', scope: 'title', feedId: 'invalid' })
  assert.equal(invalidFilter.status, 400)
  assert.equal(invalidFilter.data.error, 'Unknown feed')
  await stop()
  const cli = spawnSync(process.execPath, ['dist-server/briefing-cli.js', 'morning'], { encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: temporary, STATE_DIR: path.join(temporary, 'restored'),
    FRESHRSS_BASE_URL: `http://127.0.0.1:${fixture.address().port}`, FRESHRSS_USERNAME: 'fixture', FRESHRSS_API_PASSWORD: 'synthetic-password',
    PAPER_INTERNAL_SECRET: 'synthetic-internal', PAPER_SIGNING_SECRET: 'synthetic-signing', CODEX_ENABLED: 'true',
  } })
  assert.equal(cli.status, 1)
  assert(cli.stderr.includes('Briefing generation is disabled'))
  assert(!logs.includes('synthetic-smoke-secret'))
  assert(!logs.includes('synthetic-smoke-reader-token'))
  assert(!logs.includes('synthetic-smoke-kirby-token'))
  assert(!logs.includes('synthetic-smoke-api-key'))
  // Run configuration initialization only against a disposable copy.
  const setup = path.join(temporary, 'setup'); await fs.mkdir(path.join(setup, 'scripts'), { recursive: true })
  await fs.copyFile('scripts/init-config.mjs', path.join(setup, 'scripts/init-config.mjs'))
  await fs.copyFile('.env.example', path.join(setup, '.env.example'))
  const run = () => spawnSync(process.execPath, [path.join(setup, 'scripts/init-config.mjs')], { encoding: 'utf8' })
  assert.equal(run().status, 0)
  const first = await fs.readFile(path.join(setup, '.env'), 'utf8')
  assert.equal((await fs.stat(path.join(setup, '.env'))).mode & 0o777, 0o600)
  assert(!first.includes('PAPER_SIGNING_SECRET=replace-me'))
  assert.equal(run().status, 1); assert.equal(await fs.readFile(path.join(setup, '.env'), 'utf8'), first)
  console.log('Smoke checks passed: FreshRSS import and parity, local and remote reads/search, adapter ID validation, state writes, private connection settings, API provider tests and key redaction, disabled integrations and briefing CLI, token masking and removal, origin checks, offline assets, restart/restore, and configuration initialization.')
} catch (error) {
  console.error(logs.slice(-4000)); throw error
} finally {
  await stop(); await openai.close(); await new Promise(resolve => fixture.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true })
}
