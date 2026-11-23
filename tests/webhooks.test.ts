import { DATABASE_VERSION } from '../src/server/auth-schema.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { ingestFeed } from '../src/server/feed-ingestion'
import { Webhooks, webhookSignature } from '../src/server/webhooks'
import { deliveryLeaseMs, maxAttempts, queueLimits, retryDelay, retryWindowMs, transportTimeoutMs, WEBHOOK_SCHEMA_VERSION } from '../src/server/webhook-store'

let dir: string, db: PaperDatabase, hooks: Webhooks, feed: string, backend: string, origin: string
let server: http.Server
let status = 204
const requests: { headers: http.IncomingHttpHeaders; body: string; path: string }[] = []
function ingest(...titles: string[]) {
  return ingestFrom(feed, titles)
}
function ingestFrom(subscriptionId: string, titles: string[]) {
  return ingestFeed(db, { backendId: backend, subscriptionId, endpointGeneration: 'test',
    requestUrl: 'https://example.test/feed', responseUrl: 'https://example.test/feed', fetchedAt: new Date().toISOString(),
    xml: '<rss version="2.0"><channel><title>Fixture</title>' + titles.map((t, i) =>
      `<item><guid>${i}</guid><title>${t}</title><link>https://example.test/articles/${i}</link></item>`).join('') + '</channel></rss>' })
}
beforeEach(async () => {
  requests.length = 0; status = 204
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-webhooks-'))
  db = new PaperDatabase(path.join(dir, 'paper.sqlite')); backend = db.bindStandalone().id
  feed = db.saveLocalSubscription(backend, { title: 'Fixture', url: 'https://example.test/feed' })
  server = http.createServer(async (req, res) => {
    const parts = []
    for await (const chunk of req) parts.push(chunk)
    requests.push({ headers: req.headers, body: Buffer.concat(parts).toString(), path: req.url! })
    if (req.url === '/hang') return
    if (req.url === '/redirect') res.setHeader('Location', origin.replace('127.0.0.1', 'localhost') + '/other')
    res.writeHead(status); res.end('Synthetic private response')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  hooks = new Webhooks(db.webhooks, dir, [origin], async () => db.localNavigation())
})
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await hooks.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true })
})
function create(patch = {}) {
  return hooks.create({ kind: 'webhook', name: 'Fixture', url: origin + '/receive',
    events: ['new_entries', 'starred_entry', 'save_entry'], ...patch })
}

it('matches the timestamped raw UTF-8 signature vector', () => {
  expect(webhookSignature('synthetic-vector', '1700000000', '{"title":"café"}')).toBe('32dba411aae55108b84baff394ed725c2383b2c5b740d343d59b303aab376d03')
})

it('batches only arrivals, records star transitions and honors feed and folder scope', async () => {
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [{ type: 'create-folder', title: 'Fixture folder' }])
  const folderId = db.organization.snapshot(backend).navigation.folders[0].id
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [{ type: 'add-membership', feedId: feed, folderId }])
  const { secret } = create({ folderId })
  create({ feedId: 'missing' }); create({ folderId: 'other' })
  const [first] = ingest('First', 'Second').results
  ingest('Changed', 'Second')
  if (first.status !== 'resolved') throw new Error('Fixture identity failed')
  db.commitLocalEntryState(backend, [first.id], 'star'); db.commitLocalEntryState(backend, [first.id], 'star')
  expect(await hooks.sendArticle(first.id)).toEqual({ count: 1, message: '' })
  expect(db.webhooks.history()).toHaveLength(3)
  db.webhooks.finishBatch()
  await hooks.tick()
  expect(requests.map(r => JSON.parse(r.body).event_type)).toEqual(['new_entries', 'starred_entry', 'save_entry'])
  expect(JSON.parse(requests[0].body).entries.map((e: { title: string }) => e.title)).toEqual(['First', 'Second'])
  for (const { body, headers } of requests) expect(headers['x-paper-signature']).toBe(createHmac('sha256', secret!).update(headers['x-paper-timestamp'] + '.' + body).digest('hex'))
})

