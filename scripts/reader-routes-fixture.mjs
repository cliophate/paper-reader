import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import crypto from 'node:crypto'
import http from 'node:http'
import { PaperDatabase } from '../dist-server/db.js'
import { renderBriefing } from '../dist-server/email.js'
import { startOpenaiFixture } from '../tests/fixtures/openai-provider.mjs'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-reader-routes-'))
const state = path.join(temporary, 'data')
// Only this disposable publisher is allowlisted. Other loopback/private URLs
// still go through the production transport's address checks.
const publisher = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:4319')
  if (url.pathname === '/webhook-test') {
    response.writeHead(503)
    response.end('Synthetic private response')
  } else if (url.pathname.startsWith('/feed/')) {
    response.setHeader('Content-Type', 'application/rss+xml')
    response.end('<rss version="2.0"><channel><title>Synthetic shared feed</title><link>https://example.test</link><description>Disposable share fixture</description></channel></rss>')
  } else {
    response.setHeader('Content-Type', 'text/html')
    response.end(url.pathname === '/empty' ? '<html><title>No feeds</title></html>' : `<html><head><title>Synthetic publisher</title><link rel="alternate" type="application/rss+xml" title="Synthetic shared news" href="/feed${url.pathname}"><link rel="alternate" type="application/atom+xml" title="Synthetic replies" href="/feed/replies${url.pathname}"></head></html>`)
  }
})
publisher.listen(4319, '127.0.0.1'); await once(publisher, 'listening')
const openai = await startOpenaiFixture()
const db = new PaperDatabase(path.join(state, 'paper.sqlite'))
const backend = db.bindStandalone()
const feedId = db.saveLocalSubscription(backend.id, { title: 'Synthetic feed', url: 'https://example.test/feed' })
const otherFeed = db.saveLocalSubscription(backend.id, { title: '中文', url: 'https://example.test/other' })
let snapshot = db.organization.snapshot(backend.id)
db.organization.apply(backend.id, snapshot.revision, [{ type: 'create-folder', title: 'A' }])
snapshot = db.organization.snapshot(backend.id)
db.organization.apply(backend.id, snapshot.revision, [{ type: 'add-membership', feedId, folderId: snapshot.navigation.folders[0].id }])
const now = new Date().toISOString()
const reports = [
  'The Willow Creek footbridge opens on Saturday morning. Cyclists can use it as soon as it opens. The path to the park reopens at the same time.',
  'Crews moved the landing uphill after they found soft ground near the creek. The route through the park is about the same length.',
  'The footbridge is three metres wide, with room for people on foot and on bikes to pass each other.',
]
const storyUrl = index => `https://${index === 2 ? 'gazette' : 'example'}.test/story-${index}`
for (const [index, subscriptionId] of [[1, feedId], [2, feedId], [3, feedId], [4, otherFeed]]) {
  db.importSourceEntries(backend.id, subscriptionId, [{ identity: { externalId: `synthetic-${index}` }, entry: {
    feedTitle: subscriptionId === feedId ? 'Synthetic feed' : '中文', feedUrl: 'https://example.test/feed', title: `Synthetic article ${index}`, author: 'Fixture writer',
    url: storyUrl(index), contentHtml: '<p>This article belongs to a disposable route test. No account or live installation is involved.</p>'.repeat(12),
    excerpt: 'Disposable route fixture', publishedAt: now, timestamp: Date.now() - index, readingMinutes: 2, thumbnailUrl: '', kind: 'article',
  } }])
}
// The reader tests use feed text for scroll restoration. Put the reporting in the full-text cache.
for (const [index, report] of reports.entries()) db.cacheArticle({ url: storyUrl(index + 1),
  title: `Synthetic article ${index + 1}`, byline: 'Fixture writer', excerpt: report, contentHtml: `<p>${report}</p>`, readingMinutes: 1, fetchedAt: now })
