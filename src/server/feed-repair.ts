import { JSDOM } from 'jsdom'
import { BackendValidationError } from './backend.js'
import { boundedFetch } from './feed-http.js'

export interface FeedPreview { url: string; title: string; items: Array<{ title: string; date: string }> }

export function parseFeedPreview(xml: string, url: string): FeedPreview {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new BackendValidationError('This feed declares unsupported XML entities.')
  let document: Document
  try { document = new JSDOM(xml, { contentType: 'text/xml' }).window.document }
  catch { throw new BackendValidationError('The URL did not return a valid RSS or Atom feed.') }
  const root = document.documentElement.localName.toLowerCase()
  if (!['rss', 'rdf', 'feed'].includes(root)) throw new BackendValidationError('Use the RSS or Atom feed URL, rather than the website address.')
  const nodes = [...document.getElementsByTagNameNS('*', root === 'feed' ? 'entry' : 'item')]
  const text = (node: Element, names: string[]) => names.map(name => node.getElementsByTagNameNS('*', name)[0]?.textContent?.trim()).find(Boolean) || ''
  return { url, title: text(document.documentElement, ['title']).slice(0, 300), items: nodes.slice(0, 5).map(node => ({ title: text(node, ['title']).slice(0, 300), date: text(node, ['published', 'pubDate', 'updated', 'date']).slice(0, 100) })) }
}

export async function previewFeed(input: string, trustedOrigins: string[] = []): Promise<FeedPreview> {
  const response = await boundedFetch(input, { trustedOrigins, timeoutMs: 15000 })
  if (response.status !== 200) throw new Error(`The feed returned HTTP ${response.status}.`)
  return parseFeedPreview(response.text, response.url)
}
