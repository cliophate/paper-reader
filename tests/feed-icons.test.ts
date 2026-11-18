import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createServer, type Server, type RequestListener } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { declaredFeedIcons, discoverFeedIcon, MAX_ICON_HEAD_BYTES } from '../src/server/feed-icon-discovery.js'
import { feedIconPath, MAX_FEED_ICON_BYTES, rasterIcon } from '../src/server/feed-icon-format.js'
import { FeedIconService } from '../src/server/feed-icons.js'
import { openCoordinatedStorage } from '../src/server/storage-bootstrap.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSHAAAAFkAMH+ZHNfAAAAAElFTkSuQmCC', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.test=1</script></svg>'
const publicUrl = 'https://paper.example.test'
const hour = 60 * 60 * 1000
const day = 24 * hour
const servers: Server[] = []
const databases: PaperDatabase[] = []
const directories: string[] = []

async function fixture(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
function library() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-feed-icons-'))
  directories.push(directory)
  const file = path.join(directory, 'paper.sqlite')
  const db = new PaperDatabase(file)
  databases.push(db)
  return { directory, file, db, backend: db.bindStandalone().id }
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

it('ranks square head icons, resolves the first base, and caps and deduplicates URLs', () => {
  const html = `<!doctype html><html><head>
    <link rel="shortcut ICON" sizes="32x32" href="two.png#one">
    <link rel="icon" sizes="32x32" href="two.png#two">
    <link rel="apple-touch-icon" sizes="180x180 64x64" href="first.png">
    <link rel="icon" sizes="240x60 512x512" href="wide.png">
    <link rel="icon" href="unknown.png"><link rel="icon" sizes="16x16" href="small.png">
    <template><head><link rel="icon" sizes="64x64" href="template.png"></head></template>
    <script>const text = '<link rel="icon" sizes="64x64" href="script.png">';</script>
    <link rel="icon" href="data:image/png,abc"><link rel="icon" href="https://name:pass@sample.test/">
    <base href="../img/"><base href="https://ignored.test/">
    </head><body><link rel="icon" sizes="64x64" href="body.png"></body></html>`
  expect(declaredFeedIcons(html, 'https://sample.test/news/index.html')).toEqual(
    ['first.png', 'two.png', 'unknown.png', 'wide.png'].map(name => 'https://sample.test/img/' + name),
  )
  expect(declaredFeedIcons('<link rel="icon" href="implicit.png"><div><link rel="icon" href="body.png">', 'https://sample.test/'))
    .toEqual(['https://sample.test/implicit.png'])
})

it('reads only the first 64 KiB of large HTML and applies the parser limit in bytes', async () => {
  expect(declaredFeedIcons('<link rel="icon" href="/icon.png">' + 'é'.repeat(MAX_ICON_HEAD_BYTES / 2), publicUrl)).toEqual([])
  expect(declaredFeedIcons('<head>' + '<template>'.repeat(60) + '</template>'.repeat(60)
    + '<link rel="icon" href="/deep.png"></head>', publicUrl)).toEqual([])
  const calls: string[] = []
  const origin = await fixture((req, res) => {
    calls.push(req.url!)
    if (req.url === '/early' || req.url === '/late') {
      const filler = '<!-- ' + 'a'.repeat(MAX_ICON_HEAD_BYTES * 3) + ' -->'
      const link = '<link rel="icon" href="/icon.png">'
      const body = '<head>' + (req.url === '/early' ? link + filler : filler + link) + '</head>'
      res.setHeader('Content-Type', 'text/html')
      const bytes = req.url === '/late' ? gzipSync(body) : Buffer.from(body)
      if (req.url === '/late') res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Content-Length', bytes.length)
      return res.end(bytes)
    }
    if (req.url === '/icon.png') return res.end(png)
    res.writeHead(404).end()
  })
  const options = { trustedOrigins: [origin], signal: new AbortController().signal, isLocal: () => false }
  const feed = { url: origin + '/rss.xml', iconUrl: '' }
  expect(await discoverFeedIcon({ ...feed, siteUrl: origin + '/early' }, options)).toEqual({ bytes: png, extension: 'png' })
  expect(await discoverFeedIcon({ ...feed, siteUrl: origin + '/late' }, options)).toBeNull()
  expect(calls).toEqual(['/early', '/icon.png', '/late', '/favicon.ico'])
})

it('recognizes the supported magic bytes and rejects unsupported or damaged headers', () => {
  const icoDirectory = Buffer.from('00000100010001010000010020000000000016000000', 'hex')
  icoDirectory.writeUInt32LE(png.length, 14)
  const ico = Buffer.concat([icoDirectory, png])
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
  const webp = Buffer.from('5249464612000000574542505650384c050000002f0000000000', 'hex')
  expect([png, ico, gif, jpg, webp].map(rasterIcon)).toEqual(['png', 'ico', 'gif', 'jpg', 'webp'])
  const fakeIco = Buffer.concat([icoDirectory, Buffer.from(svg)])
  expect([Buffer.from(svg), png.subarray(0, 8), ico.subarray(0, 30), fakeIco, gif.subarray(0, 10),
    webp.subarray(0, 20), jpg.subarray(0, 12), Buffer.alloc(MAX_FEED_ICON_BYTES + 1)].map(rasterIcon)).toEqual(Array(8).fill(null))
})

it('tries the migrated URL first and skips discovery when it returns an image', async () => {
  const urls: string[] = []
  const origin = await fixture((req, res) => {
    urls.push(req.url!)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.end(png)
  })
  expect(await discoverFeedIcon({ iconUrl: origin + '/f.php?h=legacy', siteUrl: origin + '/home', url: origin + '/rss.xml' },
    { trustedOrigins: [origin], signal: new AbortController().signal, isLocal: () => false })).toEqual({ bytes: png, extension: 'png' })
  expect(urls).toEqual(['/f.php?h=legacy'])
})

it('skips Paper URLs, rejects SVG and oversized compressed images, then tries the site favicon', async () => {
  const urls: string[] = []
  const origin = await fixture((req, res) => {
    urls.push(req.url!)
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html')
      return res.end('<head><link rel="icon" href="/large" sizes="64x64"><link rel="apple-touch-icon" href="/fake.png" sizes="32x32"></head>')
    }
    if (req.url === '/large') {
      res.setHeader('Content-Encoding', 'gzip')
      return res.end(gzipSync(Buffer.concat([png, Buffer.alloc(MAX_FEED_ICON_BYTES)])))
    }
    if (req.url === '/fake.png') { res.setHeader('Content-Type', 'image/png'); return res.end(svg) }
    res.end(gif)
  })
  expect(await discoverFeedIcon({ iconUrl: origin + '/feed-icons/' + 'a'.repeat(64) + '.png', siteUrl: '', url: origin + '/rss.xml' },
    { trustedOrigins: [origin], signal: new AbortController().signal, isLocal: url => !!feedIconPath(url.pathname) })).toEqual({ bytes: gif, extension: 'gif' })
  expect(urls).toEqual(['/', '/large', '/fake.png', '/favicon.ico'])
})

