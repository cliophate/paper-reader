import sanitizeHtml from 'sanitize-html'
import { decodeHTML } from 'entities'
import { Parser } from 'htmlparser2'

const allowedTags = [
  'a', 'article', 'aside', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'iframe', 'img', 'li', 'mark',
  'ol', 'p', 'picture', 'pre', 's', 'small', 'source', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul', 'video',
]

export function cleanArticleHtml(input: string): string {
  const prepared = cleanArticleMarkup(decodeEscapedArticleMarkup(repairLinkedImageSources(input)))

  return sanitizeHtml(prepared, {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'loading'],
      iframe: ['src', 'allow', 'allowfullscreen', 'title', 'loading', 'width', 'height', 'frameborder'],
      source: ['src', 'srcset', 'sizes', 'type'],
      video: ['src', 'poster', 'controls', 'preload'],
      '*': ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedIframeHostnames: ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'],
    exclusiveFilter: frame => {
      const classes = String(frame.attribs.class || '').split(/\s+/)
      return classes.includes('screen-reader-text') || classes.includes('more-link')
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true),
      img: (_tagName, attributes) => ({
        tagName: 'img',
        attribs: {
          ...attributes,
          src: preferredImageSource(attributes),
          srcset: attributes.srcset || attributes['data-srcset'] || '',
          loading: 'lazy',
        },
      }),
      source: (_tagName, attributes) => ({
        tagName: 'source',
        attribs: {
          ...attributes,
          src: attributes.src || attributes['data-src'] || '',
          srcset: attributes.srcset || attributes['data-srcset'] || '',
        },
      }),
    },
  })
}

interface MarkupEdit {
  start: number
  end: number
  replacement: string
}

function applyMarkupEdits(input: string, edits: MarkupEdit[]): string {
  const parts: string[] = []
  let cursor = 0
  // Edits are recorded in opening-tag order. A completed outer edit takes
  // precedence over any edits inside it; incomplete elements have end = -1.
  for (const edit of edits) {
    if (edit.end < 0 || edit.start < cursor) continue
    parts.push(input.slice(cursor, edit.start), edit.replacement)
    cursor = edit.end
  }
  parts.push(input.slice(cursor))
  return parts.join('')
}

function removePostHeroes(input: string): string {
  const stack: MarkupEdit[] = []
  const edits: MarkupEdit[] = []
  const parser = new Parser({
    onopentag(name) {
      if (name !== 'post-hero') return
      const edit = { start: parser.startIndex, end: -1, replacement: '' }
      edits.push(edit)
      stack.push(edit)
    },
    onclosetag(name, implied) {
      if (name !== 'post-hero') return
      const edit = stack.pop()
      if (edit && !implied) edit.end = parser.endIndex + 1
    },
  })
  parser.end(input)
  return applyMarkupEdits(input, edits)
}

function cleanArticleMarkup(markup: string): string {
  // Hero removal precedes footer matching, as in the original cleanup order.
  // Separate structural passes prevent discarded hero text from matching a footer.
  const input = removePostHeroes(markup)
  interface Frame {
    name: string
    edit?: MarkupEdit
    enclosure?: boolean
    href?: string
    video?: string
    paragraph?: {
      previous?: Frame
      anchorStart: number
      hasAnchor: boolean
      nested: boolean
      isPost: boolean
      isFooter: boolean
    }
  }
  const stack: Frame[] = []
  const edits: MarkupEdit[] = []
  let paragraph: Frame | undefined
  const parser = new Parser({
    onopentag(name, attributes, implied) {
      const frame: Frame = { name }
      if (!implied && (name === 'p' || name === 'figure')) {
        frame.edit = { start: parser.startIndex, end: -1, replacement: '' }
        edits.push(frame.edit)
      }
      if (name === 'figure') frame.enclosure = /\benclosure\b/i.test(attributes.class || '')
      if (name === 'p') {
        if (paragraph?.paragraph) paragraph.paragraph.nested = true
        frame.paragraph = { previous: paragraph, anchorStart: parser.endIndex + 1, hasAnchor: false, nested: false, isPost: false, isFooter: false }
        paragraph = frame
      }
      if (name === 'a') {
        if (/^https?:\/\/(?:www\.)?youtube\.com\/watch\?./i.test(attributes.href || '')) frame.href = attributes.href
        const current = paragraph?.paragraph
        if (current && !current.nested) {
          // Each interval ends at the next anchor. Never rescan a growing
          // paragraph prefix or search outside the paragraph's parser boundary.
          const between = input.slice(current.anchorStart, parser.startIndex)
          if (current.isPost && /appeared first on\s+$/i.test(between)) current.isFooter = true
          if (!current.hasAnchor) current.isPost = /^\s*The post\s+$/i.test(between)
          current.hasAnchor = true
          current.anchorStart = parser.endIndex + 1
        }
      }
      stack.push(frame)
    },
    onclosetag(_name, implied) {
      const frame = stack.pop()
      if (!frame) return
      if (frame.paragraph) paragraph = frame.paragraph.previous
      let removed = false
      // EOF and implied closes cannot establish a source range to remove.
      if (!implied && frame.edit) {
        if (frame.paragraph?.isFooter && !frame.paragraph.nested) {
          frame.edit.end = parser.endIndex + 1
          removed = true
        } else if (frame.enclosure && frame.video) {
          frame.edit.end = parser.endIndex + 1
          frame.edit.replacement = `<p><a href="${escapeHtml(frame.video)}">Watch video</a></p>`
        }
      }
      const video = !implied && frame.href ? frame.href : frame.video
      const parent = stack.at(-1)
      // Propagate once per close instead of walking all enclosing figures.
      // Links in removed footers must not replace an outer figure.
      if (!removed && video && parent && !parent.video) parent.video = video
    },
  })
  parser.end(input)
  return applyMarkupEdits(input, edits)
}

