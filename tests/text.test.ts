import { describe, expect, it } from 'vitest'
import { cleanArticleHtml, decodeHtmlText, emailText, excerpt, firstImage, plainText, readingMinutes } from '../src/server/text.js'

describe('article text', () => {
  it('removes scripts and unsafe attributes', () => {
    const result = cleanArticleHtml('<p onclick="alert(1)">Hello</p><script>alert(2)</script><a href="javascript:alert(3)">bad</a>')
    expect(result).toContain('<p>Hello</p>')
    expect(result).not.toContain('script')
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('javascript:')
  })

  it('opens article links outside the reader', () => {
    const result = cleanArticleHtml('<a href="https://example.test/story">Story</a>')
    expect(result).toContain('target="_blank"')
    expect(result).toContain('rel="noopener noreferrer"')
  })

  it('promotes lazy images and removes feed chrome', () => {
    const result = cleanArticleHtml('<post-hero><h1>Repeated title</h1></post-hero><p>Story</p><img src="blank.gif" data-lazy-src="https://example.test/large.jpg"><a class="more-link"><img src="/arrow.svg" alt="Read more arrow"></a>')
    expect(result).toContain('src="https://example.test/large.jpg"')
    expect(result).not.toContain('Repeated title')
    expect(result).not.toContain('arrow.svg')
  })

  it('decodes article markup when a feed escapes the whole body', () => {
    const result = cleanArticleHtml('&lt;p&gt;&lt;img width=&quot;480&quot; src=&quot;https://example.test/hero.webp?width=480&amp;amp;height=360&quot; /&gt;&lt;/p&gt;&lt;p&gt;Moondrop&amp;#39;s headset &amp;amp;amp; speakers.&lt;/p&gt;<figure class="enclosure"><a href="https://example.test/video">Video</a></figure>')

    expect(result).toContain('<img width="480" src="https://example.test/hero.webp?width=480&amp;height=360" loading="lazy" />')
    expect(result).toContain("<p>Moondrop's headset &amp; speakers.</p>")
    expect(result).toContain('<figure class="enclosure">')
    expect(result).not.toContain('&lt;p&gt;')
  })

  it('decodes article markup when a feed escapes the whole body twice', () => {
    const result = cleanArticleHtml('&amp;lt;p&amp;gt;&amp;lt;img src=&amp;quot;https://example.test/cover.jpg?a=1&amp;amp;amp;b=2&amp;quot; /&amp;gt;&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;A&amp;amp;#39;s B &amp;amp;amp;amp; C&amp;lt;/p&amp;gt;')

    expect(result).toContain('<img src="https://example.test/cover.jpg?a=1&amp;b=2" loading="lazy" />')
    expect(result).toContain("<p>A's B &amp; C</p>")
    expect(result).not.toContain('&lt;p&gt;')
  })

  it('repairs an auto-linked image source inside escaped feed markup', () => {
    const result = cleanArticleHtml('&lt;p&gt;&lt;img width="480" src="<a href="https://example.test/cover.webp?a=1&amp;b=2">https://example.test/cover.webp?a=1&amp;b=2</a>" /&gt;&lt;/p&gt;&lt;p&gt;Headphones &amp;amp; speakers.&lt;/p&gt;')

    expect(result).toContain('<img width="480" src="https://example.test/cover.webp?a=1&amp;b=2" loading="lazy" />')
    expect(result).toContain('<p>Headphones &amp; speakers.</p>')
    expect(result).not.toContain('&lt;img')
  })

  it('turns a legacy YouTube enclosure into a normal video link', () => {
    const result = cleanArticleHtml('<figure class="enclosure"><p><a download="" href="https://www.youtube.com/watch?v=example" data-type="application/x-shockwave-flash">💾</a></p></figure>')

    expect(result).toContain('>Watch video</a>')
    expect(result).not.toContain('💾')
  })

  it('creates a bounded plain excerpt', () => {
    expect(excerpt(`<p>${'word '.repeat(100)}</p>`, 40).length).toBeLessThanOrEqual(43)
  })

  it('decodes HTML entities in plain text and excerpts', () => {
    expect(plainText('<p>Audio &amp; listening &lt;3</p>')).toBe('Audio & listening <3')
    expect(excerpt('<p>Rock &amp;amp; roll</p>')).toBe('Rock & roll')
    expect(decodeHtmlText('One &amp;amp;amp; two')).toBe('One & two')
  })

  it('estimates at least one minute', () => {
    expect(readingMinutes('<p>A short post.</p>')).toBe(1)
  })

  it('decodes escaped query separators in image URLs', () => {
    expect(firstImage('<img src="https://example.test/image?format=jpg&amp;amp;name=orig">'))
      .toBe('https://example.test/image?format=jpg&name=orig')
  })

  it('removes forbidden punctuation from generated copy', () => {
    expect(emailText('One — two – three “four”')).toBe('One, two, three "four"')
  })
})