it('rechecks private origins on HTML and image redirects and uses the site response URL for relative links', async () => {
  const requested: string[] = []
  const other = await fixture((req, res) => { requested.push(req.url!); res.end(png) })
  const origin = await fixture((req, res) => {
    requested.push(req.url!)
    if (req.url === '/page') return res.writeHead(302, { Location: '/nested/page' }).end()
    if (req.url === '/nested/page') return res.setHeader('Content-Type', 'text/html').end('<link rel="icon" href="logo">')
    if (req.url === '/nested/logo' || req.url === '/redirect') return res.writeHead(302, { Location: other + '/logo' }).end()
    res.writeHead(404).end()
  })
  const feed = { iconUrl: other + '/original', siteUrl: origin + '/page', url: origin + '/rss.xml' }
  const options = { signal: new AbortController().signal, isLocal: () => false }
  expect(await discoverFeedIcon(feed, { ...options, trustedOrigins: [] })).toBeNull()
  expect(requested).toEqual([])
  expect(await discoverFeedIcon(feed, { ...options, trustedOrigins: [origin] })).toBeNull()
  expect(requested.splice(0)).toEqual(['/page', '/nested/page', '/nested/logo', '/favicon.ico'])
  expect(await discoverFeedIcon({ ...feed, iconUrl: '', siteUrl: origin + '/redirect' }, { ...options, trustedOrigins: [origin] })).toBeNull()
  expect(requested.splice(0)).toEqual(['/redirect', '/favicon.ico'])
  expect(await discoverFeedIcon({ ...feed, iconUrl: '' }, { ...options, trustedOrigins: [origin, other] })).toEqual({ bytes: png, extension: 'png' })
  expect(requested).toEqual(['/page', '/nested/page', '/nested/logo', '/logo'])
})

