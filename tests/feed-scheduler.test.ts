import fs from 'node:fs'
import { DATABASE_VERSION } from '../src/server/database-version.js'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server, type RequestListener } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { StandaloneFeedScheduler, retryAfterTime } from '../src/server/feed-scheduler.js'
import { successfulFeedFetch } from '../src/server/feed-ingestion.js'

const backend = { id: 'standalone:collector-fixture', kind: 'standalone' as const }
let directory: string
let file: string
let db: PaperDatabase
const servers: Server[] = []
const extras: PaperDatabase[] = []
const rss = (id = 'one', title = 'Original', date = '2001-01-01') => `<rss version="2.0"><channel><title>Fixture</title><item><guid>${id}</guid><title>${title}</title><link>https://example.test/${id}</link><pubDate>${date}</pubDate></item></channel></rss>`
async function server(handler: RequestListener) {
  const instance = createServer(handler); servers.push(instance)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  return `http://127.0.0.1:${address.port}`
}
function sql<T>(callback: (connection: DatabaseSync) => T): T {
  const connection = new DatabaseSync(file)
  try { return callback(connection) } finally { connection.close() }
}
function save(url: string, id?: string) { return db.saveLocalSubscription(backend.id, { id, url, title: 'Fixture' }) }
function state(id: string) { return db.feedFetch.get(backend.id, id)! }
function due(id: string) { sql(c => c.prepare('UPDATE feed_fetch_state SET next_fetch_at = 0, available_at = 0 WHERE subscription_id = ?').run(id)) }
function scheduler(origin: string, database = db, concurrency = 4) { return new StandaloneFeedScheduler(database, backend.id, { trustedOrigins: [origin], concurrency, perHostConcurrency: Math.min(2, concurrency) }) }
function reopen() { db.close(); db = new PaperDatabase(file) }
function checkpoint(id: string) { return successfulFeedFetch(db, { backendId: backend.id, subscriptionId: id, endpointGeneration: state(id).endpointGeneration }) }
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-issue17-'))
  file = path.join(directory, 'paper.sqlite'); db = new PaperDatabase(file); db.bindBackend(backend)
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  for (const extra of extras.splice(0)) extra.close()
  db.close(); fs.rmSync(directory, { recursive: true, force: true })
})

