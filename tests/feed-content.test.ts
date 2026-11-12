import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { normalizeFeedContent, normalizeFeedThumbnail, normalizeFeedTitle } from '../src/server/feed-content.js'

describe('feed-specific article cleanup', () => {
  it('removes duplicate enclosure images but keeps distinct images and captions', () => {
    const entry = { feedTitle: 'Huckberry', url: 'https://huckberry.com/journal/test', contentHtml: '<p><img src="https://images.example/hero.jpg?width=900"></p><p>Article.</p><figure class="enclosure"><img src="https://images.example/hero.jpg"></figure><figure class="enclosure"><img src="https://images.example/other.jpg"></figure><figure class="enclosure"><img src="https://images.example/hero.jpg"><figcaption>Another view.</figcaption></figure>' }
    const result = normalizeFeedContent(entry)
    const document = new JSDOM(result).window.document
    expect(document.querySelectorAll('img')).toHaveLength(3)
    expect(result).toContain('Another view.')
    expect(result).toContain('other.jpg')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })

  it('gives the enclosure download link a label without removing the video', () => {
    const result = normalizeFeedContent({ feedTitle: 'Chris Coyier', url: 'https://chriscoyier.net/post', contentHtml: '<p>Keep 💾 in prose.</p><figure class="enclosure"><video src="https://example.com/movie.mp4" controls></video><a href="https://example.com/movie.mp4">💾</a></figure>' })
    expect(result).toContain('>Download video</a>')
    expect(result).toContain('<video')
    expect(result).toContain('Keep 💾 in prose.')
  })

  it('does not restore removed tracking or promotional images as article thumbnails', () => {
    const entry = { url: 'https://example.com/article', thumbnailUrl: 'https://example.com/promo.jpg', originalContentHtml: '<img src="https://example.com/promo.jpg?width=400"><p>Article.</p><img src="https://example.com/hero.jpg">', contentHtml: '<p>Article.</p><img src="https://example.com/hero.jpg">' }
    expect(normalizeFeedThumbnail(entry)).toBe('')
    expect(normalizeFeedThumbnail({ ...entry, thumbnailUrl: 'https://example.com/hero.jpg' })).toBe('https://example.com/hero.jpg')
    expect(normalizeFeedThumbnail({ ...entry, thumbnailUrl: 'https://example.com/separate-hero.jpg' })).toBe('https://example.com/separate-hero.jpg')
  })

  it('removes exposed Stackable CSS, including nested media rules, without dropping the contents list', () => {
    const entry = { feedTitle: 'Retro Handhelds', url: 'https://retrohandhelds.gg/weekly', contentHtml: '<p>Introduction.</p><h3>Table of Contents</h3>\n.stk-abc .toc{column-count:2 !important;}@media screen and (max-width:1023px){.stk-abc li{font-size:17px;}}<ul><li>Hardware</li></ul><p>The article.</p><pre>.stk-example{color:red;}</pre>' }
    const result = normalizeFeedContent(entry)
    expect(result).not.toContain('column-count')
    expect(result).not.toContain('@media')
    expect(result).toContain('<li>Hardware</li>')
    expect(result).toContain('<pre>.stk-example{color:red;}</pre>')
    expect(result).toContain('<p>The article.</p>')
  })

  it('removes a Tom’s Hardware promotion while retaining the surrounding article and its pictures', () => {
    const result = normalizeFeedContent({ feedTitle: "Tom's Hardware", url: 'https://www.tomshardware.com/article', contentHtml: '<article><p>Opening.</p><div><div>Go deeper with TH Premium: CPU</div><div><img src="promo.jpg"><ul><li><a href="https://example.com/?utm_medium=boxout">Unrelated CPU story</a></li></ul></div></div><p>Rest of article.</p><img src="article.jpg"></article>' })
    expect(result).not.toContain('promo.jpg')
    expect(result).not.toContain('Unrelated CPU story')
    expect(result).toContain('Rest of article.')
    expect(result).toContain('article.jpg')
  })

  it('formats Quietus review metadata as an album caption without deleting the review', () => {
    const entry = { feedTitle: 'The Quietus', url: 'https://thequietus.com/review', contentHtml: '<p><img src="album.jpg"><br>Artist</p><p>Album</p><p>A description.</p><p>Album by artist</p><p>The review.</p>' }
    const result = normalizeFeedContent(entry)
    expect(result).toContain('<figcaption>Artist · Album</figcaption>')
    expect(result).toContain('A description.')
    expect(result).toContain('The review.')
    expect(result).not.toContain('Album by artist')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })

  it('adds reading breaks to a single long HumbleDollar paragraph, preserving its exact text', () => {
    const prose = 'This sentence has enough detail to explain what happened and asks the community for its experience. '.repeat(18)
    const entry = { feedTitle: 'HumbleDollar', url: 'https://humbledollar.com/forum/example', contentHtml: `<p>${prose}</p>` }
    const result = normalizeFeedContent(entry)
    const document = new JSDOM(result).window.document
    expect(document.querySelectorAll('p').length).toBeGreaterThan(1)
    expect(document.body.textContent).toBe(prose)
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
    const linked = `<p><a href="https://example.com">Source</a>${prose}</p>`
    expect(normalizeFeedContent({ ...entry, contentHtml: linked })).toBe(linked)
  })

  it('flattens newsletter layout tables but preserves links, images and data tables', () => {
    const entry = { feedTitle: 'Newsletter', url: 'https://paper.example.test/#newsletter-ab123', contentHtml: '<div>\u034f \u00ad\u200b</div><table><tr><td><p><a href="https://example.com/web">Web version</a> · <a href="https://example.com/unsubscribe">Unsubscribe</a></p><table><tr><td><p>First paragraph.</p><img src="hero.jpg"></td></tr></table></td></tr></table><p><a href="https://example.com/story">Article link</a></p><table><tr><th>Name</th><th>Value</th></tr><tr><td>One</td><td>Two</td></tr></table><img src="https://example.com/pixel" width="1" height="1">' }
    const result = normalizeFeedContent(entry)
    const document = new JSDOM(result).window.document
    expect(document.querySelectorAll('table')).toHaveLength(1)
    expect(result).toContain('<th>Name</th>')
    expect(result).toContain('hero.jpg')
    expect(result).toContain('Article link')
    expect(result).not.toContain('Web version')
    expect(result).not.toContain('pixel')
    expect(result).not.toContain('\u034f')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })

  it('extracts the complete Substack email prose wrapper including the last paragraph and images', () => {
    const first = 'The opening paragraph of the essay has enough detail to identify the article body. '.repeat(4)
    const entry = { feedTitle: 'Newsletter', url: 'https://paper.example.test/#newsletter-abc', contentHtml: `<div>Hidden preview</div><table><tr><td><div><h1>Email header</h1><div><p><a href="https://example.substack.com/subscribe">Upgrade to paid</a></p><p>${first}</p><figure><img src="art.jpg"></figure><p>Middle paragraph.</p><p>The final paragraph.</p><p><a href="https://example.substack.com/share">Share</a></p></div><p>Unsubscribe footer</p></div></td></tr></table>` }
    const result = normalizeFeedContent(entry)
    expect(result).toContain(first)
    expect(result).toContain('art.jpg')
    expect(result).toContain('The final paragraph.')
    expect(result).not.toContain('Hidden preview')
    expect(result).not.toContain('Email header')
    expect(result).not.toContain('Unsubscribe footer')
    expect(result).not.toContain('Upgrade to paid')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })

  it('removes Reactor headers without losing the hero, credit or article paragraphs', () => {
    const contentHtml = '<div><div><div><h2>Repeated title</h2><p>By <a href="https://reactormag.com/author/writer/">Writer</a></p><div><div><details><summary>Share</summary></details></div></div></div><div><figure><img src="hero.jpg"></figure><p>Photo Credit: Studio</p></div></div></div><p>The actual article.</p><p>The ending.[end-mark]</p>'
    const entry = { feedTitle: 'Reactor', url: 'https://reactormag.com/news/', contentHtml }
    const result = normalizeFeedContent(entry)
    expect(result).not.toContain('Repeated title')
    expect(result).not.toContain('Share')
    expect(result).toContain('hero.jpg')
    expect(result).toContain('Photo Credit: Studio')
    expect(result).toContain('<p>The actual article.</p>')
    expect(result).not.toContain('[end-mark]')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })

  it('removes Aperture ads but retains photographs, credits and editorial mentions of advertising', () => {
    const result = normalizeFeedContent({ feedTitle: 'Aperture', url: 'https://aperture.org/editorial/test/', contentHtml: '<p>Advertisement is the subject of this essay.</p><div><span>Advertisement</span></div><div><div><img src="promo.jpg"></div><div><h4>Aperture Magazine Subscription</h4><a href="https://www.ezsubscription.com/ape/subscribe?key=abc">Shop Now</a></div></div><figure><img src="art.jpg"><figcaption>Artist credit</figcaption></figure>' })
    expect(result).not.toContain('promo.jpg')
    expect(result).not.toContain('<span>Advertisement')
    expect(result).toContain('Advertisement is the subject')
    expect(result).toContain('art.jpg')
    expect(result).toContain('Artist credit')
  })

  it('restores publisher blank lines without losing inline links or inventing paragraph boundaries', () => {
    const entry = { feedTitle: 'Of Dollars And Data', url: 'https://ofdollarsanddata.com/test/', contentHtml: 'First <a href="https://example.com">source</a>.\r\n\r\nSecond <em>paragraph</em>.\r\n\r\n<hr>\r\n\r\nFinal.' }
    const result = normalizeFeedContent(entry)
    expect(result).toBe('<p>First <a href="https://example.com">source</a>.</p><p>Second <em>paragraph</em>.</p><hr><p>Final.</p>')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })

  it('groups adjacent Leica thumbnails without dropping their attachment links or other images', () => {
    const entry = { feedTitle: 'Leica Rumors', url: 'https://leicarumors.com/test/', contentHtml: '<a href="attachment1"><img src="one-170x170.webp"></a>\n<a href="attachment2"><img src="two-170x170.jpg"></a><p>Article.</p><img src="large.jpg">' }
    const result = normalizeFeedContent(entry)
    expect(result).toContain('class="paper-feed-gallery"')
    expect(result).toContain('attachment1')
    expect(result).toContain('attachment2')
    expect(result).toContain('large.jpg')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })
  it('keeps the complete Permanent Style article while removing its header, related posts, ads and enclosure', () => {
    const article = '<figure><img src="shoe.jpg"><figcaption>The shoe in profile.</figcaption></figure>'
      + '<p><span>A visit to the shoe shop revealed how the shape of a last changes the fit, even between shoes from the same maker.</span></p>'
      + '<blockquote>A useful quotation.</blockquote><p>The final observation.</p>'
      + '<p><em>Images: The photographer.</em></p><p><a href="fit.jpg"><img src="fit.jpg"></a></p>'
    const entry = {
      feedTitle: 'Permanent Style',
      url: 'https://www.permanentstyle.com/2026/09/shoe-fit.html',
      contentHtml: '<div><div><div><h1>Repeated title</h1><div>Tags: Shoes</div><div>Share Subscribe 49 Comments Add to favourites</div></div>'
        + '<div>||- Begin Content -||</div></div><div><div><div>' + article + '</div></div>'
        + '<div><h3>Related posts</h3><p>Another article with enough prose to look like content, but it belongs to the recommendations.</p></div>'
        + '</div><div><a href="https://advertiser.example"><img src="advert.jpg"></a></div></div>'
        + '<figure class="enclosure"><img src="tiny-thumbnail.jpg"></figure>',
    }
    const result = normalizeFeedContent(entry)
    expect(result).toBe(article)
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
    expect(normalizeFeedContent({ ...entry, url: 'https://example.com/article' })).toBe(entry.contentHtml)
  })

  it('leaves unrecognized Permanent Style markup intact', () => {
    const entry = { feedTitle: 'Permanent Style', url: 'https://permanentstyle.com/article' }
    for (const contentHtml of [
      '<p>A short article without a header.</p><img src="shoe.jpg">',
      '<div>||- Begin Content -||</div><p>A short teaser.</p>',
    ]) expect(normalizeFeedContent({ ...entry, contentHtml })).toBe(contentHtml)
  })

  it('removes the Hugging Face model metadata preamble and repeated heading', () => {
    const result = normalizeFeedContent({
      feedTitle: 'Qwen Models',
      url: 'https://huggingface.co/Qwen/Qwen-Drive-1.0-4B',
      contentHtml: 'Qwen/Qwen-Drive-1.0-4B Image-Text-to-Text • 5B<hr><h1>Qwen-Drive-1.0-4B</h1><p>The actual model card.</p>',
    })
    expect(result).toBe('<p>The actual model card.</p>')
  })

  it('starts Reactor excerpts at the editorial introduction', () => {
    const result = normalizeFeedContent({
      feedTitle: 'Reactor Magazine',
      url: 'https://reactormag.com/an-excerpt/',
      contentHtml: '<div>Excerpts Horror<h2>An excerpt</h2><p>Duplicate summary.</p><span>|</span><span>0</span><span>Share</span></div><p>We’re thrilled to share an excerpt from the novel.</p><p>The story begins.</p>',
    })
    expect(result).toBe('<p>We’re thrilled to share an excerpt from the novel.</p><p>The story begins.</p>')
  })

  it('removes a trailing WordPress author avatar and suppresses it as a lead image', () => {
    const avatar = 'https://2.gravatar.com/avatar/abc?s=96'
    const result = normalizeFeedContent({
      feedTitle: 'agm',
      url: 'https://nomad.blog/2026/09/02/post/',
      contentHtml: `<p>The final paragraph.</p><figure class="enclosure"><p><img src="${avatar}" title="annezazu"></p></figure>`,
    })
    expect(result).toBe('<p>The final paragraph.</p>')
    expect(normalizeFeedThumbnail({ url: 'https://nomad.blog/2026/09/02/post/', thumbnailUrl: avatar })).toBe('')
  })

  it('turns an unformatted Register text blob into readable paragraphs', () => {
    const sentences = Array.from({ length: 12 }, (_, index) => `Sentence ${index + 1} contains enough reporting to make the source text useful and specific.`).join(' ')
    const result = normalizeFeedContent({
      feedTitle: 'The Register',
      url: 'https://www.theregister.com/2026/09/02/example/',
      contentHtml: `${sentences}<figure class="enclosure"><img src="cover.jpg"></figure>`,
    })
    expect(result.match(/<p>/g)?.length).toBeGreaterThan(1)
    expect(result).toContain('<figure class="enclosure">')
  })

  it('removes empty embedded players left behind by feed sanitizing', () => {
    const result = normalizeFeedContent({
      feedTitle: 'Example',
      url: 'https://example.com/post',
      contentHtml: '<p>Before</p><figure><iframe></iframe></figure><p>After</p>',
    })
    expect(result).toBe('<p>Before</p><p>After</p>')
  })

  it('removes xgo metrics and attribution before excerpts are built', () => {
    const result = normalizeFeedContent({
      feedTitle: 'LMArena',
      url: 'https://x.com/arena/status/123',
      contentHtml: '<div><div><div>Arena news.</div></div><div><span><span>💬</span><span>1</span></span></div><div><div><a href="https://xgo.ing/">⚡ Powered by xgo.ing</a></div></div></div>',
    })
    expect(result).toBe('Arena news.')
  })

  it('keeps xgo media and converts a quoted tweet into canonical quote markup', () => {
    const result = normalizeFeedContent({
      feedTitle: 'LMArena',
      url: 'https://x.com/arena/status/123',
      contentHtml: '<div><div><div>Root post.</div><div><img src="root.jpg"></div><div><div><div><img src="avatar.jpg"></div><div><span>Google</span><span>@Google</span></div></div><div>Quoted text.</div><div><img src="quote.jpg"></div><div><a href="https://x.com/Google/status/456">View Quoted Tweet</a></div></div></div><div><span><span>💬</span><span>1</span></span></div><div><div><a href="https://xgo.ing/">⚡ Powered by xgo.ing</a></div></div></div>',
    })
    expect(result).toContain('Root post.<div><img src="root.jpg"></div>')
    expect(result).toContain('<hr><div class="rsshub-quote"><img class="x-quote-avatar" src="avatar.jpg" alt="">Google @Google:\u2002Quoted text.')
    expect(result).toContain('<img src="quote.jpg">')
    expect(result).not.toContain('Powered by')
    expect(result).not.toContain('💬')
  })

  it('removes malformed serialized tweet data from Substack articles', () => {
    const result = normalizeFeedContent({
      feedTitle: 'Marcus on AI',
      url: 'https://garymarcus.substack.com/p/hot-take',
      contentHtml: '<div class="\\&quot;tweet-fake-link\\&quot;">Tweet text, "username":"arcprize", data-component-name="Twitter2ToDOM"</div><p>The article starts here.</p><p><a href="https://garymarcus.substack.com/subscribe?">Subscribe now</a></p><div><p>A useful footnote.</p><p><a href="https://garymarcus.substack.com/p/hot-take?action=share">Share</a></p></div>',
    })
    expect(result).toContain('<p>The article starts here.</p>')
    expect(result).toContain('<p>A useful footnote.</p>')
    expect(result).not.toContain('Subscribe now')
    expect(result).not.toContain('>Share<')
  })

  it('removes the PC Gamer evergreen buying guide block', () => {
    const result = normalizeFeedContent({
      feedTitle: 'PC Gamer',
      url: 'https://www.pcgamer.com/movies-tv/example/',
      contentHtml: '<article><p>The article.</p><div><p><a href="https://www.pcgamer.com/the-best-pc-games/">Best PC games</a><br><a href="https://www.pcgamer.com/the-50-best-free-pc-games/">Free PC games</a></p></div></article>',
    })
    expect(result).toContain('<p>The article.</p>')
    expect(result).not.toContain('Best PC games')
    expect(result).not.toContain('Free PC games')
  })

  it('replaces the Banker on Wheels login form with a readable notice', () => {
    const result = normalizeFeedContent({
      feedTitle: 'Banker on Wheels',
      url: 'https://www.bankeronwheels.com/example/',
      contentHtml: '<div><p>This article is FREE, but only for humans.</p><p>Log in or register</p><div>Username Password Remember Me</div></div>',
    })
    expect(result).toBe('<p>This article is available after signing in on Banker on Wheels.</p>')
  })
})


