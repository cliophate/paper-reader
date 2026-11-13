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

// Synthetic scale regression against the production server, including actual
// HTTP collection and sync-completion work. No real account or configuration.
const build = path.resolve(process.env.PAPER_TEST_BUILD_DIR || 'dist-server')
const { PaperDatabase } = await import(pathToFileURL(path.join(build, 'db.js')))
const { acquireStateLock } = await import(pathToFileURL(path.join(build, 'state-lock.js')))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-collection-scale-'))
const state = path.join(temporary, 'data'), file = path.join(state, 'paper.sqlite')
const count = 200_000, feedCount = 1266, updatedCount = 1000
const latencyBudget = 2000
const publishedAt = new Date().toISOString()
// Several KiB per row exposes metadata queries that read article payload pages.
const historicalText = 'The synthetic article. ' + 'History from a synthetic publication about science and technology. '.repeat(50)
const body = '<p>Updated the synthetic article with searchable collectionneedle. ' + 'Synthetic content for collection. '.repeat(30) + '</p>'
let released = false, requested = false
const fixture = http.createServer(async (_request, response) => {
  requested = true
  while (!released && !response.destroyed) await delay(10)
  if (response.destroyed) return
  response.setHeader('Content-Type', 'application/rss+xml')
  response.end(`<rss version="2.0"><channel><title>Synthetic collector</title><link>https://example.test</link>
    ${Array.from({ length: updatedCount }, (_, i) => `<item><guid>collected-${i}</guid><title>The synthetic article ${i}</title><link>https://example.test/${i}</link><pubDate>${publishedAt}</pubDate><description><![CDATA[${body}]]></description></item>`).join('')}
    </channel></rss>`)
})
let child, logs = '', probeRunning = false, healthFailure, maxLatency = 0, probes = 0
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 31_000)
    await exited; clearTimeout(force)
  }
}
async function until(check, timeout = 20_000) {
  const deadline = Date.now() + timeout
  do { const value = await check(); if (value) return value; await delay(20) } while (Date.now() < deadline)
  throw new Error('Timed out waiting for synthetic collection')
}
let probeLoop
try {
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening')
  const origin = `http://127.0.0.1:${fixture.address().port}`
  const db = new PaperDatabase(file), backend = db.bindStandalone()
  const feeds = Array.from({ length: feedCount }, (_, i) => db.saveLocalSubscription(backend.id, {
    title: `Synthetic feed ${i}`, url: `${origin}/feed-${i}.xml`,
  }))
  db.close()
  const sql = new DatabaseSync(file)
  sql.exec('PRAGMA foreign_keys = ON; BEGIN')
  const insert = sql.prepare(`INSERT INTO entries(id, feed_id, feed_title, feed_url, title, author, url, canonical_url,
    source_domain, content_html, content_text, excerpt, published_at, timestamp, reading_minutes, thumbnail_url, kind, synced_at)
    VALUES (?, ?, 'Synthetic collector', 'https://example.test', ?, 'Synthetic', ?, ?, 'example.test',
      ?, ?, 'The synthetic article', ?, ?, 1, '', 'article', ?)`)
  const identity = sql.prepare('INSERT INTO article_identities VALUES (?, ?, ?)')
  const alias = sql.prepare('INSERT INTO article_aliases VALUES (?, ?, ?, ?)')
  for (let i = 0; i < count; i++) {
    const id = `synthetic-${i}`, feed = i < updatedCount ? feeds[0] : feeds[i % feedCount]
    const url = `https://example.test/${i}`
    identity.run(id, backend.id, feed)
    insert.run(id, feed, `The synthetic article ${i}`, url, url, `<p>${historicalText}</p>`, historicalText, publishedAt, Date.parse(publishedAt) - i * 1000, publishedAt)
    if (i < updatedCount) alias.run(backend.id, feed, `collected-${i}`, id)
  }
  sql.prepare('UPDATE entries SET read=1, starred=1, state_revision=3 WHERE id=?').run('synthetic-0')
  sql.prepare('INSERT INTO reading_progress VALUES (?, ?, ?)').run('synthetic-0', 0.42, publishedAt)
  sql.prepare('UPDATE feed_fetch_state SET next_fetch_at=?, available_at=? WHERE subscription_id != ?')
    .run(Date.now() + 3600_000, Date.now() + 3600_000, feeds[0])
  sql.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)'); sql.close()
  const listener = http.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  function startServer(extraArgs = []) {
    child = spawn(process.execPath, [...extraArgs, path.join(build, 'index.js')], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: temporary, NODE_NO_WARNINGS: '1', STATE_DIR: state, PAPER_BACKEND: 'standalone',
      HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: base, PAPER_TRUSTED_FEED_ORIGINS: origin,
      CODEX_ENABLED: 'false',
    } })
    child.stdout.on('data', data => { logs = (logs + data).slice(-4000) })
    child.stderr.on('data', data => { logs = (logs + data).slice(-4000) })
  }
  startServer()
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
  probeRunning = true
  probeLoop = (async () => {
    while (probeRunning) { await probe(); await delay(20) }
  })().catch(error => { healthFailure = new Error('Health probe failed', { cause: error }) })
  const check = new DatabaseSync(file, { readOnly: true })
  try {
    released = true
    await until(() => {
      if (healthFailure) throw healthFailure
      return check.prepare('SELECT last_success_at FROM feed_fetch_state WHERE subscription_id=?').get(feeds[0]).last_success_at > 0
    })
    // Include the runtime's completion callbacks, not only the feed transaction.
    await until(() => {
      if (healthFailure) throw healthFailure
      return check.prepare("SELECT value FROM sync_state WHERE key='coverage_generated_at'").get()?.value
    })
    console.log('Collection and completion callbacks finished; starting common-term search.')
    const searchStart = performance.now()
    const response = await fetch(base + '/api/entries?kind=all&id=all&unread=0&q=the', { signal: AbortSignal.timeout(60_000) })
    const page = await response.json()
    assert.equal(response.status, 200); assert.equal(page.items.length, 80); assert(page.continuation)
    assert(page.items.every(item => typeof item.searchExcerpt === 'string'))
    const searchMs = performance.now() - searchStart
    console.log(`Common-term search ${searchMs.toFixed(0)}ms; max health ${maxLatency.toFixed(0)}ms.`)
    await probe(); if (healthFailure) throw healthFailure
    // Repeated common terms remain a permitted query and force substantial native
    // SQLite work even on a warm synthetic corpus. Health retains its 2s budget.
    const slowUrl = base + '/api/entries?kind=all&id=all&unread=0&q=' + encodeURIComponent('the '.repeat(64))
    let searching = true, writes = 0
    const slowStart = performance.now()
    console.log('Starting expensive search with concurrent status and state writes.')
    const slowSearch = fetch(slowUrl, { signal: AbortSignal.timeout(60_000) }).then(async response => {
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.items.length, 80); assert(result.continuation)
      return result
    }).finally(() => { searching = false })
    // Attach immediately so a failing concurrent probe cannot leave a rejection.
    void slowSearch.catch(() => {})
    while (searching) {
      if (healthFailure) throw healthFailure
      const status = await fetch(base + '/api/status', { signal: AbortSignal.timeout(latencyBudget) })
      assert.equal(status.status, 200); await status.json()
      const write = await fetch(base + '/api/entries/state', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, signal: AbortSignal.timeout(latencyBudget),
        body: JSON.stringify({ ids: ['synthetic-1001'], operation: writes % 2 ? 'unstar' : 'star', expectedRevisions: { 'synthetic-1001': writes } }),
      })
      assert.equal(write.status, 200)
      assert.equal((await write.json()).revisions['synthetic-1001'], ++writes)
      await delay(100)
    }
    await slowSearch
    const slowMs = performance.now() - slowStart
    console.log(`Expensive search ${slowMs.toFixed(0)}ms; ${writes} writes; max health ${maxLatency.toFixed(0)}ms.`)
    assert(slowMs > 5000, `expected >5s of real search work, got ${slowMs.toFixed(0)}ms`)
    assert(writes >= 3, 'state writes must complete while search is running')
    // Disconnect an active search, then prove queued work resumes after the old
    // native call exits. Ordinary GET completion must never cancel a search.
    const controller = new AbortController()
    const cancelled = fetch(slowUrl, { signal: controller.signal }).catch(error => error)
    await delay(200)
    const waitingControllers = Array.from({ length: 8 }, () => new AbortController())
    const waiting = waitingControllers.map(controller => fetch(base + '/api/entries?kind=all&id=all&q=definitelymissing', { signal: controller.signal }).catch(error => error))
    await delay(200)
    const saturated = await fetch(base + '/api/entries?kind=all&id=all&q=the', { signal: AbortSignal.timeout(latencyBudget) })
    assert.equal(saturated.status, 503); assert.match((await saturated.json()).error, /busy/)
    waitingControllers.forEach(controller => controller.abort()); await Promise.all(waiting)
    await delay(100)
    const queued = fetch(base + '/api/entries?kind=all&id=all&unread=0&q=the', { signal: AbortSignal.timeout(60_000) })
    controller.abort(); await cancelled
    const resumed = await queued
    assert.equal(resumed.status, 200); assert.equal((await resumed.json()).items.length, 80)
    await probe(); if (healthFailure) throw healthFailure
    assert.equal(check.prepare('SELECT COUNT(*) n FROM entries').get().n, count)
    assert.equal(check.prepare("SELECT COUNT(*) n FROM entries WHERE content_text LIKE '%collectionneedle%'").get().n, updatedCount)
    assert.equal(check.prepare("SELECT COUNT(*) n FROM entries_fts WHERE entries_fts MATCH 'collectionneedle'").get().n, updatedCount)
    assert.deepEqual({ ...check.prepare('SELECT read, starred, state_revision FROM entries WHERE id=?').get('synthetic-0') }, { read: 1, starred: 1, state_revision: 3 })
    assert.equal(check.prepare('SELECT position FROM reading_progress WHERE entry_id=?').get('synthetic-0').position, 0.42)
    assert.equal(check.prepare('SELECT COUNT(*) n FROM article_aliases WHERE subscription_id=?').get(feeds[0]).n, updatedCount)
    assert.equal(check.prepare("SELECT COUNT(*) n FROM backend_checkpoints WHERE key LIKE 'feed-ingestion:%'").get().n, 1)
    assert(check.prepare('SELECT lease_token FROM feed_fetch_state WHERE subscription_id=?').get(feeds[0]).lease_token === '')
    assert(probes >= 2)
    console.log(`Collection responsiveness passed: ${count} articles, ${feedCount} feeds, ${updatedCount} changed items; ${probes} health probes, max ${maxLatency.toFixed(0)}ms; common-term search ${searchMs.toFixed(0)}ms, expensive search ${slowMs.toFixed(0)}ms with ${writes} concurrent CAS writes; identity/state/checkpoint/search retained.`)
    // Stop with native work active. The parent must retain the storage lock until
    // the reader thread exits, even though the HTTP request is rejected promptly.
    const shuttingSearch = fetch(slowUrl).catch(error => error)
    await delay(200)
    probeRunning = false; await probeLoop
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const shutdownResponse = await shuttingSearch
    assert.equal(shutdownResponse.status, 503); await shutdownResponse.json()
    assert.throws(() => acquireStateLock(state, 'exclusive'), /in use/)
    const [code] = await exited
    assert.equal(code, 0)
    const exclusive = acquireStateLock(state, 'exclusive'); exclusive.release()
    console.log('Search disconnect, queued recovery and shutdown lock lifetime passed.')
    // Test the real shutdown callback without waiting 30s per case. The preload
    // changes only its timer; production has no test hook or configurable bound.
    for (const failStop of [false, true]) {
      const preload = path.join(temporary, `deadline-${failStop}.mjs`)
      await fs.writeFile(preload, `
        import { syncBuiltinESMExports } from 'node:module';
        import timers from 'node:timers';
        ${failStop ? `import { StandaloneRuntime } from ${JSON.stringify(pathToFileURL(path.join(build, 'standalone-runtime.js')).href)};
          StandaloneRuntime.prototype.stop = async () => { throw new Error('synthetic shutdown detail must not be logged') };` : ''}
        const original = timers.setTimeout;
        timers.setTimeout = globalThis.setTimeout = (callback, ms, ...args) => {
          if (ms === 30000 && String(callback).includes('SIGKILL')) {
            process.stdout.write('Synthetic deadline armed\\n');
            return original(callback, 300, ...args);
          }
          return original(callback, ms, ...args);
        };
        syncBuiltinESMExports();
      `)
      logs = ''
      startServer(['--import', pathToFileURL(preload).href])
      await until(async () => { try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } })
      // Warm the real worker before starting a long native call.
      const warm = await fetch(base + '/api/entries?kind=all&id=all&unread=0&q=the')
      assert.equal(warm.status, 200); await warm.json()
      const running = fetch(slowUrl).catch(error => error)
      await delay(200)
      const killed = once(child, 'exit')
      const forcedAt = performance.now()
      child.kill('SIGTERM')
      await until(() => logs.includes('Synthetic deadline armed'), 2000)
      assert.throws(() => acquireStateLock(state, 'exclusive'), /in use/)
      const [code, signal] = await killed
      assert.equal(code, null); assert.equal(signal, 'SIGKILL')
      assert(performance.now() - forcedAt < 2000, 'shutdown deadline was blocked by a native worker')
      await running
      const unlocked = acquireStateLock(state, 'exclusive'); unlocked.release()
      const recovered = new PaperDatabase(file)
      try { assert.equal(recovered.entryState('synthetic-1001').revision, writes) }
      finally { recovered.close() }
      assert.equal(logs.includes('synthetic shutdown detail'), false)
      if (failStop) assert(logs.includes('Paper could not finish shutdown; waiting for forced termination.'))
      console.log(`Forced shutdown ${failStop ? 'after stop failure' : 'with native work'} passed; lock released after SIGKILL.`)
    }

  } finally { check.close() }
} catch (error) { console.error(logs); throw error }
finally {
  probeRunning = false; released = true
  await probeLoop; await stop()
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true })
}
