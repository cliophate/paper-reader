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

const build = path.resolve(process.env.PAPER_TEST_BUILD_DIR || 'dist-server')
const { PaperDatabase } = await import(pathToFileURL(path.join(build, 'db.js')))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-retention-scale-'))
const state = path.join(temporary, 'data'), file = path.join(state, 'paper.sqlite')
const count = 200_000, removed = 100_000, budget = 2000
let child, logs = '', probing = true, probeLoop, probeError, probes = 0, maxLatency = 0
async function until(check, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (probeError) throw probeError
    const result = await check(); if (result) return result
    await delay(25)
  }
  throw Error('Timed out waiting for retention')
}
try {
  const db = new PaperDatabase(file), backend = db.bindStandalone()
  const feed = db.saveLocalSubscription(backend.id, { url: 'https://example.test/retention.xml', title: 'Synthetic retention' })
  db.close()
  const sql = new DatabaseSync(file)
  sql.exec('PRAGMA foreign_keys = ON; BEGIN')
  const now = Date.now(), old = now - 200 * 86_400_000
  const identity = sql.prepare('INSERT INTO article_identities VALUES (?, ?, ?)')
  const alias = sql.prepare('INSERT INTO article_aliases VALUES (?, ?, ?, ?)')
  const entry = sql.prepare(`INSERT INTO entries(id, feed_id, feed_title, feed_url, title, author, url, canonical_url,
    source_domain, content_html, content_text, excerpt, published_at, timestamp, first_seen_at, read,
    reading_minutes, thumbnail_url, kind, synced_at)
    VALUES (?, ?, 'Retention', '', 'Synthetic retentionneedle', '', ?, ?, 'example.test',
    '<p>Synthetic retentionneedle</p>', 'Synthetic retentionneedle', '', '', ?, ?, 0, 1, '', 'article', '')`)
  for (let i = 0; i < count; i++) {
    const id = `retention-${i}`, url = `https://example.test/${i}`
    identity.run(id, backend.id, feed); alias.run(backend.id, feed, `guid-${i}`, id)
    entry.run(id, feed, url, url, old, i < removed ? old : now)
  }
  sql.prepare('INSERT INTO retention_feeds VALUES (?, ?)').run(feed, now)
  // Reject any batch that deletes more than the documented bound.
  sql.exec(`CREATE TRIGGER retention_test_bound BEFORE UPDATE OF deleted ON retention_runs
    WHEN new.deleted - old.deleted > 100 BEGIN SELECT RAISE(ABORT, 'unbounded retention batch'); END;
    COMMIT; PRAGMA wal_checkpoint(TRUNCATE)`)
  sql.close()
  const listener = http.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [path.join(build, 'index.js')], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: temporary, NODE_NO_WARNINGS: '1', STATE_DIR: state,
    PAPER_BACKEND: 'standalone', PAPER_SYNC_ENABLED: 'false', HOST: '127.0.0.1', PORT: String(port), PUBLIC_URL: base, CODEX_ENABLED: 'false',
  } })
  child.stdout.on('data', data => { logs = (logs + data).slice(-4000) })
  child.stderr.on('data', data => { logs = (logs + data).slice(-4000) })
  await until(async () => { try { return (await fetch(base + '/health')).ok } catch { return false } })
  probeLoop = (async () => {
    while (probing) {
      const start = performance.now()
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(budget) })
      assert.equal(response.status, 200); await response.text()
      maxLatency = Math.max(maxLatency, performance.now() - start); probes++
      assert(maxLatency < budget, `Health blocked for ${maxLatency.toFixed(0)}ms`)
      await delay(25)
    }
  })().catch(error => { probeError = error })
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const policy = { autoReadDays: 60, folderDays: {}, feedDays: {}, readDays: 60, unreadDays: null, cacheDays: null }
  const eventAbort = new AbortController()
  const events = await fetch(base + '/api/events', { signal: eventAbort.signal })
  let invalidations = 0, eventError
  const eventLoop = (async () => {
    let pending = ''
    for await (const bytes of events.body) {
      pending += new TextDecoder().decode(bytes)
      let end
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const event = pending.slice(0, end); pending = pending.slice(end + 2)
        if (event.startsWith('event: state\n')) {
          assert.equal(event, 'event: state\ndata: null')
          invalidations++
        }
      }
    }
  })().catch(error => { if (!eventAbort.signal.aborted) eventError = error })
  const started = performance.now()
  const preview = await post('/api/retention/preview', { policy })
  assert.equal(preview.deleted, removed); assert.equal(preview.marked, removed)
  await post('/api/retention', { policy, revision: 0, token: preview.token })
  const result = await until(async () => {
    const view = await (await fetch(base + '/api/retention')).json()
    assert.equal(view.error, '')
    return view.lastRun?.finishedAt ? view.lastRun : null
  })
  assert.equal(result.marked, removed); assert.equal(result.deleted, removed); assert(result.batches >= count / 100)
  await until(() => { if (eventError) throw eventError; return invalidations === removed / 100 })
  eventAbort.abort(); await eventLoop
  const gone = await fetch(base + '/api/entries/number/1')
  assert.equal(gone.status, 410)
  const removal = await gone.json()
  assert.equal(removal.code, 'removed_by_retention')
  assert.equal(removal.removal.sequence, 1)
  assert.equal(removal.removal.feedId, feed)
  assert.equal(removal.error, `This article was removed by your retention settings on ${new Date(removal.removal.removedAt).toISOString().slice(0, 10)}.`)
  assert.equal((await fetch(base + `/api/entries/number/${count}`)).status, 200)
  assert.equal((await fetch(base + `/api/entries/number/${count + 1}`)).status, 404)
  const check = new DatabaseSync(file, { readOnly: true })
  try {
    for (const table of ['entries', 'entry_search_rows', 'entries_fts', 'article_arrivals', 'retention_tombstones', 'retention_removals']) {
      assert.equal(check.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, removed, table)
    }
    assert.equal(check.prepare("SELECT COUNT(*) n FROM entries_fts WHERE entries_fts MATCH 'retentionneedle'").get().n, removed)
    assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { check.close() }
  const backupPath = file + '.before-retention-first-delete'
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600)
  const backup = new DatabaseSync(backupPath, { readOnly: true })
  try { assert.equal(backup.prepare('SELECT COUNT(*) n FROM entries').get().n, count) } finally { backup.close() }
  assert(probes >= 10)
  probing = false; await probeLoop; if (probeError) throw probeError
  console.log(`Retention responsiveness passed: ${removed}/${count} deleted in ${result.batches} bounded batches; preview, backup and cleanup ${(performance.now() - started).toFixed(0)}ms; ${probes} health probes, max ${maxLatency.toFixed(0)}ms.`)
} catch (error) { console.error(logs); throw error }
finally {
  probing = false; await probeLoop
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 31_000)
    await exited; clearTimeout(force)
  }
  await fs.rm(temporary, { recursive: true, force: true })
}
