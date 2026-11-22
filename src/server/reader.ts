import { extractedCookieRedactor } from './feed-cookie.js'
import { extractReadableArticle } from './article-extraction.js'
import { extractionRules, extractWithOverrides } from './feed-extraction.js'
import { hasFeedOverrides, type SavedOverrides } from './feed-overrides.js'
import { BackendValidationError } from './backend.js'
import { boundedFetch, FeedHttpError } from './feed-http.js'
import type { ArticleCacheRecord, PaperDatabase } from './db.js'

export { extractReadableArticle }

const MAX_REDIRECTS = 5
const MAX_HTML_BYTES = 5 * 1024 * 1024
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const JINA_READER_ORIGIN = 'https://r.jina.ai/'

export interface FullArticle extends ArticleCacheRecord {
  overrideWarning?: string
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
    const extraction = rules && extractionRules(rules, 'article')
    let overrideWarning: string | undefined
    try {
      if (rules && extraction) {
        extracted = await extractWithOverrides({ kind: 'article', body: html, url: finalUrl.href }, extraction, reason => {
          overrideWarning = reason
          if (!preview) this.database.feedOverrides.warn(rules.revision, reason)
        }, signal)
      } else extracted = extractReadableArticle(html, finalUrl.href)
    } catch (error) {
      if (!fallback) throw error
      const page = await fetchReaderPage(finalUrl, signal).catch(() => null)
      signal?.throwIfAborted()
      if (!page) throw error
      extracted = extractReadableArticle(page.html, finalUrl.href)
    }

    const redact = rules?.cookie && extractedCookieRedactor(rules.cookie)
    if (redact) {
      extracted.title = redact.text(extracted.title)
      extracted.byline = redact.text(extracted.byline)
      extracted.excerpt = redact.text(extracted.excerpt)
      extracted.contentHtml = redact.html(extracted.contentHtml)
    }
    const article: ArticleCacheRecord = {
      url: url.href,
      ...extracted,
      fetchedAt: new Date().toISOString(),
    }
    signal?.throwIfAborted()
    if (!preview) this.database.cacheArticle(article, rules?.revision)
    return { ...article, cached: false, overrideWarning }
  }
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
  const response = await boundedFetch(readerUrl.href, {
    signal, timeoutMs: 45_000, maxRedirects: 0, accept: 'application/json', readerHtml: true,
  })
  if (response.status < 200 || response.status >= 300) throw new Error(`The article page is blocked and the reader fallback returned status ${response.status}`)

  let payload: { data?: { html?: unknown } }
  try {
    payload = JSON.parse(response.text) as { data?: { html?: unknown } }
  } catch {
    throw new Error('The article page is blocked and the reader fallback returned an invalid response')
  }
  const html = typeof payload.data?.html === 'string' ? payload.data.html : ''
  if (!html) throw new Error('The article page is blocked and the reader fallback found no article HTML')
  return { html, finalUrl: url }
}
