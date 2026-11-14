import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { GreaderOrganization } from '../src/server/greader-organization'
import { LABEL, item, resolveStream, STATE, explicit, metadata, page, where, scanPageFrom } from '../src/server/greader-query'
import { GreaderPool } from '../src/server/greader-pool'
import { GreaderAuth } from '../src/server/greader-auth'

let directory: string, db: PaperDatabase, backend: string, feed: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-greader-storage-')); db = new PaperDatabase(path.join(directory, 'paper.sqlite')); backend = db.bindStandalone().id; feed = db.saveLocalSubscription(backend, { title: 'Fixture', url: 'https://example.test/feed' }) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
const form = (values: Record<string,string>) => new URLSearchParams(values)
it('backs up v15 privately, migrates once and preserves settings on reopen', () => {
  db.close()
  const raw = new DatabaseSync(path.join(directory,'paper.sqlite'))
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'greader_%'").all()) raw.exec(`DROP TRIGGER ${row.name}`)
  for (const row of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'greader_%'").all()) raw.exec(`DROP INDEX ${row.name}`)
  raw.exec('DROP TABLE greader_settings; ALTER TABLE entries DROP COLUMN greader_modified_ms; ALTER TABLE feeds DROP COLUMN greader_modified_ms; PRAGMA user_version = 15'); raw.close()
  db = new PaperDatabase(path.join(directory,'paper.sqlite'))
  const backup = path.join(directory,'paper.sqlite.before-greader-v16')
  expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
  const prior = new DatabaseSync(backup, { readOnly: true }); expect(prior.prepare('PRAGMA user_version').get()!.user_version).toBe(15); prior.close()
  expect(db.greaderDatabase.prepare('SELECT enabled FROM greader_settings').get()!.enabled).toBe(0)
  const key = db.greaderDatabase.prepare('SELECT key FROM greader_settings').get()!.key
  db.close(); db = new PaperDatabase(path.join(directory,'paper.sqlite'))
  expect(db.greaderDatabase.prepare('SELECT key FROM greader_settings').get()!.key).toBe(key)
})
it('rolls back organization batches, rejects ambiguous moves, and retains empty folders', () => {
  const organization = new GreaderOrganization(db, backend, async () => { throw new Error() })
  const stream = `feed/${db.linkNumber('feed',feed)}`
  organization.edit('subscription/edit', form({ s: stream, ac: 'edit', a: `${LABEL}A / + % Café` }))
  organization.edit('subscription/edit', form({ s: stream, ac: 'edit', a: `${LABEL}Second`, r: `${LABEL}Uncategorized` }))
  expect(() => organization.edit('subscription/edit', form({ s: stream, ac: 'edit', a: `${LABEL}Third`, t: 'Must roll back' }))).toThrow(/multi-folder/)
  expect(db.greaderDatabase.prepare('SELECT title FROM feeds WHERE id = ?').get(feed)!.title).toBe('Fixture')
  const before = db.organization.snapshot(backend)
  expect(() => organization.edit('disable-tag', new URLSearchParams([['s',`${LABEL}Second`],['s',`${STATE}read`]]))).toThrow()
  expect(db.organization.snapshot(backend)).toEqual(before)
  organization.edit('rename-tag', form({ s: `${LABEL}Second`, dest: `${LABEL}Renamed` }))
  expect(() => resolveStream(db.greaderDatabase, `${LABEL}Second`)).toThrow()
  organization.edit('subscription/edit', form({ s: stream, ac: 'unsubscribe' }))
  expect(resolveStream(db.greaderDatabase, `${LABEL}Renamed`).kind).toBe('folder')
  organization.edit('subscription/edit', form({ s: stream, ac: 'subscribe' }))
  expect(resolveStream(db.greaderDatabase, stream).id).toBe(feed)
})
it('makes quickadd idempotent, rejects duplicate URLs and creates only through discovery', async () => {
  let requests = 0
  const organization = new GreaderOrganization(db, backend, async url => { requests++; return { responseUrl: url, body: '<rss version="2.0"><channel><title>New feed</title></channel></rss>', contentType: 'application/rss+xml' } })
  expect((await organization.quickadd('https://example.test/feed')).streamId).toBe(`feed/${db.linkNumber('feed',feed)}`)
  expect(requests).toBe(0)
  db.saveLocalSubscription(backend, { title: 'Duplicate', url: 'https://example.test/feed' })
  await expect(organization.quickadd('https://example.test/feed')).rejects.toMatchObject({ status: 409 })
  const result = await organization.quickadd('https://example.test/new'); expect(result.numResults).toBe(1); expect(requests).toBe(1)
})
it('clips oversized HTML as escaped text and keeps summary bytes bounded', () => {
  const result = item(db.greaderDatabase, { sequence: 1n, first_seen_at: 1000n, published_at: '', title: '', author: '', feed_id: feed, feed_number: 1n, origin_title: '', site_url: '', url: 'https://example.test/article', content_html: '<script>'.repeat(10000), content_text: '<&'.repeat(10000), read: 0n, starred: 0n })
  expect(Buffer.byteLength(result.summary.content)).toBeLessThanOrEqual(65536)
  expect(result.summary.content).not.toContain('<script>'); expect(result.summary.content).toContain('&lt;')
})
it('enforces process deadlines and releases cancelled and queued jobs on shutdown', async () => {
  const worker = path.join(directory, 'blocked.mjs'); fs.writeFileSync(worker, "process.once('message', () => { while(true) {} })")
  const pool = new GreaderPool(new URL(`file://${worker}`), 2, 16, 100)
  const controller = new AbortController()
  const jobs = Array.from({length: 18}, () => pool.run({}, controller.signal).catch(error => error))
  await expect(pool.run({}, controller.signal)).rejects.toMatchObject({status:503})
  expect((await jobs[0]).status).toBe(503)
  controller.abort(); await pool.close()
  expect((await Promise.all(jobs)).every(error => error.status === 503)).toBe(true)
})
it('requires transport, standalone mode and credentials and retains administrator passwords when login starts', async () => {
  const api = new GreaderAuth(db.greaderDatabase, db.auth, true, 'http://localhost')
  expect(() => api.configure(true,'reader')).toThrow(/password/)
  const app = await db.auth.createApp('Synthetic',null)
  expect(() => new GreaderAuth(db.greaderDatabase,db.auth,true,'http://example.test').configure(true,'reader')).toThrow(/HTTPS/)
  expect(() => new GreaderAuth(db.greaderDatabase,db.auth,false,'https://example.test').configure(true,'reader')).toThrow(/standalone/)
  api.configure(true,'reader')
  expect(new GreaderAuth(db.greaderDatabase,db.auth,true,'http://example.test').enabled()).toBe(false)
  await db.auth.setup(db.auth.setupCode(),'owner','synthetic owner password')
  expect((await db.auth.checkApp('reader',app.password,'127.0.0.1','reader')).id).toBe(app.id)
  await db.auth.recover('revoke-all'); expect(api.enabled()).toBe(true)
  await db.auth.recover('disable'); expect(api.enabled()).toBe(false)
})

it('keeps effective modification timestamps unchanged on identical imports and tracks mute changes', async () => {
  const { ingestFeed } = await import('../src/server/feed-ingestion')
  const options = { backendId: backend, subscriptionId: feed, endpointGeneration: 'fixture', requestUrl: 'https://example.test/feed', responseUrl: 'https://example.test/feed', fetchedAt: new Date().toISOString(), xml: '<rss version="2.0"><channel><title>Fixture</title><item><guid>one</guid><title>First</title><description>Unchanged</description></item></channel></rss>' }
  ingestFeed(db, options)
  const row = () => db.greaderDatabase.prepare('SELECT id, greader_modified_ms FROM entries').get()!
  const first = row().greader_modified_ms
  const feedClock = () => db.greaderDatabase.prepare('SELECT greader_modified_ms FROM feeds WHERE id = ?').get(feed)!.greader_modified_ms
  const firstFeed = feedClock()
  ingestFeed(db, options); expect(row().greader_modified_ms).toBe(first); expect(feedClock()).toBe(firstFeed)
  ingestFeed(db, { ...options, xml: options.xml.replace('Unchanged','Changed') }); expect(Number(row().greader_modified_ms)).toBeGreaterThan(Number(first))
  const sql = db.greaderDatabase, changed = row().greader_modified_ms
  sql.exec("INSERT INTO mute_filters VALUES ('mute', 'Changed', 'all', '', '')")
  sql.prepare("INSERT INTO muted_entries VALUES ('mute', ?)").run(row().id)
  expect(Number(row().greader_modified_ms)).toBeGreaterThan(Number(changed))
  const muted = row().greader_modified_ms
  ingestFeed(db,{...options,xml:options.xml.replace('Unchanged','Changed')})
  expect(row().greader_modified_ms).toBe(muted)
  sql.exec("DELETE FROM muted_entries WHERE filter_id='mute'")
  expect(Number(row().greader_modified_ms)).toBeGreaterThan(Number(muted))
})

it('rolls back a killed writer and releases its SQLite lock', async () => {
  const worker = path.join(directory, 'writer.mjs')
  fs.writeFileSync(worker, `import { DatabaseSync } from 'node:sqlite'; process.once('message', job => { const db = new DatabaseSync(job.path); db.exec("BEGIN IMMEDIATE; UPDATE feeds SET title = 'uncommitted'"); while(true) {} })`)
  const pool = new GreaderPool(new URL(`file://${worker}`), 1, 4, 150)
  await expect(pool.run({ path: db.searchDatabasePath }, new AbortController().signal)).rejects.toMatchObject({ status: 503 })
  await pool.close()
  expect(db.greaderDatabase.prepare('SELECT title FROM feeds WHERE id = ?').get(feed)!.title).toBe('Fixture')
  expect(() => db.saveLocalSubscription(backend, { title: 'After cancellation', url: 'https://example.test/after' })).not.toThrow()
})

it('intersects and excludes every combination of state, feed and folder streams', async () => {
  const { ingestFeed } = await import('../src/server/feed-ingestion')
  const { page } = await import('../src/server/greader-query')
  const second = db.saveLocalSubscription(backend, { title: 'Second', url: 'https://example.test/second' })
  for (const subscriptionId of [feed, second]) ingestFeed(db, { backendId: backend, subscriptionId, endpointGeneration: 'fixture', requestUrl: 'https://example.test/feed', responseUrl: 'https://example.test/feed', fetchedAt: new Date().toISOString(), xml: '<rss version="2.0"><channel><title>Fixture</title><item><guid>one</guid><title>One</title></item><item><guid>two</guid><title>Two</title></item></channel></rss>' })
  const folder = db.organization.apply(backend, db.organization.snapshot(backend).revision, [{type:'create-folder', title:'Folder'}]).results[0]
  if (folder.status !== 'applied') throw new Error('Folder fixture failed')
  db.organization.apply(backend, db.organization.snapshot(backend).revision, [{type:'add-membership', feedId:feed, folderId:folder.id!}])
  const sql = db.greaderDatabase
  sql.exec('UPDATE entries SET read = 1 WHERE rowid % 2 = 0; UPDATE entries SET starred = 1 WHERE rowid <= 2')
  const articles = sql.prepare('SELECT a.sequence, e.read, e.starred, e.feed_id FROM entries e JOIN article_arrivals a ON a.entry_id=e.id').all()
  const streams = ['reading-list','read','unread','starred'].map(id => ({kind:'state' as const,id})).concat([])
  const allStreams: import('../src/server/greader-query').Stream[] = [...streams, {kind:'feed',id:feed}, {kind:'feed',id:second}, {kind:'folder',id:folder.id!}, {kind:'folder',id:''}]
  const matches = (row: typeof articles[number], stream: typeof allStreams[number]) => stream.kind === 'feed' ? row.feed_id === stream.id : stream.kind === 'folder' ? row.feed_id === (stream.id ? feed : second) : stream.id === 'read' ? !!row.read : stream.id === 'unread' ? !row.read : stream.id === 'starred' ? !!row.starred : true
  for (const stream of allStreams) for (const include of allStreams) for (const exclude of allStreams) {
    const expected = articles.filter(row => matches(row,stream) && matches(row,include) && !matches(row,exclude)).map(row => String(row.sequence)).sort((a,b)=>Number(b)-Number(a))
    const actual = page(sql, {backend,stream,it:[include],xt:[exclude],ot:0,nt:0,order:'DESC',n:250},false).values.map(row => row.id)
    expect(actual).toEqual(expected)
  }
})

it('retains a read slot until response delivery ends', async () => {
  const worker = path.join(directory, 'reply.mjs')
  fs.writeFileSync(worker, "process.once('message', () => process.send({body:'bounded response'}, () => process.disconnect()))")
  const pool = new GreaderPool(new URL(`file://${worker}`), 1, 1, 1000)
  const first = new AbortController(), second = new AbortController()
  expect(await pool.run({},first.signal,true)).toBe('bounded response')
  const queued = pool.run({},second.signal)
  await expect(pool.run({},second.signal)).rejects.toMatchObject({status:503})
  first.abort(); expect(await queued).toBe('bounded response'); await pool.close()
})

async function seedArticles(count: number) {
  const { ingestFeed } = await import('../src/server/feed-ingestion')
  const options = { backendId: backend, subscriptionId: feed, endpointGeneration: 'fixture', requestUrl: 'https://example.test/feed', responseUrl: 'https://example.test/feed', fetchedAt: new Date().toISOString() }
  const xml = `<rss version="2.0"><channel><title>Fixture</title>${Array.from({length:count}, (_,i) => `<item><guid>${i}</guid><title>Item ${i}</title></item>`).join('')}</channel></rss>`
  ingestFeed(db, {...options, xml})
  return { ingestFeed, options, xml }
}
it('rejects content overflow before collecting the full batch', async () => {
  await seedArticles(250)
  db.greaderDatabase.prepare('UPDATE entries SET author = ?').run('x'.repeat(100000))
  expect(() => explicit(db.greaderDatabase,backend,Array.from({length:250},(_,i)=>String(i+1)),'DESC')).toThrow(expect.objectContaining({status:413}))
})
it('keeps strict web undo and rolls back reader state when activity fails', async () => {
  await seedArticles(2)
  const { LocalStateService } = await import('../src/server/local-state')
  const service = new LocalStateService(db,backend)
  const ids = db.greaderDatabase.prepare('SELECT id FROM entries ORDER BY rowid').all().map(row=>String(row.id))
  const undo = { token:'synthetic-undo', expiresAt:new Date(Date.now()+60000).toISOString() }
  db.commitLocalEntryState(backend,ids,'read',{undo})
  service.editReaderNumbers([1n,2n],{read:true})
  expect(db.entryState(ids[0])!.revision).toBe(1)
  service.editReaderNumbers([1n],{starred:true})
  expect(()=>service.undo(undo.token)).toThrow()
  expect(ids.map(id=>db.entryState(id)!.read)).toEqual([true,true])
  const before = ids.map(id=>db.entryState(id))
  db.greaderDatabase.exec("CREATE TRIGGER fail_reader_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'fixture'); END")
  expect(()=>service.editReaderNumbers([1n,2n],{read:false,starred:false})).toThrow(/fixture/)
  expect(ids.map(id=>db.entryState(id))).toEqual(before)
})
it('reconciles actual retention deletions without recycling arrivals or reimporting tombstones', async () => {
  const { ingestFeed,options,xml } = await seedArticles(2)
  const { defaultPolicy,DAY } = await import('../src/server/retention-store')
  const { LocalStateService } = await import('../src/server/local-state')
  ingestFeed(db,{...options,xml:'<rss version="2.0"><channel><title>Fixture</title></channel></rss>'})
  const sql = db.greaderDatabase
  sql.prepare('UPDATE entries SET first_seen_at = ?').run(Date.now()-200*DAY)
  sql.exec('UPDATE entries SET starred=1 WHERE rowid=2')
  const run = db.retention.start({...defaultPolicy(),unreadDays:1})
  expect(db.retention.batch(run,true).done).toBe(true)
  const q = {backend,stream:{kind:'state' as const,id:'reading-list'},it:[],xt:[],ot:0,nt:0,order:'DESC' as const,n:250}
  expect(page(sql,q,false).values.map(row=>row.id)).toEqual(['2'])
  expect(explicit(sql,backend,['1','2'],'DESC').map(row=>row.id)).toEqual(['tag:google.com,2005:reader/item/0000000000000002'])
  expect(metadata(sql,'unread-count',backend)).toMatchObject({max:1})
  new LocalStateService(db,backend).editReaderNumbers([1n,2n],{read:true})
  expect(ingestFeed(db,{...options,xml}).results[0].status).toBe('tombstoned')
  ingestFeed(db,{...options,xml:xml.replace('<guid>0</guid>','<guid>new</guid>')})
  expect(Number(sql.prepare('SELECT max(sequence) n FROM article_arrivals').get()!.n)).toBeGreaterThan(2)
})

it('keeps quickadd behind the production private-address policy', async () => {
  const { discoveryTransport } = await import('../src/server/discovery-transport')
  const { createServer } = await import('node:http')
  let requests = 0
  const server = createServer((_req,res) => { requests++; res.end('<rss version="2.0"><channel/></rss>') })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const port = (server.address() as {port:number}).port
    const organization = new GreaderOrganization(db,backend,discoveryTransport([]))
    await expect(organization.quickadd(`http://127.0.0.1:${port}/feed`)).rejects.toThrow()
    await expect(organization.quickadd('https://user:password@example.test/feed')).rejects.toThrow(/credentials/)
    expect(requests).toBe(0)
    expect(db.greaderDatabase.prepare('SELECT count(*) n FROM feeds').get()!.n).toBe(1)
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())) }
})

