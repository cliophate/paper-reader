import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acquireStateLock } from '../src/server/state-lock.js'

let directory: string
const children: ChildProcess[] = []
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-runtime-'))
  fs.writeFileSync(path.join(directory, 'synthetic-model'), '#!/bin/sh\ncat >/dev/null\nexit 1\n', { mode: 0o700 })
})
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }))
  fs.rmSync(directory, { recursive: true, force: true })
})
async function port() {
  const server = http.createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
function start(file: string, port: number, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', `src/server/${file}.ts`], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: '1',
      STATE_DIR: directory, PAPER_BACKEND: 'standalone', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://127.0.0.1:${port}`,
      PAPER_SYNC_ENABLED: 'false', CODEX_ENABLED: 'false', ...extra },
  })
  children.push(child)
  let output = ''
  child.stdout!.on('data', chunk => { output += chunk }); child.stderr!.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit').then(([code]) => ({ code, output }))
  return { child, exited }
}
async function ready(port: number) {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return } catch {}
    await delay(50)
  }
  throw new Error('Synthetic server did not start')
}

it('starts the actual server and briefing CLI together, then admits a current CLI while excluding exclusive access', async () => {
  const number = await port()
  const server = start('index', number)
  const firstBriefing = start('briefing-cli', number, { CODEX_ENABLED: 'true', PAPER_AI_LOCAL: 'unsafe', CODEX_BIN: path.join(directory, 'synthetic-model') })
  await ready(number)
  const firstResult = await firstBriefing.exited
  expect(firstResult.code, firstResult.output).toBe(0)
  const status = await (await fetch(`http://127.0.0.1:${number}/api/status`)).json()
  expect(status).toMatchObject({ backend: 'standalone', localReadsActive: true, briefingConfigured: false, readwiseConfigured: false, kirbyConfigured: false })
  const db = new DatabaseSync(path.join(directory, 'paper.sqlite'), { readOnly: true })
  const schema = db.prepare('PRAGMA schema_version').get()?.schema_version
  expect(() => acquireStateLock(directory, 'exclusive')).toThrow(/in use/)
  const nextBriefing = await start('briefing-cli', number, { CODEX_ENABLED: 'true', PAPER_AI_LOCAL: 'unsafe', CODEX_BIN: path.join(directory, 'synthetic-model') }).exited
  expect(nextBriefing.code, nextBriefing.output).toBe(0)
  expect(db.prepare('PRAGMA schema_version').get()?.schema_version).toBe(schema)
  db.close()
  const secrets = fs.readFileSync(path.join(directory, 'secrets.json'))
  expect(fs.statSync(path.join(directory, 'secrets.json')).mode & 0o777).toBe(0o600)
  server.child.kill('SIGTERM'); expect((await server.exited).code).toBe(0)
  const lock = acquireStateLock(directory, 'exclusive'); lock.release()
  const restarted = start('index', number); await ready(number)
  expect((await (await fetch(`http://127.0.0.1:${number}/api/status`)).json()).backendInstance).toBe(status.backendInstance)
  expect(fs.readFileSync(path.join(directory, 'secrets.json'))).toEqual(secrets)
  restarted.child.kill('SIGKILL'); await restarted.exited
  acquireStateLock(directory, 'exclusive').release()
}, 20000)

it('excludes both real entrypoints while an exclusive lock owns the directory, then releases failed startup resources', async () => {
  const number = await port(), lock = acquireStateLock(directory, 'exclusive')
  try {
    const results = await Promise.all([start('index', number).exited, start('briefing-cli', number).exited])
    for (const result of results) { expect(result.code).not.toBe(0); expect(result.output).toMatch(/in use/) }
    expect(fs.existsSync(path.join(directory, 'paper.sqlite'))).toBe(false)
    expect(fs.existsSync(path.join(directory, 'secrets.json'))).toBe(false)
  } finally { lock.release() }
  const server = start('index', number); await ready(number)
  server.child.kill('SIGTERM'); expect((await server.exited).code).toBe(0)
}, 15000)

it('rejects configuration-only ownership changes before generating secrets or loading connections', async () => {
  const number = await port()
  const server = start('index', number); await ready(number)
  server.child.kill('SIGTERM'); await server.exited
  fs.rmSync(path.join(directory, 'secrets.json'))
  const result = await start('briefing-cli', number, { PAPER_BACKEND: 'freshrss', PAPER_LOCAL_READS: 'false',
    FRESHRSS_BASE_URL: 'https://rss.example.test', FRESHRSS_USERNAME: 'synthetic', FRESHRSS_API_PASSWORD: 'synthetic' }).exited
  expect(result.code).not.toBe(0); expect(result.output).toMatch(/another backend/)
  expect(fs.existsSync(path.join(directory, 'secrets.json'))).toBe(false)
  acquireStateLock(directory, 'exclusive').release()
}, 15000)

