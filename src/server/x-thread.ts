import { JSDOM } from 'jsdom'
import { cleanArticleHtml, decodeHtmlText } from './text.js'

export interface XThreadPost {
  id: string
  url: string
  author: string
  contentHtml: string
  publishedAt: string
}

interface CachedThread {
  expiresAt: number
  posts: XThreadPost[]
}

const CACHE_TTL = 10 * 60 * 1000
const MAX_XML_BYTES = 2 * 1024 * 1024

export class XThreadService {
  private readonly cache = new Map<string, CachedThread>()

  constructor(private readonly baseUrl: string) {}

  async load(entryUrl: string): Promise<XThreadPost[]> {
    const reference = parseXStatusUrl(entryUrl)
    const key = `${reference.handle.toLowerCase()}/${reference.status}`
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.posts

    const route = `${this.baseUrl}/twitter/tweet/${encodeURIComponent(reference.handle)}/status/${reference.status}`
    const response = await fetch(route, {
      headers: { Accept: 'application/rss+xml, application/xml;q=0.9' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`RSSHub returned status ${response.status}`)
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (declaredLength > MAX_XML_BYTES) throw new Error('The X thread response is too large')
    const xml = await response.text()
    if (Buffer.byteLength(xml) > MAX_XML_BYTES) throw new Error('The X thread response is too large')

    const posts = parseXThreadXml(xml, reference)
    this.cache.set(key, { posts, expiresAt: Date.now() + CACHE_TTL })
    return posts
  }
}

export function parseXStatusUrl(input: string): { handle: string; status: string } {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('This entry does not have a valid X URL') }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (!['x.com', 'twitter.com'].includes(host)) throw new Error('This entry is not an X post')
  const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i)
  if (!match) throw new Error('Paper could not identify this X post')
  return { handle: match[1], status: match[2] }
}

export function parseXThreadXml(xml: string, root: { handle: string; status: string }): XThreadPost[] {
  const document = new JSDOM(xml, { contentType: 'text/xml' }).window.document
  const posts = [...document.querySelectorAll('item')].flatMap(item => {
    const url = item.querySelector('link')?.textContent?.trim() || ''
    let reference: { handle: string; status: string }
    try { reference = parseXStatusUrl(url) } catch { return [] }
    if (reference.handle.toLowerCase() !== root.handle.toLowerCase() || reference.status === root.status) return []
    const description = item.querySelector('description')?.textContent || ''
    const title = decodeHtmlText(item.querySelector('title')?.textContent?.trim() || '')
    if (!isThreadContinuation(title, root.handle, description)) return []
    const creator = item.getElementsByTagName('dc:creator')[0]?.textContent || item.querySelector('author')?.textContent || ''
    const published = item.querySelector('pubDate')?.textContent || ''
    return [{
      id: reference.status,
      url,
      author: decodeHtmlText(creator.trim()),
      contentHtml: cleanArticleHtml(stripThreadPrefix(description, root.handle)),
      publishedAt: validDate(published),
    }]
  })
  return posts.sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt)).slice(0, 40)
}

export function isThreadContinuation(title: string, rootHandle: string, description = ''): boolean {
  if (/rsshub-quote/i.test(description)) return false
  const handle = rootHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const normalized = title.trim()
  if (!/^Re\s+/i.test(normalized)) return false
  const mentioned = normalized.match(/^Re\s+@([^\s:]+)/i)?.[1]
  return !mentioned || new RegExp(`^${handle}$`, 'i').test(mentioned)
}

function stripThreadPrefix(description: string, rootHandle: string): string {
  const handle = rootHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return description.replace(new RegExp(`^\\s*Re(?:\\s+@${handle})?\\s+`, 'i'), '')
}

function validDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}
