import { Worker, parentPort, workerData } from 'node:worker_threads'
import { RULE_BATCH_SIZE } from './article-rules.js'
import { PaperDatabase } from './db.js'
import type { FeedLease, FetchCompletion } from './feed-fetch-state.js'
import type { ParsedFeed } from './feed-parser.js'
import { ingestFeed } from './feed-ingestion.js'
import { displayFeedUrl } from './feed-url-display.js'
import { subscriptionUrl } from './opml.js'

type Completion = { lease: FeedLease; now: number; update: FetchCompletion; parsed?: ParsedFeed; responseUrl: string }

function commit(db: PaperDatabase, { lease, now, update, parsed, responseUrl }: Completion) {
  return db.feedFetch.complete(lease, now, update, () => {
    if (!parsed) return 0
    const ingested = ingestFeed(db, { backendId: lease.backendId, subscriptionId: lease.subscriptionId,
      endpointGeneration: lease.endpointGeneration, parsed, requestUrl: lease.url, responseUrl, fetchedAt: new Date(now).toISOString() })
    update.publisherSiteUrl = parsed.siteUrl.length <= 4096 ? displayFeedUrl(parsed.siteUrl) : ''
    const declared = parsed.declaredUrl || ''
    update.declaredUrl = declared.length <= 4096 ? subscriptionUrl(declared) : ''
    update.ambiguous = ingested.ambiguous
    return ingested.ambiguous
  })
}

export async function completeFeed(db: PaperDatabase, input: Completion): Promise<ReturnType<typeof commit>> {
  // A feed and its successful-fetch checkpoint must commit together. Keep
  // large rule-enabled transactions off the HTTP thread without splitting them.
  if (!input.parsed || input.parsed.entries.length <= RULE_BATCH_SIZE || db.searchDatabasePath === ':memory:' || !db.rules.hasQueries()) {
    return commit(db, input)
  }
  const options = { execArgv: [] as string[], env: {}, workerData: { file: db.searchDatabasePath, feedCompletion: input } }
  const worker = import.meta.url.endsWith('.ts')
    ? new Worker(`import { tsImport } from 'tsx/esm/api'; await tsImport(${JSON.stringify(import.meta.url)}, import.meta.url)`, { ...options, eval: true })
    : new Worker(new URL(import.meta.url), options)
  return new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error('Feed ingestion stopped before recording its result.')))
  })
}

if (parentPort && workerData?.feedCompletion) {
  const db = new PaperDatabase(workerData.file)
  try { parentPort.postMessage(commit(db, { ...workerData.feedCompletion, now: Date.now() })) }
  finally { db.close() }
}
