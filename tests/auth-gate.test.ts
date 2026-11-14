import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import ts from 'typescript'
import { DatabaseSync } from 'node:sqlite'
import { ingestFeed } from '../src/server/feed-ingestion'
import { defaultPolicy } from '../src/server/retention-store'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ABSOLUTE_MS, IDLE_MS } from '../src/server/auth-store'
import { PaperDatabase } from '../src/server/db'
import { routeAccess } from '../src/server/auth-routes'
import classifications from './fixtures/auth-route-classification.json'

// This inventory is intentionally separate from the gate. A new route or mount
// changes the snapshot and must be reviewed and classified explicitly.
const files = [
  ['src/server/index.ts', 'app', ''], ['src/server/auth-routes.ts', 'router', '/api/auth'],
  ['src/server/retention-routes.ts', 'router', '/api/retention'],
  ['src/server/subscription-tools-routes.ts', 'router', '/api/subscription-tools'],
  ['src/server/feed-check-routes.ts', 'router', '/api/feed-checks'], ['src/server/organization-routes.ts', 'router', '/api/organization'],
]
function inventory(extra = '') {
  const routes: string[] = []
  for (const [file, receiver, prefix] of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8') + (receiver === 'app' ? extra : ''), ts.ScriptTarget.Latest, true)
    const middleware = new Set(['preventFraming', 'requireAllowedHost', 'requireSameOrigin', 'authGate', 'express.json', 'express.urlencoded', 'json'])
    const fail = (node: ts.Node): never => { throw new Error(`Unclassified Express declaration in ${file}: ${node.getText(source)}`) }
    const rootedAtReceiver = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node)) return node.text === receiver
      if (ts.isCallExpression(node)) return rootedAtReceiver(node.expression)
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return rootedAtReceiver(node.expression)
      return false
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && rootedAtReceiver(node.expression)) {
        if (!ts.isPropertyAccessExpression(node.expression) || node.expression.expression.getText(source) !== receiver) fail(node)
        const expression = node.expression as ts.PropertyAccessExpression
        const method = expression.name.text, first = node.arguments[0]
        if (['set', 'disable', 'listen'].includes(method)) { ts.forEachChild(node, visit); return }
        if (!['get', 'post', 'patch', 'delete', 'put', 'head', 'options', 'all', 'use'].includes(method) || !first) fail(node)
        if (method === 'use' && !ts.isStringLiteral(first) && !ts.isArrayLiteralExpression(first)) {
          for (const arg of node.arguments) {
            if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) continue
            const name = ts.isCallExpression(arg) ? arg.expression.getText(source) : arg.getText(source)
            if (name === 'express.static') routes.push('STATIC /*')
            else if (!middleware.has(name)) fail(arg)
          }
        } else {
          const args = ts.isArrayLiteralExpression(first) ? first.elements : [first]
          if (!args.length) fail(first)
          for (const arg of args) {
            if (!ts.isStringLiteral(arg)) fail(arg)
            const pathname = (arg as ts.StringLiteral).text
            routes.push(`${method.toUpperCase()} ${prefix}${pathname === '/' && prefix ? '' : pathname}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return routes.sort()
}
let directory: string, child: ChildProcess, base: string
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-auth-gate-'))
  const db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  const backend = db.bindStandalone()
  const feed = db.saveLocalSubscription(backend.id, { url: 'https://example.test/rss', title: 'Retention fixture' })
  ingestFeed(db, { backendId: backend.id, subscriptionId: feed, endpointGeneration: 'fixture',
    requestUrl: 'https://example.test/rss', responseUrl: 'https://example.test/rss', fetchedAt: new Date().toISOString(),
    xml: '<rss version="2.0"><channel><title>Fixture</title><item><guid>old</guid><title>Old article</title><pubDate>2000-01-01T00:00:00Z</pubDate></item></channel></rss>' })
  const sql = new DatabaseSync(path.join(directory, 'paper.sqlite'))
  sql.exec('UPDATE entries SET first_seen_at = 1'); sql.close()
  await db.auth.setup(db.auth.setupCode(), 'owner', 'synthetic gate password')
  db.close()
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: {
    PATH: process.env.PATH, HOME: directory, STATE_DIR: directory, PAPER_BACKEND: 'standalone', PORT: '0', HOST: '127.0.0.1', PUBLIC_URL: 'http://localhost', PAPER_SYNC_ENABLED: 'false', PAPER_AI_PROVIDER: 'none',
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', () => {})
  // The server logs its bound port for ephemeral test listeners.
  for (let i = 0; i < 200; i++) {
    const match = /Paper is listening on port (\d+)/.exec(output)
    if (match && match[1] !== '0') { base = `http://127.0.0.1:${match[1]}`; return }
    if (child.exitCode !== null) throw new Error('Synthetic Paper process exited before listening.')
    await delay(25)
  }
  throw new Error('Synthetic Paper process did not start.')
}, 15000)
afterAll(async () => {
  if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve())) }
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})
it('classifies every route and router mount in index.ts and every mounted router', () => {
  expect(inventory()).toEqual(Object.keys(classifications).sort())
  for (const [route, classification] of Object.entries(classifications)) {
    const [method, template] = route.split(' ')
    if (['USE', 'STATIC'].includes(method) || template === '*splat') continue
    expect(routeAccess(method, template.replace(/:[^/]+/g, 'fixture')), route).toBe(classification)
  }
})
it('denies every session-protected API and page on the running server, including mounted routers', async () => {
  for (const [route, classification] of Object.entries(classifications)) {
    if (classification !== 'session') continue
    let [method, pathname] = route.split(' ')
    if (['STATIC'].includes(method)) continue
    if (method === 'USE') method = 'GET'
    pathname = pathname.replace(/:[^/]+/g, 'fixture').replace('*splat', '/feeds/1/fixture')
    const response = await fetch(base + pathname, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: ['POST', 'PATCH', 'PUT'].includes(method) ? '{}' : undefined })
    expect(response.status, route).toBe(pathname.startsWith('/api') || !['GET', 'HEAD'].includes(method) ? 401 : 303)
  }
})
it('leaves only health, login assets and exact self-authenticating routes outside the gate', async () => {
  expect((await fetch(base + '/health')).status).toBe(200)
  expect((await fetch(base + '/api/auth/status')).status).toBe(200)
  expect((await fetch(base + '/api/internal/briefings/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
  for (const method of ['GET', 'POST']) expect((await fetch(base + '/briefings/fixture/confirm', { method, body: method === 'POST' ? '' : undefined })).status).toBe(404)
  expect((await fetch(base + '/api/internal/briefings/fixture/extra', { method: 'POST' })).status).toBe(401)
  expect((await fetch(base + '/api/new-unclassified-endpoint')).status).toBe(401)
  expect((await fetch(base + '/_offline/articles/private', { redirect: 'manual' })).status).toBe(303)
})
it('delivers retention invalidations through an authenticated stream and closes it after CLI revocation', async () => {
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'synthetic gate password' }) })
  const cookie = login.headers.getSetCookie()[0].split(';')[0]
  const stream = await fetch(base + '/api/events', { headers: { cookie }, signal: AbortSignal.timeout(5000) })
  expect(stream.headers.get('cache-control')).toContain('no-store')
  const reader = stream.body!.getReader(); expect((await reader.read()).done).toBe(false)
  const saved = await fetch(base + '/api/retention', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: { ...defaultPolicy(), autoReadDays: 1 }, revision: 0 }) })
  expect(saved.status).toBe(200)
  const update = await reader.read()
  expect(update.done).toBe(false)
  expect(new TextDecoder().decode(update.value)).toContain('event: state')
  const db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  expect(db.retention.lastRun()?.marked).toBe(1)
  try { await db.auth.recover('revoke-all') } finally { db.close() }
  expect((await reader.read()).done).toBe(true)
})