it('enforces route CAS, publishes committed revisions, and prevents bulk undo from overwriting later state', async () => {
  const { PaperDatabase } = await import('../src/server/db.js')
  const db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  const identity = db.bindStandalone()
  const feedId = db.saveLocalSubscription(identity.id, { title: 'Synthetic feed', url: 'https://example.test/feed' })
  const entries = [1, 2].map(n => ({ identity: { externalId: `fixture-${n}` }, entry: {
    feedTitle: 'Synthetic feed', feedUrl: 'https://example.test/feed', title: `Synthetic ${n}`, author: '', url: `https://example.test/${n}`,
    contentHtml: '<p>Synthetic content</p>', excerpt: 'Synthetic content', publishedAt: new Date().toISOString(), timestamp: Date.now(),
    readingMinutes: 1, thumbnailUrl: '', kind: 'article' as const,
  } }))
  const ids = db.importSourceEntries(identity.id, feedId, entries).map(item => item.status === 'resolved' ? item.id : '')
  db.close()
  const number = await port(), server = start('index', number)
  await ready(number)
  const base = `http://127.0.0.1:${number}`
  const post = async (route: string, body: unknown) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const events = await fetch(base + '/api/events'), reader = events.body!.getReader()
  try {
    await reader.read() // Initial synchronization status.
    const changed = await post('/api/entries/state', { ids: [ids[0]], operation: 'star', expectedRevisions: { [ids[0]]: 0 } })
    expect(changed).toMatchObject({ status: 200, body: { revisions: { [ids[0]]: 1 } } })
    const event = new TextDecoder().decode((await reader.read()).value)
    expect(event).toContain('event: state'); expect(event).toContain('"revisions"')
    const stale = await post('/api/entries/state', { ids, operation: 'read', expectedRevisions: Object.fromEntries(ids.map(id => [id, 0])) })
    expect(stale).toMatchObject({ status: 409, body: { code: 'state-conflict', states: { [ids[0]]: { read: false, starred: true, revision: 1 }, [ids[1]]: { read: false, revision: 0 } } } })
    const stream = { kind: 'all', id: 'all', title: 'All' }
    const preview = await post('/api/streams/preview-read', { stream })
    await post('/api/entries/state', { ids: [ids[1]], operation: 'star' })
    expect((await post('/api/streams/confirm-read', { token: preview.body.token })).status).toBe(409)
    const read = await post('/api/streams/mark-read', stream)
    expect(read.body.count).toBe(2)
    await post('/api/entries/state', { ids: [ids[0]], operation: 'unstar' })
    expect((await post('/api/undo', { token: read.body.undoToken })).status).toBe(409)
    expect((await post('/api/entries/item', { id: ids[1] })).body.entry.read).toBe(true)
    const unstar = await post('/api/entries/state', { ids: [ids[1]], operation: 'unstar', undo: true })
    expect((await post('/api/undo', { token: unstar.body.undoToken })).status).toBe(200)
    expect((await post('/api/undo', { token: unstar.body.undoToken })).status).toBe(410)
  } finally { await reader.cancel() }
  server.child.kill('SIGTERM'); expect((await server.exited).code).toBe(0)
}, 15000)

it('bounds remote search pages and resumes from the returned continuation', async () => {
  const pages: number[] = []
  const fixture = http.createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture')
    if (url.pathname.endsWith('/accounts/ClientLogin')) return response.end('Auth=synthetic-token\n')
    if (url.pathname.includes('/stream/contents/')) {
      const page = Number(url.searchParams.get('c') || 0)
      pages.push(page)
      response.setHeader('Content-Type', 'application/json')
      return response.end(JSON.stringify({ items: [{
        id: `tag:google.com,2005:reader/item/${String(page + 1).padStart(16, '0')}`,
        title: page === 10 ? 'Needle found' : 'Unrelated article', published: 1, categories: [],
        canonical: [{ href: `https://example.test/${page}` }],
        origin: { streamId: 'feed/1', title: 'Synthetic feed' }, summary: { content: '<p>Fixture</p>' },
      }], continuation: page < 11 ? String(page + 1) : '' }))
    }
    response.statusCode = 404; response.end()
  }).listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  try {
    const number = await port()
    const server = start('index', number, { PAPER_BACKEND: 'freshrss', PAPER_LOCAL_READS: 'false',
      FRESHRSS_BASE_URL: `http://127.0.0.1:${(fixture.address() as { port: number }).port}`,
      FRESHRSS_USERNAME: 'synthetic', FRESHRSS_API_PASSWORD: 'synthetic' })
    await ready(number)
    const base = `http://127.0.0.1:${number}/api/entries?q=needle`
    const first = await (await fetch(base)).json()
    expect(pages).toEqual(Array.from({ length: 10 }, (_, index) => index))
    expect(first).toMatchObject({ items: [], continuation: '10' })
    const second = await (await fetch(`${base}&continuation=${first.continuation}`)).json()
    expect(second).toMatchObject({ items: [{ title: 'Needle found' }], continuation: '' })
    expect(pages).toHaveLength(12)
    server.child.kill('SIGTERM'); expect((await server.exited).code).toBe(0)
  } finally {
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
}, 15000)

