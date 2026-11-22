import { describe, expect, it } from 'vitest'
import { duplicateFeedGroups, feedMatchesAge } from '../src/client/feedFilters'
import { feedUrlKeys } from '../src/server/feed-url-comparison'
import { DEFAULT_STALE_DAYS } from '../src/server/feed-maintenance'
import type { Feed } from '../src/client/types'

const now = Date.parse('2026-09-01T00:00:00Z')
const feed = (daysOld: number): Feed => ({
  id: 'feed/1', title: 'Example', url: 'https://example.com/feed', siteUrl: 'https://example.com',
  iconUrl: '', categories: [], unread: 0, lastPublishedAt: new Date(now - daysOld * 86_400_000).toISOString(),
  lastCheckedAt: null, lastErrorAt: null, broken: false,
})

describe('feed age filters', () => {
  it('keeps the three age ranges exclusive', () => {
    expect(feedMatchesAge(feed(100), 'first', DEFAULT_STALE_DAYS, now)).toBe(true)
    expect(feedMatchesAge(feed(200), 'first', DEFAULT_STALE_DAYS, now)).toBe(false)
    expect(feedMatchesAge(feed(200), 'second', DEFAULT_STALE_DAYS, now)).toBe(true)
    expect(feedMatchesAge(feed(400), 'second', DEFAULT_STALE_DAYS, now)).toBe(false)
    expect(feedMatchesAge(feed(400), 'oldest', DEFAULT_STALE_DAYS, now)).toBe(true)
  })
})

it('uses configured boundaries and leaves undated feeds out of the age bands', () => {
  expect(feedMatchesAge(feed(9), 'first', [10, 20, 30], now)).toBe(false)
  expect(feedMatchesAge(feed(10), 'first', [10, 20, 30], now)).toBe(true)
  expect(feedMatchesAge(feed(20), 'first', [10, 20, 30], now)).toBe(false)
  expect(feedMatchesAge(feed(20), 'second', [10, 20, 30], now)).toBe(true)
  expect(feedMatchesAge(feed(30), 'oldest', [10, 20, 30], now)).toBe(true)
  expect(feedMatchesAge({ ...feed(0), lastPublishedAt: null }, 'oldest', [10, 20, 30], now)).toBe(false)
})

it('preserves the endpoint and original query bytes except for tracking fields', () => {
  const endpoint = 'http://www.example.test:81/News/?b=2&a=%20&a=+'
  const keys = feedUrlKeys(endpoint)!
  expect(feedUrlKeys(endpoint + '&utm_source=x&fbclid=y#fragment')).toEqual(keys)
  for (const variant of [endpoint.replace('http:', 'https:'), endpoint.replace('www.', ''), endpoint.replace('/?', '?')]) {
    expect(feedUrlKeys(variant)?.exact).not.toBe(keys.exact)
    expect(feedUrlKeys(variant)?.possible).toBe(keys.possible)
  }
  for (const variant of [endpoint.replace(':81', ''), endpoint.replace('News', 'news'), endpoint.replace('b=2&a=%20', 'a=%20&b=2'), endpoint.replace('%20', '+')]) {
    expect(feedUrlKeys(variant)?.possible).not.toBe(keys.possible)
  }
  expect(feedUrlKeys('https://example.test/feed?')?.exact).not.toBe(feedUrlKeys('https://example.test/feed')?.exact)
  expect(feedUrlKeys('ftp://example.test/')).toBeUndefined()
})

it('labels exact address matches separately from similar URLs and matching sites and titles', () => {
  const item = (id: string, url: string, title = id, siteUrl = '') => ({ ...feed(1), id, title, url, siteUrl })
  const feeds = [
    item('a', 'http://www.example.test/old/'), item('b', 'https://example.test/old?utm_source=fixture'),
    item('c', 'https://example.test/old', ' Gazette ', 'http://gazette.test'),
    item('d', 'https://gazette.test/rss', 'Gazette', 'https://www.gazette.test/'),
    item('e', 'https://gazette.test/photos', 'Photos', 'https://gazette.test/'),
    item('f', ''), item('g', ''),
  ]
  expect(duplicateFeedGroups(feeds, new Map()).map(group => [group.label, group.feeds.map(f => f.id)]))
    .toEqual([['Same feed address', ['b', 'c']], ['Possible duplicate', ['a', 'b', 'c', 'd']]])
})