it.each([
  "app.route('/unclassified').get(handler)",
  'app.use(router)',
  'app.get(/^\\/unclassified$/, handler)',
  "app.get('/unclassified', handler)",
  "app['post']('/unclassified', handler)",
])('rejects an unclassified declaration: %s', declaration => {
  expect(() => expect(inventory(declaration)).toEqual(Object.keys(classifications).sort())).toThrow()
})

const streamAliases = ['/api/events', '/api/events/', '/API/EVENTS', '/API/EVENTS/',
  '/api/discussion/events', '/api/discussion/events/', '/API/DISCUSSION/EVENTS', '/API/DISCUSSION/EVENTS/']
it.each(['setup', 'logout', 'sign-out-others', 'reset-password', 'remove-passkeys', 'revoke-all', 'disable', 'idle expiry', 'absolute expiry'])(
  'closes every SSE alias after %s', async action => {
    const db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    const controllers: AbortController[] = []
    try {
      await db.auth.recover('disable')
      if (action !== 'setup') await db.auth.setup(db.auth.setupCode(), 'owner', 'synthetic gate password')
      const token = action === 'setup' ? '' : db.auth.newSession('', 'stream browser')
      const other = action === 'sign-out-others' ? db.auth.newSession('', 'retained browser') : ''
      const readers = await Promise.all(streamAliases.map(async alias => {
        const controller = new AbortController(); controllers.push(controller)
        const response = await fetch(base + alias, { headers: { cookie: `paper_session=${token}` }, signal: controller.signal })
        expect(response.status, alias).toBe(200)
        const reader = response.body!.getReader()
        expect((await reader.read()).done, alias).toBe(false)
        return reader
      }))
      if (action === 'setup') await db.auth.setup(db.auth.setupCode(), 'owner', 'synthetic gate password')
      else if (action === 'logout' || action === 'sign-out-others') {
        const route = action === 'logout' ? '/logout' : '/sessions/sign-out-others'
        expect((await fetch(base + '/api/auth' + route, { method: 'POST', headers: { cookie: `paper_session=${other || token}` } })).status).toBe(200)
        if (other) expect(db.auth.session(other)).toBeDefined()
      } else if (action.endsWith('expiry')) {
        const raw = new DatabaseSync(path.join(directory, 'paper.sqlite'))
        try { raw.prepare(`UPDATE auth_sessions SET ${action === 'idle expiry' ? 'seen' : 'created'} = ?`).run(Date.now() - (action === 'idle expiry' ? IDLE_MS : ABSOLUTE_MS)) } finally { raw.close() }
      } else {
        const recovery = spawn(process.execPath, ['--import', 'tsx', 'src/server/auth-cli.ts', action], { env: { PATH: process.env.PATH, STATE_DIR: directory }, stdio: ['pipe', 'ignore', 'ignore'] })
        recovery.stdin!.end(action === 'reset-password' ? 'synthetic replacement password\n' : '')
        expect(await new Promise(resolve => recovery.once('exit', resolve))).toBe(0)
      }
      await Promise.all(readers.map(async (reader, i) => {
        const timeout = setTimeout(() => controllers[i].abort(), 2500)
        try { expect((await reader.read()).done, streamAliases[i]).toBe(true) } finally { clearTimeout(timeout) }
      }))
    } finally { controllers.forEach(controller => controller.abort()); db.close() }
  }, 15000)