it('queues the matching star after 256 out-of-scope stars in one bulk action', async () => {
  const outside = ingest(...Array.from({ length: 256 }, (_, i) => 'Outside ' + i))
  const insideFeed = db.saveLocalSubscription(backend, { title: 'Inside', url: 'https://example.test/inside' })
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [{ type: 'create-folder', title: 'Selected' }])
  const folderId = db.localNavigation().folders[0].id
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [{ type: 'add-membership', feedId: insideFeed, folderId }])
  const [inside] = ingestFrom(insideFeed, ['Inside']).results
  const ids = outside.results.filter(entry => entry.status === 'resolved').map(entry => entry.id)
  expect(ids).toHaveLength(256)
  if (inside.status !== 'resolved') throw new Error('Fixture identity failed')
  create({ folderId, events: ['starred_entry'] })

  db.commitLocalEntryState(backend, [...ids, inside.id], 'star')
  expect(db.webhooks.history().map(job => job.event)).toEqual(['starred_entry'])
  await hooks.tick()
  expect(requests.map(request => JSON.parse(request.body).entry.id)).toEqual([inside.id])
})

it('persists queued and interrupted deliveries across restart and caps retries', async () => {
  const { target } = create()
  hooks.test(target.id)
  const job = db.webhooks.claim(Date.now())!
  db.close()
  db = new PaperDatabase(path.join(dir, 'paper.sqlite')); hooks = new Webhooks(db.webhooks, dir, [origin], async () => db.localNavigation())
  let now = Date.now() + deliveryLeaseMs + 1
  for (let attempt = 2; attempt <= maxAttempts; attempt++) {
    expect(db.webhooks.claim(now)).toMatchObject({ id: job.id, attempts: attempt })
    db.webhooks.finish(job.id, attempt, 503, 'Target returned HTTP 503.', now)
    if (attempt < maxAttempts) {
      now += retryDelay(attempt)
      expect(db.webhooks.claim(now - 1)).toBeUndefined()
    }
  }
  expect(db.webhooks.claim(now + 2 * 86_400_000)).toBeUndefined()
  expect(db.webhooks.history()[0]).toMatchObject({ state: 'failed', attempts: 8, nextRetry: null })
  expect(Array.from({ length: 7 }, (_, i) => retryDelay(i + 1) / 60_000)).toEqual([10, 20, 40, 80, 160, 320, 640])
  expect(db.webhooks.retry(job.id)).toBe(1)
  await hooks.tick()
  expect(db.webhooks.history()[0]).toMatchObject({ state: 'delivered', attempts: 9, status: 204 })
})

it('signs queued deliveries with the current secret and keeps the private target file owner-only', async () => {
  const { target, secret } = create()
  expect(fs.statSync(path.join(dir, 'webhooks', target.id + '.json')).mode & 0o777).toBe(0o600)
  hooks.test(target.id)
  const rotated = hooks.rotate(target.id).secret
  expect(rotated).not.toBe(secret)
  await hooks.tick()
  const { headers, body } = requests[0]
  expect(headers['x-paper-signature']).toBe(webhookSignature(rotated, String(headers['x-paper-timestamp']), body))
  expect(JSON.stringify(db.webhooks.targets())).not.toContain(rotated)
})

it('commits new articles and stars while the receiver hangs', async () => {
  const { target } = create({ url: origin + '/hang' }); hooks.test(target.id)
  const pending = hooks.tick()
  await expect.poll(() => requests.length).toBe(1)
  const [first] = ingest('While waiting').results
  if (first.status !== 'resolved') throw new Error('Fixture identity failed')
  db.commitLocalEntryState(backend, [first.id], 'star')
  expect(db.entryState(first.id)?.starred).toBe(true)
  expect(db.webhooks.history().map(job => job.state)).toEqual(['pending', 'collecting', 'sending'])
  await hooks.stop(); await pending
})

