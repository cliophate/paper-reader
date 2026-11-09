import { JSDOM } from 'jsdom'
import { escapeHtml, plainText } from './text.js'

interface FeedContent {
  contentHtml: string
  feedTitle: string
  url: string
  title?: string
}

export function normalizeFeedContent(entry: FeedContent): string {
  let html = stripXgoChrome(cleanEnclosures(removeEmptyEmbeds(entry.contentHtml)))
  const host = hostname(entry.url)

  if (/#newsletter-[a-f\d]+$/i.test(entry.url)) html = cleanNewsletterLayout(html, entry.title)
  if (host.endsWith('.substack.com')) html = stripSubstackChrome(html)
  if (host === 'huggingface.co' && /\bmodels?\b/i.test(entry.feedTitle)) {
    html = stripHuggingFaceModelPreamble(html)
  }

  if (host === 'reactormag.com') html = stripReactorChrome(html)
  if (host === 'aperture.org') html = stripApertureAds(html)
  if (host === 'ofdollarsanddata.com') html = restoreBlankLineParagraphs(html)
  if (host === 'leicarumors.com') html = groupThumbnailGallery(html)
  if (host === 'permanentstyle.com') html = stripPermanentStyleChrome(html)
  if (host === 'nomad.blog') html = stripTrailingAuthorAvatar(html)
  if (host === 'pcgamer.com') html = stripPcGamerBuyingGuide(html)
  if (host === 'tomshardware.com') html = stripHardwarePromotions(html)
  if (host === 'retrohandhelds.gg') html = stripLeakedStyles(html)
  if (host === 'thequietus.com') html = formatQuietusReview(html)
  if (host === 'humbledollar.com') html = splitLongForumParagraph(html)
  if (host === 'bankeronwheels.com') html = replaceBankerLoginWall(html)
  if (host === 'theregister.com' || host.endsWith('.theregister.com')) html = paragraphizeRegisterArticle(html)

  return html.trim()
}

function cleanEnclosures(html: string): string {
  if (!/class=["'][^"']*\benclosure\b/i.test(html)) return html
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    for (const figure of document.querySelectorAll('figure')) {
      if (!figure.textContent?.trim() && !figure.querySelector('img, video, iframe, audio')) figure.remove()
    }
    const images = new Set([...document.querySelectorAll('img[src]')]
      .filter(image => !image.closest('.enclosure'))
      .map(image => imageKey(image.getAttribute('src')!)))
    for (const enclosure of document.querySelectorAll('.enclosure')) {
      const image = enclosure.querySelector('img[src]')
      if (image && enclosure.querySelectorAll('img').length === 1 && !enclosure.textContent?.trim()
        && images.has(imageKey(image.getAttribute('src')!))) {
        enclosure.remove()
        continue
      }
      for (const link of enclosure.querySelectorAll('a[href]')) {
        if (link.textContent?.trim() !== '💾') continue
        const video = enclosure.querySelector('video[src]')
        if (video?.getAttribute('src') === link.getAttribute('href')) link.textContent = 'Download video'
      }
    }
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function cleanNewsletterLayout(html: string, title?: string): string {
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    const leadingText = document.body.firstChild
    if (title && leadingText?.nodeType === dom.window.Node.TEXT_NODE && leadingText.textContent?.trim() === title.trim()) leadingText.remove()
    // Substack mail includes a hidden preview and a large email header outside
    // the prose wrapper. Its classes have already been stripped by FreshRSS.
    if (/<table\b/i.test(html) && /substack(?:cdn)?\.com/i.test(html)) {
      const first = [...document.querySelectorAll('p')].find(p => (p.textContent?.trim().length || 0) > 200)
      const body = first?.closest('div')
      if (body && body.querySelectorAll('p').length >= 3 && !body.querySelector('h1')) {
        document.body.replaceChildren(body)
      }
    }
    for (const image of document.querySelectorAll('img')) {
      if (Number(image.getAttribute('width')) === 1 && Number(image.getAttribute('height')) === 1) image.remove()
    }
    // Keep actual data tables. Email layout cells otherwise inherit the reader's
    // table borders and padding at every nesting level.
    for (const table of [...document.querySelectorAll('table')].reverse()) {
      if (table.querySelector('th, thead')) continue
      for (const cell of table.querySelectorAll('td')) {
        const block = document.createElement('div')
        block.append(...cell.childNodes)
        cell.replaceWith(block)
      }
      for (const wrapper of [...table.querySelectorAll('tbody, tr')].reverse()) wrapper.replaceWith(...wrapper.childNodes)
      const block = document.createElement('div')
      block.append(...table.childNodes)
      table.replaceWith(block)
    }
    for (const element of [...document.querySelectorAll('p, div, span')].reverse()) {
      const text = (element.textContent || '').replace(/[\s\u034f\u00ad\u200b-\u200d\ufeff]/g, '')
      if (!text && !element.querySelector('img, video, iframe, hr')) element.remove()
      else if (element.querySelector('a') && /^(?:Upgrade to paid|Subscribe now|Share(?: [^\n]{1,60})?|Web version\s*·\s*Unsubscribe)$/i.test(element.textContent?.trim() || '')) element.remove()
    }
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function stripHardwarePromotions(html: string): string {
  if (!html.includes('Go deeper with TH Premium')) return html
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    for (const heading of dom.window.document.querySelectorAll('div')) {
      if (heading.children.length || !heading.textContent?.trim().startsWith('Go deeper with TH Premium:')) continue
      const box = heading.parentElement
      if (box?.querySelector('a[href*="utm_medium=boxout"]')) box.remove()
    }
    return dom.window.document.body.innerHTML
  } finally { dom.window.close() }
}

function stripLeakedStyles(html: string): string {
  if (!html.includes('.stk-')) return html
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const walker = dom.window.document.createTreeWalker(dom.window.document.body, dom.window.NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.parentElement?.closest('pre, code')) continue
      let text = node.textContent || ''
      while (/^\s*(?:\.stk-[^{]+|@media[^{}]+)\{/.test(text)) {
        let depth = 0
        let end = -1
        for (let index = text.indexOf('{'); index < text.length; index++) {
          if (text[index] === '{') depth++
          if (text[index] === '}' && --depth === 0) { end = index + 1; break }
        }
        if (end < 0) break
        text = text.slice(end)
      }
      node.textContent = text
    }
    return dom.window.document.body.innerHTML
  } finally { dom.window.close() }
}

function formatQuietusReview(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    const [artist, album, , embed] = [...document.body.children]
    const image = artist?.querySelector('img')
    const artistName = artist?.textContent?.trim()
    const albumName = album?.textContent?.trim()
    if (!image || artist?.tagName !== 'P' || album?.tagName !== 'P' || !artistName || !albumName
      || embed?.textContent?.trim().toLowerCase() !== `${albumName} by ${artistName}`.toLowerCase()) return html
    const figure = document.createElement('figure')
    const caption = document.createElement('figcaption')
    caption.textContent = `${artistName} · ${albumName}`
    figure.append(image, caption)
    artist.replaceWith(figure)
    album.remove()
    embed.remove()
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function splitLongForumParagraph(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    const paragraphs = document.querySelectorAll('p')
    const paragraph = paragraphs[0]
    // This publisher sometimes supplies the entire post as a single paragraph.
    // Add reading breaks only to plain text, keeping every word and its spacing.
    if (paragraphs.length !== 1 || paragraph.children.length || (paragraph.textContent?.length || 0) < 1200) return html
    const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(paragraph.textContent!)]
    if (sentences.length < 6) return html
    let text = ''
    const blocks: HTMLParagraphElement[] = []
    for (const sentence of sentences) {
      text += sentence.segment
      if (text.length >= 360) {
        const block = document.createElement('p')
        block.textContent = text
        blocks.push(block)
        text = ''
      }
    }
    if (text) {
      const block = document.createElement('p')
      block.textContent = text
      blocks.push(block)
    }
    paragraph.replaceWith(...blocks)
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function stripPermanentStyleChrome(html: string): string {
  if (!html.includes('||- Begin Content -||')) return html
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    const marker = [...document.body.querySelectorAll('div')].find(element =>
      element.children.length === 0 && element.textContent?.trim() === '||- Begin Content -||',
    )
    if (!marker) return html

    // FreshRSS has removed the site's classes, but preserves its article wrapper.
    // Find the prose after the header marker, then keep that wrapper's complete
    // contents, including figures before the first paragraph and image credits.
    const firstParagraph = [...document.body.querySelectorAll('p')].find(element =>
      (marker.compareDocumentPosition(element) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      && (element.textContent?.trim().length || 0) >= 80,
    )
    const body = firstParagraph?.closest('div, article, section')
    if (!body || body.contains(marker) || body.querySelectorAll('p').length < 2) return html
    return body.innerHTML
  } finally {
    dom.window.close()
  }
}

function stripSubstackChrome(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    for (const element of document.body.querySelectorAll('div')) {
      const className = (element.getAttribute('class') || '').replace(/[\\"]/g, '')
      const text = element.textContent || ''
      if (className.includes('tweet-fake-link') && /(?:"username"|data-component-name)/i.test(text)) element.remove()
    }
    for (const link of document.body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = link.getAttribute('href') || ''
      if (/\/subscribe(?:[/?#]|$)/i.test(href) || /(?:[?&])action=share(?:&|$)/i.test(href)) link.closest('p')?.remove()
    }
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function stripPcGamerBuyingGuide(html: string): string {
  if (!/Best PC games/i.test(html) || !/Free PC games/i.test(html)) return html
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!/\/the-best-pc-games\/?(?:$|[?#])/i.test(link.href)) continue
      const container = link.closest('div')
      if (container && /Best PC games/i.test(container.textContent || '') && /Free PC games/i.test(container.textContent || '')) container.remove()
    }
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function replaceBankerLoginWall(html: string): string {
  const text = plainText(html)
  if (!/This article is FREE/i.test(text) || !/Log in or register/i.test(text)) return html
  return '<p>This article is available after signing in on Banker on Wheels.</p>'
}

function stripXgoChrome(html: string): string {
  if (!/Powered by xgo\.ing/i.test(html)) return html
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    const outer = document.body.firstElementChild
    const content = outer?.firstElementChild
    if (!content) return html

    const blocks = [...content.children]
    if (!blocks.length) return content.innerHTML.trim()
    const quote = blocks.find(block => /View Quoted Tweet/i.test(block.textContent || ''))
    const main = [blocks[0].innerHTML, ...blocks.slice(1).filter(block => block !== quote).map(block => block.outerHTML)].join('')
    return quote ? `${main}<hr>${normalizeXgoQuote(quote)}`.trim() : main.trim()
  } finally { dom.window.close() }
}

function normalizeXgoQuote(quote: Element): string {
  const parts = [...quote.children]
  const labels = parts[0]?.querySelectorAll('span') || []
  const name = labels[0]?.textContent?.trim() || ''
  const handle = labels[1]?.textContent?.trim() || ''
  const author = [name, handle].filter(Boolean).join(' ')
  const avatar = parts[0]?.querySelector('img')?.getAttribute('src') || ''
  const authorMarkup = `${avatar ? `<img class="x-quote-avatar" src="${escapeHtml(avatar)}" alt="">` : ''}${escapeHtml(author)}`
  const body = parts[1]?.innerHTML || ''
  const extras = parts.slice(2).map(part => part.outerHTML).join('')
  return `<div class="rsshub-quote">${author ? `${authorMarkup}:\u2002` : ''}${body}${extras}</div>`
}

function imageKey(source: string): string {
  try {
    const url = new URL(source.replace(/&amp;/g, '&'))
    return url.host + decodeURIComponent(url.pathname).replace(/-\d{2,4}x\d{2,4}(?=\.[a-z]+$)/i, '')
  } catch { return source }
}

export function normalizeFeedThumbnail(entry: Pick<FeedContent, 'url'> & { thumbnailUrl: string; contentHtml?: string; originalContentHtml?: string }): string {
  if (hostname(entry.url) === 'nomad.blog' && /(?:^|\.)gravatar\.com\//i.test(entry.thumbnailUrl)) return ''
  if (entry.originalContentHtml && entry.contentHtml !== undefined) {
    const key = imageKey(entry.thumbnailUrl)
    const containsImage = (html: string) => [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].some(match => imageKey(match[1]) === key)
    // A removed tracking pixel or promotional image must not reappear as the hero.
    if (containsImage(entry.originalContentHtml) && !containsImage(entry.contentHtml)) return ''
  }
  return entry.thumbnailUrl
}

function stripHuggingFaceModelPreamble(html: string): string {
  const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)
  if (!heading || heading.index === undefined) return html
  return html.slice(heading.index + heading[0].length).trim()
}

function stripReactorChrome(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    const share = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent?.trim() === 'Share')
    const header = share?.closest('div')?.parentElement?.parentElement
    // The header contains the repeated title and author, but not its sibling hero.
    if (header?.querySelector('h2') && header.querySelector('a[href*="/author/"]')) {
      header.remove()
      return document.body.innerHTML.replace(/\[end-mark\]/g, '')
    }
  } finally { dom.window.close() }
  const articleStart = html.search(/<p\b[^>]*>\s*(?:We(?:'|’)?re|We are)\s+(?:thrilled|pleased|excited)\s+to\s+(?:share|present)/i)
  return articleStart >= 0 ? html.slice(articleStart) : html
}

function stripApertureAds(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    for (const node of document.querySelectorAll('span')) {
      if (node.textContent?.trim() === 'Advertisement') node.remove()
    }
    for (const heading of document.querySelectorAll('h4')) {
      if (heading.textContent?.trim() !== 'Aperture Magazine Subscription') continue
      const box = heading.parentElement?.parentElement
      if (box?.querySelector('a[href^="https://www.ezsubscription.com/ape/subscribe"]') && !box.querySelector('p')) box.remove()
    }
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function restoreBlankLineParagraphs(html: string): string {
  if (/<(?:p|div|blockquote|pre|table|ul|ol|h[1-6])\b/i.test(html) || !/\n\s*\n/.test(html)) return html
  return html.split(/(<hr\b[^>]*>)/i).map(section => /^<hr\b/i.test(section) ? section : section.split(/\r?\n\s*\r?\n/).filter(part => part.trim()).map(part => `<p>${part.trim()}</p>`).join('')).join('')
}

function groupThumbnailGallery(html: string): string {
  if (html.includes('paper-feed-gallery')) return html
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const document = dom.window.document
    for (const link of [...document.querySelectorAll('a')]) {
      const isThumbnail = (node: Element) => node.tagName === 'A' && /-\d{2,3}x\d{2,3}\./.test(node.querySelector('img')?.getAttribute('src') || '')
      if (!link.isConnected || !isThumbnail(link)) continue
      const group = [link as Element]
      let next = link.nextElementSibling
      while (next && isThumbnail(next)) { group.push(next); next = next.nextElementSibling }
      if (group.length < 2) continue
      const gallery = document.createElement('div')
      gallery.className = 'paper-feed-gallery'
      link.before(gallery)
      group.forEach(node => gallery.append(node))
    }
    return document.body.innerHTML
  } finally { dom.window.close() }
}

function stripTrailingAuthorAvatar(html: string): string {
  return html.replace(
    /<figure\b[^>]*class=(['"])[^'"]*\benclosure\b[^'"]*\1[^>]*>\s*(?:<p\b[^>]*>)?\s*<img\b[^>]*src=(['"])[^'"]*(?:^|\.)gravatar\.com\/[^'"]*\2[^>]*>\s*(?:<\/p>)?\s*<\/figure>\s*$/i,
    '',
  )
}

function paragraphizeRegisterArticle(html: string): string {
  const enclosureIndex = html.search(/<figure\b[^>]*class=(['"])[^'"]*\benclosure\b[^'"]*\1/i)
  const article = enclosureIndex >= 0 ? html.slice(0, enclosureIndex) : html
  const enclosure = enclosureIndex >= 0 ? html.slice(enclosureIndex) : ''
  if (/<(?:p|h[1-6]|ul|ol|blockquote|pre|table|div)\b/i.test(article)) return html

  const text = plainText(article)
  if (text.length < 400) return html
  const paragraphs = sentenceParagraphs(text).map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('')
  return `${paragraphs}${enclosure}`
}

function sentenceParagraphs(text: string): string[] {
  const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map(part => part.segment.trim())
    .filter(Boolean)
  if (sentences.length < 2) return [text]

  const paragraphs: string[] = []
  let current: string[] = []
  let length = 0
  for (const sentence of sentences) {
    current.push(sentence)
    length += sentence.length
    if ((current.length >= 3 && length >= 360) || length >= 620) {
      paragraphs.push(current.join(' '))
      current = []
      length = 0
    }
  }
  if (current.length) paragraphs.push(current.join(' '))
  return paragraphs
}

function removeEmptyEmbeds(html: string): string {
  return html
    .replace(/<figure\b[^>]*>\s*<iframe(?![^>]*\bsrc=)[^>]*>\s*<\/iframe>\s*<\/figure>/gi, '')
    .replace(/<iframe(?![^>]*\bsrc=)[^>]*>\s*<\/iframe>/gi, '')
}

function hostname(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}
