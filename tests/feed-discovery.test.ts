import { describe, expect, it, vi } from 'vitest'
import { discoverFeeds, parseDiscoveryDocument } from '../src/server/feed-discovery'

const parse = (body: string, contentType = 'text/html', responseUrl = 'https://example.test/redirected/page') => parseDiscoveryDocument({ body, contentType, responseUrl })
describe('feed discovery documents', () => {
  it('resolves relative candidates against the final response and HTML base, retaining multiple choices', () => {
    const result = parse('<title>Example</title><base href="../feeds/"><link rel="alternate" type="application/rss+xml" href="news.xml"><link rel="ALTERNATE stylesheet" type="application/atom+xml; charset=utf-8" title="Comments" href="comments.xml"><link rel="alternate" type="application/rss+xml" href="news.xml">')
    expect(result.candidates).toEqual([{ url: 'https://example.test/feeds/news.xml', title: 'Example', format: 'rss' }, { url: 'https://example.test/feeds/comments.xml', title: 'Comments', format: 'atom' }])
  })
  it('ignores unsafe URLs, non-feed alternates and scripts', () => {
    const result = parse('<script>throw Error("executed")</script><link rel="alternate" type="text/html" href="/other"><link rel="alternate" type="application/rss+xml" href="javascript:alert(1)"><link rel="alternate" type="application/rss+xml" href="https://user:secret@example.test/rss">')
    expect(result.candidates).toEqual([])
  })
  it('recognizes a direct feed and rejects malformed XML and entity documents', () => {
    expect(parse('<rss version="2.0"><channel><title>News</title></channel></rss>', 'application/rss+xml').candidates[0].format).toBe('rss')
    expect(() => parse('<rss><channel>', 'text/xml')).toThrow(/valid RSS/)
    expect(() => parse('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]><rss><channel/></rss>', 'text/xml')).toThrow()
  })
  it('uses only the injected shared transport and its final response URL', async () => {
    const transport = vi.fn(async () => ({ body: '<link rel="alternate" type="application/atom+xml" href="feed">', responseUrl: 'https://redirect.test/path/', contentType: 'text/html' }))
    const result = await discoverFeeds('https://example.test/', transport)
    expect(transport).toHaveBeenCalledWith('https://example.test/')
    expect(result.candidates[0].url).toBe('https://redirect.test/path/feed')
    await expect(discoverFeeds('https://user:password@example.test/', transport)).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('bounds advertised candidates', () => {
    expect(() => parse(Array.from({ length: 101 }, (_, i) => `<link rel="alternate" type="application/rss+xml" href="/${i}">`).join(''))).toThrow(/100 feeds/)
  })
})