function downgrade(db: PaperDatabase) {
  db.greaderDatabase.exec(`
    DROP TABLE feed_icon_state;
    DROP TABLE feed_icons;
    DELETE FROM sync_state WHERE key = 'feed_icon_key';
    DROP TRIGGER greader_feed;
    CREATE TRIGGER greader_feed AFTER UPDATE OF title, url, site_url, active ON feeds
    WHEN old.title IS NOT new.title OR old.url IS NOT new.url OR old.site_url IS NOT new.site_url OR old.active IS NOT new.active
    BEGIN UPDATE feeds SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = new.id; END;
    PRAGMA user_version = 17;
  `)
  databases.splice(databases.indexOf(db), 1)
  db.close()
}

it('upgrades a standalone v17 database with FreshRSS URLs and keeps a private rollback backup', async () => {
  const { directory, file, db, backend } = library()
  const origin = await fixture((_req, res) => res.end(png))
  const migrated = origin + '/f.php?h=legacy'
  const id = db.saveLocalSubscription(backend, { title: 'Migrated', url: origin + '/rss.xml', iconUrl: migrated })
  const revision = db.organization.revision(backend)
  downgrade(db)

  const storage = await openCoordinatedStorage(directory)
  const upgraded = storage.database
  try {
    const backupPath = file + '.before-feed-icons-v18'
    expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600)
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    try {
      expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(17)
      expect(backup.prepare('SELECT icon_url FROM feeds WHERE id = ?').get(id)?.icon_url).toBe(migrated)
    } finally { backup.close() }
    expect(upgraded.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(18)
    expect(upgraded.localNavigation().uncategorized[0].iconUrl).toBe(migrated)
    const updated = vi.fn()
    const service = new FeedIconService(upgraded.feedIcons, backend, publicUrl, [origin], updated)
    await service.runDue()
    const iconUrl = upgraded.localNavigation().uncategorized[0].iconUrl
    expect(iconUrl).toMatch(/^https:\/\/paper\.example\.test\/feed-icons\/[a-f0-9]{64}\.png$/)
    expect(upgraded.organization.revision(backend)).toBe(revision + 1)
    expect(Number(upgraded.greaderDatabase.prepare('SELECT greader_modified_ms FROM feeds').get()?.greader_modified_ms)).toBeGreaterThan(0)
    expect(updated).toHaveBeenCalledOnce()
    const reopened = new PaperDatabase(file)
    try {
      const { hash, extension } = feedIconPath(new URL(iconUrl).pathname)!
      expect(reopened.feedIcons.get(hash, extension)).toEqual(png)
    } finally { reopened.close() }
  } finally { storage.close() }
})

it('rolls back a failed v18 migration and keeps the original backup for a retry', async () => {
  const { directory, file, db } = library()
  downgrade(db)
  const sql = new DatabaseSync(file)
  try {
    sql.exec('CREATE VIEW feed_icon_state AS SELECT 1 AS incompatible')
    await expect(openCoordinatedStorage(directory)).rejects.toThrow()
    expect(sql.prepare('PRAGMA user_version').get()?.user_version).toBe(17)
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'feed_icons'").get()).toBeUndefined()
    const backupPath = file + '.before-feed-icons-v18'
    const backup = fs.readFileSync(backupPath)
    sql.exec('DROP VIEW feed_icon_state')
    const storage = await openCoordinatedStorage(directory)
    storage.close()
    expect(fs.readFileSync(backupPath)).toEqual(backup)
  } finally { sql.close() }
})