describe('standalone collector', () => {
  it('publishes committed failures and successful checks in feed health, including 304 recovery', async () => {
    let status = 503
    const origin = await server((_req, res) => { res.writeHead(status, { ETag: '"health"' }); res.end(status === 200 ? rss() : '') })
    const id = save(origin)
    const health = () => db.localNavigation().uncategorized.find(feed => feed.id === id)!
    const before = Date.now()
    await scheduler(origin).runDue()
    expect(health()).toMatchObject({ broken: true, lastCheckedAt: null })
    expect(Date.parse(health().lastErrorAt!)).toBeGreaterThanOrEqual(before)
    const failedAt = health().lastErrorAt
    status = 200; due(id); await scheduler(origin).runDue()
    expect(health()).toMatchObject({ broken: false, lastErrorAt: failedAt, lastCheckedAt: new Date(state(id).lastSuccessAt).toISOString() })
    status = 503; due(id); await scheduler(origin).runDue()
    expect(health().broken).toBe(true)
    status = 304; due(id); await scheduler(origin).runDue()
    expect(health()).toMatchObject({ broken: false, lastCheckedAt: new Date(state(id).lastSuccessAt).toISOString() })
  })

  it('rolls back health and fetch completion together and ignores stale failures', () => {
    const id = save('https://example.test/feed')
    const lease = db.feedFetch.claim(backend.id, 100, 100)!
    const failure = { nextFetchAt: 1000, failures: 1, lastStatus: 503, lastError: 'http-503' }
    const before = db.localNavigation()
    sql(c => c.exec("CREATE TRIGGER reject_health BEFORE UPDATE OF broken ON feeds BEGIN SELECT RAISE(ABORT, 'synthetic health failure'); END"))
    expect(() => db.feedFetch.complete(lease, 101, failure, () => {})).toThrow(/synthetic health/)
    expect(state(id)).toEqual(lease)
    expect(db.localNavigation()).toEqual(before)
    sql(c => c.exec('DROP TRIGGER reject_health'))
    expect(db.feedFetch.complete(lease, 200, failure, () => {})).toEqual({ committed: false })
    expect(db.localNavigation()).toEqual(before)
  })

  it('persists conditional state, leaves articles/checkpoint untouched on 304, and imports backdated arrivals', async () => {
    let delivery = 0
    const conditions: Array<string | undefined> = []
    const origin = await server((req, res) => {
      conditions.push(req.headers['if-none-match'])
      if (delivery === 1) { res.writeHead(304, { ETag: '"second"' }); res.end() }
      else { res.setHeader('ETag', '"first"'); res.setHeader('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT'); res.end(delivery === 2 ? rss('backdated', 'Delayed', '1990-01-01') : rss()) }
    })
    const id = save(origin + '/feed')
    expect(await scheduler(origin).runDue()).toMatchObject({ fetched: 1 })
    const before = checkpoint(id)
    const entryId = db.syncEntryIds({ kind: 'all', id: 'all', title: 'All' })[0]
    db.commitLocalEntryState(backend.id, [entryId], 'read'); db.commitLocalEntryState(backend.id, [entryId], 'star')
    const article = db.localEntry(entryId)
    delivery = 1; due(id); reopen()
    expect(await scheduler(origin).runDue()).toMatchObject({ notModified: 1 })
    expect(conditions).toEqual([undefined, '"first"'])
    expect(db.localEntry(entryId)).toEqual(article)
    expect(checkpoint(id)).toEqual(before)
    expect(state(id)).toMatchObject({ etag: '"second"', failures: 0, lastStatus: 304, leaseToken: '' })
    delivery = 2; due(id)
    expect(await scheduler(origin).runDue()).toMatchObject({ fetched: 1 })
    expect(db.entryCount()).toBe(2)
    expect(db.entryState(entryId)).toEqual({ read: true, starred: true, revision: 2 })
  })

  it('persists retry/backoff and honors Retry-After across restart without advancing success', async () => {
    let status = 503
    const origin = await server((_req, res) => { res.writeHead(status, { 'Retry-After': '120' }); res.end(status === 200 ? rss() : 'unavailable') })
    const id = save(origin)
    const before = Date.now()
    expect(await scheduler(origin).runDue()).toMatchObject({ failed: 1 })
    expect(state(id).nextFetchAt).toBeGreaterThanOrEqual(before + 120_000)
    expect(state(id)).toMatchObject({ failures: 1, lastSuccessAt: 0, lastError: 'http-503' })
    expect(checkpoint(id)).toBeNull()
    reopen(); expect(await scheduler(origin).runDue()).toMatchObject({ attempted: 0 })
    status = 200; due(id)
    expect(await scheduler(origin).runDue()).toMatchObject({ fetched: 1 })
    expect(state(id).failures).toBe(0)
    expect(retryAfterTime('Wed, 21 Oct 2015 07:28:00 GMT', 0)).toBe(Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))
    expect(retryAfterTime('-1', Date.now())).toBe(0)
  })

  it('rejects unsolicited 304 and invalid XML without saving validators or article checkpoints', async () => {
    let status = 304
    const origin = await server((_req, res) => { res.writeHead(status, { ETag: '"invalid-content"' }); res.end('<rss>broken') })
    const id = save(origin)
    expect(await scheduler(origin).runDue()).toMatchObject({ failed: 1 })
    expect(state(id)).toMatchObject({ etag: '', lastSuccessAt: 0 })
    status = 200; due(id)
    expect(await scheduler(origin).runDue()).toMatchObject({ failed: 1 })
    expect(state(id)).toMatchObject({ etag: '', lastError: 'ingestion', lastSuccessAt: 0 })
    expect(checkpoint(id)).toBeNull(); expect(db.entryCount()).toBe(0)
  })

  it.each(['repair', 'unsubscribe'] as const)('fences a response after %s during fetch', async action => {
    let release!: () => void
    let received!: () => void
    const arrived = new Promise<void>(resolve => { received = resolve })
    const origin = await server((_req, res) => { release = () => res.end(rss()); received() })
    const id = save(origin + '/a')
    const originalGeneration = state(id).endpointGeneration
    const work = scheduler(origin).runDue({ maxFeeds: 1 })
    await arrived
    if (action === 'repair') {
      save(origin + '/b', id); const secondGeneration = state(id).endpointGeneration
      save(origin + '/a', id)
      expect(new Set([originalGeneration, secondGeneration, state(id).endpointGeneration]).size).toBe(3)
    } else db.organization.apply(backend.id, db.organization.snapshot(backend.id).revision, [{ type: 'unsubscribe', feedId: id }])
    release()
    expect(await work).toMatchObject({ stale: 1, fetched: 0 })
    expect(db.entryCount()).toBe(0); expect(checkpoint(id)).toBeNull(); expect(state(id).lastSuccessAt).toBe(0)
    if (action === 'unsubscribe') { save(origin + '/a', id); expect(await scheduler(origin).runDue()).toMatchObject({ attempted: 0 }) }
  })

  it('preserves generation and validators for unchanged URLs and metadata edits', async () => {
    const origin = await server((_req, res) => { res.setHeader('ETag', '"saved"'); res.end(rss()) })
    const id = save(origin)
    await scheduler(origin).runDue()
    const before = state(id)
    db.saveLocalSubscription(backend.id, { id, title: 'Renamed', url: origin, siteUrl: 'https://example.test' })
    expect(state(id)).toEqual(before)
    save(origin + '/new', id)
    expect(state(id)).toMatchObject({ nextFetchAt: 0, lastSuccessAt: 0, etag: '', validatorUrl: '', failures: 0, leaseToken: '' })
  })

  it('recovers abandoned leases after restart and fences the original worker', () => {
    const id = save('https://example.test/feed')
    const first = db.feedFetch.claim(backend.id, 100, 100)!
    reopen()
    expect(db.feedFetch.claim(backend.id, 199, 100)).toBeNull()
    const second = db.feedFetch.claim(backend.id, 200, 100)!
    expect(second.leaseToken).not.toBe(first.leaseToken)
    const update = { nextFetchAt: 1000, failures: 0, lastStatus: 304, lastError: '' }
    let writes = 0
    expect(db.feedFetch.complete(first, 201, update, () => { writes++ })).toEqual({ committed: false })
    expect(db.feedFetch.complete(second, 201, update, () => { writes++ })).toMatchObject({ committed: true })
    expect(writes).toBe(1); expect(state(id).nextFetchAt).toBe(1000)
  })

  it('rejects an old response after a replacement worker has committed newer content', async () => {
    let release!: () => void, received!: () => void, requests = 0
    const arrived = new Promise<void>(resolve => { received = resolve })
    const origin = await server((_req, res) => {
      requests++
      if (requests === 1) { release = () => { res.setHeader('ETag', '\"old\"'); res.end(rss('one', 'Old')) }; received() }
      else { res.setHeader('ETag', '\"new\"'); res.end(rss('one', 'New')) }
    })
    const id = save(origin)
    const first = scheduler(origin).runDue({ maxFeeds: 1 })
    await arrived
    // Simulate the durable recovery condition without waiting for a real lease.
    sql(c => c.prepare('UPDATE feed_fetch_state SET lease_until = 0, available_at = 0 WHERE subscription_id = ?').run(id))
    const other = new PaperDatabase(file); extras.push(other)
    expect(await scheduler(origin, other).runDue()).toMatchObject({ fetched: 1 })
    const success = checkpoint(id)
    release()
    expect(await first).toMatchObject({ stale: 1 })
    const entryId = db.syncEntryIds({ kind: 'all', id: 'all', title: 'All' })[0]
    expect(db.localEntry(entryId)?.title).toBe('New')
    expect(state(id).etag).toBe('\"new\"'); expect(checkpoint(id)).toEqual(success)
  })

  it('rolls back entries, aliases and successful-fetch state when final schedule persistence fails', async () => {
    const origin = await server((_req, res) => { res.setHeader('ETag', '"new"'); res.end(rss()) })
    const id = save(origin)
    sql(c => c.exec(`CREATE TRIGGER reject_fetch_success BEFORE UPDATE ON feed_fetch_state
      WHEN new.last_success_at > 0 BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`))
    expect(await scheduler(origin).runDue()).toMatchObject({ failed: 1 })
    expect(db.entryCount()).toBe(0); expect(checkpoint(id)).toBeNull()
    expect(state(id)).toMatchObject({ lastSuccessAt: 0, etag: '', failures: 1 })
    expect(sql(c => c.prepare('SELECT COUNT(*) AS count FROM article_aliases').get()?.count)).toBe(0)
  })

  it('bounds concurrent redirected requests across competing workers and imports each subscription once', async () => {
    let active = 0, peak = 0, requests = 0
    const origin = await server((req, res) => {
      active++; peak = Math.max(peak, active); requests++
      setTimeout(() => { active--; if (req.url?.startsWith('/redirect')) { res.writeHead(302, { Location: req.url.replace('/redirect', '/feed') }); res.end() } else res.end(rss(req.url)) }, 8)
    })
    for (let index = 0; index < 24; index++) save(origin + '/redirect/' + index)
    const other = new PaperDatabase(file); extras.push(other)
    const [a, b] = await Promise.all([scheduler(origin).runDue(), scheduler(origin, other).runDue()])
    expect(a.fetched + b.fetched).toBe(24)
    expect(requests).toBe(48); expect(peak).toBeLessThanOrEqual(2)
    expect(db.entryCount()).toBe(24)
    expect(sql(c => c.prepare('SELECT COUNT(*) AS count FROM feed_http_slots').get()?.count)).toBe(0)
  })

  it('shares global and host reservations across connections and recovers expired slots', () => {
    const other = new PaperDatabase(file); extras.push(other)
    const first = db.feedFetch.reserveHttp(backend.id, 'one.test', 100, 200, 3, 2)!
    expect(first).toBeTruthy()
    expect(other.feedFetch.reserveHttp(backend.id, 'one.test', 100, 200, 3, 2)).toBeTruthy()
    expect(other.feedFetch.reserveHttp(backend.id, 'one.test', 100, 200, 3, 2)).toBeNull()
    expect(other.feedFetch.reserveHttp(backend.id, 'two.test', 100, 200, 3, 2)).toBeTruthy()
    expect(other.feedFetch.reserveHttp(backend.id, 'three.test', 100, 200, 3, 2)).toBeNull()
    db.feedFetch.releaseHttp(first)
    expect(other.feedFetch.reserveHttp(backend.id, 'three.test', 100, 200, 3, 2)).toBeTruthy()
    expect(other.feedFetch.reserveHttp(backend.id, 'one.test', 200, 300, 3, 2)).toBeTruthy()
  })

  it('retains old validators and successful checkpoint after a malformed update', async () => {
    let xml = rss()
    const origin = await server((_req, res) => { res.setHeader('ETag', xml === rss() ? '\"old\"' : '\"new\"'); res.end(xml) })
    const id = save(origin)
    await scheduler(origin).runDue()
    const before = state(id), success = checkpoint(id)
    xml = '<rss>broken'; due(id)
    expect(await scheduler(origin).runDue()).toMatchObject({ failed: 1 })
    expect(state(id)).toMatchObject({ etag: before.etag, lastSuccessAt: before.lastSuccessAt })
    expect(checkpoint(id)).toEqual(success); expect(db.entryCount()).toBe(1)
  })

  it('cancels in-flight work, persists its retry and releases all HTTP slots', async () => {
    let received!: () => void
    const arrived = new Promise<void>(resolve => { received = resolve })
    const origin = await server((_req, res) => { res.write('<rss>'); received() })
    const id = save(origin)
    const controller = new AbortController()
    const work = scheduler(origin).runDue({ signal: controller.signal })
    await arrived; controller.abort()
    expect(await work).toMatchObject({ failed: 1 })
    expect(state(id)).toMatchObject({ lastError: 'aborted', leaseToken: '', lastSuccessAt: 0 })
    expect(sql(c => c.prepare('SELECT COUNT(*) AS count FROM feed_http_slots').get()?.count)).toBe(0)
  })

  it('queries due work in bounded batches for large subscription lists', async () => {
    const origin = await server((_req, res) => res.end(rss()))
    for (let index = 0; index < 2000; index++) save(origin + '/' + index)
    expect(await scheduler(origin).runDue({ maxFeeds: 7 })).toMatchObject({ attempted: 7, fetched: 7 })
    expect(db.entryCount()).toBe(7)
    const query = sql(c => c.prepare('EXPLAIN QUERY PLAN SELECT subscription_id FROM feed_fetch_state WHERE backend_id = ? AND available_at <= ? ORDER BY available_at, subscription_id LIMIT 1').all(backend.id, Date.now()))
    expect(JSON.stringify(query)).toContain('feed_fetch_due')
  }, 30000)

  it('rejects FreshRSS and foreign backend scheduling', () => {
    expect(() => new StandaloneFeedScheduler(db, 'another')).toThrow(/active standalone/)
    const remote = new PaperDatabase(path.join(directory, 'remote.sqlite')); extras.push(remote)
    remote.bindBackend({ id: 'freshrss:synthetic', kind: 'freshrss' })
    expect(() => new StandaloneFeedScheduler(remote, 'freshrss:synthetic')).toThrow(/active standalone/)
  })
})

