import { Parser } from 'htmlparser2'
import { parseFeed, feedUrl, FEED_LIMITS } from './feed-parser.js'
import { SubscriptionInputError, portableUrl } from './opml.js'
import type { DiscoveryCandidate, DiscoveryResult } from '../shared/subscription-tools.js'

export interface DiscoveryDocument { body: string; responseUrl: string; contentType: string }
export type DiscoveryTransport = (url: string) => Promise<DiscoveryDocument>

// Streaming HTML parsing loads no resources or scripts. Network policy belongs to the
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
      if (/xml|rss|atom|json/i.test(contentType) || /^\s*(?:<\?xml|<rss[\s>]|<feed[\s>])/i.test(body)) throw new SubscriptionInputError('The URL did not return a valid RSS, Atom or JSON feed.')
    }
  }
  let base = responseUrl, sawBase = false, title = '', sawTitle = false, titleDepth = 0, nodes = 0
  const stack: string[] = []
  const links: Array<{ href: string; title: string; format: DiscoveryCandidate['format'] }> = []
  const parser = new Parser({
    onopentag(name, attributes) {
      if (++nodes > FEED_LIMITS.nodes || stack.length >= FEED_LIMITS.depth) throw new SubscriptionInputError('Discovery HTML exceeds the structure limit.')
      stack.push(name)
      if (stack.some(tag => ['script', 'template', 'svg', 'math'].includes(tag))) return
      if (name === 'base' && !sawBase && attributes.href !== undefined) {
        sawBase = true; base = feedUrl(attributes.href, responseUrl) || responseUrl
      }
      if (name === 'title' && !sawTitle) { sawTitle = true; titleDepth = stack.length }
      if (name !== 'link' || !(attributes.rel || '').toLowerCase().split(/\s+/).includes('alternate')) return
      const type = (attributes.type || '').split(';')[0].trim().toLowerCase()
      const format = type === 'application/atom+xml' ? 'atom' : type === 'application/rss+xml' ? 'rss' : type === 'application/rdf+xml' ? 'rdf' : type === 'application/feed+json' ? 'json' : null
      if (format && attributes.href) {
        if (links.length >= 1000) throw new SubscriptionInputError('The page advertises too many feed links. Use a feed URL directly.')
        links.push({ href: attributes.href, title: (attributes.title || '').trim().slice(0, 240), format })
      }
    },
    ontext(text) { if (titleDepth && stack.length === titleDepth) title = (title + text).slice(0, 240) },
    onclosetag() { if (titleDepth === stack.length) titleDepth = 0; stack.pop() },
  }, { decodeEntities: true })
  parser.write(body); parser.end()
  const candidates: DiscoveryCandidate[] = []
  for (const link of links) {
    const url = portableUrl(feedUrl(link.href, base))
    if (!url || candidates.some(candidate => candidate.url === url)) continue
    if (candidates.length >= 100) throw new SubscriptionInputError('The page advertises more than 100 feeds. Use a feed URL directly.')
    candidates.push({ url, title: link.title || title.trim() || url, format: link.format })
  }
  return { responseUrl: safeResponseUrl, candidates }
}

export async function discoverFeeds(url: string, transport: DiscoveryTransport): Promise<DiscoveryResult> {
  const safe = portableUrl(url)
  if (!safe) throw new SubscriptionInputError('Enter a complete website or feed URL without credentials.')
  return parseDiscoveryDocument(await transport(safe))
}
