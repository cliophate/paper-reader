import { describe, expect, it } from 'vitest'
import { duplicateFeedGroups, feedMatchesAge, normalizedFeedUrl } from '../src/client/feedFilters'
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

it('ignores scheme, www, trailing slashes, fragments and tracking, but preserves feed selectors', () => {
  const base = normalizedFeedUrl('http://WWW.Example.test:80/News/?b=2&utm_source=f&a=1&fbclid=c#item')
  expect(base).toBe(normalizedFeedUrl('https://example.test/News?a=1&b=2'))
  for (const url of ['https://example.test/news?a=1&b=2', 'https://example.test:81/News?a=1&b=2', 'https://example.test/News?a=1']) {
    expect(normalizedFeedUrl(url)).not.toBe(base)
  }
  expect(normalizedFeedUrl('')).toBe('')
  expect(normalizedFeedUrl('ftp://example.test/')).toBe('')
})

it('groups overlapping endpoint, final address and site/title matches once', () => {
  const item = (id: string, url: string, title = id, siteUrl = '') => ({ ...feed(1), id, title, url, siteUrl })
  const feeds = [
    item('a', 'http://www.example.test/old/'), item('b', 'https://example.test/old?utm_source=fixture'),
    item('c', 'https://elsewhere.test/feed', ' Gazette ', 'http://gazette.test'),
    item('d', 'https://gazette.test/rss', 'Gazette', 'https://www.gazette.test/'),
    item('e', 'https://gazette.test/photos', 'Photos', 'https://gazette.test/'),
    item('f', ''), item('g', ''),
  ]
  const redirect = { redirects: [{ status: 302, url: 'https://example.test/final' }], declaredUrl: '', suggestedUrl: '' }
  const groups = duplicateFeedGroups(feeds, new Map([['b', { move: redirect }], ['c', { finalUrl: redirect.redirects[0].url }]]))
  expect(groups.map(group => group.map(f => f.id))).toEqual([['a', 'b', 'c', 'd']])
  expect(feeds).toHaveLength(7)
})
