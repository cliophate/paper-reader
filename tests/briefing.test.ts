import { describe, expect, it } from 'vitest'
import { briefingNeedsFullText, clusterNews, newsImageFitsHeadline, proposedNewsClusters, shouldLimitBriefingToUnread, splitBriefingCandidates } from '../src/server/briefing.js'
import type { Entry } from '../src/server/types.js'

function entry(id: string, title: string, url: string): Entry {
  return {
    id,
    title,
    url,
    feedId: `feed/${id}`,
    feedTitle: new URL(url).hostname,
    feedUrl: url,
    author: '',
    contentHtml: '<p>Text</p>',
    excerpt: 'Text',
    publishedAt: new Date().toISOString(),
    timestamp: Date.now(),
    read: false,
    starred: false,
    readingMinutes: 1,
    thumbnailUrl: '',
    kind: 'article',
  }
}

describe('news clustering', () => {
  it('groups similar coverage from distinct domains', () => {
    const result = clusterNews([
      entry('1', 'Valve announces a new living room gaming PC', 'https://one.example/valve-pc'),
      entry('2', 'Valve announces its new living room gaming PC', 'https://two.example/news'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].domains).toHaveLength(2)
  })

  it('does not call repeated coverage from one domain hot', () => {
    const result = clusterNews([
      entry('1', 'Valve announces a new living room gaming PC', 'https://one.example/valve-pc'),
      entry('2', 'Valve announces its new living room gaming PC', 'https://one.example/update'),
    ])
    expect(result).toHaveLength(0)
  })

  it('uses stable cluster IDs regardless of feed order', () => {
    const first = entry('1', 'Nvidia launches DLSS 5 on September 3', 'https://one.example/dlss')
    const second = entry('2', 'DLSS 5 launches September 3 for Nvidia GPUs', 'https://two.example/news')
    expect(clusterNews([first, second])[0].id).toBe(clusterNews([second, first])[0].id)
  })

  it('does not merge stories that only share a company name', () => {
    const result = clusterNews([
      entry('1', 'Nvidia launches DLSS 5 on September 3', 'https://one.example/dlss'),
      entry('2', 'Nvidia fixes monitor flickering in new driver', 'https://two.example/driver'),
    ])
    expect(result).toHaveLength(0)
  })
})

describe('briefing full-text enrichment', () => {
  it('requests full text for a truncated feed entry', () => {
    const candidate = entry('1', 'A short item', 'https://one.example/post')
    candidate.contentHtml = '<p>Keep on reading: A short item</p>'
    expect(briefingNeedsFullText(candidate)).toBe(true)
  })

  it('leaves a substantial feed entry alone', () => {
    const candidate = entry('1', 'A complete item', 'https://one.example/post')
    candidate.contentHtml = `<p>${'Complete article text. '.repeat(80)}</p>`
    candidate.readingMinutes = 4
    expect(briefingNeedsFullText(candidate)).toBe(false)
  })
})

describe('briefing candidate pools', () => {
  it('keeps Writers posts out of news and social sections', () => {
    const writer = entry('writer', 'A personal essay', 'https://writer.example/post')
    const news = entry('news', 'A news story', 'https://news.example/post')
    const social = { ...entry('social', 'A post', 'https://social.example/post'), kind: 'x' as const }
    const result = splitBriefingCandidates([writer, news, social], [writer])
    expect(result.news.map(item => item.id)).toEqual(['news'])
    expect(result.social.map(item => item.id)).toEqual(['social'])
  })
})

describe('Luna news proposals', () => {
  it('accepts a semantic group only when publishers are independent', () => {
    const first = entry('1', 'A differently worded story', 'https://one.example/story')
    const second = entry('2', 'Another headline for the same event', 'https://two.example/report')
    expect(proposedNewsClusters([['1', '2']], [first, second], [])).toHaveLength(1)
    second.url = 'https://one.example/another'
    expect(proposedNewsClusters([['1', '2']], [first, second], [])).toHaveLength(0)
  })
})

describe('briefing news images', () => {
  it('requires the source title to match the edited headline', () => {
    expect(newsImageFitsHeadline(
      'John Ternus takes over Apple as durability becomes a signal',
      "Tim Cook's Apple: his 10 biggest wins and misses",
    )).toBe(false)
    expect(newsImageFitsHeadline(
      'DLSS 5 arrives with artistic control and a steep performance cost',
      'Nvidia DLSS 5 launches on September 3',
    )).toBe(true)
  })
})

describe('briefing read-status test window', () => {
  const expiry = new Date('2026-09-04T00:00:00+02:00')

  it('includes read posts before the test window expires', () => {
    expect(shouldLimitBriefingToUnread(new Date('2026-09-03T18:30:00+02:00'), expiry)).toBe(false)
  })

  it('returns to unread-only at the expiry time', () => {
    expect(shouldLimitBriefingToUnread(new Date('2026-09-04T00:00:00+02:00'), expiry)).toBe(true)
  })

  it('uses unread-only when no test window is configured', () => {
    expect(shouldLimitBriefingToUnread(new Date(), null)).toBe(true)
  })
})
