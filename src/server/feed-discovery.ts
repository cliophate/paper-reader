import { JSDOM } from 'jsdom'
import { parseFeed, feedUrl, FEED_LIMITS } from './feed-parser.js'
import { SubscriptionInputError, portableUrl } from './opml.js'
import type { DiscoveryCandidate, DiscoveryResult } from '../shared/subscription-tools.js'

export interface DiscoveryDocument { body: string; responseUrl: string; contentType: string }
export type DiscoveryTransport = (url: string) => Promise<DiscoveryDocument>

// No resources or scripts are loaded by JSDOM. Network policy belongs to the
// shared HTTP transport, including the final URL and every redirect.
export function parseDiscoveryDocument({ body, responseUrl, contentType }: DiscoveryDocument): DiscoveryResult {
  if (Buffer.byteLength(body, 'utf8') > FEED_LIMITS.bytes) throw new SubscriptionInputError('Discovery document exceeds the size limit.')
  const safeResponseUrl = portableUrl(responseUrl)
  if (!safeResponseUrl) throw new SubscriptionInputError('Discovery requires an HTTP or HTTPS URL without credentials.')
  if (!/html/i.test(contentType) && !/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body)) {
    try {
      const parsed = parseFeed(body, responseUrl)
      return { responseUrl: safeResponseUrl, candidates: [{ url: safeResponseUrl, title: parsed.title || safeResponseUrl, format: parsed.format }] }
    } catch {
      // An XML document must parse as a feed. Do not reinterpret malformed XML
      // as HTML and offer links extracted from an invalid document.
      if (/xml|rss|atom/i.test(contentType) || /^\s*(?:<\?xml|<rss[\s>]|<feed[\s>])/i.test(body)) throw new SubscriptionInputError('The URL did not return a valid RSS or Atom feed.')
    }
  }
  const dom = new JSDOM(body, { url: responseUrl })
  try {
    const document = dom.window.document
    const rawBase = document.querySelector('base[href]')?.getAttribute('href')
    const base = rawBase ? feedUrl(rawBase, responseUrl) || responseUrl : responseUrl
    const candidates: DiscoveryCandidate[] = []
    for (const link of document.querySelectorAll('link[href]')) {
      if (!(link.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('alternate')) continue
      const type = (link.getAttribute('type') || '').split(';')[0].trim().toLowerCase()
      const format = type === 'application/atom+xml' ? 'atom' : type === 'application/rss+xml' ? 'rss' : type === 'application/rdf+xml' ? 'rdf' : null
      const url = portableUrl(feedUrl(link.getAttribute('href') || '', base))
      if (!format || !url || candidates.some(candidate => candidate.url === url)) continue
      if (candidates.length >= 100) throw new SubscriptionInputError('The page advertises more than 100 feeds. Use a feed URL directly.')
      candidates.push({ url, title: (link.getAttribute('title') || document.title || url).trim().slice(0, 240), format })
    }
    return { responseUrl: safeResponseUrl, candidates }
  } finally { dom.window.close() }
}

export async function discoverFeeds(url: string, transport: DiscoveryTransport): Promise<DiscoveryResult> {
  const safe = portableUrl(url)
  if (!safe) throw new SubscriptionInputError('Enter a complete website or feed URL without credentials.')
  return parseDiscoveryDocument(await transport(safe))
}
