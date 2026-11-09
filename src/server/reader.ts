import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import type { ArticleCacheRecord, PaperDatabase } from './db.js'
import { cleanArticleHtml, plainText, readingMinutes } from './text.js'

const MAX_REDIRECTS = 5
const MAX_HTML_BYTES = 5 * 1024 * 1024
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const JINA_READER_ORIGIN = 'https://r.jina.ai/'

const blockedAddresses = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6')
}

export interface FullArticle extends ArticleCacheRecord {
  cached: boolean
}

export class ReaderService {
  constructor(private readonly database: PaperDatabase, private readonly fallbackEnabled = false) {}

  async fetch(urlInput: string, maxCacheAgeMs = CACHE_MAX_AGE_MS): Promise<FullArticle> {
    const url = normalizeUrl(urlInput)
    const cached = this.database.getArticle(url.href)
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < maxCacheAgeMs) return { ...cached, cached: true }

    const { html, finalUrl } = await fetchHtml(url, this.fallbackEnabled)
    let extracted: Omit<ArticleCacheRecord, 'url' | 'fetchedAt'>
    try {
      extracted = extractReadableArticle(html, finalUrl.href)
    } catch (error) {
      if (!this.fallbackEnabled) throw error
      const fallback = await fetchReaderPage(finalUrl).catch(() => null)
      if (!fallback) throw error
      extracted = extractReadableArticle(fallback.html, finalUrl.href)
    }

    const article: ArticleCacheRecord = {
      url: url.href,
      ...extracted,
      fetchedAt: new Date().toISOString(),
    }
    this.database.cacheArticle(article)
    return { ...article, cached: false }
  }
}

export function extractReadableArticle(html: string, url: string): Omit<ArticleCacheRecord, 'url' | 'fetchedAt'> {
  const dom = new JSDOM(html, { url })
  try {
    const document = dom.window.document
    const pageImage = document.querySelector<HTMLMetaElement>('meta[property="og:image"], meta[name="twitter:image"]')?.content || ''
    prepareDocument(document, url)
    const parsed = new Readability(document).parse()
    if (!parsed?.content) throw new Error('Paper could not find a readable article on this page')

    let contentHtml = cleanArticleHtml(parsed.content)
    if (pageImage && !/<img\b/i.test(contentHtml)) {
      try {
        const imageUrl = new URL(pageImage, url)
        if (['http:', 'https:'].includes(imageUrl.protocol)) contentHtml = `<figure><img src="${escapeAttribute(imageUrl.href)}" alt=""></figure>${contentHtml}`
      } catch { /* Ignore invalid page metadata. */ }
    }
    const articleText = plainText(contentHtml)
    if (/This article is FREE/i.test(articleText) && /Log in or register/i.test(articleText)) {
      throw new Error('This publisher requires you to sign in to read the article')
    }
    if (articleText.length < 240) throw new Error('The extracted page did not contain enough article text')
    return {
      title: parsed.title?.trim() || '',
      byline: parsed.byline?.trim() || '',
      excerpt: parsed.excerpt?.trim() || '',
      contentHtml,
      readingMinutes: readingMinutes(contentHtml),
    }
  } finally { dom.window.close() }
}

function prepareDocument(document: Document, url: string) {
  for (const element of document.querySelectorAll([
    'nav', 'footer', '[role="navigation"]', '[role="dialog"]',
    '.newsletter', '.newsletter-signup', '.social-share', '.share-buttons',
    '.copy-link', '.follow-button', '.comments', '#comments',
    '.w-heading-options', '.action-bar-follow', '.qa-action-list', '.w-follow-btn',
    '.article-date', '.w-article-header-author-img', '.article-header',
  ].join(','))) element.remove()

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

export async function fetchHtml(startUrl: URL, fallbackEnabled = false): Promise<{ html: string; finalUrl: URL }> {
  let url = startUrl
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicUrl(url)
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; PaperReader/1.0; +https://github.com/cliophate/paper-reader)',
      },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`The article returned an incomplete redirect with status ${response.status}`)
      url = normalizeUrl(new URL(location, url).href)
      continue
    }
    if (fallbackEnabled && [401, 403, 406, 429].includes(response.status)) return fetchReaderPage(url)
    if (!response.ok) throw new Error(`The article page returned status ${response.status}`)
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('The article URL did not return an HTML page')
    return { html: await readLimited(response), finalUrl: url }
  }
  throw new Error('The article redirected too many times')
}

async function fetchReaderPage(url: URL): Promise<{ html: string; finalUrl: URL }> {
  const readerUrl = new URL(`${JINA_READER_ORIGIN}${url.href}`)
  const response = await fetch(readerUrl, {
    signal: AbortSignal.timeout(45_000),
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

export async function assertPublicUrl(url: URL) {
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Paper cannot fetch private network addresses')
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address, family }) => blockedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4'))) {
    throw new Error('Paper cannot fetch private network addresses')
  }
}

export async function readLimited(response: Response): Promise<string> {
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
