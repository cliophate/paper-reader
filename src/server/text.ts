import sanitizeHtml from 'sanitize-html'
import { decodeHTML } from 'entities'

const allowedTags = [
  'a', 'article', 'aside', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'iframe', 'img', 'li', 'mark',
  'ol', 'p', 'picture', 'pre', 's', 'small', 'source', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul', 'video',
]

export function cleanArticleHtml(input: string): string {
  const prepared = decodeEscapedArticleMarkup(repairLinkedImageSources(input))
    .replace(/<post-hero\b[^>]*>[\s\S]*?<\/post-hero>/gi, '')
    .replace(/<p\b[^>]*>\s*The post\s+<a\b[\s\S]*?appeared first on\s+<a\b[\s\S]*?<\/p>/gi, '')
    .replace(/<figure\b[^>]*class=(["'])[^"']*\benclosure\b[^"']*\1[^>]*>[\s\S]*?<a\b[^>]*href=(["'])(https?:\/\/(?:www\.)?youtube\.com\/watch\?[^"']+)\2[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/figure>/gi, '<p><a href="$3">Watch video</a></p>')

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

function repairLinkedImageSources(input: string): string {
  return input.replace(
    /(src\s*=\s*)(["'])<a\b[^>]*\bhref=(["'])(https?:\/\/[^"']+)\3[^>]*>[\s\S]*?<\/a>\2/gi,
    '$1$2$4$2',
  )
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

export function plainText(html: string): string {
  return decodeHtmlText(sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }))
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
