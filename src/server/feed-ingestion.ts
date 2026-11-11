import type { PaperDatabase } from './db.js'
import { parseFeed, feedUrl } from './feed-parser.js'
import { detectKind } from './entry-kind.js'
import { excerpt, firstImage, readingMinutes } from './text.js'

export interface FeedEndpoint {
  backendId: string
  subscriptionId: string
  // Persist a new opaque generation whenever the configured endpoint changes,
  // even when repairing a subscription back to a previously used URL.
  endpointGeneration: string
}
export interface SuccessfulFeedFetch {
  fetchedAt: string
  requestUrl: string
  responseUrl: string
}
export interface VerifiedFeedAliasChange {
  externalId: string
  previousExternalIds: string[]
  // Trusted caller evidence, such as an operator-confirmed publisher ID change.
  // Never construct this from a shared URL or from untrusted feed extensions.
  evidence: string
}
function checkpointKey(endpoint: FeedEndpoint): string {
  if (!endpoint.subscriptionId || !endpoint.endpointGeneration) throw new Error('Feed ingestion requires a subscription and endpoint generation')
  return `feed-ingestion:v1:${JSON.stringify([endpoint.subscriptionId, endpoint.endpointGeneration])}`
}
export function successfulFeedFetch(db: PaperDatabase, endpoint: FeedEndpoint): SuccessfulFeedFetch | null {
  const saved = db.identities.checkpoint(endpoint.backendId, checkpointKey(endpoint))
  return saved ? JSON.parse(saved) as SuccessfulFeedFetch : null
}

// The caller supplies an already fetched, decoded response from the current
// endpoint generation. Fetch policy, scheduling and stale-response fencing are
// owned by the HTTP collector, not by XML parsing or identity matching.
export function ingestFeed(db: PaperDatabase, input: FeedEndpoint & {
  xml: string
  requestUrl: string
  responseUrl: string
  fetchedAt: string
  verifiedAliasChanges?: readonly VerifiedFeedAliasChange[]
}) {
  const key = checkpointKey(input)
  const requestUrl = feedUrl(input.requestUrl)
  const responseUrl = feedUrl(input.responseUrl)
  const fetchedTime = Date.parse(input.fetchedAt)
  if (!requestUrl || !responseUrl || !Number.isFinite(fetchedTime)) throw new Error('Invalid feed fetch metadata')
  const parsed = parseFeed(input.xml, responseUrl)
  const changes = new Map<string, string[]>()
  for (const change of input.verifiedAliasChanges || []) {
    const id = change.externalId.trim()
    const previous = [...new Set(change.previousExternalIds.map(value => value.trim()).filter(Boolean))]
    if (!id || !previous.length || !change.evidence.trim() || changes.has(id) || !parsed.entries.some(entry => entry.externalId === id)) {
      throw new Error('Invalid verified feed alias change')
    }
    changes.set(id, previous)
  }
  const items = parsed.entries.map(item => ({
    identity: {
      externalId: item.externalId, previousExternalIds: item.externalId ? changes.get(item.externalId) : undefined,
      url: item.url, publishedAt: item.publishedAt, title: item.title, author: item.author,
    },
    entry: {
      feedTitle: parsed.title, feedUrl: parsed.siteUrl, title: item.title || 'Untitled', author: item.author,
      url: item.url, contentHtml: item.contentHtml, excerpt: excerpt(item.contentHtml),
      publishedAt: item.publishedAt, timestamp: item.publishedAt ? Date.parse(item.publishedAt) : fetchedTime,
      crawledAt: fetchedTime, readingMinutes: readingMinutes(item.contentHtml),
      thumbnailUrl: firstImage(item.contentHtml) || item.thumbnailUrl,
      kind: detectKind(parsed.title, item.url, parsed.siteUrl),
    },
  }))
  // Counts are returned from persisted identity outcomes. The checkpoint records
  // successful batch delivery, including explicitly recorded ambiguities.
  const checkpoint = { fetchedAt: new Date(fetchedTime).toISOString(), requestUrl, responseUrl }
  const results = db.importSourceEntries(input.backendId, input.subscriptionId, items, {
    checkpoint: { key, value: JSON.stringify(checkpoint) }, feedTitle: parsed.title,
  })
  return { feed: parsed, results, resolved: results.filter(result => result.status === 'resolved').length, ambiguous: results.filter(result => result.status === 'ambiguous').length }
}