describe('manual feed checks', () => {
  function allowManual(id: string) { sql(c => c.prepare('UPDATE feed_fetch_state SET last_attempt_at = 0 WHERE subscription_id = ?').run(id)) }

  it('forces a future check with conditional headers, deduplicates it, and persists cooldown across restart', async () => {
    const conditions: Array<string | undefined> = []
    const origin = await server((req, res) => {
      conditions.push(req.headers['if-none-match'])
      res.writeHead(conditions.length === 1 ? 200 : 304, { ETag: '"manual"' })
      res.end(conditions.length === 1 ? rss() : '')
    })
    const id = save(origin)
    const collector = scheduler(origin)
    await collector.runDue()
    expect(state(id).nextFetchAt).toBeGreaterThan(Date.now())
    expect(collector.queueChecks([id])[0].status).toBe('cooldown')
    allowManual(id)
    expect(collector.queueChecks([id, id])).toEqual([{ feedId: id, status: 'queued' }])
    expect(collector.queueChecks([id])).toEqual([{ feedId: id, status: 'queued' }])
    expect(await collector.runDue()).toMatchObject({ attempted: 1, notModified: 1 })
    expect(conditions).toEqual([undefined, '"manual"'])
    reopen()
    expect(scheduler(origin).queueChecks([id])[0].status).toBe('cooldown')
    expect(state(id).leaseToken).toBe('')
  })

  it.each([200, 503])('respects Retry-After on manual checks after HTTP %s and restart', async status => {
    let requests = 0
    const origin = await server((_req, res) => { requests++; res.writeHead(status, { 'Retry-After': '3600' }); res.end(status === 200 ? rss() : '') })
    const id = save(origin)
    await scheduler(origin).runDue()
    const until = state(id).retryAfterUntil
    expect(until).toBeGreaterThan(Date.now() + 3500_000)
    allowManual(id); reopen()
    const collector = scheduler(origin)
    expect(collector.queueChecks([id])).toEqual([{ feedId: id, status: 'retry-after', until }])
    expect(await collector.runDue()).toMatchObject({ attempted: 0 })
    expect(requests).toBe(1)
  })

  it('shares bounded workers with automatic collection and deduplicates running checks', async () => {
    let active = 0, peak = 0
    const requests = new Map<string, number>()
    const origin = await server((req, res) => {
      active++; peak = Math.max(peak, active)
      requests.set(req.url!, (requests.get(req.url!) || 0) + 1)
      setTimeout(() => { active--; res.end(rss(req.url)) }, 20)
    })
    const ids = Array.from({ length: 12 }, (_, index) => save(origin + '/' + index))
    const collector = scheduler(origin, db, 2)
    collector.queueChecks(ids.slice(0, 8))
    const running = collector.runDue()
    expect(collector.checkState(ids[0])).toBe('running')
    expect(collector.queueChecks(ids.slice(0, 8)).map(result => result.status)).toEqual(['running', 'running', ...Array(6).fill('queued')])
    expect(collector.runDue()).toBe(running)
    expect(await running).toMatchObject({ attempted: 12, fetched: 12 })
    expect(peak).toBe(2)
    expect([...requests.values()]).toEqual(Array(12).fill(1))
  })

  it('uses saved global and per-feed intervals, updates schedules, and retains failure and publisher waits', async () => {
    const origin = await server((_req, res) => res.end(rss()))
    const first = save(origin + '/first'), second = save(origin + '/second')
    db.feedFetch.setInterval(backend.id, 0, 60)
    db.feedFetch.setInterval(backend.id, 1, 5, second)
    await scheduler(origin).runDue()
    expect(state(first).nextFetchAt - state(first).lastSuccessAt).toBe(60 * 60_000)
    expect(state(second).nextFetchAt - state(second).lastSuccessAt).toBe(5 * 60_000)
    db.feedFetch.setInterval(backend.id, 2, 30)
    expect(state(first).nextFetchAt - state(first).lastSuccessAt).toBe(30 * 60_000)
    expect(state(second).nextFetchAt - state(second).lastSuccessAt).toBe(5 * 60_000)
    db.feedFetch.setInterval(backend.id, 3, null, second)
    expect(state(second).nextFetchAt - state(second).lastSuccessAt).toBe(30 * 60_000)
    const until = Date.now() + 86400_000
    sql(c => c.prepare('UPDATE feed_fetch_state SET retry_after_until = ?, next_fetch_at = ?, available_at = ? WHERE subscription_id = ?').run(until, until, until, first))
    sql(c => c.prepare('UPDATE feed_fetch_state SET failures = 2 WHERE subscription_id = ?').run(second))
    const failed = state(second)
    db.feedFetch.setInterval(backend.id, 4, 5)
    expect(state(first).nextFetchAt).toBe(until)
    expect(state(second)).toEqual(failed)
    for (const minutes of [0, 4, 1441, 5.5, NaN, Infinity]) expect(() => db.feedFetch.setInterval(backend.id, 5, minutes)).toThrow(/5 to 1440/)
    expect(() => db.feedFetch.setInterval(backend.id, 0, 15)).toThrow(/changed/)
    expect(db.feedFetch.settings(backend.id)).toEqual({ revision: 5, intervalMinutes: 5 })
    reopen()
    expect(db.feedFetch.settings(backend.id)).toEqual({ revision: 5, intervalMinutes: 5 })
  })

  it('keeps the destination policy for a forced request and fences an unexpired durable lease', async () => {
    let requests = 0
    const origin = await server((_req, res) => { requests++; res.end(rss()) })
    const id = save(origin)
    const lease = db.feedFetch.claim(backend.id, Date.now(), 60000)!
    reopen()
    const collector = new StandaloneFeedScheduler(db, backend.id)
    expect(collector.queueChecks([id])[0].status).toBe('running')
    db.feedFetch.complete(lease, Date.now(), { nextFetchAt: Date.now() + 900000, failures: 0, lastError: '', lastStatus: 200 }, () => {})
    allowManual(id)
    collector.queueChecks([id])
    expect(await collector.runDue()).toMatchObject({ failed: 1 })
    expect(state(id).lastError).toBe('policy')
    expect(requests).toBe(0)
  })
})

