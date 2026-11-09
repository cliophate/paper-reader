import { describe, expect, it } from 'vitest'
import { feedMatchesFilter } from '../src/client/feedFilters'
import type { Feed } from '../src/client/types'

const now = Date.parse('2026-09-01T00:00:00Z')
const feed = (daysOld: number): Feed => ({
  id: 'feed/1', title: 'Example', url: 'https://example.com/feed', siteUrl: 'https://example.com',
  iconUrl: '', categories: [], unread: 0, lastPublishedAt: new Date(now - daysOld * 86_400_000).toISOString(),
  lastCheckedAt: null, lastErrorAt: null, broken: false,
})

describe('feed age filters', () => {
  it('keeps the three age ranges exclusive', () => {
    expect(feedMatchesFilter(feed(100), '3m', now)).toBe(true)
    expect(feedMatchesFilter(feed(200), '3m', now)).toBe(false)
    expect(feedMatchesFilter(feed(200), '6m', now)).toBe(true)
    expect(feedMatchesFilter(feed(400), '6m', now)).toBe(false)
    expect(feedMatchesFilter(feed(400), '1y', now)).toBe(true)
  })
})