function repairLinkedImageSources(input: string): string {
  const candidates = Array.from(input.matchAll(/\bsrc\s*=\s*(["'])<a\b/gi))
  const edits: MarkupEdit[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const start = candidate.index + candidate[0].length - 2
    const limit = candidates[index + 1]?.index ?? input.length
    let href: string | undefined
    let anchorDepth = 0
    const parser = new Parser({
      onopentag(name, attributes) {
        if (name === 'a') anchorDepth += 1
        if (name === 'a' && parser.startIndex === 0 && /^https?:\/\//i.test(attributes.href || '')) href = attributes.href
      },
      onclosetag(name, implied) {
        if (name !== 'a' || --anchorDepth !== 0) return
        const end = start + parser.endIndex + 1
        if (!implied && href && input[end] === candidate[1]) edits.push({ start, end, replacement: escapeHtml(href) })
        parser.pause()
      },
    })
    // A malformed candidate cannot scan through later candidates. These slices
    // are disjoint, including when none of the anchors ever closes.
    parser.end(input.slice(start, limit))
  }
  return applyMarkupEdits(input, edits)
}

function decodeEscapedArticleMarkup(input: string): string {
  const articleBlock = /^\s*<(?:article|aside|blockquote|div|figure|h[1-6]|img|p|picture|pre|section|table|ul|ol)\b/i
  let decoded = input
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeHTML(decoded)
    if (next === decoded) return input
    decoded = next
    if (articleBlock.test(decoded)) return decodeHtmlText(input)
  }
  return input
}

function preferredImageSource(attributes: Record<string, string>): string {
  const lazySource = attributes['data-large-file']
    || attributes['data-orig-file']
    || attributes['data-original']
    || attributes['data-lazy-src']
    || attributes['data-src']
  const source = attributes.src || ''
  if (!lazySource) return source
  if (!source || /(?:^|\/)blank\.(?:gif|png)|data:image\/gif|spacer\.(?:gif|png)/i.test(source)) return lazySource
  return source
}

const textBoundaryTags = [
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]

export function plainText(html: string): string {
  const parts: string[] = []
  // Keep only block tags, then turn their boundaries into spaces in one pass.
  const parser = new Parser({
    onopentag() { parts.push(' ') },
    onclosetag() { parts.push(' ') },
    ontext(text) { parts.push(text) },
  }, { decodeEntities: false })
  parser.end(sanitizeHtml(html, { allowedTags: textBoundaryTags, allowedAttributes: {} }))
  return decodeHtmlText(parts.join(''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function decodeHtmlText(input: string): string {
  let output = input
  for (let pass = 0; pass < 4; pass += 1) {
    const decoded = decodeHTML(output)
    if (decoded === output) break
    output = decoded
  }
  return output
}

export function excerpt(html: string, max = 220): string {
  const text = plainText(html)
  if (text.length <= max) return text
  return `${text.slice(0, max).replace(/\s+\S*$/, '')}...`
}

export function readingMinutes(html: string): number {
  const words = plainText(html).split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / 230))
}

export function firstImage(html: string): string {
  const match = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)
  let source = match?.[1] || ''
  for (let pass = 0; pass < 3 && source.includes('&amp;'); pass += 1) {
    source = source.replace(/&amp;/g, '&')
  }
  return source
}

export function emailText(input: string): string {
  return input
    .replace(/[\u2013\u2014]/g, ',')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