describe('reported article formatting', () => {
  it('cleans Gumroad newsletter previews, repeated headings, footer and tracking pixels', () => {
    const title = '"A useful newsletter"'
    const prose = 'Here is a newsletter introduction long enough to identify its duplicated hidden preview.'
    const entry = { title, feedTitle: 'Newsletter', url: 'https://reader.example/#newsletter-ab123', contentHtml: '&amp;quot;A useful newsletter&amp;quot;<div><div>' + prose + '...</div><h2>' + title + '</h2><p>' + prose + '</p><p>Keep the story and <a href="https://track.gumroad.com/CL0/story">its link</a>.</p></div><div><p>You\'ve received this email because you got a product. <a href="https://track.gumroad.com/unsubscribe">Unsubscribe</a></p><p>Postal address</p></div><a href="https://gumroad.com/">Powered by<img src="https://assets.gumroad.com/images/email/wordmark_logo.png"></a><img src="https://track.gumroad.com/CI0/pixel"><img src="https://example.test/illustration.jpg">' }
    const result = normalizeFeedContent(entry)
    expect(result.split(prose)).toHaveLength(2)
    expect(result).not.toContain('Postal address')
    expect(result).not.toContain('CI0/pixel')
    expect(result).not.toContain('wordmark_logo')
    expect(result).not.toContain('h2')
    expect(result).not.toContain('&amp;quot;')
    expect(result).toContain('CL0/story')
    expect(result).toContain('illustration.jpg')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
  })
  it('paragraphizes MacRumors legacy text and removes feed metadata without dropping article links', () => {
    const entry = { feedTitle: 'MacRumors', url: 'https://www.macrumors.com/2026/01/01/story/', contentHtml: '<img src="cover.jpg" width="160">First <a href="https://www.macrumors.com/roundup/ipad/">iPad</a> paragraph.<br>\r<br>Second paragraph.<div>Related Roundups: <a href="https://www.macrumors.com/roundup/ipad/">iPad</a></div><div>Buyer\'s Guide: <a href="https://buyersguide.macrumors.com/">Buy</a></div><br>This article, "<a href="https://www.macrumors.com/story">Story</a>" first appeared on MacRumors.com<br>Discuss this article' }
    const result = normalizeFeedContent(entry)
    const dom = new JSDOM(result)
    expect(dom.window.document.querySelectorAll('p')).toHaveLength(2)
    expect(result).toContain('Second paragraph.')
    expect(result).toContain('roundup/ipad/')
    expect(result).not.toContain('Related Roundups')
    expect(result).not.toContain("Buyer's Guide")
    expect(result).not.toContain('first appeared')
    expect(normalizeFeedContent({ ...entry, contentHtml: result })).toBe(result)
    dom.window.close()
  })
  it('gives URL-titled image posts a readable title while preserving real titles', () => {
    const entry = { feedTitle: 'Photo blog', url: 'https://author.example/post', title: 'http://author.micro.blog/post', contentHtml: '<img src="photo.jpg">' }
    expect(normalizeFeedTitle(entry)).toBe('Photo')
    expect(normalizeFeedTitle({ ...entry, contentHtml: '<p>A short note.</p>' })).toBe('A short note.')
    expect(normalizeFeedTitle({ ...entry, title: 'My actual title' })).toBe('My actual title')
  })
})
