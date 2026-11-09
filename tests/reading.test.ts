import { describe, expect, it } from 'vitest'
import { authorLine, resistedPullDistance, shouldAutoMarkRead, shouldAutomaticallyFetchFullArticle, shouldFetchFullArticle, shouldReleaseToRefresh } from '../src/client/reading'
import type { Entry } from '../src/client/types'

const entry: Entry = {
  id: '1', feedId: 'feed/1', feedTitle: 'Example', feedUrl: 'https://example.com/feed',
  title: 'Article', author: '', url: 'https://example.com/article', contentHtml: '', excerpt: '',
  publishedAt: '2026-09-01T00:00:00Z', timestamp: 0, read: false, starred: false,
  readingMinutes: 1, thumbnailUrl: '', kind: 'article',
}

describe('automatic full article detection', () => {
  it('retrieves lost Africa Is a Country paragraphs but leaves formatted posts and linked-list commentary alone', () => {
    const flat = { ...entry, url: 'https://africasacountry.com/2026/09/example', contentHtml: 'A sentence without source paragraph tags. '.repeat(40), readingMinutes: 4 }
    expect(shouldAutomaticallyFetchFullArticle(flat, false)).toBe(true)
    expect(shouldAutomaticallyFetchFullArticle({ ...flat, contentHtml: `<p>${flat.contentHtml}</p>` }, false)).toBe(false)
    expect(shouldAutomaticallyFetchFullArticle({ ...flat, fullText: true }, false)).toBe(false)
    expect(shouldAutomaticallyFetchFullArticle({ ...entry, feedUrl: 'https://daringfireball.net/', url: 'https://mastodon.social/@writer/123', contentHtml: '<p>A complete short comment.</p>' }, true)).toBe(false)
  })
  it('fetches an obvious feed teaser', () => {
    expect(shouldFetchFullArticle({ ...entry, contentHtml: '<p>A short introduction.</p><p>Keep on reading: <a href="/post">Article</a></p>' })).toBe(true)
  })

  it('fetches short one-minute feed content', () => {
    expect(shouldFetchFullArticle({ ...entry, contentHtml: `<p>${'A useful sentence. '.repeat(20)}</p>` })).toBe(true)
  })

  it('leaves complete articles and social posts alone', () => {
    const contentHtml = `<p>${'A complete paragraph with actual reporting. '.repeat(80)}</p>`
    expect(shouldFetchFullArticle({ ...entry, contentHtml, readingMinutes: 4 })).toBe(false)
    expect(shouldFetchFullArticle({ ...entry, contentHtml: '<p>Short post</p>', kind: 'x' })).toBe(false)
    expect(shouldFetchFullArticle({ ...entry, contentHtml: '<p>Short post</p>', fullText: true })).toBe(false)
  })

  it('automatically fetches truncated Codrops articles without changing the learned feed preference', () => {
    const codrops = { ...entry, url: 'https://tympanus.net/codrops/2026/09/03/example/', contentHtml: '<p>A short introduction.</p>', readingMinutes: 1 }
    expect(shouldAutomaticallyFetchFullArticle(codrops, false)).toBe(true)
    expect(shouldAutomaticallyFetchFullArticle({ ...codrops, url: 'https://example.com/post' }, false)).toBe(false)
    expect(shouldAutomaticallyFetchFullArticle({ ...codrops, url: 'https://example.com/post' }, true)).toBe(true)
  })
})

describe('pull to refresh threshold', () => {
  it('resists and caps the drag distance', () => {
    expect(resistedPullDistance(-10)).toBe(0)
    expect(resistedPullDistance(100)).toBe(45)
    expect(resistedPullDistance(1000)).toBe(104)
  })

  it('refreshes only after the release threshold', () => {
    expect(shouldReleaseToRefresh(71)).toBe(false)
    expect(shouldReleaseToRefresh(72)).toBe(true)
  })
})

describe('automatic read state', () => {
  it('does not override a manual unread action on the open article', () => {
    expect(shouldAutoMarkRead(entry, 'article', '')).toBe(true)
    expect(shouldAutoMarkRead(entry, 'article', entry.id)).toBe(false)
    expect(shouldAutoMarkRead({ ...entry, read: true }, 'article', '')).toBe(false)
    expect(shouldAutoMarkRead(entry, 'stories', '')).toBe(false)
  })

})

describe('author presentation', () => {
  it('does not repeat a feed-provided By prefix', () => {
    expect(authorLine('Apoorva Tadepalli')).toBe('By Apoorva Tadepalli')
    expect(authorLine('By Apoorva Tadepalli')).toBe('By Apoorva Tadepalli')
  })
})
