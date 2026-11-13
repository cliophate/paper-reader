import { describe, expect, it } from 'vitest'
import { readReaderLocation, readerLocationUrl, readerSlug, resolveReaderLocation, type ReaderLinks } from '../src/client/location'
import { readerLocationUrl as legacyUrl } from './fixtures/legacy-location'
import type { Entry, Feed } from '../src/client/types'

const feed = { id: 'paper:subscription:one', title: 'Example Feed', linkNumber: 12 } as Feed
const article = { id: 'paper:article:one', feedId: feed.id, linkNumber: 48213 } as Entry
const links: ReaderLinks = {
  navigation: { unread: 1, starred: 1, uncategorized: [feed], folders: [{ id: 'paper:folder:one', title: 'A', linkNumber: 13, unread: 1, feeds: [feed] }] },
  entries: [article],
  collections: [{ id: 'collection-uuid', linkNumber: 14, headline: 'Synthetic collection', sources: [{ id: article.id }] }],
}
const resolve = (url: string, targets = links) => resolveReaderLocation(readReaderLocation(url), targets, async () => null, async () => null)

describe('reader routes', () => {
  for (const path of ['/', '/starred', '/feed/12/example-feed', '/folder/13/a', '/a/48213', '/starred/a/48213', '/feed/12/example-feed/a/48213', '/folder/13/a/a/48213', '/collection/14', '/collection/14/a/48213', '/recent', '/recent/a/48213', '/offline', '/offline/a/48213', '/briefings', '/pulse']) {
    it(`round trips ${path}`, async () => {
      const result = await resolve(path)
      expect(result.notice).toBe('')
      expect(readerLocationUrl(result.location, links)).toBe(path)
    })
  }
  it('parses optional slugs and the literal a by segment count', async () => {
    expect((await resolve('/folder/13/a')).location.selectedId).toBe('')
    expect((await resolve('/folder/13/a/48213')).location.selectedId).toBe(article.id)
    expect((await resolve('/folder/13/a/a/48213')).location.selectedId).toBe(article.id)
    expect(readerLocationUrl((await resolve('/feed/12/a/48213')).location, links)).toBe('/feed/12/example-feed/a/48213')
  })
  it('corrects stale and duplicate titles using IDs, with bounded ASCII slugs', async () => {
    expect(readerLocationUrl((await resolve('/feed/12/old-title')).location, links)).toBe('/feed/12/example-feed')
    expect(readerSlug('  Café & NEWS!  ')).toBe('cafe-news')
    expect(readerSlug('中文')).toBe('')
    expect(readerSlug('a'.repeat(80))).toHaveLength(60)
    const empty = { ...links, navigation: { ...links.navigation!, uncategorized: [{ ...feed, title: '中文' }], folders: [] } }
    expect(readerLocationUrl((await resolve('/feed/12', empty)).location, empty)).toBe('/feed/12')
  })
  it('keeps search scope, dates, unread and pane with path defaults', async () => {
    const route = '/feed/12/example-feed/a/48213?unread=0&q=quiet&in=folder%2F13&after=2026-01-01&before=2026-02-01&pane=stories'
    expect(readerLocationUrl((await resolve(route)).location, links)).toBe(route)
    expect(readReaderLocation('/a/48213').mobilePane).toBe('article')
    expect(readReaderLocation('/a/48213?pane=sources').mobilePane).toBe('sources')
    expect(readerLocationUrl((await resolve('/?pane=stories')).location, links)).toBe('/?pane=stories')
  })
  it('rewrites bookmarks produced by the original URL writer', async () => {
    const old = legacyUrl({ view: 'reader', stream: { kind: 'feed', id: feed.id, title: 'Old feed title' }, selectedId: article.id,
      unreadOnly: false, query: 'quiet', mobilePane: 'article', searchStream: { kind: 'category', id: 'paper:folder:one', title: 'Old folder' }, searchUnread: true,
      after: '2026-01-01', before: '2026-02-01' })
    expect(old).toContain('entry=paper%3Aarticle%3Aone')
    const result = await resolve(old)
    expect(result.location.selectedId).toBe(article.id)
    expect(readerLocationUrl(result.location, links)).toBe('/feed/12/example-feed/a/48213?unread=1&q=quiet&in=folder%2F13&after=2026-01-01&before=2026-02-01')
    for (const view of ['briefings', 'pulse'] as const) {
      const url = legacyUrl({ view, stream: { kind: 'all', id: 'all', title: 'All articles' }, selectedId: '', unreadOnly: true, query: '', mobilePane: 'sources' })
      expect(readerLocationUrl((await resolve(url)).location, links)).toBe(`/${view}`)
    }
    expect(readReaderLocation('/?view=topics').view).toBe('pulse')
  })
  it('keeps legacy parameters emitted without a stream or article ID', async () => {
    const base = { view: 'reader' as const, stream: { kind: 'all' as const, id: 'all', title: 'All articles' },
      selectedId: '', unreadOnly: false, query: 'quiet', mobilePane: 'stories' as const, searchUnread: true }
    const old = legacyUrl(base)
    expect(old).toBe('/?unread=0&q=quiet&searchUnread=1&pane=stories')
    expect(readReaderLocation(old).searchUnread).toBe(true)
    expect(readerLocationUrl((await resolve(old)).location, links)).toBe('/?unread=1&q=quiet&pane=stories')
    const titled = legacyUrl({ ...base, query: '', stream: { ...base.stream, title: 'Custom all title' } })
    expect(readReaderLocation(titled).stream.title).toBe('Custom all title')
    for (const library of ['recent', 'offline'] as const) {
      const url = legacyUrl({ ...base, query: '', library })
      expect(readerLocationUrl((await resolve(url)).location, links)).toBe(`/${library}?unread=0&pane=stories`)
    }
    const collection = legacyUrl({ ...base, query: '', view: 'pulse', collection: 'collection-uuid' })
    expect(readerLocationUrl((await resolve(collection)).location, links)).toBe('/collection/14?unread=0&pane=stories')
    const archive = legacyUrl({ ...base, unreadOnly: true, searchUnread: false })
    expect(archive).toBe('/?q=quiet&pane=stories')
    expect(readReaderLocation(archive)).toMatchObject({ unreadOnly: true, searchUnread: false })
    expect(readerLocationUrl((await resolve(archive)).location, links)).toBe(archive)
    expect(readReaderLocation('/?unread=1&q=quiet')).toMatchObject({ unreadOnly: true, searchUnread: true })
    for (const query of ['', 'quiet']) {
      const url = legacyUrl({ ...base, query, searchUnread: false, after: '2026-01-01', before: '2026-02-01' })
      expect(readerLocationUrl((await resolve(url)).location, links)).toBe(url)
    }
  })

  it('keeps old Starred search scopes in the Starred path', async () => {
    const old = legacyUrl({ view: 'reader', stream: { kind: 'all', id: 'all', title: 'All articles' }, selectedId: '',
      unreadOnly: true, query: 'quiet', mobilePane: 'stories', searchStream: { kind: 'starred', id: 'starred', title: 'Starred' }, searchUnread: false })
    const canonical = readerLocationUrl((await resolve(old)).location, links)
    expect(canonical).toBe('/starred?q=quiet&pane=stories')
    expect((await resolve(canonical)).location.searchStream?.kind).toBe('starred')
    const all = { ...readReaderLocation('/starred?unread=0&q=quiet'), searchStream: { kind: 'all' as const, id: 'all', title: 'All articles' } }
    expect(readerLocationUrl(all, links)).toBe('/?unread=0&q=quiet')
  })

  it('falls back with notices for missing targets and leaves an unknown article in its stream', async () => {
    for (const kind of ['feed', 'folder', 'collection']) {
      const result = await resolve(`/${kind}/999`)
      expect(result.notice).toMatch(/not found/)
      expect(readerLocationUrl(result.location, links)).toBe('/')
    }
    const result = await resolve('/feed/12/example-feed/a/999')
    expect(result.notice).toBe('Article not found')
    expect(readerLocationUrl(result.location, links)).toBe('/feed/12/example-feed?pane=stories')
  })
  it('resolves an unloaded article and corrects its former feed', async () => {
    const moved = { ...article, feedId: 'new-feed' }
    const targets = { ...links, entries: [], navigation: { ...links.navigation!, uncategorized: [feed, { ...feed, id: 'new-feed', title: 'New feed', linkNumber: 15 }] } }
    const result = await resolveReaderLocation(readReaderLocation('/feed/12/example-feed/a/48213'), targets, async n => n === 48213 ? moved : null, async () => null)
    expect(result.entry).toEqual(moved)
    expect(readerLocationUrl(result.location, { ...targets, entries: [moved] })).toBe('/feed/15/new-feed/a/48213')
  })
})
