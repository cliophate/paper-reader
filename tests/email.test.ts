import { describe, expect, it } from 'vitest'
import { renderBriefing } from '../src/server/email.js'
import type { Entry } from '../src/server/types.js'

const article: Entry = {
  id: '1',
  feedId: 'feed/1',
  feedTitle: 'Example',
  feedUrl: 'https://example.com',
  title: 'A useful — source title',
  author: 'Writer',
  url: 'https://example.com/post',
  contentHtml: '<p>Text</p>',
  excerpt: 'Text',
  publishedAt: '2026-09-01T06:00:00.000Z',
  timestamp: 1788242400000,
  read: false,
  starred: false,
  readingMinutes: 2,
  thumbnailUrl: '',
  kind: 'article',
}

describe('briefing email', () => {
  it('renders both formats and the confirmation link', () => {
    const result = renderBriefing({
      kind: 'morning',
      cutoff: new Date('2026-09-01T07:30:00.000Z'),
      entries: new Map([[article.id, article]]),
      confirmUrl: 'https://paper.example.test/briefings/test/confirm?token=secret',
      selection: {
        news: [],
        worthNoticing: [{ entryId: '1', reason: 'Specific and useful.', summary: 'A direct summary — with bad punctuation.' }],
        social: [],
      },
    })
    expect(result.html).toContain('Worth noticing')
    expect(result.html).toContain('https://paper.example.test/briefings/test/confirm?token=secret')
    expect(result.text).toContain('A useful, source title | https://example.com/post')
    expect(result.html).not.toContain('—')
    expect(result.html).toContain('width=device-width, initial-scale=1')
    expect(result.html).toContain('max-width:760px')
    expect(result.html).toContain('.paper-body { padding: 28px 16px 30px !important; }')
    expect(result.subject).toBe('Morning Paper Briefing | A useful, source title')
  })

  it('renders an editorial intro and visual social card', () => {
    const instagram: Entry = {
      ...article,
      id: 'social-1',
      kind: 'instagram',
      feedTitle: '@photographer',
      title: '@photographer image story',
      url: 'https://instagram.com/stories/photographer/1',
      thumbnailUrl: 'https://images.example/story.jpg',
    }
    const result = renderBriefing({
      kind: 'evening',
      cutoff: new Date('2026-09-01T18:30:00.000Z'),
      entries: new Map([[instagram.id, instagram]]),
      confirmUrl: 'https://paper.example.test/briefings/test/confirm?token=secret',
      selection: {
        intro: 'The day had one useful visual aside.',
        news: [],
        worthNoticing: [],
        social: [{ entryId: instagram.id, summary: 'A quiet study of late summer light.', imageEntryId: instagram.id }],
      },
    })
    expect(result.html).toContain('The day had one useful visual aside.')
    expect(result.html).toContain('https://images.example/story.jpg')
    expect(result.html).toContain('Instagram story')
    expect(result.html).toContain('Writer')
    expect(result.subject).toBe('Evening Paper Briefing | Evening reading')
  })

  it('preserves a short social post and shows its name and handle', () => {
    const threads: Entry = {
      ...article,
      id: 'threads-1',
      kind: 'threads',
      feedTitle: 'Threads @craigmod',
      title: '@craigmod: A useful corrective about model names.',
      author: 'Craig Mod',
      url: 'https://www.threads.com/@craigmod/post/example',
      contentHtml: '<p>Model names accumulate faster than people can understand what changed.</p>',
      excerpt: 'Model names accumulate faster than people can understand what changed.',
    }
    const result = renderBriefing({
      kind: 'morning',
      cutoff: new Date('2026-09-01T07:30:00.000Z'),
      entries: new Map([[threads.id, threads]]),
      confirmUrl: 'https://paper.example.test/briefings/test/confirm?token=secret',
      selection: {
        news: [],
        worthNoticing: [],
        social: [{ entryId: threads.id, summary: 'An unnecessary model-written summary.', imageEntryId: '' }],
      },
    })
    expect(result.html).toContain('Craig Mod · @craigmod')
    expect(result.html).toContain('Model names accumulate faster than people can understand what changed.')
    expect(result.html).not.toContain('An unnecessary model-written summary.')
    expect(result.text).toContain('Craig Mod · @craigmod: Model names accumulate faster than people can understand what changed.')
  })

  it('keeps the edited summary for a long social post', () => {
    const longPost: Entry = {
      ...article,
      id: 'social-long',
      kind: 'mastodon',
      feedTitle: 'Mastodon @writer',
      author: 'Writer',
      url: 'https://mastodon.social/@writer/1',
      contentHtml: `<p>${'A long post with details. '.repeat(40)}</p>`,
      excerpt: 'A long post with details.',
    }
    const result = renderBriefing({
      kind: 'evening',
      cutoff: new Date('2026-09-01T18:30:00.000Z'),
      entries: new Map([[longPost.id, longPost]]),
      confirmUrl: 'https://paper.example.test/briefings/test/confirm?token=secret',
      selection: {
        news: [],
        worthNoticing: [],
        social: [{ entryId: longPost.id, summary: 'The edited version keeps this long post readable.', imageEntryId: '' }],
      },
    })
    expect(result.html).toContain('The edited version keeps this long post readable.')
  })
})
