import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { briefingNeedsFullText, clusterNews, newsImageFitsHeadline, proposedNewsClusters, shouldLimitBriefingToUnread, splitBriefingCandidates, validateSelection } from '../src/server/briefing.js'
import { renderBriefing } from '../src/server/email.js'
import type { BriefingSelection, Entry } from '../src/server/types.js'
import { switchingEntrySource } from '../src/server/repository.js'

it('pages remote briefing streams past muted and ordinary entries to include followed stories before the cap', async () => {
  const stream = { kind: 'all' as const, id: 'all', title: 'All' }
  const items = Array.from({ length: 2101 }, (_, index) => entry(String(index), 'Fixture', 'https://example.test'))
  const remote = {
    entries: async () => items.slice(0, 1000),
    entriesPage: vi.fn(async (_stream: typeof stream, options?: { continuation?: string; limit?: number }) => {
      const offset = Number(options?.continuation || 0)
      const end = offset + (options?.limit || 250)
      return { items: items.slice(offset, end), continuation: end < items.length ? String(end) : '' }
    }),
    navigation: async () => ({ folders: [], uncategorized: [], starred: 0, unread: 0 }),
    entry: async () => null, entryIds: async () => [],
  }
  const source = switchingEntrySource(() => false, remote, remote)
  const options = { before: new Date(), limit: 1000, unreadOnly: true }
  const picked = await source.briefingEntries!(stream, { ...options, muted: new Set(items.slice(0, 100).map(item => item.id)), followed: new Set(['1200']) })
  expect(picked.map(item => item.id)).toEqual(['1200', ...items.slice(100, 1099).map(item => item.id)])
  remote.entriesPage.mockClear()
  await source.briefingEntries!(stream, { ...options, followed: new Set(['already-read']) })
  expect(remote.entriesPage).toHaveBeenCalledTimes(5)
  remote.entriesPage.mockClear()
  await source.briefingEntries!(stream, { ...options, followed: new Set(['10']) })
  expect(remote.entriesPage).toHaveBeenCalledTimes(4)
  remote.entriesPage.mockClear()
  expect(await source.briefingEntries!(stream, options)).toEqual(items.slice(0, 1000))
  expect(remote.entriesPage).not.toHaveBeenCalled()
})

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