const articles = db.localEntriesPage({ kind: 'all', id: 'all', title: 'All articles' }, { unreadOnly: false }).items
const members = articles.filter(article => article.feedId === feedId)
const developments = Object.fromEntries(members.map(article => [article.id, db.getArticle(article.url)?.excerpt || '']))
db.savePulseBatch([{ id: 'collection-fixture', headline: 'Willow Creek footbridge', scope: 'Local reporting on a new path across the creek and into the park.', entryIds: members.map(article => article.id), developments }], members.map(article => article.id), now)
db.commitLocalEntryState(backend.id, [members[0].id], 'star')
db.saveReadingProgress(members[0].id, .25)
const briefingSelection = { news: [{ headline: 'Synthetic briefing story', summary: 'Two source stories cover a synthetic development.', collectionId: 'collection-fixture',
  entryIds: members.slice(0, 2).map(article => article.id), backgroundEntryIds: [members[2].id] }], worthNoticing: [], social: [] }
const briefingToken = 'synthetic-route-briefing-token'
const rendered = renderBriefing({ kind: 'morning', cutoff: new Date(now), selection: briefingSelection,
  entries: new Map(articles.map(article => [article.id, article])),
  confirmUrl: `http://127.0.0.1:4318/briefings/route-briefing/confirm?token=${briefingToken}` })
db.createBriefing({ id: 'route-briefing', kind: 'morning', windowStart: now, cutoff: now, createdAt: now,
  ...rendered, status: 'generated', tokenHash: crypto.createHash('sha256').update(briefingToken).digest('hex'),
  selection: briefingSelection, deliveredAt: null, acknowledgedAt: null },
  members.slice(0, 2).map(article => ({ id: article.id, section: 'news' })))
db.createBriefing({ id: 'missing-source-briefing', kind: 'morning', windowStart: now, cutoff: now, createdAt: now,
  ...rendered, subject: 'Synthetic unavailable source', status: 'delivered', tokenHash: crypto.createHash('sha256').update('synthetic-missing-source-token').digest('hex'),
  selection: { news: [{ headline: 'Synthetic unavailable source', summary: 'A source has disappeared.', entryIds: [members[0].id, 'missing-source'] }], worthNoticing: [], social: [] },
  deliveredAt: now, acknowledgedAt: null }, [{ id: members[0].id, section: 'news' }, { id: 'missing-source', section: 'news' }])
db.close()
const ownerState = path.join(temporary, 'owner-data')
const ownerDb = new PaperDatabase(path.join(ownerState, 'paper.sqlite'))
ownerDb.bindStandalone()
await ownerDb.auth.setup(ownerDb.auth.setupCode(), 'owner', 'synthetic route password')
ownerDb.close()
const owner = spawn(process.execPath, [path.resolve('dist-server/index.js')], { stdio: 'inherit', env: {
  PATH: process.env.PATH, NODE_NO_WARNINGS: '1', STATE_DIR: ownerState, PAPER_BACKEND: 'standalone', PAPER_SYNC_ENABLED: 'false',
  HOST: '127.0.0.1', PORT: '4320', PUBLIC_URL: 'http://127.0.0.1:4320', CODEX_ENABLED: 'false',
  PAPER_TRUSTED_FEED_ORIGINS: 'http://127.0.0.1:4319',
} })
const ownerExit = once(owner, 'exit')
const child = spawn(process.execPath, [path.resolve('dist-server/index.js')], { stdio: 'inherit', env: {
  PATH: process.env.PATH, NODE_NO_WARNINGS: '1', STATE_DIR: state, PAPER_BACKEND: 'standalone', PAPER_SYNC_ENABLED: 'false',
  HOST: '127.0.0.1', PORT: '4318', PUBLIC_URL: 'http://127.0.0.1:4318', CODEX_ENABLED: 'false',
  PAPER_TRUSTED_FEED_ORIGINS: 'http://127.0.0.1:4319',
  PAPER_TRUSTED_SAVE_ORIGINS: 'http://127.0.0.1:4319',
  PAPER_TRUSTED_AI_ORIGINS: openai.origin, PAPER_OPENAI_BASE_URL: `${openai.origin}/v1`, PAPER_OPENAI_DISCUSSION_MODEL: 'collection-fixture',
} })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill('SIGTERM'); owner.kill('SIGTERM') })
try { await once(child, 'exit') }
finally {
  owner.kill('SIGTERM'); await ownerExit
  publisher.closeAllConnections(); await new Promise(resolve => publisher.close(resolve))
  await openai.close()
  await fs.rm(temporary, { recursive: true, force: true })
}
