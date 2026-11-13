import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { PaperDatabase } from '../dist-server/db.js'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-reader-routes-'))
const state = path.join(temporary, 'data')
const db = new PaperDatabase(path.join(state, 'paper.sqlite'))
const backend = db.bindStandalone()
const feedId = db.saveLocalSubscription(backend.id, { title: 'Synthetic feed', url: 'https://example.test/feed' })
const otherFeed = db.saveLocalSubscription(backend.id, { title: '中文', url: 'https://example.test/other' })
let snapshot = db.organization.snapshot(backend.id)
db.organization.apply(backend.id, snapshot.revision, [{ type: 'create-folder', title: 'A' }])
snapshot = db.organization.snapshot(backend.id)
db.organization.apply(backend.id, snapshot.revision, [{ type: 'add-membership', feedId, folderId: snapshot.navigation.folders[0].id }])
const now = new Date().toISOString()
for (const [index, subscriptionId] of [[1, feedId], [2, feedId], [3, feedId], [4, otherFeed]]) {
  db.importSourceEntries(backend.id, subscriptionId, [{ identity: { externalId: `synthetic-${index}` }, entry: {
    feedTitle: subscriptionId === feedId ? 'Synthetic feed' : '中文', feedUrl: 'https://example.test/feed', title: `Synthetic article ${index}`, author: 'Fixture writer',
    url: `https://example.test/story-${index}`, contentHtml: '<p>This article belongs to a disposable route test. No account or live installation is involved.</p>'.repeat(12),
    excerpt: 'Disposable route fixture', publishedAt: now, timestamp: Date.now() - index, readingMinutes: 2, thumbnailUrl: '', kind: 'article',
  } }])
}
const articles = db.localEntriesPage({ kind: 'all', id: 'all', title: 'All articles' }, { unreadOnly: false }).items
const members = articles.filter(article => article.feedId === feedId)
db.savePulseBatch([{ id: 'collection-fixture', headline: 'Synthetic collection', scope: 'Synthetic route testing', entryIds: members.map(article => article.id) }], members.map(article => article.id), now)
db.commitLocalEntryState(backend.id, [members[0].id], 'star')
db.saveReadingProgress(members[0].id, .25)
db.close()
const child = spawn(process.execPath, [path.resolve('dist-server/index.js')], { stdio: 'inherit', env: {
  PATH: process.env.PATH, NODE_NO_WARNINGS: '1', STATE_DIR: state, PAPER_BACKEND: 'standalone', PAPER_SYNC_ENABLED: 'false',
  HOST: '127.0.0.1', PORT: '4318', PUBLIC_URL: 'http://127.0.0.1:4318', CODEX_ENABLED: 'false', OPENCODE_ENABLED: 'false',
} })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGTERM'))
try { await once(child, 'exit') }
finally { await fs.rm(temporary, { recursive: true, force: true }) }
