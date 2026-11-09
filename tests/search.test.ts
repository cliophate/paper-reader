import { describe, expect, it } from 'vitest'
import { entryMatchesSearch } from '../src/server/search.js'
import type { Entry } from '../src/server/types.js'

const entry: Entry = {
  id: '1', feedId: 'feed/one', feedTitle: 'Small Systems', feedUrl: '',
  title: 'A quiet computer for the living room', author: 'Ada Writer', url: 'https://example.test/one',
  contentHtml: '<p>The machine runs <strong>Bazzite</strong> and changed how we play games.</p>', excerpt: '',
  publishedAt: '2026-09-01T00:00:00.000Z', timestamp: 1, read: false, starred: false,
  readingMinutes: 2, thumbnailUrl: '', kind: 'article',
}

describe('archive search', () => {
  it('matches every term across title, source, author, and article text', () => {
    expect(entryMatchesSearch(entry, 'quiet bazzite')).toBe(true)
    expect(entryMatchesSearch(entry, 'ADA systems')).toBe(true)
  })

  it('rejects an entry when any term is absent', () => {
    expect(entryMatchesSearch(entry, 'quiet wayland')).toBe(false)
  })
})
