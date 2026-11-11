import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FEED_LIMITS, parseFeed } from '../src/server/feed-parser.js'
const base = 'https://example.test/feeds/feed.xml'
const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/feeds/${name}.xml`, import.meta.url), 'utf8')
const rss = (items: string) => `<rss version="2.0"><channel><title>Fixture</title>${items}</channel></rss>`

describe('feed parsing', () => {
  it('parses RSS namespaces, CDATA, dates, relative links and image enclosures', () => {
    const feed = parseFeed(fixture('rss'), base)
    expect(feed).toMatchObject({ format: 'rss', title: 'Synthetic & news', siteUrl: 'https://example.test/' })
    expect(feed.entries[0]).toMatchObject({ externalId: 'story-1', title: 'First & best', author: 'Ada', url: 'https://example.test/posts/one', publishedAt: '2024-01-01T12:00:00.000Z' })
    expect(feed.entries[0].contentHtml).toContain('https://example.test/more')
    expect(feed.entries[0].contentHtml).toContain('https://example.test/image.jpg')
    expect(feed.entries[0].contentHtml).not.toMatch(/script|onerror|bad\(\)/)
    expect(feed.entries[1]).toMatchObject({ publishedAt: '', externalId: undefined, thumbnailUrl: 'https://example.test/cover.jpg' })
  })
  it('parses Atom text constructs, nested xml:base, alternate links and inherited authors', () => {
    const feed = parseFeed(fixture('atom'), base)
    expect(feed).toMatchObject({ format: 'atom', title: 'Synthetic Atom', siteUrl: 'https://example.test/root/' })
    expect(feed.entries[0]).toMatchObject({ externalId: 'urn:story:1', title: 'Plain <title>', author: 'Ada', url: 'https://example.test/root/posts/one', publishedAt: '2024-01-01T12:00:00.000Z' })
    expect(feed.entries[0].contentHtml).toContain('https://example.test/root/images/one.jpg')
    expect(feed.entries[0].contentHtml).toContain('https://example.test/root/two')
    expect(feed.entries[1]).toMatchObject({ publishedAt: '2026-01-01T00:00:00.000Z', contentHtml: '&lt;script&gt;literal&lt;/script&gt;' })
  })
  it('uses Atom updated only when published is absent and leaves undated entries empty', () => {
    let index = 0
    const entry = (dates: string) => `<entry><id>urn:date:${index++}</id>${dates}</entry>`
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      ${entry('<updated>2024-02-01T00:00:00Z</updated>')}
      ${entry('<published>2024-01-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated>')}
      ${entry('<published>invalid</published><updated>2024-02-01T00:00:00Z</updated>')}
      ${entry('')}
    </feed>`
    expect(parseFeed(xml, base).entries.map(item => item.publishedAt)).toEqual([
      '2024-02-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '', '',
    ])
  })
  it('supports RSS 1.0 and 0.90 RDF with URI identity', () => {
    for (const xml of [fixture('rdf'), fixture('rdf').replaceAll('http://purl.org/rss/1.0/', 'http://my.netscape.com/rdf/simple/0.9/')]) {
      expect(parseFeed(xml, base).entries[0]).toMatchObject({ externalId: 'https://example.test/feeds/post', author: 'Ada', publishedAt: '2024-01-01T00:00:00.000Z' })
    }
  })
  it('supports RSS 0.91/0.92 and permalink GUID defaults without treating opaque IDs as links', () => {
    for (const version of ['2.0', '0.91', '0.92']) {
      const xml = rss('<item><guid>https://example.test/a</guid></item><item><guid isPermaLink="false">opaque</guid></item>').replace('2.0', version)
      expect(parseFeed(xml, base).entries.map(e => e.url)).toEqual(['https://example.test/a', ''])
    }
  })
  it('uses the final response URL as the relative base and ignores extension items', () => {
    const feed = parseFeed(rss('<item><guid>x</guid><link>post</link></item><item xmlns="urn:extension"><title>Ignore</title></item>'), 'https://redirect.test/new/feed')
    expect(feed.entries).toHaveLength(1)
    expect(feed.entries[0].url).toBe('https://redirect.test/new/post')
  })
  it('sanitizes active markup and rejects unsafe or credential-bearing URLs', () => {
    const feed = parseFeed(rss('<item><guid isPermaLink="false">x</guid><link>javascript:bad()</link><description><![CDATA[<img src="data:text/html,bad" srcset="evil 1x" onerror="bad()"><a href="javascript:bad()">x</a><iframe src="https://evil.test/"></iframe><svg onload="bad()"></svg><img src="https://user:password@example.test/a">]]></description></item>'), base)
    expect(feed.entries[0].url).toBe('')
    expect(feed.entries[0].contentHtml).not.toMatch(/javascript|data:|onerror|onload|iframe|svg|srcset|password/)
    expect(() => parseFeed(rss(''), 'https://user:password@example.test/feed')).toThrow(/credentials/)
  })
  it('deduplicates exact items and removes every conflicting source ID regardless of order', () => {
    const one = '<item><guid>x</guid><title>One</title><link>/one</link></item>'
    const two = one.replace('One', 'Two').replace('/one', '/two')
    const other = one.replace('<guid>x', '<guid>y')
    expect(parseFeed(rss(one + one), base).entries).toHaveLength(1)
    for (const items of [one + two + one + other, two + one + two + other]) {
      const { entries, conflictingExternalIds } = parseFeed(rss(items), base)
      expect(conflictingExternalIds).toEqual(['x'])
      expect(entries).toHaveLength(3)
      expect(entries.slice(0, 2).map(entry => entry.externalId)).toEqual([undefined, undefined])
      expect(entries[2].externalId).toBe('y')
      expect(new Set(entries.slice(0, 2).map(entry => entry.title))).toEqual(new Set(['One', 'Two']))
    }
  })
  it.each([
    '', '<rss>', '<rss version="2.0"><channel></rss>', rss('<item>&unknown;</item>'), rss('<item>&#0;</item>'),
    '<!DOCTYPE rss [<!ENTITY x "expanded">]>' + rss('<item>&x;</item>'),
    '<!DOCTYPE rss SYSTEM "file:///no-read">' + rss(''),
    rss('<item p:x="unbound"/>'), rss('<item x="1" x="2"/>'),
    '<feed xmlns="urn:wrong"/>', '<rss version="2.0"/>', '<html/>',
  ])('rejects malformed or unsupported XML: %s', xml => {
    expect(() => parseFeed(xml, base)).toThrow()
  })
  it('allows predefined/numeric XML entities and literal entity text in CDATA', () => {
    expect(parseFeed(rss('<item><guid>x</guid><title>&amp; &#65; &#x42;</title><description><![CDATA[Literal &unknown;]]></description></item>'), base).entries[0].title).toBe('& A B')
  })
  it('bounds bytes, nesting, nodes and entries before ingestion', () => {
    expect(() => parseFeed('é'.repeat(FEED_LIMITS.bytes / 2 + 1), base)).toThrow(/byte limit/)
    expect(() => parseFeed(rss('<x>'.repeat(64) + '</x>'.repeat(64)), base)).toThrow(/structure limit/)
    expect(() => parseFeed(rss('<x/>'.repeat(FEED_LIMITS.nodes)), base)).toThrow(/structure limit/)
    expect(() => parseFeed(rss('<item/>'.repeat(FEED_LIMITS.entries + 1)), base)).toThrow(/entry limit/)
  })
})
