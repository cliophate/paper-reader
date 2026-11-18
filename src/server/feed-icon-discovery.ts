import { Parser } from 'htmlparser2'
import { boundedFetch, FeedHttpError } from './feed-http.js'
import { MAX_FEED_ICON_BYTES, rasterIcon, type FeedIconExtension } from './feed-icon-format.js'
import { feedUrl } from './feed-parser.js'

export const MAX_ICON_HEAD_BYTES = 64 * 1024
const MAX_DECLARED_ICONS = 4
const MAX_HEAD_DEPTH = 32
const HEAD_TAGS = new Set(['html', 'head', 'base', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title'])

function iconUrl(value: string, base?: string): string {
  const safe = feedUrl(value, base)
  if (!safe) return ''
  const url = new URL(safe)
  url.hash = ''
  return url.href
}

function sizeRank(sizes = ''): number {
  const squareSizes = sizes.split(/\s+/).map(size => /^(\d{1,5})x\1$/i.exec(size))
    .filter(size => size !== null).map(size => Number(size[1]))
  const preferred = squareSizes.filter(size => size >= 32 && size <= 180)
  if (preferred.length) return Math.min(...preferred.map(size => Math.abs(size - 64)))
  return sizes && sizes.toLowerCase() !== 'any' ? 1001 : 1000
}

export function declaredFeedIcons(html: string, responseUrl: string): string[] {
  if (Buffer.byteLength(html) > MAX_ICON_HEAD_BYTES) return []
  let base = responseUrl
  let sawBase = false
  const stack: string[] = []
  const inHead = () => stack.length === 0 || stack.length === 1 && ['html', 'head'].includes(stack[0])
    || stack.length === 2 && stack[0] === 'html' && stack[1] === 'head'
  const links: Array<{ href: string; rank: number }> = []
  const parser = new Parser({
    onopentag(name, attributes) {
      if (stack.length >= MAX_HEAD_DEPTH) { parser.pause(); return }
      const inHeadContext = inHead()
      stack.push(name)
      if (!inHeadContext) return
      if (!HEAD_TAGS.has(name)) { parser.pause(); return }
      if (name === 'base' && !sawBase && attributes.href !== undefined) {
        sawBase = true
        base = iconUrl(attributes.href, responseUrl) || responseUrl
      }
      if (name !== 'link' || !attributes.href) return
      const rel = (attributes.rel || '').toLowerCase().split(/\s+/)
      if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
        links.push({ href: attributes.href, rank: sizeRank(attributes.sizes) })
      }
    },
    onclosetag(name) {
      if (name === 'head' && inHead()) parser.pause()
      stack.pop()
    },
  })
  parser.end(html)
  const urls = links.sort((a, b) => a.rank - b.rank).map(link => iconUrl(link.href, base)).filter(Boolean)
  return [...new Set(urls)].slice(0, MAX_DECLARED_ICONS)
}

export interface FeedIconImage { bytes: Buffer; extension: FeedIconExtension }
export interface FeedIconSources { url: string; siteUrl: string; iconUrl: string }

export async function discoverFeedIcon(feed: FeedIconSources, options: {
  trustedOrigins: readonly string[]
  signal: AbortSignal
  isLocal: (url: URL) => boolean
}): Promise<FeedIconImage | null> {
  const { trustedOrigins, signal, isLocal } = options
  const common = { trustedOrigins, signal, timeoutMs: 4000, maxRedirects: 3, acquire: async (url: URL) => {
    if (isLocal(url)) throw new FeedHttpError('policy', 'Paper already serves this icon.')
    return () => {}
  } }
  const attempted = new Set<string>()
  const image = async (url: string): Promise<FeedIconImage | null> => {
    if (!url || attempted.has(url) || isLocal(new URL(url)) || signal.aborted) return null
    attempted.add(url)
    try {
      const response = await boundedFetch(url, { ...common, responseBody: 'bytes',
        accept: 'image/png, image/x-icon, image/vnd.microsoft.icon, image/gif, image/jpeg, image/webp, */*;q=0.1',
        maxResponseBytes: MAX_FEED_ICON_BYTES, maxDecompressedBytes: MAX_FEED_ICON_BYTES })
      attempted.add(response.url)
      const extension = response.status === 200 && rasterIcon(response.bytes)
      return extension ? { extension, bytes: response.bytes } : null
    } catch (error) { if (error instanceof FeedHttpError) return null; throw error }
  }

  const existing = await image(iconUrl(feed.iconUrl))
  if (existing || signal.aborted) return existing
  const endpoint = iconUrl(feed.url)
  const site = iconUrl(feed.siteUrl) || (endpoint && new URL(endpoint).origin)
  if (!site) return null
  let declared: string[] = []
  try {
    const response = await boundedFetch(site, { ...common, responseBody: 'text-prefix', fatalDecoding: false,
      accept: 'text/html, application/xhtml+xml;q=0.9', maxResponseBytes: 2 * MAX_ICON_HEAD_BYTES,
      maxDecompressedBytes: MAX_ICON_HEAD_BYTES, maxDecodedBytes: MAX_ICON_HEAD_BYTES })
    const type = response.contentType.split(';')[0].trim().toLowerCase()
    if (response.status === 200 && ['', 'text/html', 'application/xhtml+xml', 'text/plain', 'application/octet-stream'].includes(type)) {
      declared = declaredFeedIcons(response.text, response.url)
    }
  } catch (error) { if (!(error instanceof FeedHttpError)) throw error }
  for (const url of [...declared, new URL('/favicon.ico', site).href]) {
    const found = await image(url)
    if (found) return found
  }
  return null
}
