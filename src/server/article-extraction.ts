import type { ExtractionRules } from '../shared/feed-overrides.js'
import { applyFeedRewrites } from './feed-rewrites.js'
import { BackendValidationError } from './backend.js'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { ArticleCacheRecord } from './db.js'
import { cleanArticleHtml, excerpt, plainText, readingMinutes } from './text.js'

export function extractReadableArticle(html: string, url: string, rules?: ExtractionRules): Omit<ArticleCacheRecord, 'url' | 'fetchedAt'> {
  const dom = new JSDOM(html, { url })
  try {
    const document = dom.window.document
    const pageImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"], meta[name="twitter:image"]')?.content || ''
    if (rules) applyFeedRewrites(document, url, rules)
    const root = rules?.contentSelector ? document.querySelector(rules.contentSelector) : null
    if (rules?.contentSelector && !root) throw new BackendValidationError('The content selector did not match this page.')
    prepareDocument(document, url, !root)
    const parsed = root ? { title: document.title, byline: '', excerpt: '', content: root.outerHTML }
      : new Readability(document).parse()
    if (!parsed?.content) throw new Error('Paper could not find a readable article on this page')

    let contentHtml = cleanArticleHtml(parsed.content)
    if (!root && !rules?.removeSelectors.length && pageImage && !/<img\b/i.test(contentHtml)) {
      try {
        const imageUrl = new URL(pageImage, url)
        if (['http:', 'https:'].includes(imageUrl.protocol)) contentHtml = `<figure><img src="${escapeAttribute(imageUrl.href)}" alt=""></figure>${contentHtml}`
      } catch { /* Ignore invalid page metadata. */ }
    }
    const articleText = plainText(contentHtml)
    if (/This article is FREE/i.test(articleText) && /Log in or register/i.test(articleText)) {
      throw new Error('This publisher requires you to sign in to read the article')
    }
    if (root && !articleText && !/<(?:img|video|iframe)\b/i.test(contentHtml)) throw new BackendValidationError('The selected element contains no readable content.')
    if (!root && articleText.length < 240) throw new Error('The extracted page did not contain enough article text')
    return {
      title: parsed.title?.trim() || '',
      byline: parsed.byline?.trim() || '',
      excerpt: root ? excerpt(contentHtml) : parsed.excerpt?.trim() || '',
      contentHtml,
      readingMinutes: readingMinutes(contentHtml),
    }
  } finally { dom.window.close() }
}

function prepareDocument(document: Document, url: string, removeChrome: boolean) {
  if (removeChrome) {
    for (const element of document.querySelectorAll([
      'nav', 'footer', '[role="navigation"]', '[role="dialog"]',
      '.newsletter', '.newsletter-signup', '.social-share', '.share-buttons',
      '.copy-link', '.follow-button', '.comments', '#comments',
      '.w-heading-options', '.action-bar-follow', '.qa-action-list', '.w-follow-btn',
      '.article-date', '.w-article-header-author-img', '.article-header',
    ].join(','))) element.remove()
  }

  for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
    const lazySource = image.getAttribute('data-large-file')
      || image.getAttribute('data-orig-file')
      || image.getAttribute('data-original')
      || image.getAttribute('data-lazy-src')
      || image.getAttribute('data-src')
    if (lazySource && (!image.getAttribute('src') || /(?:^|\/)blank\.(?:gif|png)|data:image\/gif|spacer\.(?:gif|png)/i.test(image.getAttribute('src') || ''))) {
      image.setAttribute('src', lazySource)
    }
    const lazySet = image.getAttribute('data-srcset')
    if (lazySet && !image.getAttribute('srcset')) image.setAttribute('srcset', lazySet)
  }

  for (const source of document.querySelectorAll<HTMLSourceElement>('source')) {
    const lazySource = source.getAttribute('data-src')
    const lazySet = source.getAttribute('data-srcset')
    if (lazySource && !source.getAttribute('src')) source.setAttribute('src', lazySource)
    if (lazySet && !source.getAttribute('srcset')) source.setAttribute('srcset', lazySet)
  }

  for (const [selector, attribute] of [
    ['a[href]', 'href'], ['img[src]', 'src'], ['source[src]', 'src'], ['video[src]', 'src'], ['video[poster]', 'poster'], ['iframe[src]', 'src'],
  ] as const) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const value = element.getAttribute(attribute)
      if (!value) continue
      try { element.setAttribute(attribute, new URL(value, url).href) } catch { element.removeAttribute(attribute) }
    }
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