it('deduplicates by content and retains replaced images for the immutable cache lifetime', () => {
  const { db, backend } = library()
  const store = db.feedIcons
  const original = db.saveLocalSubscription(backend, { title: 'First', url: 'https://example.test/rss' })
  const second = db.saveLocalSubscription(backend, { title: 'Second', url: 'https://example.test/second' })
  const now = Date.now()
  for (const attempt of store.due(backend, now, 4)) {
    expect(store.complete(backend, attempt, { bytes: png, extension: 'png' }, publicUrl, now)).toBe(true)
  }
  const firstUrl = db.localNavigation().uncategorized.find(feed => feed.id === original)?.iconUrl
  expect(firstUrl).toBe(db.localNavigation().uncategorized.find(feed => feed.id === second)?.iconUrl)
  const { hash } = feedIconPath(new URL(firstUrl!).pathname)!
  expect(store.get(hash, 'png')).toEqual(png)
  expect(store.get(hash, 'jpg')).toBeUndefined()
  expect(store.get(createHash('sha256').update(png).digest('hex'), 'png')).toBeUndefined()
  expect(store.due(backend, now + 30 * day - 1, 4)).toEqual([])
  const refreshed = now + 30 * day
  const [unchanged, failed] = store.due(backend, refreshed, 4)
  const revision = db.organization.revision(backend)
  const markers = db.greaderDatabase.prepare('SELECT greader_modified_ms FROM feeds ORDER BY id').all()
  expect(store.complete(backend, unchanged, { bytes: png, extension: 'png' }, publicUrl, refreshed)).toBe(false)
  expect(store.complete(backend, failed, null, publicUrl, refreshed)).toBe(false)
  expect(db.localNavigation().uncategorized.map(feed => feed.iconUrl)).toEqual([firstUrl, firstUrl])
  expect(db.greaderDatabase.prepare('SELECT greader_modified_ms FROM feeds ORDER BY id').all()).toEqual(markers)
  expect(db.organization.revision(backend)).toBe(revision)
  expect(db.greaderDatabase.prepare('SELECT count(*) AS n FROM feed_icons').get()?.n).toBe(1)
  for (const attempt of store.due(backend, refreshed + 30 * day, 4)) {
    expect(store.complete(backend, attempt, { bytes: gif, extension: 'gif' }, publicUrl, refreshed + 30 * day)).toBe(true)
  }
  expect(store.prune(backend, refreshed + 30 * day + 365 * day - 1)).toBe(0)
  expect(store.prune(backend, refreshed + 30 * day + 365 * day)).toBe(1)
  expect(store.get(hash, 'png')).toBeUndefined()
})

it('remembers failures across restart, keeps the current URL, and skips stale completions after repair', async () => {
  const { db, backend, file } = library()
  const origin = await fixture((_req, res) => res.writeHead(404).end())
  const iconUrl = origin + '/f.php?h=legacy'
  const oldUrl = origin + '/feed.xml'
  const id = db.saveLocalSubscription(backend, { title: 'Existing', url: oldUrl, iconUrl })
  const revision = db.organization.revision(backend)
  const updated = vi.fn()
  const service = new FeedIconService(db.feedIcons, backend, publicUrl, [origin], updated)
  await service.runDue()
  expect(db.localNavigation().uncategorized[0].iconUrl).toBe(iconUrl)
  expect(db.organization.revision(backend)).toBe(revision)
  expect(updated).not.toHaveBeenCalled()

  const reopened = new PaperDatabase(file)
  try {
    const { last_failure_at, next_attempt_at } = reopened.greaderDatabase.prepare('SELECT * FROM feed_icon_state').get()!
    const next = Number(next_attempt_at)
    expect(next - Number(last_failure_at)).toBe(hour)
    expect(reopened.feedIcons.due(backend, next - 1, 4)).toEqual([])
    const [attempt] = reopened.feedIcons.due(backend, next, 4)
    reopened.feedIcons.complete(backend, attempt, null, publicUrl, next)
    expect(reopened.feedIcons.due(backend, next + 2 * hour - 1, 4)).toEqual([])
    const [retry] = reopened.feedIcons.due(backend, next + 2 * hour, 4)
    db.saveLocalSubscription(backend, { id, title: 'Existing', url: origin + '/fixed.xml', iconUrl })
    expect(reopened.feedIcons.complete(backend, retry, { bytes: png, extension: 'png' }, publicUrl, next + 2 * hour)).toBe(false)
    expect(reopened.localNavigation().uncategorized[0].iconUrl).toBe(iconUrl)
    expect(reopened.feedIcons.due(backend, next, 4)[0]).toMatchObject({ url: origin + '/fixed.xml', failures: 0 })
  } finally { reopened.close() }
})

it('takes at most four feeds per run, starts with new subscriptions and uses two workers', async () => {
  const { db, backend } = library()
  const pending: Array<() => void> = []
  const requests: string[] = []
  const origin = await fixture((req, res) => {
    requests.push(req.url!)
    pending.push(() => res.end(png))
  })
  for (let i = 0; i < 6; i++) db.saveLocalSubscription(backend, { title: String(i), url: origin + '/rss/' + i, iconUrl: origin + '/icon/' + i })
  const service = new FeedIconService(db.feedIcons, backend, publicUrl, [origin], () => {})
  const work = service.runDue()
  expect(service.runDue()).toBe(work)
  for (let batch = 0; batch < 2; batch++) {
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(requests.slice(batch * 2).sort()).toEqual([4 - batch * 2, 5 - batch * 2].map(i => '/icon/' + i))
    pending.splice(0).forEach(finish => finish())
  }
  await work
  expect(requests).toHaveLength(4)
  expect(db.feedIcons.due(backend, Date.now(), 4)).toHaveLength(2)
})
