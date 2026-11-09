import type { Feed } from './types'

export type FeedFilter = 'all' | 'attention' | '3m' | '6m' | '1y'

const DAY_MS = 86_400_000

export function feedMatchesFilter(feed: Feed, filter: FeedFilter, now = Date.now()): boolean {
  if (filter === 'all') return true
  if (filter === 'attention') return feed.broken
  if (!feed.lastPublishedAt) return false

  const age = now - Date.parse(feed.lastPublishedAt)
  if (filter === '3m') return age >= 90 * DAY_MS && age < 182 * DAY_MS
  if (filter === '6m') return age >= 182 * DAY_MS && age < 365 * DAY_MS
  return age >= 365 * DAY_MS
}
