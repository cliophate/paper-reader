import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DATABASE_VERSION, FEED_OVERRIDE_VERSION } from '../src/server/auth-schema'
import { PaperDatabase } from '../src/server/db'
import { ingestFeed } from '../src/server/feed-ingestion'
import { boundedFetch } from '../src/server/feed-http'
import { extractWithOverrides } from '../src/server/feed-extraction'
import { validateOverrides } from '../src/server/feed-overrides'
import { ReaderService } from '../src/server/reader'

vi.mock('../src/server/feed-http', async original => ({ ...await original<typeof import('../src/server/feed-http')>(), boundedFetch: vi.fn() }))
const defaults = { userAgent: '', articleCookieOrigin: '', contentSelector: '', removeSelectors: [], lazyImages: false, stripTracking: false }
const story = 'https://example.test/story'
const html = `<title>Fixture</title><article><p>${'Outside paragraph. '.repeat(25)}</p></article><main class="story">
  <p>${'Selected paragraph. '.repeat(25)}</p><aside class="omit">Promotion</aside>
  <a href="/more?id=4&amp;q=a%20b&amp;utm_source=mail&amp;mc_eid=example#anchor">More</a><script>bad()</script>
  <img src="/low.jpg" data-src="/large.jpg" data-srcset="/small,a.jpg 1x, /large.jpg 2x" onerror="bad()"></main>`
let db: PaperDatabase, directory: string, filename: string, feedId: string, entryId: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-feed-overrides-'))
  filename = path.join(directory, 'paper.sqlite')
  db = new PaperDatabase(filename)
  const backend = db.bindStandalone()
  const url = 'https://example.test/rss'
  feedId = db.saveLocalSubscription(backend.id, { url, title: 'Fixture feed' })
  ingestFeed(db, { backendId: backend.id, subscriptionId: feedId, endpointGeneration: 'fixture', requestUrl: url, responseUrl: url,
    fetchedAt: new Date().toISOString(), xml: `<rss version="2.0"><channel><title>Fixture feed</title><item><guid>one</guid><title>Fixture</title><link>${story}</link></item></channel></rss>` })
  entryId = db.recentEntryIds(1)[0]
  vi.mocked(boundedFetch).mockResolvedValue({ status: 200, url: story, text: html, contentType: 'text/html', conditional: false })
})
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('rejects header controls before trimming and bounds selector input', () => {
  for (const invalid of ['\r', '\n', '\t', '\x00', '\x7f', '\u2028']) {
    for (const key of ['cookie', 'userAgent']) expect(() => validateOverrides({ ...defaults, [key]: 'test' + invalid })).toThrow('one line')
  }
  for (const invalid of [{ cookie: 'a'.repeat(4097) }, { userAgent: 'a'.repeat(513) }, { contentSelector: '[' }, { contentSelector: 'article:has(p)' }, { removeSelectors: ['p:nth-child(2n)'] },
    { trackingExcludedHosts: ['https://example.test/path'] },
    { contentSelector: 'a'.repeat(257) }, { removeSelectors: Array(13).fill('p') }]) expect(() => validateOverrides({ ...defaults, ...invalid })).toThrow()
})

it('keeps, replaces and clears a private cookie and pins its original origin across repairs', () => {
  const cookie = 'fixture=synthetic'
  const saved = db.feedOverrides.save(feedId, { ...defaults, cookie, expectedCookieOrigin: 'https://example.test' })
  expect(saved.cookieSet).toBe(true)
  expect(JSON.stringify(saved)).not.toContain(cookie)
  expect(JSON.stringify(db.feedOverrides.view(feedId))).not.toContain(cookie)
  expect(db.greaderDatabase.prepare('SELECT cookie FROM feed_overrides').get()?.cookie).not.toContain(cookie)
  db.close(); db = new PaperDatabase(filename)
  db.greaderDatabase.prepare('UPDATE feeds SET url = ? WHERE id = ?').run('https://other.test/rss', feedId)
  expect(() => db.feedOverrides.save(feedId, { ...defaults, cookie, expectedCookieOrigin: 'https://example.test' })).toThrow('feed origin')
  db.feedOverrides.save(feedId, { ...defaults, lazyImages: true })
  expect(db.feedOverrides.get(feedId)).toMatchObject({ cookie, cookieOrigin: 'https://example.test' })
  db.feedOverrides.save(feedId, { ...defaults, cookie: 'fixture=replaced', expectedCookieOrigin: 'https://other.test' })
  expect(db.feedOverrides.get(feedId)).toMatchObject({ cookie: 'fixture=replaced', cookieOrigin: 'https://other.test' })
  expect(() => db.feedOverrides.save(feedId, { ...defaults, articleCookieOrigin: 'https://publisher.test' })).toThrow('cookie again')
  expect(db.feedOverrides.save(feedId, { ...defaults, cookie: null }).cookieSet).toBe(false)
  expect(db.feedOverrides.get(feedId)).toBeUndefined()
})

