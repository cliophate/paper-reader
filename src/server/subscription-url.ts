import { createHmac, randomBytes } from 'node:crypto'
import { feedUrl } from './feed-parser.js'
import type { Feed } from './types.js'

export function normalizedSubscriptionUrl(value: string): string {
  return feedUrl(value).split('#', 1)[0]
}

export function subscriptionUrl(value: string): string {
  if (value.length > 4096 || !/^https?:\/\//i.test(value.trim())) return ''
  const url = normalizedSubscriptionUrl(value)
  return url.length <= 4096 ? url : ''
}

// A navigation snapshot can identify the saved endpoint without exposing its query.
const referenceKey = randomBytes(32)
export function privateFeedRef(id: string, url: string) {
  return createHmac('sha256', referenceKey).update(JSON.stringify([id, url])).digest('base64url')
}

export function matchesSubscriptionUrl(feed: Feed, url: string): boolean {
  return !!url && (feed.urlRef ? feed.urlRef === privateFeedRef(feed.id, url) : subscriptionUrl(feed.url) === url)
}
