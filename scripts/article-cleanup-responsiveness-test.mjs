import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { cleanupInputs } from '../tests/fixtures/article-cleanup-inputs.mjs'

// Production collection with a synthetic body that stalled the old cleanup.
// Keep the same 2s health deadline as collection-responsiveness-test.mjs.
const build = path.resolve(process.env.PAPER_TEST_BUILD_DIR || 'dist-server')
const { PaperDatabase } = await import(pathToFileURL(path.join(build, 'db.js')))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-parser-test-'))
const state = path.join(temporary, 'data'), file = path.join(state, 'paper.sqlite')
const latencyBudget = 2000
const body = '<p>Synthetic parser story</p>' + cleanupInputs.enclosure(1500) + '<p>Keep the ending</p>'
const publishedAt = '2026-01-02T03:04:05.000Z'
let release = false, requested = false, child, check, logs = '', probeRunning = false, probeLoop, healthFailure
let probes = 0, maxLatency = 0
const fixture = http.createServer(async (_request, response) => {
  requested = true
  while (!release && !response.destroyed) await delay(10)
  if (response.destroyed) return
  response.setHeader('Content-Type', 'application/rss+xml')
  response.end(`<rss version="2.0"><channel><title>Synthetic parser</title><link>https://example.test</link><item><guid>parser-fixture</guid><title>Parser fixture</title><link>https://example.test/parser</link><pubDate>${publishedAt}</pubDate><description><![CDATA[${body}]]></description></item></channel></rss>`)
})
async function until(test, timeout = 20_000) {
  const deadline = Date.now() + timeout
  do {
    if (healthFailure) throw healthFailure
    if (await test()) return
    await delay(20)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for synthetic parser collection')
}
try {
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening')
  const origin = `http://127.0.0.1:${fixture.address().port}`
  const db = new PaperDatabase(file), backend = db.bindStandalone()
  const feed = db.saveLocalSubscription(backend.id, { title: 'Synthetic parser', url: origin + '/feed.xml' })
  db.close()
  const listener = http.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [path.join(build, 'index.js')], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: temporary, NODE_NO_WARNINGS: '1', STATE_DIR: state, PAPER_BACKEND: 'standalone',
    HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: base, PAPER_TRUSTED_FEED_ORIGINS: origin,
    CODEX_ENABLED: 'false',
  } })
  child.stdout.on('data', data => { logs = (logs + data).slice(-4000) })
  child.stderr.on('data', data => { logs = (logs + data).slice(-4000) })
  await until(async () => { try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } })
  await until(() => requested)
  async function probe() {
    const start = performance.now()
    const response = await fetch(base + '/health', { signal: AbortSignal.timeout(latencyBudget) })
    await response.text(); assert.equal(response.status, 200)
    const elapsed = performance.now() - start
    maxLatency = Math.max(maxLatency, elapsed); probes++
    assert(elapsed < latencyBudget, `health blocked for ${elapsed.toFixed(0)}ms`)
  }
  await probe()
  console.log(JSON.stringify({ phase: 'release', bytes: Buffer.byteLength(body), latencyBudget }))
  const started = performance.now()
  probeRunning = true
  probeLoop = (async () => { while (probeRunning) { await probe(); await delay(20) } })()
    .catch(error => { healthFailure = new Error('Health probe failed during parser collection', { cause: error }) })
  check = new DatabaseSync(file, { readOnly: true })
  release = true
  await until(() => check.prepare('SELECT last_success_at FROM feed_fetch_state WHERE subscription_id=?').get(feed).last_success_at > 0)
  await until(() => check.prepare("SELECT value FROM sync_state WHERE key='coverage_generated_at'").get()?.value)
  const article = check.prepare('SELECT content_html, published_at, read, starred FROM entries').get()
  assert(article.content_html.includes('Synthetic parser story'))
  assert(article.content_html.includes('Keep the ending'))
  assert(!article.content_html.includes('Watch video'))
  assert.equal(article.published_at, publishedAt)
  assert.equal(article.read, 0); assert.equal(article.starred, 0)
  assert.equal(check.prepare('SELECT COUNT(*) n FROM entries').get().n, 1)
  assert.equal(check.prepare('SELECT COUNT(*) n FROM article_aliases WHERE subscription_id=?').get(feed).n, 1)
  await probe()
  probeRunning = false; await probeLoop
  if (healthFailure) throw healthFailure
  console.log(JSON.stringify({ phase: 'passed', collectionMs: performance.now() - started, probes, maxHealthMs: maxLatency, latencyBudget }))
} catch (error) {
  console.error(logs)
  throw error
} finally {
  probeRunning = false
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1000)
    await exited; clearTimeout(force)
  }
  await probeLoop
  check?.close()
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true })
}