it('previews unsaved rules against the stored article without changing its settings or cache', async () => {
  const reader = new ReaderService(db)
  const saved = { ...defaults, userAgent: 'Fixture reader', cookie: 'fixture=synthetic', expectedCookieOrigin: 'https://example.test' }
  db.feedOverrides.save(feedId, saved)
  const overrides = { ...defaults, userAgent: 'Draft reader', contentSelector: '.story', removeSelectors: ['.omit'], stripTracking: true, lazyImages: true }
  await expect(reader.fetch(story, 0, undefined, entryId, { feedId: 'other', overrides })).rejects.toThrow('this feed')
  const preview = await reader.fetch('https://other.test/', 0, undefined, entryId, { feedId, overrides })
  expect(boundedFetch).toHaveBeenCalledWith(story, expect.objectContaining({ userAgent: 'Draft reader', cookie: { origin: 'https://example.test', value: saved.cookie } }))
  expect(preview.contentHtml).toContain('Selected paragraph')
  expect(preview.contentHtml).toContain('https://example.test/more?id=4&amp;q=a%20b#anchor')
  expect(preview.contentHtml).toContain('srcset="https://example.test/small,a.jpg 1x, https://example.test/large.jpg 2x"')
  expect(preview.contentHtml).not.toMatch(/Outside paragraph|Promotion|low.jpg|onerror|bad\(\)|utm_source/)
  expect(db.getArticleForEntry(entryId)).toBeNull()
  expect(db.feedOverrides.view(feedId).userAgent).toBe(saved.userAgent)
  db.feedOverrides.save(feedId, { ...overrides, stripTracking: false })
  const article = await reader.fetch(story, undefined, undefined, entryId)
  expect(article.contentHtml).toContain('utm_source')
  expect(db.getArticleForEntry(entryId)?.contentHtml).toBe(article.contentHtml)
  expect((await reader.fetch(story, undefined, undefined, entryId)).cached).toBe(true)
  expect(db.getArticle(story)).toBeNull()
  db.feedOverrides.save(feedId, { ...defaults, contentSelector: '.absent' })
  await expect(reader.fetch(story, undefined, undefined, entryId)).rejects.toThrow('did not match')
  expect(db.getArticleForEntry(entryId)).toBeNull()
})

it('sends a replacement cookie to an additional article origin only after the owner chooses it', async () => {
  const publisher = 'https://publisher.test'
  db.greaderDatabase.prepare('UPDATE entries SET url = ? WHERE id = ?').run(publisher + '/story', entryId)
  db.feedOverrides.save(feedId, { ...defaults, cookie: 'fixture=synthetic', expectedCookieOrigin: 'https://example.test', articleCookieOrigin: publisher })
  await new ReaderService(db).fetch(story, 0, undefined, entryId)
  expect(boundedFetch).toHaveBeenCalledWith(publisher + '/story', expect.objectContaining({ cookie: { origin: publisher, value: 'fixture=synthetic' } }))
})

it('previews the configured reader fallback only when the draft restores defaults', async () => {
  const reader = new ReaderService(db, true)
  vi.mocked(boundedFetch).mockResolvedValue({ status: 403, url: story, text: '', contentType: 'text/html', conditional: false })

  await expect(reader.fetch(story, 0, undefined, entryId, { feedId, overrides: { ...defaults, userAgent: 'Fixture' } })).rejects.toThrow('403')
  expect(boundedFetch).toHaveBeenCalledTimes(1)
  vi.mocked(boundedFetch).mockResolvedValueOnce({ status: 403, url: story, text: '', contentType: '', conditional: false })
    .mockResolvedValueOnce({ status: 200, url: story, text: JSON.stringify({ data: { html } }), contentType: 'application/json', conditional: false })
  await expect(reader.fetch(story, 0, undefined, entryId, { feedId, overrides: defaults })).resolves.toMatchObject({ cached: false })
  expect(boundedFetch).toHaveBeenLastCalledWith('https://r.jina.ai/' + story, expect.objectContaining({ maxRedirects: 0 }))
  expect(db.getArticleForEntry(entryId)).toBeNull()
})