describe('briefing news layout', () => {
  const imageUrl = 'https://news.example/park.png'
  const source = { ...entry('park', 'City opens the riverside park', 'https://news.example/park'), thumbnailUrl: imageUrl }
  const background = entry('plans', 'City releases plans for the park', 'https://news.example/plans')
  const entries = new Map([[source.id, source], [background.id, background]])
  const story = { headline: 'City opens the riverside park', summary: 'The park opened to visitors on Saturday.', entryIds: [source.id] }
  const selection = (news: BriefingSelection['news']): BriefingSelection => ({ news, worthNoticing: [], social: [] })
  const render = (news: BriefingSelection['news']) => renderBriefing({ kind: 'morning', cutoff: new Date('2026-08-12T08:00:00Z'), selection: selection(news),
    entries, confirmUrl: 'https://paper.example/briefings/example/confirm?token=synthetic' })

  it('cleans, deduplicates and caps brief lines, and keeps prose for the lead', () => {
    const bullets = ['  ', 42, '▪ The path is open. ', 'The path is open.', 'A ferry\nstop opens Monday.', 'A '.repeat(200), 'An extra line.']
    const brief = { ...story, role: 'brief' as const, bullets: bullets as string[], imageEntryId: source.id }
    const lead = { ...story, role: 'lead' as const, bullets: ['Discard this.'] }
    const result = validateSelection(selection([brief, lead]), entries, [], 'morning')
    expect(result.news[0]).toMatchObject({ summary: '', imageEntryId: '', bullets: ['The path is open.', 'A ferry stop opens Monday.', expect.stringMatching(/\.\.\.$/)] })
    expect(result.news[0].bullets?.[2].length).toBeLessThanOrEqual(240)
    expect(result.news[1].summary).toBe(story.summary)
    expect(result.news[1].bullets).toBeUndefined()
  })

  it.each([{ bullets: undefined }, { bullets: 'One line' }, { bullets: ['The path is open.', '• The path is open.', '■'] }])('keeps a brief with fewer than two usable lines as prose', ({ bullets }) => {
    const brief = { ...story, role: 'brief' as const, bullets: bullets as string[] }
    const [item] = validateSelection(selection([brief]), entries, [], 'morning').news
    expect(item).toMatchObject({ role: 'brief', summary: story.summary })
    expect(item.bullets).toBeUndefined()
  })

  it('uses a single line as the summary, demotes a lead without prose, and drops empty stories', () => {
    const single = { ...story, summary: '', role: 'brief' as const, bullets: ['The path is open.'] }
    const bareLead = { ...story, summary: '', role: 'lead' as const, bullets: ['The path is open.', 'A ferry stop opens Monday.'] }
    const empty = { ...story, summary: '', role: 'brief' as const, bullets: [] }
    const result = validateSelection(selection([single, bareLead, empty]), entries, [], 'morning')
    expect(result.news).toHaveLength(2)
    expect(result.news[0]).toMatchObject({ role: 'brief', summary: 'The path is open.' })
    expect(result.news[1]).toMatchObject({ role: 'brief', summary: '', bullets: ['The path is open.', 'A ferry stop opens Monday.'], imageEntryId: '' })
  })

  it('renders square markers, plain text lines and separate source counts', () => {
    const bullets = ['The path is open.', 'Bring water & sunscreen.']
    const email = render([{ ...story, role: 'brief', bullets, entryIds: [source.id, source.id], backgroundEntryIds: [source.id, background.id], collectionId: 'collection-park' }])
    const document = new JSDOM(email.html).window.document
    const section = document.querySelector('section')!
    expect(section.querySelectorAll('td[aria-hidden="true"]')).toHaveLength(2)
    expect(section.querySelector('td[aria-hidden="true"]')?.outerHTML).toContain('color:#a43b31')
    expect(section.textContent).toContain('Bring water & sunscreen.')
    expect(section.textContent).not.toContain(story.summary)
    for (const [label, url] of [['Based on 1 source', source.url], ['1 background source', background.url]]) {
      const count = [...section.querySelectorAll('a')].find(link => link.textContent === label)!
      expect(document.querySelector(count.getAttribute('href')!)?.querySelector('a')?.href).toBe(url)
      expect(email.text).toContain(label)
    }
    expect(email.text).toContain(`\n${story.headline}\n${bullets.join('\n')}\nBased on 1 source\n`)
    const pulseLink = 'https://paper.example/pulse?collection=collection-park&filter=new'
    expect([...section.querySelectorAll('a')].find(link => link.textContent === 'Follow this story in Pulse')?.href).toBe(pulseLink)
    expect(email.text).toContain(pulseLink)
  })

  it('puts a full-width lead image above the headline and summary', () => {
    const email = render([{ ...story, role: 'lead', imageEntryId: source.id }])
    const document = new JSDOM(email.html).window.document
    const image = document.querySelector('section img')!
    expect(image.src).toBe(imageUrl)
    expect(image.style.width).toBe('100%')
    expect(image.nextElementSibling?.textContent).toBe(story.headline)
    expect(image.nextElementSibling?.nextElementSibling?.textContent).toBe(story.summary)
  })

  it('renders old summaries and a text-only lead when its image is unavailable', () => {
    const olderBrief = { ...story, headline: 'Park plans', summary: 'The plans were approved last year.', role: 'brief' as const }
    const email = render([{ ...story, imageEntryId: 'missing' }, olderBrief])
    expect(email.html).toContain('paper-lead-title')
    expect(email.html).not.toContain('<img')
    expect(email.html).not.toContain('Follow this story in Pulse')
    for (const summary of [story.summary, olderBrief.summary]) {
      expect(email.html).toContain(summary)
      expect(email.text).toContain(summary)
    }
  })
})

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
