import { SaxesParser, type SaxesAttributeNS } from 'saxes'
import sanitizeHtml from 'sanitize-html'
import { cleanArticleHtml, escapeHtml, plainText } from './text.js'

const ATOM = 'http://www.w3.org/2005/Atom'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RSS1 = 'http://purl.org/rss/1.0/'
const RSS090 = 'http://my.netscape.com/rdf/simple/0.9/'
const DC = 'http://purl.org/dc/elements/1.1/'
const CONTENT = 'http://purl.org/rss/1.0/modules/content/'
const XML = 'http://www.w3.org/XML/1998/namespace'
const XHTML = 'http://www.w3.org/1999/xhtml'

export const FEED_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, depth: 64, nodes: 100_000, entries: 5_000 })
export interface ParsedFeedEntry {
  externalId?: string
  title: string
  author: string
  url: string
  publishedAt: string
  contentHtml: string
  thumbnailUrl: string
}
export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf'
  title: string
  siteUrl: string
  entries: ParsedFeedEntry[]
}
interface Node {
  name: string
  ns: string
  base: string
  attributes: SaxesAttributeNS[]
  children: Array<Node | string>
}

// This only resolves URLs. The HTTP collector must enforce network access policy.
export function feedUrl(value: string, base?: string): string {
  if (!value.trim()) return ''
  try {
    const url = new URL(value.trim(), base)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}
function attribute(node: Node, name: string, ns = ''): string {
  return node.attributes.find(a => a.local === name && a.uri === ns)?.value || ''
}
function children(node: Node, name: string, ns = node.ns): Node[] {
  return node.children.filter((child): child is Node => typeof child !== 'string' && child.name === name && child.ns === ns)
}
function child(node: Node, name: string, ns = node.ns): Node | undefined { return children(node, name, ns)[0] }
function text(node?: Node): string {
  return node?.children.map(value => typeof value === 'string' ? value : text(value)).join('') || ''
}
function value(node: Node, name: string, ns = node.ns): string { return text(child(node, name, ns)).trim() }
function linkText(node?: Node): string { return node ? feedUrl(text(node), node.base) : '' }
function date(value: string): string {
  const timestamp = value ? Date.parse(value) : NaN
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function parseXml(xml: string, url: string): Node {
  if (Buffer.byteLength(xml, 'utf8') > FEED_LIMITS.bytes) throw new Error('Feed exceeds the XML byte limit')
  const parser = new SaxesParser({ xmlns: true })
  const stack: Node[] = []
  let root: Node | undefined
  let count = 0
  parser.on('doctype', () => { throw new Error('Feed document types and entity declarations are unsupported') })
  // Do not include source text, URLs or credentials in parse errors.
  parser.on('error', () => { throw new Error('Malformed feed XML or unsupported entity') })
  parser.on('opentag', tag => {
    if (++count > FEED_LIMITS.nodes || stack.length >= FEED_LIMITS.depth) throw new Error('Feed exceeds the XML structure limit')
    const parent = stack.at(-1)
    const node: Node = { name: tag.local, ns: tag.uri, attributes: Object.values(tag.attributes), base: parent?.base || url, children: [] }
    const base = attribute(node, 'base', XML)
    if (base) node.base = feedUrl(base, node.base) || node.base
    if (parent) parent.children.push(node)
    else root = node
    stack.push(node)
  })
  const append = (value: string) => { if (stack.length) stack.at(-1)!.children.push(value) }
  parser.on('text', append)
  parser.on('cdata', append)
  parser.on('closetag', () => { stack.pop() })
  parser.write(xml).close()
  if (!root) throw new Error('Empty feed XML')
  return root
}

function safeHtml(html: string, base: string): string {
  return sanitizeHtml(cleanArticleHtml(html), {
    // Input has already passed the shared article allowlist. This pass only
    // rewrites URLs and removes unusable embeds.
    allowedTags: false, allowedAttributes: false, allowVulnerableTags: true,
    exclusiveFilter: frame => frame.tag === 'iframe' && !frame.attribs.src,
    transformTags: { '*': (tagName, attribs) => {
      for (const name of ['href', 'src', 'poster']) {
        if (attribs[name]) attribs[name] = feedUrl(attribs[name], base)
      }
      // Avoid retaining unresolved candidates. The ordinary image src remains.
      delete attribs.srcset
      return { tagName, attribs }
    } },
  })
}
function xhtml(node: Node): string {
  if (node.ns !== XHTML) return ''
  const attrs = node.attributes.filter(a => !a.uri).map(a => {
    const v = ['href', 'src', 'poster'].includes(a.local) ? feedUrl(a.value, node.base) : a.value
    return ` ${a.local}="${escapeHtml(v)}"`
  }).join('')
  return `<${node.name}${attrs}>${node.children.map(c => typeof c === 'string' ? escapeHtml(c) : xhtml(c)).join('')}</${node.name}>`
}
function atomContent(node?: Node): string {
  if (!node || attribute(node, 'src')) return ''
  const type = attribute(node, 'type') || 'text'
  if (type === 'xhtml') return safeHtml(children(node, 'div', XHTML).map(xhtml).join(''), node.base)
  if (type === 'html' || type === 'text/html') return safeHtml(text(node), node.base)
  if (type === 'text' || type === 'text/plain') return escapeHtml(text(node))
  return ''
}
function atomLink(node: Node): string {
  const links = children(node, 'link', ATOM).filter(link => !attribute(link, 'rel') || attribute(link, 'rel') === 'alternate')
  links.sort((a, b) => Number(!['', 'text/html', 'application/xhtml+xml'].includes(attribute(a, 'type'))) - Number(!['', 'text/html', 'application/xhtml+xml'].includes(attribute(b, 'type'))))
  return links.map(link => feedUrl(attribute(link, 'href'), link.base)).find(Boolean) || ''
}
function atomAuthor(node: Node): string { return value(child(node, 'author', ATOM) || node, 'name', ATOM) }

export function parseFeed(xml: string, responseUrl: string): ParsedFeed {
  const url = feedUrl(responseUrl)
  if (!url) throw new Error('Feed response URL must use HTTP or HTTPS without credentials')
  const root = parseXml(xml, url)
  let format: ParsedFeed['format']
  let channel: Node
  let items: Node[]
  if (root.name === 'feed' && root.ns === ATOM) {
    format = 'atom'; channel = root; items = children(root, 'entry', ATOM)
  } else if (root.name === 'rss' && !root.ns && ['2.0', '0.91', '0.92'].includes(attribute(root, 'version'))) {
    format = 'rss'
    const channels = children(root, 'channel')
    if (channels.length !== 1) throw new Error('RSS requires one channel')
    channel = channels[0]; items = children(channel, 'item')
  } else if (root.name === 'RDF' && root.ns === RDF) {
    format = 'rdf'
    const channels = [...children(root, 'channel', RSS1), ...children(root, 'channel', RSS090)]
    if (channels.length !== 1) throw new Error('Unsupported RSS/RDF channel')
    channel = channels[0]; items = children(root, 'item', channel.ns)
  } else throw new Error('Unsupported feed format')
  if (items.length > FEED_LIMITS.entries) throw new Error('Feed exceeds the entry limit')
  const title = format === 'atom' ? plainText(atomContent(child(channel, 'title'))) : plainText(value(channel, 'title'))
  const siteUrl = format === 'atom' ? atomLink(channel) : linkText(child(channel, 'link'))
  const entries = items.map(item => {
    if (format === 'atom') {
      const contentHtml = atomContent(child(item, 'content')) || atomContent(child(item, 'summary'))
      return {
        externalId: value(item, 'id') || undefined,
        title: plainText(atomContent(child(item, 'title'))),
        author: atomAuthor(item) || atomAuthor(child(item, 'source') || channel) || atomAuthor(channel),
        url: atomLink(item), publishedAt: date(value(item, 'published')),
        contentHtml, thumbnailUrl: '',
      }
    }
    const guid = child(item, 'guid')
    const about = attribute(item, 'about', RDF)
    const content = child(item, 'encoded', CONTENT) || child(item, 'description')
    const enclosure = children(item, 'enclosure').find(node => attribute(node, 'type').startsWith('image/'))
    return {
      externalId: text(guid).trim() || (about ? feedUrl(about, item.base) || about : undefined),
      title: plainText(value(item, 'title')),
      author: plainText(value(item, 'creator', DC) || value(item, 'author')),
      url: linkText(child(item, 'link')) || (guid && attribute(guid, 'isPermaLink') !== 'false' ? linkText(guid) : '') || (about ? feedUrl(about, item.base) : ''),
      publishedAt: date(value(item, 'pubDate') || value(item, 'date', DC)),
      contentHtml: content ? safeHtml(text(content), content.base) : '',
      thumbnailUrl: enclosure ? feedUrl(attribute(enclosure, 'url'), enclosure.base) : '',
    }
  })
  // Repeated identical items are harmless; contradictory uses of one source ID
  // must not overwrite one another according to incidental document order.
  const seen = new Map<string, string>()
  const unique = entries.filter(entry => {
    if (!entry.externalId) return true
    const serialized = JSON.stringify(entry)
    const previous = seen.get(entry.externalId)
    if (previous && previous !== serialized) throw new Error('Feed contains conflicting duplicate source IDs')
    seen.set(entry.externalId, serialized)
    return !previous
  })
  return { format, title, siteUrl, entries: unique }
}
