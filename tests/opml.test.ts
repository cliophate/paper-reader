import { describe, expect, it } from 'vitest'
import { exportOpml, OPML_LIMITS, opmlIdentity, parseOpml, previewOpml } from '../src/server/opml'
import type { Feed, NavigationPayload } from '../src/server/types'

export const feed = (id: string, url = 'https://example.test/rss'): Feed => ({ id, title: id, url, siteUrl: 'https://example.test/', iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false })
const navigation: NavigationPayload = { unread: 0, starred: 0, folders: [{ id: 'a', title: 'Science', unread: 0, feeds: [feed('one'), feed('two')] }, { id: 'b', title: 'Reading', unread: 0, feeds: [feed('one')] }], uncategorized: [feed('three', 'https://other.test/feed')] }
const wrap = (body: string) => `<opml version="2.0"><body>${body}</body></opml>`

describe('OPML parsing and portability', () => {
  it('retains distinct subscription identities and groups repeated identity outlines into memberships', () => {
    const { xml, omitted } = exportOpml(navigation, 'backend')
    expect(omitted).toBe(0)
    const parsed = parseOpml(xml)
    expect(parsed.subscriptions).toHaveLength(3)
    const preview = previewOpml(parsed, navigation, 'backend')
    expect(preview.map(row => row.suggestedId)).toEqual(['one', 'two', 'three'])
    expect(preview[0].folders).toEqual(['Science', 'Reading'])
    expect(preview[0].matches.map(row => row.id)).toEqual(['one', 'two'])
    expect(xml).not.toContain('paper:id="one"')
  })

  it('does not implicitly merge imported identities by URL on another backend', () => {
    const parsed = parseOpml(exportOpml(navigation, 'backend').xml)
    const preview = previewOpml(parsed, { ...navigation, folders: [], uncategorized: [feed('other')] }, 'different-backend')
    expect(preview.slice(0, 2).map(row => row.suggestedId)).toEqual([null, null])
    expect(preview.slice(0, 2).every(row => row.repeatedUrl)).toBe(true)
  })

  it('flags conflicting exported identity and endpoint evidence', () => {
    const xml = exportOpml(navigation, 'backend').xml
    const changed = { ...navigation, folders: [], uncategorized: [feed('one', 'https://changed.test/rss')] }
    const first = previewOpml(parseOpml(xml), changed, 'backend')[0]
    expect(first.identityConflict).toBe(true)
    expect(first.suggestedId).toBeNull()
    expect(first.matches[0].url).toBe('https://changed.test/rss')
  })

  it('flattens nested groups deterministically and reports ambiguous full-path names', () => {
    const parsed = parseOpml(wrap('<outline text="News"><outline text="World"><outline text="A &amp; B" xmlUrl="https://one.test/rss"/></outline></outline><outline text="News / World"><outline xmlUrl="https://two.test/rss"/></outline>'))
    const rows = previewOpml(parsed, { ...navigation, folders: [], uncategorized: [] }, 'backend')
    expect(rows[0].title).toBe('A & B')
    expect(rows[0].sourcePaths).toEqual([['News', 'World']])
    expect(rows.map(row => row.folders)).toEqual([['News / World'], ['News / World']])
    expect(rows.every(row => row.folderConflict)).toBe(true)
  })

  it('retains repeated plain outlines as separate rows and never assumes they identify one subscription', () => {
    const parsed = parseOpml(wrap('<outline xmlUrl="https://same.test/rss"/><outline xmlUrl="https://same.test/rss"/>'))
    const rows = previewOpml(parsed, { ...navigation, folders: [], uncategorized: [feed('existing', 'https://same.test/rss')] }, 'backend')
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.repeatedUrl && row.suggestedId === null)).toBe(true)
  })

  it.each(['<opml><body></opml>', '<opml><body>&unknown;</body></opml>', '<!DOCTYPE opml [<!ENTITY secret SYSTEM "file:///private">]><opml><body>&secret;</body></opml>', '<html/>', '<opml/>', '<opml><body/><body/></opml>'])('rejects malformed or unsafe XML', xml => {
    expect(() => parseOpml(xml)).toThrow()
  })

  it('bounds bytes, depth and subscription count', () => {
    expect(() => parseOpml(' '.repeat(OPML_LIMITS.bytes + 1))).toThrow(/1 MiB/)
    expect(() => parseOpml(wrap('<outline>'.repeat(40) + '</outline>'.repeat(40)))).toThrow(/structure/)
    expect(() => parseOpml(wrap('<outline xmlUrl="https://example.test/rss"/>'.repeat(1001)))).toThrow(/1,000/)
  })

  it('rejects embedded credentials and omits credential query parameters from export', () => {
    const privateNav = { ...navigation, folders: [], uncategorized: [feed('feed/https://user:password@example.test/rss', 'https://user:password@example.test/rss'), feed('secret', 'https://example.test/rss?token=private-value')] }
    const exported = exportOpml(privateNav, 'private-backend')
    expect(exported.omitted).toBe(2)
    expect(exported.xml).not.toMatch(/password|private-value|private-backend/)
    const rows = parseOpml(wrap('<outline xmlUrl="https://user:password@example.test/rss"/>')).subscriptions
    expect(rows[0].url).toBe('')
    expect(rows[0].problem).toBeTruthy()
  })

  it('uses namespace URI for the identity extension and supports predefined/numeric entities', () => {
    const id = opmlIdentity('backend', 'one')
    const parsed = parseOpml(`<opml xmlns:x="https://paper-reader.app/ns/opml"><body><outline text="A &amp; &#66;" xmlUrl="https://example.test/rss?a=1&amp;b=2" x:id="${id}"/></body></opml>`)
    expect(parsed.subscriptions[0].identity).toBe(id)
    expect(parsed.subscriptions[0].title).toBe('A & B')
  })
})