it.each(['app', 'global', 'disabled'])('checks %s revocation inside discovery and state write transactions without connection polling', async invalidation => {
  const { assertReaderCredential } = await import('../src/server/greader-auth')
  const { LocalStateService } = await import('../src/server/local-state')
  await seedArticles(2)
  await db.auth.createApp('Synthetic pending mutation', null)
  const credential = db.auth.apps()[0], sql = db.greaderDatabase
  const auth = new GreaderAuth(sql, db.auth, true, 'http://localhost')
  auth.configure(true, 'reader')
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const organization = new GreaderOrganization(db, backend, async url => {
    await gate
    return { responseUrl: url, body: '<rss version="2.0"><channel><title>Pending</title></channel></rss>', contentType: 'application/rss+xml' }
  })
  const authorize = () => { expect(sql.isTransaction).toBe(true); assertReaderCredential(sql, credential) }
  const quickadd = organization.quickadd('https://example.test/pending-quickadd', authorize)
  const subscribe = organization.subscribe(form({ s: 'feed/https://example.test/pending-subscribe', ac: 'subscribe' }), authorize)
  const before = db.organization.metadata(backend)
  if (invalidation === 'app') db.auth.revokeApp(credential.id)
  // A generation-only change tests the global comparison independently of revoked rows.
  if (invalidation === 'global') sql.exec('UPDATE auth_meta SET generation = generation + 1')
  if (invalidation === 'disabled') auth.configure(false, 'reader')
  const rejectedQuickadd = expect(quickadd).rejects.toMatchObject({ status: 401 })
  const rejectedSubscribe = expect(subscribe).rejects.toMatchObject({ status: 401 })
  resume(); await Promise.all([rejectedQuickadd, rejectedSubscribe])
  expect(db.organization.metadata(backend)).toEqual(before)
  expect(() => new LocalStateService(db, backend).editReaderNumbers([1n], { read: true }, authorize)).toThrow(expect.objectContaining({ status: 401 }))
  expect(() => organization.edit('subscription/edit', form({ s: `feed/${db.linkNumber('feed', feed)}`, ac: 'unsubscribe' }), authorize)).toThrow(expect.objectContaining({ status: 401 }))
  expect(sql.prepare('SELECT sum(read) read, sum(state_revision) revision FROM entries').get()).toMatchObject({ read: 0, revision: 0 })
  expect(db.organization.metadata(backend)).toEqual(before)
})

