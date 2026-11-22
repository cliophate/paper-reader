import type { FeedCheckStatus, StaleDays } from '../shared/feed-checks'
import { feedUrlKeys } from '../server/feed-url-comparison'
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

function matchedGroups(feeds: Feed[], keysFor: (feed: Feed) => string[]) {
  const byKey = new Map<string, string>()
  const parents = new Map<string, string>()
  function root(id: string): string {
    let current = id
    while (parents.has(current)) current = parents.get(current)!
    if (current !== id) parents.set(id, current)
    return current
  }

  for (const feed of feeds) {
    for (const key of keysFor(feed)) {
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
  return { groups: [...groups.values()].filter(group => group.length > 1), root }
}

export function duplicateFeedGroups(feeds: Feed[], checks: Map<string, Pick<FeedCheckStatus, 'endpointKeys' | 'publisherSiteUrl'>>) {
  const endpoints = new Map(feeds.map(feed => {
    const url = !feed.urlRef && feedUrlKeys(feed.url)
    return [feed.id, checks.get(feed.id)?.endpointKeys ?? (url ? [url] : [])]
  }))
  const exact = matchedGroups(feeds, feed => endpoints.get(feed.id)!.map(url => url.exact))
  const possible = matchedGroups(feeds, feed => {
    const keys = endpoints.get(feed.id)!.map(url => 'url:' + url.possible)
    const site = feedUrlKeys(feed.siteUrl || checks.get(feed.id)?.publisherSiteUrl || '')
    const title = feed.title.trim().replace(/\s+/g, ' ').toLowerCase()
    if (site && title) keys.push(JSON.stringify([site.possible, title]))
    return keys
  })
  return [
    ...exact.groups.map(feeds => ({ feeds, label: 'Same feed address' })),
    ...possible.groups.filter(group => group.some(feed => exact.root(feed.id) !== exact.root(group[0].id)))
      .map(feeds => ({ feeds, label: 'Possible duplicate' })),
  ]
}
