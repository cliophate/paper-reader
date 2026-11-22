import type { FeedCheckStatus, StaleDays } from '../shared/feed-checks'
import type { Feed } from './types'

export type FeedFilter = 'all' | 'attention' | 'moved' | 'duplicates' | 'first' | 'second' | 'oldest'
const DAY_MS = 86_400_000

export function feedMatchesAge(feed: Feed, filter: FeedFilter, days: StaleDays | undefined, now = Date.now()): boolean {
  if (filter !== 'first' && filter !== 'second' && filter !== 'oldest') return true
  if (!days || !feed.lastPublishedAt) return false
  const age = (now - Date.parse(feed.lastPublishedAt)) / DAY_MS
  if (filter === 'first') return age >= days[0] && age < days[1]
  if (filter === 'second') return age >= days[1] && age < days[2]
  return age >= days[2]
}

// Comparison only. Keep the subscribed address intact for fetching and repair.
export function normalizedFeedUrl(input: string) {
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.host.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '') + url.search
  } catch { return '' }
}

export function duplicateFeedGroups(feeds: Feed[], checks: Map<string, Pick<FeedCheckStatus, 'move' | 'publisherSiteUrl' | 'finalUrl'>>): Feed[][] {
  const byKey = new Map<string, string>()
  const parents = new Map<string, string>()
  function root(id: string): string {
    let current = id
    while (parents.has(current)) current = parents.get(current)!
    if (current !== id) parents.set(id, current)
    return current
  }

  for (const feed of feeds) {
    const check = checks.get(feed.id)
    const endpoint = normalizedFeedUrl(feed.url)
    const finalUrl = normalizedFeedUrl(check?.move?.redirects.at(-1)?.url ?? check?.finalUrl ?? '')
    const site = normalizedFeedUrl(feed.siteUrl || check?.publisherSiteUrl || '')
    const title = feed.title.trim().replace(/\s+/g, ' ').toLowerCase()
    const keys = [endpoint, finalUrl].filter(Boolean).map(url => 'url:' + url)
    if (site && title) keys.push(JSON.stringify([site, title]))
    for (const key of keys) {
      const match = byKey.get(key)
      if (match === undefined) byKey.set(key, feed.id)
      else {
        const left = root(feed.id), right = root(match)
        if (left !== right) parents.set(left, right)
      }
    }
  }
  const groups = new Map<string, Feed[]>()
  for (const feed of feeds) {
    const key = root(feed.id)
    const group = groups.get(key)
    if (group) group.push(feed)
    else groups.set(key, [feed])
  }
  return [...groups.values()].filter(group => group.length > 1)
}
