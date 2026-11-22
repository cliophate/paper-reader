import type { ExtractionRules } from '../shared/feed-overrides.js'
import { hasFeedOverrides, type SavedOverrides } from './feed-overrides.js'
import { applyFeedRewrites } from './feed-rewrites.js'
import { BackendValidationError } from './backend.js'
import { boundedFetch, FeedHttpError } from './feed-http.js'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { ArticleCacheRecord, PaperDatabase } from './db.js'
import { cleanArticleHtml, excerpt, plainText, readingMinutes } from './text.js'

const MAX_REDIRECTS = 5
const MAX_HTML_BYTES = 5 * 1024 * 1024
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const JINA_READER_ORIGIN = 'https://r.jina.ai/'

export interface FullArticle extends ArticleCacheRecord {
  cached: boolean
}

export class ReaderService {
  constructor(private readonly database: PaperDatabase, private readonly fallbackEnabled = false) {}

  async fetch(urlInput: string, maxCacheAgeMs = CACHE_MAX_AGE_MS, signal?: AbortSignal,
    entryId?: string, preview?: { feedId: string; overrides: unknown }): Promise<FullArticle> {
    signal?.throwIfAborted()
    const entry = entryId ? this.database.feedOverrides.article(entryId) : undefined
    if (preview && (!entry || preview.feedId !== entry.feedId)) throw new BackendValidationError('Choose an article from this feed.')
    const url = normalizeUrl(entry ? entry.url : urlInput)
    const rules = preview ? this.database.feedOverrides.draft(preview.feedId, preview.overrides)
      : entry ? this.database.feedOverrides.get(entry.feedId) : undefined
    const cached = !preview && this.database.getArticle(url.href, rules?.revision)
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < maxCacheAgeMs) return { ...cached, cached: true }

    const fallback = this.fallbackEnabled && (!rules || !hasFeedOverrides(rules, rules.cookie))
    const { html, finalUrl } = await fetchHtml(url, fallback, signal, rules)
    signal?.throwIfAborted()
    let extracted: Omit<ArticleCacheRecord, 'url' | 'fetchedAt'>
    try {
      extracted = extractReadableArticle(html, finalUrl.href, rules)
    } catch (error) {
      if (!fallback) throw error
      const page = await fetchReaderPage(finalUrl, signal).catch(() => null)
      signal?.throwIfAborted()
      if (!page) throw error
      extracted = extractReadableArticle(page.html, finalUrl.href)
    }

    const article: ArticleCacheRecord = {
      url: url.href,
      ...extracted,
      fetchedAt: new Date().toISOString(),
    }
    if (!preview) this.database.cacheArticle(article, rules?.revision)
    return { ...article, cached: false }
  }
}

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

function normalizeUrl(input: string): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('A valid article URL is required') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('A public HTTP article URL is required')
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Paper only fetches standard web ports')
  url.hash = ''
  return url
}

export async function fetchHtml(startUrl: URL, fallbackEnabled = false, signal?: AbortSignal, rules?: SavedOverrides): Promise<{ html: string; finalUrl: URL }> {
  let response
  try {
    response = await boundedFetch(startUrl.href, {
      signal,
      accept: 'text/html,application/xhtml+xml',
      cookie: rules?.cookie ? { origin: rules.articleCookieOrigin === startUrl.origin ? startUrl.origin : rules.cookieOrigin, value: rules.cookie } : undefined,
      userAgent: rules?.userAgent || 'Mozilla/5.0 (compatible; PaperReader/1.0; +https://github.com/cliophate/paper-reader)',
      acceptLanguage: 'en-US,en;q=0.8',
      skipBodyStatuses: [401, 403, 406, 429],
      fatalDecoding: false,
      timeoutMs: 20_000,
      maxResponseBytes: MAX_HTML_BYTES,
      maxDecompressedBytes: MAX_HTML_BYTES,
      maxDecodedBytes: MAX_HTML_BYTES,
      maxRedirects: MAX_REDIRECTS,
      acquire: async url => { normalizeUrl(url.href); return () => {} },
    })
  } catch (error) {
    if (error instanceof FeedHttpError && error.code === 'limit') throw new Error('The article page is too large to extract')
    throw error
  }
  const url = new URL(response.url)
  if (fallbackEnabled && [401, 403, 406, 429].includes(response.status)) return fetchReaderPage(url, signal)
  if (response.status < 200 || response.status >= 300) throw new Error(`The article page returned status ${response.status}`)
  if (!response.contentType.includes('text/html') && !response.contentType.includes('application/xhtml+xml')) throw new Error('The article URL did not return an HTML page')
  return { html: response.text, finalUrl: url }
}

async function fetchReaderPage(url: URL, signal?: AbortSignal): Promise<{ html: string; finalUrl: URL }> {
  const readerUrl = new URL(`${JINA_READER_ORIGIN}${url.href}`)
  const response = await fetch(readerUrl, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    headers: {
      Accept: 'application/json',
      DNT: '1',
      'X-Return-Format': 'html',
    },
  })
  if (!response.ok) throw new Error(`The article page is blocked and the reader fallback returned status ${response.status}`)

  let payload: { data?: { html?: unknown } }
  try {
    payload = JSON.parse(await readLimited(response)) as { data?: { html?: unknown } }
  } catch {
    throw new Error('The article page is blocked and the reader fallback returned an invalid response')
  }
  const html = typeof payload.data?.html === 'string' ? payload.data.html : ''
  if (!html) throw new Error('The article page is blocked and the reader fallback found no article HTML')
  return { html, finalUrl: url }
}

async function readLimited(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > MAX_HTML_BYTES) throw new Error('The article page is too large to extract')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_HTML_BYTES) {
      await reader.cancel()
      throw new Error('The article page is too large to extract')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
