import { JSDOM } from 'jsdom'
import { assertPublicUrl, readLimited } from './reader.js'

export interface FeedPreview { url: string; title: string; items: Array<{ title: string; date: string }> }

export function parseFeedPreview(xml: string, url: string): FeedPreview {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('This feed declares unsupported XML entities.')
  let document: Document
  try { document = new JSDOM(xml, { contentType: 'text/xml' }).window.document }
  catch { throw new Error('The URL did not return a valid RSS or Atom feed.') }
  const root = document.documentElement.localName.toLowerCase()
  if (!['rss', 'rdf', 'feed'].includes(root)) throw new Error('Use the RSS or Atom feed URL, rather than the website address.')
  const nodes = [...document.getElementsByTagNameNS('*', root === 'feed' ? 'entry' : 'item')]
  const text = (node: Element, names: string[]) => names.map(name => node.getElementsByTagNameNS('*', name)[0]?.textContent?.trim()).find(Boolean) || ''
  return { url, title: text(document.documentElement, ['title']).slice(0, 300), items: nodes.slice(0, 5).map(node => ({ title: text(node, ['title']).slice(0, 300), date: text(node, ['published', 'pubDate', 'updated', 'date']).slice(0, 100) })) }
}

export async function previewFeed(input: string, trustedOrigins: string[] = []): Promise<FeedPreview> {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Enter a complete feed URL.') }
  for (let i = 0; i < 6; i++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS feed URL without embedded login details.')
    // Private feed proxies require an explicit administrator allowlist.
    if (!trustedOrigins.includes(url.origin)) await assertPublicUrl(url)
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('The feed returned an invalid redirect.')
      url = new URL(location, url); continue
    }
    if (!response.ok) throw new Error(`The feed returned HTTP ${response.status}.`)
    return parseFeedPreview(await readLimited(response), url.href)
  }
  throw new Error('The feed redirected too many times.')
}
