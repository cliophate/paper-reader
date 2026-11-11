import { spawnSync } from 'node:child_process'
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

  it('removes only a complete syndication footer', () => {
    const footer = '<p>The post <a href="https://example.test/post">Story</a> appeared first on <a href="https://example.test">Site</a>.</p>'
    expect(cleanArticleHtml('<p>Before</p>' + footer + '<p>After</p>')).toBe('<p>Before</p><p>After</p>')
    expect(cleanArticleHtml('<p>The post <a>Story</a></p><p>appeared first on <a>Site</a></p>')).toContain('Story')
    expect(cleanArticleHtml('<p>Discussing The post <a>Story</a> appeared first on <a>Site</a></p>')).toContain('Discussing')
  })

  it('keeps unrelated content after unclosed or implicitly closed cleanup elements', () => {
    for (const markup of [
      '<post-hero>Unclosed hero<p>Keep this story</p>',
      '<div><post-hero>Unclosed hero</div><p>Keep this story</p>',
      '<figure class="enclosure"><a href="https://youtube.com/watch?v=x">Video</a><p>Keep this story</p>',
      '<div><figure class="enclosure"><a href="https://youtube.com/watch?v=x">Video</a></div><p>Keep this story</p>',
      '<p>The post <a>Story</a> appeared first on <a>Site</a><p>Keep this story</p>',
      '<p>The post <a>Story</a> appeared first on <a>Site</a><div>Keep this story</div>',
      '<p>The post <a>Story</a> appeared first on <a>Site</a><span><p>Keep this story</p></span></p>',
    ]) {
      const result = cleanArticleHtml(markup)
      expect(result).toContain('Keep this story')
      expect(result).not.toContain('Watch video')
    }
  })

  it('does not borrow a video link or closing tag from a sibling figure', () => {
    const result = cleanArticleHtml('<figure class="enclosure">Keep enclosure</figure><figure><a href="https://youtube.com/watch?v=x">Keep video</a></figure>')
    expect(result).toContain('Keep enclosure')
    expect(result).toContain('Keep video')
    expect(result).not.toContain('Watch video')
  })

  it('handles nested cleanup ranges and ignores video links inside removed chrome', () => {
    const video = '<a href="https://youtube.com/watch?v=x">Video</a>'
    expect(cleanArticleHtml('<post-hero><post-hero>Inner</post-hero><figure class="enclosure">' + video + '</figure>Outer</post-hero><p>Story</p>'))
      .toBe('<p>Story</p>')
    const nested = cleanArticleHtml('<figure class="enclosure"><figure class="enclosure">' + video + '</figure></figure><p>Story</p>')
    expect(nested.match(/Watch video/g)).toHaveLength(1)
    expect(nested).toContain('<p>Story</p>')
    const removed = cleanArticleHtml('<figure class="enclosure"><post-hero>' + video + '</post-hero><p>The post <a>Story</a> appeared first on ' + video + '</p>Keep media</figure>')
    expect(removed).toBe('<figure class="enclosure">Keep media</figure>')
  })

  it('matches footers only after removing hero content', () => {
    const result = cleanArticleHtml('<p>The post <a>Story</a><post-hero> appeared first on <a>Site</a></post-hero>Keep this paragraph</p>')
    expect(result).toContain('Keep this paragraph')
    expect(result).not.toContain('Site')
    expect(cleanArticleHtml('<p><post-hero>Heading</post-hero>The post <a>Story</a> appeared first on <a>Site</a></p><p>Keep this story</p>'))
      .toBe('<p>Keep this story</p>')
  })

  it('handles quoted tag delimiters and escapes reconstructed video URLs', () => {
    const result = cleanArticleHtml(`<figure title="a > b" class="enclosure"><a title="c > d" href='https://www.youtube.com/watch?v=x&amp;title=&quot;onmouseover=&quot;bad'>Video</a></figure>`)
    expect(result).toBe('<p><a href="https://www.youtube.com/watch?v=x&amp;title=&quot;onmouseover=&quot;bad" rel="noopener noreferrer" target="_blank">Watch video</a></p>')
  })

  it('repairs multiple linked image sources with quoted delimiters and nested link text', () => {
    const result = cleanArticleHtml(`<p><img src='<a title="a > b" href="https://example.test/a?a=1&amp;b=2"><em>Image</em></a>'><img src="<a href='https://example.test/b'>Image</a>"></p>`)
    expect(result).toBe('<p><img src="https://example.test/a?a=1&amp;b=2" loading="lazy" /><img src="https://example.test/b" loading="lazy" /></p>')
    const malformed = cleanArticleHtml(`src="<a href="https://example.test/bad">unclosed <p><img src="<a href="https://example.test/good">Image</a>"></p>`)
    expect(malformed).toContain('<img src="https://example.test/good" loading="lazy" />')
  })

  it('does not repair an unclosed image link using a nested anchor close', () => {
    const result = cleanArticleHtml(`<p><img src="<a href='https://example.test/outer'><a href='https://example.test/inner'>Image</a>"></p><p>Keep story</p>`)
    expect(result).not.toContain('src="https://example.test/outer"')
    expect(result).toContain('<p>Keep story</p>')
  })

  it('keeps decoding after linked-image repair and before structural cleanup', () => {
    const result = cleanArticleHtml('&lt;p&gt;&lt;img src="<a href="https://example.test/image">Image</a>"&gt;&lt;/p&gt;&lt;figure class="enclosure"&gt;&lt;a href="https://youtube.com/watch?v=x"&gt;Video&lt;/a&gt;&lt;/figure&gt;')
    expect(result).toBe('<p><img src="https://example.test/image" loading="lazy" /></p><p><a href="https://youtube.com/watch?v=x" rel="noopener noreferrer" target="_blank">Watch video</a></p>')
  })

  it('preserves ordinary media and applies the existing sanitizer after cleanup', () => {
    const result = cleanArticleHtml('<figure class="enclosure"><video controls poster="https://example.test/poster"><source src="https://example.test/movie" type="video/mp4"></video><figcaption>Movie</figcaption></figure><iframe src="https://www.youtube.com/embed/x" allowfullscreen></iframe><iframe src="https://evil.test/embed"></iframe><a href="javascript:alert(1)">Unsafe</a><img src="blank.gif" data-src="https://example.test/cover" onerror="bad()"><span class="screen-reader-text">Hidden</span>')
    expect(result).toContain('<figure class="enclosure"><video controls poster="https://example.test/poster"><source src="https://example.test/movie" type="video/mp4"></source></video><figcaption>Movie</figcaption></figure>')
    expect(result).toContain('src="https://www.youtube.com/embed/x"')
    expect(result).toContain('src="https://example.test/cover"')
    expect(result).not.toMatch(/evil|javascript|onerror|Hidden/)
  })

  it.each(['enclosure', 'hero', 'footer', 'image', 'deep', 'nestedParagraphs'])('bounds repeated or deep %s markup in a killable subprocess', name => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/article-cleanup-benchmark.mjs', 'src/server/text.ts', '--case', name, '10000'], {
      encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH },
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout).count).toBe(10000)
  }, 10_000)

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