describe('schema v13 recovery', () => {
  function downgrade() {
    db.close()
    sql(c => c.exec(`DROP TABLE feed_check_settings;
      ALTER TABLE feed_fetch_state DROP COLUMN interval_minutes;
      ALTER TABLE feed_fetch_state DROP COLUMN last_attempt_at;
      ALTER TABLE feed_fetch_state DROP COLUMN retry_after_until;
      PRAGMA user_version = 12`))
    db = new PaperDatabase(':memory:')
  }
  it('backs up v12, preserves validators and leases, and conservatively retains old waits', () => {
    const id = save('https://example.test/feed')
    const lease = db.feedFetch.claim(backend.id, 100, 60000)!
    sql(c => c.prepare('UPDATE feed_fetch_state SET next_fetch_at = 100000, etag = ? WHERE subscription_id = ?').run('"saved"', id))
    downgrade()
    const migrated = new PaperDatabase(file); extras.push(migrated)
    expect(migrated.feedFetch.get(backend.id, id)).toMatchObject({ leaseToken: lease.leaseToken, leaseUntil: lease.leaseUntil,
      etag: '"saved"', retryAfterUntil: 100000, intervalMinutes: null, lastAttemptAt: 0 })
    expect(migrated.feedFetch.settings(backend.id)).toEqual({ revision: 0, intervalMinutes: 15 })
    const backup = `${file}.before-feed-checks-v13`
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    const connection = new DatabaseSync(backup, { readOnly: true })
    expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(12)
    expect(connection.prepare('SELECT etag FROM feed_fetch_state').get()?.etag).toBe('"saved"')
    connection.close()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(DATABASE_VERSION)
  })
  it('rolls back a failed migration and reuses the original backup', () => {
    save('https://example.test/feed'); downgrade()
    sql(c => c.exec("CREATE TRIGGER reject_upgrade BEFORE UPDATE ON feed_fetch_state BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END"))
    expect(() => new PaperDatabase(file)).toThrow(/synthetic migration failure/)
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(12)
    expect(sql(c => c.prepare('PRAGMA table_info(feed_fetch_state)').all().some(row => row.name === 'retry_after_until'))).toBe(false)
    const backup = fs.readFileSync(`${file}.before-feed-checks-v13`)
    sql(c => c.exec('DROP TRIGGER reject_upgrade'))
    const migrated = new PaperDatabase(file); extras.push(migrated)
    expect(fs.readFileSync(`${file}.before-feed-checks-v13`)).toEqual(backup)
  })
})