it('checks addresses at delivery, rejects redirects and omits private response text', async () => {
  const { target, secret } = create({ url: origin + '/redirect' })
  const policy = new Webhooks(db.webhooks, dir, [], async () => db.localNavigation())
  expect(() => policy.create({ kind: 'ntfy', name: 'Private', url: origin, events: ['save_entry'] })).toThrow(/PAPER_TRUSTED_SAVE_ORIGINS/)
  const denied = policy.create({ name: 'Private HTTPS', kind: 'webhook', url: 'https://127.0.0.1/topic', events: ['save_entry'] })
  policy.test(denied.target.id); await policy.tick()
  expect(db.webhooks.history()[0].error).toMatch(/network policy/)
  status = 302; hooks.test(target.id); await hooks.tick()
  expect(requests).toHaveLength(1)
  expect(db.webhooks.history()[0]).toMatchObject({ status: 302, attempts: 1, state: 'pending' })
  const visible = JSON.stringify([db.webhooks.targets(), db.webhooks.history()])
  for (const value of [secret!, '/redirect', 'Synthetic private response']) expect(visible).not.toContain(value)
})

it('keeps ntfy and Apprise credentials private and sends their native requests', async () => {
  const events = ['save_entry']
  const ntfy = create({ kind: 'ntfy', url: origin + '/topic', events, credential: 'synthetic-token' })
  const apprise = create({ kind: 'apprise', url: origin + '/notify?tag=alerts', events, credential: 'synthetic-key' })
  const [first] = ingest('Push fixture').results
  if (first.status !== 'resolved') throw new Error('Fixture identity failed')
  await hooks.sendArticle(first.id); await hooks.tick()
  expect(requests[0]).toMatchObject({ path: '/topic', headers: { authorization: 'Bearer synthetic-token', 'content-type': 'text/plain' } })
  expect(requests[1].path).toBe('/notify/synthetic-key?tag=alerts')
  expect(JSON.parse(requests[1].body).body).toContain('Push fixture')
  expect(JSON.stringify([ntfy, apprise, db.webhooks.targets(), db.webhooks.history()])).not.toMatch(/synthetic-(key|token)/)
  expect(() => create({ kind: 'ntfy' })).toThrow(/supported/)
  expect(await hooks.sendArticle(first.id, apprise.target.id)).toEqual({ count: 1, message: '' })
  expect(db.webhooks.history()[0]).toMatchObject({ event: 'rule_entry' })
})

it('limits batch sizes and deletes finished history by age and count', async () => {
  const { target } = create()
  ingest(...Array.from({ length: 160 }, (_, i) => '📚'.repeat(600) + i))
  db.webhooks.finishBatch(); await hooks.tick()
  expect(requests.length).toBeGreaterThan(1)
  expect(requests.every(r => Buffer.byteLength(r.body) <= 65536)).toBe(true)
  expect(requests.flatMap(r => JSON.parse(r.body).entries)).toHaveLength(160)
  for (let i = 0; i < 501; i++) {
    hooks.test(target.id)
    db.greaderDatabase.exec("UPDATE webhook_deliveries SET state='delivered' WHERE state='pending'")
  }
  db.webhooks.prune(Date.now())
  expect(db.greaderDatabase.prepare('SELECT count(*) AS count FROM webhook_deliveries').get()?.count).toBe(500)
  hooks.test(target.id)
  db.webhooks.prune(Date.now() + 31 * 86_400_000)
  expect(db.webhooks.history()).toEqual([])
})