it('passes disconnect cancellation through discovery and prevents a late transport from writing', async () => {
  const controller = new AbortController()
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const organization = new GreaderOrganization(db, backend, async (url, signal) => {
    expect(signal).toBe(controller.signal)
    await gate
    return { responseUrl: url, body: '<rss version="2.0"><channel/></rss>', contentType: 'application/rss+xml' }
  })
  const pending = organization.quickadd('https://example.test/disconnected', () => {}, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  controller.abort(); resume(); await rejected
  expect(db.greaderDatabase.prepare("SELECT id FROM feeds WHERE url = 'https://example.test/disconnected'").get()).toBeUndefined()
})

it('returns every article after feed organization changes without updating article clocks', async () => {
  await seedArticles(1260)
  const sql = db.greaderDatabase
  const organization = new GreaderOrganization(db, backend, async () => { throw new Error() })
  const stream = `feed/${db.linkNumber('feed', feed)}`
  const q = { backend, stream: { kind: 'state' as const, id: 'reading-list' }, it: [], xt: [], ot: 1001, nt: 0, order: 'ASC' as const, n: 250 }
  const reset = () => sql.exec('UPDATE entries SET first_seen_at = 1000000, greader_modified_ms = 1000000; UPDATE feeds SET greader_modified_ms = 1000000')
  const clock = () => sql.prepare('SELECT greader_modified_ms n FROM feeds WHERE id = ?').get(feed)!.n
  const all = () => {
    let last: string | undefined, high: string | undefined, count = 0
    do {
      const result = page(sql, { ...q, high, last }, false)
      count += result.values.length; last = result.last; high = result.high
    } while (last)
    expect(count).toBe(1260)
    expect(sql.prepare('SELECT min(greader_modified_ms) low, max(greader_modified_ms) high FROM entries').get()).toMatchObject({ low: 1000000, high: 1000000 })
    expect(page(sql, { ...q, ot: 0, nt: 1000 }, false).values).toHaveLength(0)
  }
  for (const [kind, fields] of [
    ['subscription/edit', { s: stream, ac: 'edit', t: 'Renamed' }],
    ['subscription/edit', { s: stream, ac: 'edit', a: `${LABEL}Folder` }],
    ['rename-tag', { s: `${LABEL}Folder`, dest: `${LABEL}Renamed folder` }],
    ['subscription/edit', { s: stream, ac: 'edit', a: `${LABEL}Moved` }],
  ] as [string, Record<string, string>][]) {
    reset(); expect(page(sql, q, false).values).toHaveLength(0)
    organization.edit(kind, form(fields)); all()
    const changed = clock()
    if (kind !== 'rename-tag') { organization.edit(kind, form(fields)); expect(clock()).toBe(changed) }
    else { organization.edit(kind, form({ s: fields.dest, dest: fields.dest })); expect(clock()).toBe(changed) }
  }
  reset(); organization.edit('disable-tag', form({ s: `${LABEL}Moved` })); all()
  organization.edit('subscription/edit', form({ s: stream, ac: 'unsubscribe' }))
  reset(); expect(page(sql, q, false).values).toHaveLength(0)
  organization.edit('subscription/edit', form({ s: stream, ac: 'subscribe' })); all()
  const active = clock(); organization.edit('subscription/edit', form({ s: stream, ac: 'subscribe' })); expect(clock()).toBe(active)
  reset()
  const { StandaloneBackend } = await import('../src/server/standalone-backend')
  const local = new StandaloneBackend(db)
  await local.repairFeed(feed, 'https://example.test/repaired', 'https://example.test/feed'); all()
  const repaired = clock(); await local.repairFeed(feed, 'https://example.test/repaired', 'https://example.test/repaired'); expect(clock()).toBe(repaired)
  reset(); sql.exec('UPDATE feeds SET greader_modified_ms = 1001000')
  expect(page(sql, { ...q, nt: 1001 }, false).values).toHaveLength(250)
  expect(page(sql, { ...q, ot: 1002 }, false).values).toHaveLength(0)
})

it('uses indexed arrival, article and feed modification paths for sparse incremental sync', async () => {
  await seedArticles(5)
  const q = { backend, stream: { kind: 'state' as const, id: 'reading-list' }, it: [], xt: [], ot: Math.ceil(Date.now() / 1000) + 60, nt: 0, order: 'DESC' as const, n: 250 }
  const filter = where(q), scan = scanPageFrom(db.greaderDatabase, q)
  const plan = db.greaderDatabase.prepare(`EXPLAIN QUERY PLAN SELECT a.sequence ${scan.from} WHERE ${filter.sql}${scan.extra} ORDER BY a.sequence DESC LIMIT 251`).all(...filter.args).map(row => row.detail).join('; ')
  for (const index of ['entries_first_seen_idx', 'greader_modified', 'greader_feed_modified', 'entries_feed_published_idx']) expect(plan).toContain(index)
  expect(plan).not.toMatch(/SCAN (e|a)\b/)
})



it.each(['unread', 'starred'])('uses the partial index for sparse %s pages', async state => {
  await seedArticles(5)
  const sql = db.greaderDatabase
  sql.exec('UPDATE entries SET read = 1, starred = 0')
  sql.exec(`UPDATE entries SET ${state === 'unread' ? 'read = 0' : 'starred = 1'} WHERE rowid IN (2, 4)`)
  const q = { backend, stream: { kind: 'state' as const, id: state }, it: [], xt: [], ot: 0, nt: 0, order: 'DESC' as const, n: 250 }
  const filter = where(q), scan = scanPageFrom(sql, q)
  const plan = sql.prepare(`EXPLAIN QUERY PLAN SELECT a.sequence ${scan.from} WHERE ${filter.sql}${scan.extra} ORDER BY a.sequence DESC LIMIT 251`).all(...filter.args).map(row => row.detail).join('; ')
  expect(plan).toContain(`USING ${state === 'unread' ? 'COVERING ' : ''}INDEX greader_${state}`)
  expect(plan).not.toMatch(/SCAN a\b/)
  expect(page(sql, q, false).values.map(row => row.id)).toEqual(['4', '2'])
})


it.each(['web state', 'reader state', 'undo', 'retention'])('advances the clock with one article update for %s', async writer => {
  await seedArticles(1)
  const { LocalStateService } = await import('../src/server/local-state')
  const { defaultPolicy, DAY } = await import('../src/server/retention-store')
  const sql = db.greaderDatabase, service = new LocalStateService(db, backend)
  const id = String(sql.prepare('SELECT id FROM entries').get()!.id)
  const undo = { token: 'clock-undo', expiresAt: new Date(Date.now() + 60000).toISOString() }
  if (writer === 'undo') service.editEntries([id], 'read', { undo })
  // A future clock exercises the monotonic branch without depending on timers.
  const before = Date.now() + 10 * 365 * DAY
  sql.prepare('UPDATE entries SET first_seen_at = ?, greader_modified_ms = ?').run(Date.now() - 200 * DAY, before)
  sql.exec(`CREATE TABLE article_updates (id TEXT);
    CREATE TRIGGER count_article_updates AFTER UPDATE ON entries BEGIN INSERT INTO article_updates VALUES (new.id); END`)
  if (writer === 'web state') service.editEntries([id], 'read')
  else if (writer === 'reader state') service.editReaderNumbers([1n], { read: true, starred: true })
  else if (writer === 'undo') service.undo(undo.token)
  else {
    const run = db.retention.start({ ...defaultPolicy(), autoReadDays: 1 })
    service.retentionBatch(run, true)
  }
  expect(sql.prepare('SELECT greader_modified_ms n FROM entries').get()!.n).toBe(before + 1)
  expect(sql.prepare('SELECT count(*) n FROM article_updates').get()!.n).toBe(1)
})
