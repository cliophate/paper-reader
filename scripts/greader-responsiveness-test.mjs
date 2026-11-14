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

const diskRoot = process.env.PAPER_PERF_DIR || os.homedir()
assert.notEqual(Number((await fs.statfs(diskRoot)).type), 0x01021994, 'PAPER_PERF_DIR must be disk-backed, not tmpfs')
const temporary = await fs.mkdtemp(path.join(diskRoot, 'paper-greader-scale-'))
console.log(`Disk fixture: ${temporary}`)
const file = path.join(temporary, 'paper.sqlite'), largeFeedCount = 200000, count = largeFeedCount + 20000, feedCount = 1266
let child, probeLoop, stop = false, maxHealth = 0, peakRss = 0, failure, pages = []
try {
  const db = new PaperDatabase(file), backend = db.bindStandalone()
  const feeds = Array.from({ length: feedCount }, (_, i) => db.saveLocalSubscription(backend.id, { title: `Synthetic ${i}`, url: `https://example.test/${i}` }))
  const sql = db.greaderDatabase
  const body = '<p>' + 'Synthetic body text for the reader performance regression. '.repeat(68) + '</p>'
  db.transaction(() => {
    const insert = sql.prepare(`INSERT INTO entries(id, feed_id, feed_title, feed_url, title, author, url, canonical_url, source_domain, content_html, content_text, excerpt, published_at, timestamp, first_seen_at, reading_minutes, thumbnail_url, kind, synced_at, starred)
      VALUES (?, ?, 'Synthetic', 'https://example.test', 'Synthetic article', '', 'https://example.test/article', '', 'example.test', ?, ?, '', '', ?, ?, 1, '', 'article', '', ?)`)
    const identity = sql.prepare('INSERT INTO article_identities VALUES (?, ?, ?)')
    for (let i = 0; i < count; i++) { const id = `synthetic-${i}`, feed = feeds[i < largeFeedCount ? 0 : i < largeFeedCount + 10000 ? 1 : 2 + i % (feedCount - 2)]; identity.run(id, backend.id, feed); insert.run(id, feed, body, body, 1000000, 1000000, Number(i % 2 === 0)) }
    for (const title of ['First', 'Second']) {
      const snapshot = db.organization.metadata(backend.id)
      const result = db.organization.apply(backend.id, snapshot.revision, [{ type: 'create-folder', title }])
      const folder = result.results[0].id
      const member = sql.prepare('INSERT INTO feed_folders(feed_id, folder_id) VALUES (?, ?)')
      for (const feed of feeds) member.run(feed, folder)
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
    const p = new URLSearchParams(fields), start = performance.now()
    const response = await fetch(root + '/reader/api/0/' + endpoint + (method === 'GET' ? '?' + p : ''), { method, headers, body: method === 'POST' ? p : undefined, signal: AbortSignal.timeout(17000) })
    const text = await response.text()
    assert.equal(response.status, 200, `${endpoint}: ${text}`)
    if (failure) throw failure
    return { text, ms: performance.now() - start }
  }
  const token = (await call('token')).text.trim()
  console.log(`Seeded ${count} articles, ${largeFeedCount} in one feed; starting full pagination.`)
  let writing = true, writes = 0
  const web = (async () => { while (writing) { const response = await fetch(base + '/api/entries/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['synthetic-1'], operation: 'star' }) }); await response.text(); assert([200,503].includes(response.status), `web write returned ${response.status}`); writes++; await delay(100) } })().catch(error => { failure = error })
  const syncStarted = performance.now()
  let cursor, seen = 0, previous = BigInt(count + 1)
  do {
    const response = await call('stream/items/ids', [['s', 'user/-/state/com.google/reading-list'], ['xt', 'user/-/state/com.google/read'], ['n', '10000'], ...(cursor ? [['c', cursor]] : [])])
    pages.push(response.ms); const data = JSON.parse(response.text); for (const ref of data.itemRefs) { const id = BigInt(ref.id); assert(id < previous, 'ID pages must advance without duplicates'); previous = id }; seen += data.itemRefs.length; if (seen % 50000 === 0) console.log(`Paged ${seen} IDs`); cursor = data.continuation
  } while (cursor)
  assert(pages.length >= 200); assert.equal(seen, count); assert.equal(previous, 1n)
  const content = Array.from({ length: 250 }, (_, i) => ['i', String(i + 1)])
  const downloads = await Promise.all(Array.from({ length: 8 }, () => call('stream/items/contents', content, 'POST')))
  downloads.forEach(result => assert.equal(JSON.parse(result.text).items.length, 250))
  console.log(`Eight content downloads: ${Math.round(Math.max(...downloads.map(d => d.ms)))}ms max`)
  const counts = await call('unread-count'); assert.equal(JSON.parse(counts.text).max, count)
  console.log(`Counts: ${Math.round(counts.ms)}ms`)
  const syncMs = performance.now() - syncStarted
  writing = false; await web
  assert(writes > 0)
  const explicitWrite = await call('edit-tag', [...Array.from({ length: 1000 }, (_, i) => ['i', String(i + 1)]), ['a', 'user/-/state/com.google/starred'], ['T', token]], 'POST')
  console.log(`Explicit state write: ${Math.round(explicitWrite.ms)}ms`)
  const subscriptions = JSON.parse((await call('subscription/list')).text).subscriptions
  const stream = subscriptions.find(feed => feed.url === 'https://example.test/0').id
  const orgTimings = []
  async function measure(api, operation, action) {
    let done = false, health = 0, probes = 0
    console.log(`Measuring ${api} ${operation}`)
    const probing = (async () => {
      do {
        const start = performance.now()
        const response = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) })
        assert.equal(response.status, 200); await response.text()
        health = Math.max(health, performance.now() - start); probes++
        await delay(5)
      } while (!done)
    })().catch(error => { failure = new Error(`${api} ${operation} health probe failed`, { cause: error }) })
    const start = performance.now()
    try { await action() } finally { done = true; await probing }
    const result = { api, operation, ms: Math.round(performance.now() - start), healthMaxMs: Math.round(health), probes }
    assert(health < 2000); if (failure) throw failure
    orgTimings.push(result); console.log(JSON.stringify(result))
  }
  const readerWrite = (endpoint, fields) => call(endpoint, [...Object.entries(fields), ['T', token]], 'POST')
  async function webRequest(endpoint, method, body) {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(17000) })
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data
  }
  console.log('Loading web organization snapshot')
  let snapshot = await webRequest('/api/organization', 'GET')
  console.log('Loaded web organization snapshot')
  const folderId = title => snapshot.navigation.folders.find(folder => folder.title === title).id
  async function command(value) {
    const result = await webRequest('/api/organization/commands', 'POST', { expectedRevision: snapshot.revision, commands: [value] })
    assert.equal(result.results[0].status, 'applied'); assert.equal(result.results[0].changed, true)
    assert(result.snapshot, result.refreshError); snapshot = result.snapshot
  }
  await measure('web', 'feed rename', () => command({ type: 'rename-feed', feedId: feeds[0], title: 'Web renamed' }))
  await measure('web', 'folder rename', () => command({ type: 'rename-folder', folderId: folderId('First'), title: 'Web folder' }))
  await measure('web', 'move', () => command({ type: 'move-feed', feedId: feeds[0], fromFolderId: folderId('Web folder'), toFolderId: null }))
  await measure('web', 'folder delete', () => command({ type: 'remove-folder', folderId: folderId('Second') }))
  await measure('web', 'unsubscribe', () => command({ type: 'unsubscribe', feedId: feeds[0] }))
  await readerWrite('subscription/edit', { s: stream, ac: 'subscribe', a: 'user/-/label/Web folder' })
  await measure('greader', 'feed rename', () => readerWrite('subscription/edit', { s: stream, ac: 'edit', t: 'Reader renamed' }))
  await measure('greader', 'folder rename', () => readerWrite('rename-tag', { s: 'user/-/label/Web folder', dest: 'user/-/label/Reader folder' }))
  await measure('greader', 'move', () => readerWrite('subscription/edit', { s: stream, ac: 'edit', r: 'user/-/label/Reader folder', a: 'user/-/label/Destination' }))
  // Put the large history back before deleting the large folder.
  await readerWrite('subscription/edit', { s: stream, ac: 'edit', a: 'user/-/label/Reader folder' })
  await measure('greader', 'folder delete', () => readerWrite('disable-tag', { s: 'user/-/label/Reader folder' }))
  await measure('greader', 'unsubscribe', () => readerWrite('subscription/edit', { s: stream, ac: 'unsubscribe' }))
  await readerWrite('subscription/edit', { s: stream, ac: 'subscribe' })
  await measure('web legacy', 'feed rename', () => webRequest('/api/feeds', 'PATCH', { id: feeds[0], title: 'Legacy renamed', currentFolder: '', folder: '' }))
  await measure('web legacy', 'move', () => webRequest('/api/feeds', 'PATCH', { id: feeds[0], title: 'Legacy renamed', currentFolder: '', folder: 'Legacy folder' }))
  await measure('web legacy', 'unsubscribe', () => webRequest('/api/feeds', 'DELETE', { id: feeds[0] }))
  await readerWrite('subscription/edit', { s: stream, ac: 'subscribe' })
  const deferred = await fetch(root + '/reader/api/0/mark-all-as-read', { method: 'POST', headers, body: new URLSearchParams({ s: 'user/-/state/com.google/reading-list', T: token }) })
  assert.equal(deferred.status, 404); assert.deepEqual(await deferred.json(), { errors: ['Not found.'] })
  // Prepare sparse state in a separate fixture process. This is not an API endpoint.
  const prepare = spawn(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=5000; UPDATE entries SET read=1; UPDATE entries SET read=0 WHERE rowid IN (2,3)'); db.close()`, file], { env: {}, stdio: 'ignore' })
  assert.equal((await once(prepare, 'exit'))[0], 0)
  const check = new PaperDatabase(file, { readOnly: true })
  assert.equal(check.entryState('synthetic-1').starred, true)
  for (const stream of ['unread', 'starred']) {
    const q = { backend: backend.id, stream: { kind: 'state', id: stream }, it: [], xt: [], ot: 0, nt: 0, order: 'DESC', n: 250 }
    const filter = where(q), scan = scanPageFrom(check.greaderDatabase,q)
    console.log(`${stream} plan:`, check.greaderDatabase.prepare(`EXPLAIN QUERY PLAN SELECT a.sequence ${scan.from} WHERE ${filter.sql}${scan.extra} ORDER BY a.sequence DESC LIMIT 251`).all(...filter.args).map(row => row.detail).join('; '))
    const result = JSON.parse((await call('stream/items/ids', [['s', `user/-/state/com.google/${stream}`], ['n', '250']])).text)
    assert.equal(result.itemRefs.length, stream === 'unread' ? 2 : 250)
  }
  const dated = { backend: backend.id, stream: { kind: 'state', id: 'reading-list' }, it: [], xt: [], ot: Math.ceil(Date.now()/1000) + 60, nt: 0, order: 'DESC', n: 250 }
  const datedFilter = where(dated), datedScan = scanPageFrom(check.greaderDatabase,dated)
  const datePlan = check.greaderDatabase.prepare(`EXPLAIN QUERY PLAN SELECT a.sequence ${datedScan.from} WHERE ${datedFilter.sql}${datedScan.extra} ORDER BY a.sequence DESC LIMIT 251`).all(...datedFilter.args).map(row => row.detail).join('; ')
  console.log('sparse date plan:', datePlan)
  for (const index of ['greader_arrived', 'greader_modified', 'greader_feed_modified', 'greader_feed_items']) assert(datePlan.includes(index), datePlan)
  assert(!/SCAN (e|a)\b/.test(datePlan), datePlan)
  check.close()
  const controllers = Array.from({length:8}, () => new AbortController())
  const cancelled = controllers.map(controller => fetch(root + '/reader/api/0/stream/items/contents', { method: 'POST', headers, body: new URLSearchParams(content), signal: controller.signal }).then(response => response.text()).catch(() => {}))
  await delay(10); controllers.forEach(controller => controller.abort()); await Promise.all(cancelled)
  stop = true; await probeLoop
  if (failure) throw failure
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
  const lock = acquireStateLock(temporary, 'exclusive'); lock.release()
  assert(maxHealth < 2000); assert(peakRss < 1024 * 1024 * 1024, 'process RSS exceeded 1 GiB')
  console.log(JSON.stringify({ articles: count, articlesInLargestFeed: largeFeedCount, feeds: feedCount, pages: pages.length, syncMs: Math.round(syncMs), organization: orgTimings, healthMaxMs: Math.round(maxHealth), pageMaxMs: Math.round(Math.max(...pages)), pageMeanMs: Math.round(pages.reduce((a,b)=>a+b,0)/pages.length), contentMaxMs: Math.round(Math.max(...downloads.map(d=>d.ms))), countsMs: Math.round(counts.ms), explicitWriteMs: Math.round(explicitWrite.ms), peakRssMiB: Math.round(peakRss/1024/1024), concurrentWebRequests: writes }))
} finally {
  stop = true; await probeLoop
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  await fs.rm(temporary, { recursive: true, force: true })
}
