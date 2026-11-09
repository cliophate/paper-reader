import { describe, expect, it } from 'vitest'
import { isThreadContinuation, parseXStatusUrl, parseXThreadXml } from '../src/server/x-thread.js'

describe('X thread loading', () => {
  it('parses canonical X and Twitter status URLs', () => {
    expect(parseXStatusUrl('https://x.com/example/status/123?s=20')).toEqual({ handle: 'example', status: '123' })
    expect(parseXStatusUrl('https://twitter.com/Example/status/456')).toEqual({ handle: 'Example', status: '456' })
  })

  it('keeps same-author replies, excludes the root and sorts chronologically', () => {
    const xml = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <item><title>Re Third</title><link>https://x.com/example/status/3</link><description>Re Third</description><dc:creator>Ada</dc:creator><pubDate>Wed, 02 Sep 2026 10:03:00 GMT</pubDate></item>
      <item><title>Re @example Other reply</title><link>https://x.com/other/status/2</link><description>Other reply</description><pubDate>Wed, 02 Sep 2026 10:02:00 GMT</pubDate></item>
      <item><link>https://x.com/example/status/1</link><description>Root</description><pubDate>Wed, 02 Sep 2026 10:01:00 GMT</pubDate></item>
      <item><title>Re @example Second</title><link>https://x.com/example/status/2</link><description>Re @example &lt;p&gt;Second&lt;/p&gt;</description><dc:creator>Ada</dc:creator><pubDate>Wed, 02 Sep 2026 10:02:00 GMT</pubDate></item>
      <item><title>Re @someone_else Conversation reply</title><link>https://x.com/example/status/4</link><description>Not part of the thread</description><dc:creator>Ada</dc:creator><pubDate>Wed, 02 Sep 2026 10:04:00 GMT</pubDate></item>
    </channel></rss>`
    const posts = parseXThreadXml(xml, { handle: 'example', status: '1' })
    expect(posts.map(post => post.id)).toEqual(['2', '3'])
    expect(posts[0]).toMatchObject({ author: 'Ada', contentHtml: '<p>Second</p>' })
  })

  it('distinguishes self-thread continuations from replies to other people', () => {
    expect(isThreadContinuation('Re Another part', 'example')).toBe(true)
    expect(isThreadContinuation('Re @Example Another part', 'example')).toBe(true)
    expect(isThreadContinuation('Re @someone_else A conversation reply', 'example')).toBe(false)
    expect(isThreadContinuation('Re A quoted reply', 'example', '<div class="rsshub-quote">Someone else</div>')).toBe(false)
    expect(isThreadContinuation('A standalone post', 'example')).toBe(false)
  })
})
