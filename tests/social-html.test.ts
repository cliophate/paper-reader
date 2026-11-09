import { describe, expect, it } from 'vitest'
import { formatInstagramHtml, formatThreadsHtml, formatXPostHtml, formatYoutubeHtml } from '../src/client/socialHtml'

describe('X post presentation', () => {
  it('turns quoted material into an inset post with an author', () => {
    const result = formatXPostHtml('My comment<hr /><div>Mitchell Hashimoto:\u2002The quoted post.<br /></div>')
    expect(result).toContain('<div class="x-post-body">My comment</div>')
    expect(result).toContain('<div class="x-quote-kicker">Quoted post</div>')
    expect(result).toContain('<div class="x-quote-author">Mitchell Hashimoto</div>')
    expect(result).toContain('<div class="x-quote-body">The quoted post.<br /></div>')
    expect(result).not.toContain('<hr')
  })

  it('labels a retweet and removes the RSSHub prefix from its body', () => {
    const result = formatXPostHtml('RT\u2002T3 Code<br />The reposted text')
    expect(result).toContain('<p class="x-repost-label">Reposted from <strong>T3 Code</strong></p>')
    expect(result).toContain('<div class="x-post-body">The reposted text</div>')
    expect(result).not.toContain('RT\u2002')
  })

  it('keeps links in quoted author names', () => {
    const result = formatXPostHtml('Reply<hr /><div>Theo - <a href="http://t3.gg">t3.gg</a>:\u2002Quoted text</div>')
    expect(result).toContain('<div class="x-quote-author">Theo - <a href="http://t3.gg">t3.gg</a></div>')
  })

  it('recognizes the styled RSSHub quote separator and wrapper', () => {
    const result = formatXPostHtml('Root text<hr style="border:0"><div class="rsshub-quote">Google:\u2002@Google<br><br>Quoted text</div>')
    expect(result).toContain('<div class="x-post-body">Root text</div>')
    expect(result).toContain('<div class="x-quote-kicker">Quoted post</div>')
    expect(result).toContain('<div class="x-quote-author">Google</div>')
    expect(result).toContain('<div class="x-quote-body">@Google<br><br>Quoted text</div>')
    expect(result).not.toContain('rsshub-quote')
  })

  it('groups trailing post images into a media grid', () => {
    const result = formatXPostHtml('A post<br /><img src="one.jpg" /><br /><img src="two.jpg" />')
    expect(result).toContain('class="x-media-grid media-count-2"')
    expect(result).toContain('<img src="one.jpg" />')
  })

  it('removes xgo engagement counters and its provider footer', () => {
    const html = '<div><div><div>Dive into the Arena.</div></div><div><span><span>💬</span><span>1</span></span><span><span>❤️</span><span>2</span></span></div><div><div><a href="https://xgo.ing/">⚡ Powered by xgo.ing</a></div></div></div>'
    const result = formatXPostHtml(html)
    expect(result).toContain('<div class="x-post-body">Dive into the Arena.</div>')
    expect(result).not.toContain('Powered by')
    expect(result).not.toContain('💬')
  })

  it('routes Twitter videos through Paper and enables inline playback', () => {
    const result = formatXPostHtml('<video src="https://video.twimg.com/amplify_video/123/example.mp4?tag=29&amp;x=1" controls></video>')
    expect(result).toContain('<video playsinline')
    expect(result).toContain('src="/api/x/media?url=https%3A%2F%2Fvideo.twimg.com%2Famplify_video%2F123%2Fexample.mp4%3Ftag%3D29%26x%3D1"')
  })
})

describe('Instagram presentation', () => {
  it('turns cached video links into a native video player', () => {
    const result = formatInstagramHtml('<p><img src="poster.jpg" /></p><p><a href="https://feed.example/video.mp4">Open video file</a></p>')
    expect(result).toBe('<video controls playsinline preload="metadata" poster="poster.jpg" src="https://feed.example/video.mp4"></video>')
  })
})

describe('Threads presentation', () => {
  it('removes the repeated account prefix', () => {
    expect(formatThreadsHtml('<p><strong>@craigmod</strong>:</p><p>A short post.</p><p></p>')).toBe('<p>A short post.</p>')
  })
})

describe('YouTube presentation', () => {
  it('keeps the description without repeating the feed thumbnail', () => {
    const html = '<figure class="enclosure"><p><img src="thumb.jpg" /></p><p class="enclosure-content">Save</p><figcaption class="enclosure-description">The description.<br /><br />More.</figcaption></figure>'
    expect(formatYoutubeHtml(html)).toBe('<div class="youtube-description">The description.<br /><br />More.</div>')
  })
})