it('backs up the previous schema before adding feed overrides', () => {
  db.greaderDatabase.exec(`DROP TABLE feed_overrides; PRAGMA user_version = ${FEED_OVERRIDE_VERSION - 1}`)
  db.close(); db = new PaperDatabase(filename)
  expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
  expect(db.feedOverrides.view(feedId)).toMatchObject({ ...defaults, cookieSet: false, articles: [{ id: entryId }] })
  const backup = new DatabaseSync(filename + `.before-feed-overrides-v${FEED_OVERRIDE_VERSION}`, { readOnly: true })
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(FEED_OVERRIDE_VERSION - 1)
    expect(backup.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'feed_overrides'").get()).toBeUndefined()
  } finally { backup.close() }
})

const defaultPage = '<article><p>' + 'Default article paragraph. '.repeat(25) + '</p></article>'

it('terminates the worker at its deadline and retries default article extraction', async () => {
  const warning = vi.fn()
  const result = await extractWithOverrides({ kind: 'article', body: defaultPage, url: story },
    { ...defaults, contentSelector: '.absent' }, warning, undefined, 1)
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  expect(result.contentHtml).toContain('Default article paragraph')
})

it('returns default content and a preview warning for pages over the selector node limit', async () => {
  const nav = '<nav>' + ('<div>' + '<!--node-->'.repeat(100) + '</div>').repeat(100) + '</nav>'
  const text = nav + defaultPage
  vi.mocked(boundedFetch).mockResolvedValue({ status: 200, url: story, text, contentType: 'text/html', conditional: false })
  const overrides = { ...defaults, contentSelector: '.absent' }
  const result = await new ReaderService(db).fetch(story, 0, undefined, entryId, { feedId, overrides })
  expect(result.overrideWarning).toContain('10,000-node')
  expect(result.contentHtml).toContain('Default article paragraph')
  expect(db.feedOverrides.view(feedId).overrideWarning).toBeUndefined()
})

it('preserves whole signed queries and excluded hosts when stripping tracking', async () => {
  const names = ['sig', 'SIGNATURE', 'hash', 'token', 'expires', 'X-Amz-Date', 'X-Goog-Signature', 'Key-Pair-Id']
  const links = [...names.map(name => '/a?' + name + '=x%2fy&utm_source=v'), 'https://cdn.test/a?utm_source=v', 'https://xn--bcher-kva.test/a?utm_source=v', '/a?b=2&utm_source=v']
  vi.mocked(boundedFetch).mockResolvedValue({ status: 200, url: story, contentType: 'text/html', conditional: false,
    text: '<main>' + links.map(link => '<a href="' + link.replaceAll('&', '&amp;') + '">link</a>').join(' ') + '</main>' })
  const overrides = { ...defaults, stripTracking: true, contentSelector: 'main', trackingExcludedHosts: ['CDN.test', 'bücher.test'] }
  db.feedOverrides.save(feedId, overrides)
  const { contentHtml } = await new ReaderService(db).fetch(story, 0, undefined, entryId)
  for (const name of names) expect(contentHtml).toContain(name + '=x%2fy&amp;utm_source=v')
  expect(contentHtml).toContain('https://cdn.test/a?utm_source=v')
  expect(contentHtml).toContain('https://xn--bcher-kva.test/a?utm_source=v')
  expect(contentHtml).toContain('https://example.test/a?b=2"')
})

it('removes cached cookie-backed full text from search on reset', async () => {
  db.feedOverrides.save(feedId, { ...defaults, cookie: 'sid=synthetic', expectedCookieOrigin: 'https://example.test' })
  await new ReaderService(db).fetch(story, 0, undefined, entryId)
  const search = () => db.greaderDatabase.prepare("SELECT entry_id FROM entries_fts WHERE entries_fts MATCH 'paragraph'").all()
  expect(search()).toEqual([{ entry_id: entryId }])
  db.feedOverrides.save(feedId, { ...defaults, cookie: null })
  expect(search()).toEqual([])
  expect(db.getArticleForEntry(entryId)).toBeNull()
})