it('uses current navigation for moved feeds and reports an unverifiable folder without blocking other targets', async () => {
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [
    { type: 'create-folder', title: 'Old folder' }, { type: 'create-folder', title: 'Current folder' },
  ])
  const [old, current] = db.localNavigation().folders
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [{ type: 'add-membership', feedId: feed, folderId: old.id }])
  let available = true
  hooks = new Webhooks(db.webhooks, dir, [origin], async () => {
    if (!available) throw new Error('offline')
    return db.localNavigation()
  })
  create({ name: 'Old', folderId: old.id, url: origin + '/old' })
  create({ name: 'Current', folderId: current.id, url: origin + '/current' })
  create({ name: 'All', events: ['save_entry'], url: origin + '/all' })
  const [first] = ingest('Moved').results
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [
    { type: 'move-feed', feedId: feed, fromFolderId: old.id, toFolderId: current.id },
  ])
  if (first.status !== 'resolved') throw new Error('Fixture identity failed')
  db.commitLocalEntryState(backend, [first.id], 'star')
  db.webhooks.finishBatch()
  expect(await hooks.sendArticle(first.id)).toEqual({ count: 2, message: '' })
  await hooks.tick()
  expect(requests.map(r => r.path)).toEqual(['/current', '/current', '/all'])
  expect(db.webhooks.history()).toContainEqual(expect.objectContaining({ target: 'Old', event: 'new_entries', state: 'skipped' }))
  db.commitLocalEntryState(backend, [first.id], 'unstar')
  db.commitLocalEntryState(backend, [first.id], 'star')
  available = false
  expect(await hooks.sendArticle(first.id)).toMatchObject({ count: 1, message: expect.stringMatching(/verify folder membership/) })
  await hooks.tick()
  const skipped = db.webhooks.history().filter(row => row.error.includes('verify folder membership'))
  expect(skipped.map(row => row.event).sort()).toEqual(['save_entry', 'save_entry', 'starred_entry'])
  expect(requests.slice(3).map(r => r.path)).toEqual(['/all'])
})

it.each(['rows', 'bytes'] as const)('enforces per-target and global pending %s and summarizes automatic overflow', async limit => {
  const sql = db.greaderDatabase
  const targetCount = limit === 'rows' ? queueLimits.totalRows / queueLimits.targetRows : queueLimits.totalBytes / queueLimits.targetBytes
  const ids = Array.from({ length: targetCount + 1 }, (_, i) => create({ name: String(i) }).target.id)
  const seed = sql.prepare("INSERT INTO webhook_deliveries(target_id,event,entries) VALUES (?,'test',?)")
  for (const id of ids.slice(0, -1)) {
    db.transaction(() => {
      if (limit === 'rows') for (let i = 0; i < queueLimits.targetRows; i++) seed.run(id, '[]')
      else {
        const payload = JSON.stringify(['x'.repeat(32768 - 4)])
        for (let i = 0; i < queueLimits.targetBytes / 32768; i++) seed.run(id, payload)
      }
    })
    expect(() => hooks.test(id)).toThrow(/queue is full/)
  }
  expect(() => hooks.test(ids.at(-1)!)).toThrow(/queue is full/)
  const [first] = ingest('Overflow', 'Second').results
  if (first.status !== 'resolved') throw new Error('Fixture identity failed')
  expect(await hooks.sendArticle(first.id)).toMatchObject({ count: 0, message: expect.stringMatching(/queue is full/) })
  db.commitLocalEntryState(backend, [first.id], 'star')
  expect(db.entryState(first.id)?.starred).toBe(true)
  expect(sql.prepare("SELECT target_id,dropped FROM webhook_deliveries WHERE event='overflow' ORDER BY seq").all())
    .toEqual(ids.map(target_id => ({ target_id, dropped: 3 })))
  expect(db.webhooks.history()[0].error).toMatch(/3 automatic events dropped/)
  const push = create({ kind: 'ntfy', events: ['starred_entry'] }).target
  expect(await hooks.sendArticle(first.id, push.id)).toMatchObject({ count: 0, message: expect.stringMatching(/queue is full/) })
  expect(db.webhooks.history()[0]).toMatchObject({ event: 'overflow', state: 'skipped' })
  db.webhooks.prune(Date.now() + retryWindowMs + 1)
  expect(sql.prepare("SELECT count(*) AS n FROM webhook_deliveries WHERE state='pending'").get()?.n).toBe(0)
  hooks.test(ids[0])
})

