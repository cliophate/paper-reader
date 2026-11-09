import { PaperDatabase } from '../dist-server/db.js'
import { HeadlineService } from '../dist-server/headlines.js'
import { setImmediate } from 'node:timers/promises'

if (!global.gc) throw new Error('Run with node --expose-gc')

const db = new PaperDatabase(':memory:')
const contentHtml = '<figure class="enclosure"><img src="https://example.test/hero.jpg"></figure>' + '<p>Synthetic article text with enough reporting to parse.</p>'.repeat(120)
const entries = Array.from({ length: 500 }, (_, n) => ({
  id: String(n), feedId: 'feed/synthetic', feedTitle: 'Synthetic', feedUrl: 'https://androidpolice.com/feed/',
  url: `https://androidpolice.com/${n}`, title: `Synthetic story ${n}`, contentHtml, author: 'Example', excerpt: 'Synthetic',
  timestamp: Math.floor(Date.now()/1000), publishedAt: new Date().toISOString(), read: false, starred: false,
  readingMinutes: 10, thumbnailUrl: '', kind: 'article',
}))
db.upsertEntries(entries)
db.savePulseBatch([{ id: 'stress', headline: 'Synthetic', scope: 'Synthetic memory regression check', entryIds: entries.map(e => e.id) }], entries.map(e => e.id), new Date().toISOString())
const heap = () => { global.gc(); return Math.round(process.memoryUsage().heapUsed / 1024 / 1024) }
const before = heap()
for (let i = 0; i < 200; i++) {
  const collections = db.pulseCollections()
  if (collections[0].sources.length !== 500) throw new Error('Collection members changed')
  await setImmediate()
}
const after = heap()
const service = new HeadlineService(db, async () => ({ contentHtml: '<p>Too short for rewriting.</p>' }), async () => { throw new Error('Unexpected model call') })
for (let i = 0; i < 20; i++) { await service.run(); await setImmediate() }
await setImmediate()
const afterHeadlines = heap()
console.log(JSON.stringify({ syntheticArticles: 500, collectionReads: 200, headlinePasses: 20, heapBeforeMB: before, heapAfterMB: after, heapAfterHeadlinesMB: afterHeadlines }))
if (after - before > 32 || afterHeadlines - before > 64) throw new Error('Heap grew across repeated processing')
db.close()