it('shuts down cleanly with Pulse on and an event stream open', async () => {
  const number = await port()
  const server = start('index', number, {
    PAPER_AI_PROVIDER: 'openai', PAPER_OPENAI_API_KEY: 'synthetic-key', PAPER_OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', PAPER_TRUSTED_AI_ORIGINS: 'http://127.0.0.1:9',
  })
  await ready(number)
  expect((await (await fetch(`http://127.0.0.1:${number}/api/pulse`)).json()).status.enabled).toBe(true)
  const events = http.get(`http://127.0.0.1:${number}/api/events`)
  const [response] = await once(events, 'response') as [http.IncomingMessage]
  response.resume()
  // Pulse notifies its listeners while shutdown is disabling it, after the stream has ended.
  server.child.kill('SIGTERM')
  const { code, output } = await server.exited
  events.destroy()
  expect(output).not.toContain('ERR_STREAM_WRITE_AFTER_END')
  expect(code).toBe(0)
})

it('returns 400 for unknown streams and invalid feed preview input', async () => {
  const fixture = http.createServer((_request, response) => response.end('<html><title>Website</title></html>')).listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  try {
    const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`
    const number = await port(), server = start('index', number, { PAPER_TRUSTED_FEED_ORIGINS: origin })
    await ready(number)
    const base = `http://127.0.0.1:${number}`
    const post = (route: string, body: unknown) => fetch(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const responses = await Promise.all([
      fetch(base + '/api/entries?kind=unknown'),
      post('/api/streams/mark-read', { kind: 'unknown' }),
      ...['not a URL', 'file:///etc/hosts', 'http://127.0.0.1/', origin].map(url => post('/api/feeds/preview', { url })),
    ])
    expect(responses.map(response => response.status)).toEqual([400, 400, 400, 400, 400, 400])
    server.child.kill('SIGTERM'); expect((await server.exited).code).toBe(0)
  } finally {
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
  }
}, 15000)


it('uses Paper wording for an acknowledged briefing confirmation', async () => {
  const { PaperDatabase } = await import('../src/server/db.js')
  const db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  db.bindStandalone()
  const now = new Date().toISOString(), token = 'synthetic-confirmation-token'
  db.createBriefing({
    id: 'synthetic-briefing', kind: 'morning', windowStart: now, cutoff: now,
    subject: 'Synthetic briefing', html: '', text: '', status: 'generated',
    tokenHash: createHash('sha256').update(token).digest('hex'),
    selection: { news: [], worthNoticing: [], social: [] },
    createdAt: now, deliveredAt: now, acknowledgedAt: now,
  }, [])
  db.close()
  const number = await port(), server = start('index', number)
  await ready(number)
  const response = await fetch(`http://127.0.0.1:${number}/briefings/synthetic-briefing/confirm?token=${token}`)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('entries from this briefing are read in Paper.')
  server.child.kill('SIGTERM'); expect((await server.exited).code).toBe(0)
}, 15000)

it('keeps legacy provider installs readable and reports the removed provider once', async () => {
  const number = await port()
  const server = start('index', number, { OPENCODE_ENABLED: 'true', OPENCODE_BIN: '/missing/old-cli' })
  await ready(number)
  const settings = await (await fetch(`http://127.0.0.1:${number}/api/settings/connections`)).json()
  expect(settings.aiRuntime.available).toBe(false)
  expect(settings.aiRuntime.message).toContain('AI is off')
  expect(settings.ai.provider).toBe('none')
  expect(settings.ai).not.toHaveProperty('openCodeEnabled')
  server.child.kill('SIGTERM')
  const result = await server.exited
  expect(result.code).toBe(0)
  expect(result.output.match(/OpenCode support was removed/g)).toHaveLength(1)
}, 15000)

it('refuses briefing generation without a worker or explicit unsafe local opt-in', async () => {
  const result = await start('briefing-cli', await port(), { CODEX_ENABLED: 'true', CODEX_BIN: path.join(directory, 'synthetic-model') }).exited
  expect(result.code).not.toBe(0)
  expect(result.output).toContain('AI is unavailable')
})

it('masks SMTP credentials, sends a loopback test, and preserves the external briefing contract', async () => {
  const { startSmtpFixture } = await import('./fixtures/smtp.mjs')
  const { startOpenaiFixture } = await import('./fixtures/openai-provider.mjs')
  const [smtp, model, number] = await Promise.all([startSmtpFixture(), startOpenaiFixture(), port()])
  const secret = 'synthetic-internal'
  const password = 'synthetic-private-echo'
  const server = start('index', number, {
    TZ: 'UTC', PAPER_INTERNAL_SECRET: secret, PAPER_AI_PROVIDER: 'openai',
    PAPER_OPENAI_BASE_URL: model.origin + '/v1', PAPER_TRUSTED_AI_ORIGINS: model.origin,
    PAPER_SMTP_HOST: '127.0.0.1', PAPER_SMTP_PORT: String(smtp.port), PAPER_SMTP_SECURITY: 'none',
    PAPER_SMTP_USER: 'fixture', PAPER_SMTP_PASSWORD: password,
    PAPER_BRIEFING_FROM: 'paper@example.test', PAPER_BRIEFING_TO: 'reader@example.test',
  })
  const base = `http://127.0.0.1:${number}`
  const connections = '/api/settings/connections'
  const request = (url: string, data: unknown, method = 'POST', headers = {}) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  })
  try {
    await ready(number)
    const response = await fetch(base + connections)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const initial = await response.json()
    expect(initial.briefingDelivery).toMatchObject({
      smtp: { passwordConfigured: true, passwordSource: 'environment', security: 'none' },
      schedule: { enabled: false, morning: '07:30', evening: '18:30' },
    })
    expect(initial.briefingDelivery.smtp).not.toHaveProperty('password')
    expect(JSON.stringify(initial)).not.toContain(password)
    expect(smtp.connections).toBe(0)
    const tested = await request(connections + '/test-smtp', {})
    expect(tested.status).toBe(200)
    expect(await tested.text()).toContain('SMTP 250')
    expect(smtp.messages[0]).toContain('Subject: Paper test email')
    smtp.mode = 'auth'
    const rejected = await request(connections + '/test-smtp', {})
    const error = await rejected.text()
    expect(rejected.status).toBe(422)
    expect(error).toContain('SMTP authentication failed')
    expect(error).not.toContain(password)
    smtp.mode = 'accept'

    const internal = { 'x-paper-secret': secret }
    const generate = '/api/internal/briefings/generate'
    expect((await request(generate, { kind: 'morning' })).status).toBe(401)
    for (const kind of ['morning', 'evening']) {
      const generated = await request(generate, { kind }, 'POST', internal)
      expect(generated.status).toBe(200)
      const record = await generated.json()
      expect(record).toMatchObject({ id: expect.any(String), subject: expect.any(String), html: expect.any(String), text: expect.any(String), entryCount: 0, cutoff: expect.any(String) })
      const endpoint = '/api/internal/briefings/' + record.id
      const rendered = await request(endpoint + '/render', {}, 'POST', internal)
      expect(await rendered.json()).toMatchObject({ id: record.id, subject: record.subject, html: record.html, text: record.text, entryCount: record.entryCount })
      const href = record.html.match(/href="([^"]+\/confirm\?token=[^"]+)"/)?.[1]
      expect(href).toBeTruthy()
      const page = await fetch(href)
      expect(await page.text()).toContain('Mark this briefing read?')
      expect((await request(endpoint + '/delivered', {})).status).toBe(401)
      const delivered = await request(endpoint + '/delivered', {}, 'POST', internal)
      expect(await delivered.json()).toEqual({ ok: true })
      expect(await (await fetch(base + '/api/briefings/' + record.id)).json()).toMatchObject({ deliveredAt: expect.any(String) })
    }
    const local = new Date().toISOString().slice(11, 16)
    const updated = await request(connections, {
      smtp: { user: '', password: null }, briefingSchedule: { enabled: true, morning: local, evening: local },
    }, 'PATCH')
    const saved = await updated.json()
    expect(updated.status).toBe(200)
    expect(saved.briefingDelivery.smtp).toMatchObject({ passwordConfigured: false, passwordSource: null })
    expect(JSON.stringify(saved)).not.toContain(password)
    expect(fs.statSync(path.join(directory, 'connections.json')).mode & 0o777).toBe(0o600)
    await expect.poll(async () => (await (await fetch(base + connections + '/briefing-delivery')).json()).filter(job => job.state === 'skipped')).toHaveLength(2)
    expect(smtp.connections).toBe(2)
    expect(smtp.messages).toHaveLength(1)
  } finally {
    server.child.kill('SIGTERM')
    await Promise.all([server.exited, smtp.close(), model.close()])
  }
}, 20000)