it('keeps initial star state silent and batches first-import articles published since target creation', () => {
  db.close()
  db = new PaperDatabase(path.join(dir, 'remote.sqlite'))
  db.bindBackend({ kind: 'freshrss', id: 'freshrss:fixture' })
  hooks = new Webhooks(db.webhooks, dir, [origin], async () => db.localNavigation())
  const { target } = create()
  const created = Number(db.greaderDatabase.prepare('SELECT created FROM webhook_targets WHERE id=?').get(target.id)!.created)
  const items = Array.from({ length: 301 }, (_, i) => {
    const timestamp = i < 201 ? created : created - 1
    return { id: 'article-' + i, feedId: 'feed/1', feedTitle: 'Fixture', feedUrl: '', title: 'Imported', author: '',
      url: '', contentHtml: '', excerpt: '', timestamp, publishedAt: new Date(timestamp).toISOString(),
      read: true, starred: i !== 0, readingMinutes: 1, thumbnailUrl: '', kind: 'article' as const }
  })
  db.saveRemotePage(items, { backfill_complete: 'true' })
  const stars = items.map(item => item.id)
  db.reconcileEntryState([], stars)
  expect(db.entryState(stars[0])?.starred).toBe(true)
  db.webhooks.finishBatch()
  expect(db.greaderDatabase.prepare('SELECT event,json_array_length(entries) AS n FROM webhook_deliveries ORDER BY seq').all())
    .toEqual([100, 100, 1].map(n => ({ event: 'new_entries', n })))
  db.reconcileEntryState([], stars.slice(1))
  db.reconcileEntryState([], stars)
  db.reconcileEntryState([], stars)
  expect(db.webhooks.history().filter(job => job.event === 'starred_entry')).toHaveLength(1)
})

it('holds the process lock through a pending POST even when its database lease expires', async () => {
  const { target } = create({ url: origin + '/hang' })
  hooks.test(target.id)
  const other = new Webhooks(db.webhooks, dir, [origin], async () => db.localNavigation())
  const sending = hooks.tick()
  try {
    await expect.poll(() => requests.length).toBe(1)
    const lease = db.greaderDatabase.prepare("SELECT due-created AS duration FROM webhook_deliveries WHERE state='sending'").get()
    expect(Number(lease?.duration)).toBeGreaterThan(transportTimeoutMs)
    db.greaderDatabase.exec("UPDATE webhook_deliveries SET due=0 WHERE state='sending'")
    void other.tick()
    expect(db.webhooks.history()[0].attempts).toBe(1)
  } finally { await other.stop(); await hooks.stop(); await sending }
  expect(requests).toHaveLength(1)
})

it('backs up the previous schema before installing the queue', () => {
  const [article] = ingest('Preserved').results
  db.greaderDatabase.exec(`DROP TRIGGER webhook_arrival; DROP TRIGGER webhook_star; DROP VIEW webhook_intake; DROP VIEW webhook_capacity;
    DROP TABLE webhook_deliveries; DROP TABLE webhook_targets; PRAGMA user_version=${WEBHOOK_SCHEMA_VERSION - 1}`)
  db.close(); db = new PaperDatabase(path.join(dir, 'paper.sqlite'))
  expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
  const filename = path.join(dir, `paper.sqlite.before-webhooks-v${WEBHOOK_SCHEMA_VERSION}`)
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600)
  const backup = new DatabaseSync(filename, { readOnly: true })
  try {
    expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='webhook_targets'").get()).toBeUndefined()
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(WEBHOOK_SCHEMA_VERSION - 1)
  } finally { backup.close() }
  expect(db.webhooks.history()).toEqual([])
  if (article.status === 'resolved') expect(db.localEntry(article.id)?.title).toBe('Preserved')
})