describe('schema v9 recovery', () => {
  function downgrade() {
    db.close()
    sql(c => c.exec('DROP TABLE feed_http_slots; DROP TABLE feed_fetch_state; PRAGMA user_version = 8'))
    db = new PaperDatabase(':memory:')
  }
  it('backs up v8, seeds existing endpoints and preserves generation on reopen', () => {
    const id = save('https://example.test/feed')
    downgrade()
    const migrated = new PaperDatabase(file); extras.push(migrated)
    const saved = migrated.feedFetch.get(backend.id, id)!
    expect(saved).toMatchObject({ url: 'https://example.test/feed', nextFetchAt: 0 })
    expect(saved.endpointGeneration).toBeTruthy()
    const reopened = new PaperDatabase(file); extras.push(reopened)
    expect(reopened.feedFetch.get(backend.id, id)).toEqual(saved)
    const backup = `${file}.before-feed-fetch-v9`
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    const connection = new DatabaseSync(backup, { readOnly: true })
    expect(connection.prepare('PRAGMA user_version').get()?.user_version).toBe(8); connection.close()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(DATABASE_VERSION)
  })
  it('rolls back migration failures and reuses its pre-upgrade backup', () => {
    downgrade()
    sql(c => c.exec('CREATE VIEW feed_fetch_state AS SELECT 1 AS broken'))
    expect(() => new PaperDatabase(file)).toThrow()
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(8)
    const backup = fs.readFileSync(`${file}.before-feed-fetch-v9`)
    sql(c => c.exec('DROP VIEW feed_fetch_state'))
    const migrated = new PaperDatabase(file); extras.push(migrated)
    expect(sql(c => c.prepare('PRAGMA user_version').get()?.user_version)).toBe(DATABASE_VERSION)
    expect(fs.readFileSync(`${file}.before-feed-fetch-v9`)).toEqual(backup)
  })
})
