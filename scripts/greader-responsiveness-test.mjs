import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDatabase } from '../dist-server/db.js'
import { acquireStateLock } from '../dist-server/state-lock.js'
import { GreaderAuth } from '../dist-server/greader-auth.js'
import { where, scanPageFrom } from '../dist-server/greader-query.js'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-greader-scale-'))
const file = path.join(temporary, 'paper.sqlite'), count = 200000, feedCount = 1266
let child, probeLoop, stop = false, maxHealth = 0, peakRss = 0, failure, pages = [], bulkMs = 0
try {
  const db = new PaperDatabase(file), backend = db.bindStandalone()
  const feeds = Array.from({ length: feedCount }, (_, i) => db.saveLocalSubscription(backend.id, { title: `Synthetic ${i}`, url: `https://example.test/${i}` }))
  const sql = db.greaderDatabase
  const body = '<p>' + 'Synthetic body text for the reader performance regression. '.repeat(64) + '</p>'
  db.transaction(() => {
    const insert = sql.prepare(`INSERT INTO entries(id, feed_id, feed_title, feed_url, title, author, url, canonical_url, source_domain, content_html, content_text, excerpt, published_at, timestamp, first_seen_at, reading_minutes, thumbnail_url, kind, synced_at, starred)
      VALUES (?, ?, 'Synthetic', 'https://example.test', 'Synthetic article', '', 'https://example.test/article', '', 'example.test', ?, ?, '', '', ?, ?, 1, '', 'article', '', ?)`)
    const identity = sql.prepare('INSERT INTO article_identities VALUES (?, ?, ?)')
    for (let i = 0; i < count; i++) { const id = `synthetic-${i}`; identity.run(id, backend.id, feeds[i % feedCount]); insert.run(id, feeds[i % feedCount], body, body, Date.now(), Date.now(), Number(i % 2 === 0)) }
    for (const title of ['First', 'Second']) {
      const snapshot = db.organization.snapshot(backend.id)
      const result = db.organization.apply(backend.id, snapshot.revision, [{ type: 'create-folder', title }])
      const folder = result.results[0].id
      db.organization.apply(backend.id, result.revision, feeds.slice(0, 100).map(feedId => ({ type: 'add-membership', feedId, folderId: folder })))
    }
  })
  const password = (await db.auth.createApp('Synthetic scale', null)).password
  const auth = new GreaderAuth(sql, db.auth, true, 'http://localhost'); auth.configure(true, 'synthetic')
  sql.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close()
  child = spawn(process.execPath, ['dist-server/index.js'], { env: { PATH: process.env.PATH, HOME: temporary, STATE_DIR: temporary, PAPER_BACKEND: 'standalone', PORT: '0', HOST: '127.0.0.1', PUBLIC_URL: 'http://localhost', PAPER_SYNC_ENABLED: 'false', PAPER_AI_PROVIDER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; child.stdout.on('data', data => { logs = (logs + data).slice(-5000) }); child.stderr.on('data', () => {})
  let port
  for (let i = 0; i < 400; i++) { port = /Paper is listening on port (\d+)/.exec(logs)?.[1]; if (port) break; await delay(25) }
  assert(port, 'server did not start')
  const base = `http://127.0.0.1:${port}`, root = `${base}/api/greader.php`
  probeLoop = (async () => {
    while (!stop) {
      const started = performance.now(), res = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) }); assert.equal(res.status, 200); await res.text()
      maxHealth = Math.max(maxHealth, performance.now() - started)
      try {
        const pids = [child.pid, ...(await fs.readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)]
        let rss = 0
        for (const pid of pids) { try { rss += Number(/VmRSS:\s+(\d+)/.exec(await fs.readFile(`/proc/${pid}/status`, 'utf8'))?.[1] || 0) } catch {} }
        peakRss = Math.max(peakRss, rss * 1024)
      } catch {}
      await delay(30)
    }
  })().catch(error => { failure = new Error('Health probe failed', { cause: error }) })
  const login = await fetch(root + '/accounts/ClientLogin', { method: 'POST', body: new URLSearchParams({ Email: 'synthetic', Passwd: password }) })
  assert.equal(login.status, 200); const bearer = /Auth=(.+)/.exec(await login.text())[1]
  const headers = { Authorization: `GoogleLogin auth=${bearer}` }
  async function call(endpoint, fields = [], method = 'GET') {
    for (;;) {
      const p = new URLSearchParams(fields), start = performance.now()
      const response = await fetch(root + '/reader/api/0/' + endpoint + (method === 'GET' ? '?' + p : ''), { method, headers, body: method === 'POST' ? p : undefined, signal: AbortSignal.timeout(17000) })
      const text = await response.text()
      if (response.status === 429) { await delay(1000); continue }
      assert.equal(response.status, 200, `${endpoint}: ${text}`)
      if (failure) throw failure
      return { text, ms: performance.now() - start }
    }
  }
  const token = (await call('token')).text.trim()
  console.log('Seeded 200000 articles; starting full pagination.')
  let cursor, seen = 0, previous = BigInt(count + 1)
  do {
    const response = await call('stream/items/ids', [['s', 'user/-/state/com.google/reading-list'], ['xt', 'user/-/state/com.google/read'], ['n', '10000'], ...(cursor ? [['c', cursor]] : [])])
    pages.push(response.ms); const data = JSON.parse(response.text); for (const ref of data.itemRefs) { const id = BigInt(ref.id); assert(id < previous, 'ID pages must advance without duplicates'); previous = id }; seen += data.itemRefs.length; if (seen % 50000 === 0) console.log(`Paged ${seen} IDs`); cursor = data.continuation
  } while (cursor)
  assert.equal(seen, count); assert.equal(previous, 1n)
  const content = Array.from({ length: 250 }, (_, i) => ['i', String(i + 1)])
  const downloads = await Promise.all(Array.from({ length: 8 }, () => call('stream/items/contents', content, 'POST')))
  downloads.forEach(result => assert.equal(JSON.parse(result.text).items.length, 250))
  console.log(`Eight content downloads: ${Math.round(Math.max(...downloads.map(d => d.ms)))}ms max`)
  const counts = await call('unread-count'); assert.equal(JSON.parse(counts.text).max, count)
  console.log(`Counts: ${Math.round(counts.ms)}ms`)
  let writing = true, writes = 0
  const web = (async () => { while (writing) { const response = await fetch(base + '/api/entries/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['synthetic-1'], operation: 'star' }) }); await response.text(); assert([200,503].includes(response.status), `web write returned ${response.status}`); writes++; await delay(100) } })()
  try { bulkMs = (await call('mark-all-as-read', [['s', 'user/-/state/com.google/reading-list'], ['T', token]], 'POST')).ms } finally { writing = false; await web }
  console.log(`Bulk mark-read: ${Math.round(bulkMs)}ms`)
  assert(bulkMs < 15000); assert(writes > 0)
  const finalWrite = await fetch(base + '/api/entries/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['synthetic-1'], operation: 'star' }) }); assert.equal(finalWrite.status, 200); await finalWrite.text()
  await call('edit-tag', [['i','2'],['i','3'],['r','user/-/state/com.google/read'],['T',token]], 'POST')
  const check = new PaperDatabase(file, { readOnly: true })
  assert.equal(check.entryState('synthetic-1').starred, true)
  for (const stream of ['unread', 'starred']) {
    const q = { backend: backend.id, stream: { kind: 'state', id: stream }, it: [], xt: [], ot: 0, nt: 0, order: 'DESC', n: 250 }
    const filter = where(q), scan = scanPageFrom(check.greaderDatabase,q)
    console.log(`${stream} plan:`, check.greaderDatabase.prepare(`EXPLAIN QUERY PLAN SELECT a.sequence ${scan.from} WHERE ${filter.sql}${scan.extra} ORDER BY a.sequence DESC LIMIT 251`).all(...filter.args).map(row => row.detail).join('; '))
    const result = JSON.parse((await call('stream/items/ids', [['s', `user/-/state/com.google/${stream}`], ['n', '250']])).text)
    assert.equal(result.itemRefs.length, stream === 'unread' ? 2 : 250)
  }
  const dated = { backend: backend.id, stream: { kind: 'state', id: 'reading-list' }, it: [], xt: [], ot: Math.floor(Date.now()/1000), nt: 0, order: 'DESC', n: 250 }
  const datedFilter = where(dated), datedScan = scanPageFrom(check.greaderDatabase,dated)
  console.log('date plan:', check.greaderDatabase.prepare(`EXPLAIN QUERY PLAN SELECT a.sequence ${datedScan.from} WHERE ${datedFilter.sql} ORDER BY a.sequence DESC LIMIT 251`).all(...datedFilter.args).map(row => row.detail).join('; '))
  check.close()
  const controllers = Array.from({length:8}, () => new AbortController())
  const cancelled = controllers.map(controller => fetch(root + '/reader/api/0/stream/items/contents', { method: 'POST', headers, body: new URLSearchParams(content), signal: controller.signal }).then(response => response.text()).catch(() => {}))
  await delay(10); controllers.forEach(controller => controller.abort()); await Promise.all(cancelled)
  stop = true; await probeLoop
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
  const lock = acquireStateLock(temporary, 'exclusive'); lock.release()
  assert(maxHealth < 2000); assert(peakRss < 1024 * 1024 * 1024, 'process RSS exceeded 1 GiB')
  console.log(JSON.stringify({ articles: count, feeds: feedCount, pages: pages.length, healthMaxMs: Math.round(maxHealth), pageMaxMs: Math.round(Math.max(...pages)), pageMeanMs: Math.round(pages.reduce((a,b)=>a+b,0)/pages.length), contentMaxMs: Math.round(Math.max(...downloads.map(d=>d.ms))), countsMs: Math.round(counts.ms), bulkMs: Math.round(bulkMs), peakRssMiB: Math.round(peakRss/1024/1024), concurrentWebRequests: writes }))
} finally {
  stop = true; await probeLoop
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  await fs.rm(temporary, { recursive: true, force: true })
}
