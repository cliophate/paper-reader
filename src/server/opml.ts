import { createHash } from 'node:crypto'
import { SaxesParser } from 'saxes'
import { feedUrl } from './feed-parser.js'
import type { NavigationPayload, Feed } from './types.js'
import type { ImportRow } from '../shared/subscription-tools.js'

export const OPML_LIMITS = Object.freeze({ bytes: 1024 * 1024, depth: 32, nodes: 10_000, subscriptions: 1000 })
const PAPER = 'https://paper-reader.app/ns/opml'
export interface OpmlSubscription { key: string; title: string; url: string; paths: string[][]; identity: string; problem?: string }
export interface OpmlDocument { subscriptions: OpmlSubscription[]; warnings: string[] }

export class SubscriptionInputError extends Error {}

// Exported IDs are scoped lookup hints, never authority and never provider URLs.
export function opmlIdentity(backendId: string, id: string): string {
  return createHash('sha256').update(JSON.stringify([backendId, id])).digest('hex')
}

export function subscriptionUrl(value: string): string {
  const safe = feedUrl(value)
  if (!safe) return ''
  const url = new URL(safe)
  url.hash = ''
  return url.href
}

// Private feed URLs must be transferred separately. Never strip a credential and
// export a different, apparently working subscription.
export function portableUrl(value: string): string {
  const safe = subscriptionUrl(value)
  if (!safe) return ''
  const url = new URL(safe)
  if ([...url.searchParams.keys()].some(key => /token|secret|password|passwd|api.?key|auth|signature|credential/i.test(key))) return ''
  return safe
}

export function parseOpml(xml: string): OpmlDocument {
  if (Buffer.byteLength(xml, 'utf8') > OPML_LIMITS.bytes) throw new SubscriptionInputError('OPML exceeds the 1 MiB limit.')
  const parser = new SaxesParser({ xmlns: true })
  const stack: Array<{ name: string; path: string[]; outline: boolean }> = []
  const subscriptions: OpmlSubscription[] = []
  const warnings = new Set<string>()
  let nodes = 0, bodies = 0, outlines = 0
  parser.on('error', () => { throw new SubscriptionInputError('Malformed OPML XML or unsupported entity.') })
  parser.on('doctype', () => { throw new SubscriptionInputError('OPML document types and entity declarations are not supported.') })
  parser.on('opentag', tag => {
    if (++nodes > OPML_LIMITS.nodes || stack.length >= OPML_LIMITS.depth) throw new SubscriptionInputError('OPML exceeds the XML structure limit.')
    const parent = stack.at(-1)
    const name = tag.uri ? '' : tag.local
    if (!parent && name !== 'opml') throw new SubscriptionInputError('Expected an OPML document.')
    if (name === 'body' && parent?.name === 'opml') bodies++
    const outline = name === 'outline' && (parent?.name === 'body' || parent?.outline === true)
    let path = parent?.path || []
    if (outline) {
      const attribute = (name: string, uri = '') => Object.values(tag.attributes).find(a => a.local === name && a.uri === uri)?.value || ''
      const title = (attribute('title') || attribute('text')).trim().normalize('NFC')
      const rawUrl = attribute('xmlUrl')
      if (rawUrl || attribute('type').toLowerCase() === 'rss' || attribute('type').toLowerCase() === 'atom') {
        if (++outlines > OPML_LIMITS.subscriptions) throw new SubscriptionInputError('OPML exceeds the 1,000 subscription limit.')
        const url = portableUrl(rawUrl)
        const identity = attribute('id', PAPER)
        const problem = !url ? 'A complete HTTP or HTTPS feed URL without embedded credentials or token parameters is required.' : title.length > 240 ? 'The feed title exceeds 240 characters.' : undefined
        // Only this extension identifies repeated memberships. Equal URLs do not.
        const previous = identity && /^[a-f0-9]{64}$/.test(identity) ? subscriptions.find(row => row.identity === identity) : undefined
        if (previous && previous.url === url && !problem && !previous.problem) {
          if (!previous.paths.some(p => JSON.stringify(p) === JSON.stringify(path))) previous.paths.push(path)
        } else {
          subscriptions.push({ key: String(outlines), title: title.slice(0, 240) || url || 'Invalid subscription', url, paths: [path], identity: /^[a-f0-9]{64}$/.test(identity) ? identity : '', ...(problem ? { problem } : {}) })
          if (previous) warnings.add('Conflicting subscription identity hints remain separate rows. Review them before import.')
        }
      } else {
        if (title) path = [...path, title]
        else warnings.add('An unnamed group was flattened into its parent group.')
      }
    }
    stack.push({ name, path, outline })
  })
  parser.on('closetag', () => { stack.pop() })
  parser.write(xml).close()
  if (bodies !== 1) throw new SubscriptionInputError('OPML must contain exactly one body.')
  if (!subscriptions.length) warnings.add('This file contains no subscriptions. Empty groups are not imported.')
  else warnings.add('Empty groups are not imported. Nested groups become flat names joined by /; review the folder mapping.')
  return { subscriptions, warnings: [...warnings] }
}

export function subscriptionList(navigation: NavigationPayload): Array<{ feed: Feed; folders: string[] }> {
  const feeds = new Map<string, { feed: Feed; folders: string[] }>()
  for (const folder of navigation.folders) for (const feed of folder.feeds) {
    const row = feeds.get(feed.id) || { feed, folders: [] }
    if (!row.folders.includes(folder.title)) row.folders.push(folder.title)
    feeds.set(feed.id, row)
  }
  for (const feed of navigation.uncategorized) if (!feeds.has(feed.id)) feeds.set(feed.id, { feed, folders: [] })
  return [...feeds.values()]
}

export function previewOpml(document: OpmlDocument, navigation: NavigationPayload, backendId: string): ImportRow[] {
  const current = subscriptionList(navigation)
  return document.subscriptions.map(row => {
    const identified = current.filter(({ feed }) => row.identity && opmlIdentity(backendId, feed.id) === row.identity)
    const matches = current.filter(({ feed }) => (subscriptionUrl(feed.url) === row.url && row.url) || identified.some(item => item.feed.id === feed.id))
    const identityConflict = identified.some(({ feed }) => subscriptionUrl(feed.url) !== row.url)
    const repeatedUrl = document.subscriptions.some(other => other !== row && other.url && other.url === row.url)
    const folders = [...new Set(row.paths.map(path => path.join(' / ')))]
    const fold = (name: string) => name.trim().normalize('NFKC').toLowerCase()
    const folderConflict = row.paths.some(path => {
      const name = path.join(' / ')
      return document.subscriptions.some(other => other.paths.some(otherPath => fold(otherPath.join(' / ')) === fold(name) && JSON.stringify(otherPath) !== JSON.stringify(path))) ||
        navigation.folders.some(folder => fold(folder.title) === fold(name) && folder.title !== name)
    })
    return {
      key: row.key, title: row.title, url: row.url, folders, sourcePaths: row.paths,
      identityConflict, folderConflict,
      matches: matches.map(({ feed, folders }) => ({ id: feed.id, title: feed.title, folders, url: portableUrl(feed.url) })),
      suggestedId: identified.length === 1 && !identityConflict ? identified[0].feed.id : !row.identity && !repeatedUrl && matches.length === 1 ? matches[0].feed.id : null,
      repeatedUrl: document.subscriptions.some(other => other !== row && other.url && other.url === row.url),
      ...(row.problem ? { problem: row.problem } : {}),
    }
  })
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)

export function exportOpml(navigation: NavigationPayload, backendId: string): { xml: string; omitted: number } {
  let omitted = 0
  const outline = (feed: Feed) => {
    const url = portableUrl(feed.url)
    if (!url) { omitted++; return '' }
    const site = portableUrl(feed.siteUrl)
    return `<outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(url)}"${site ? ` htmlUrl="${escapeXml(site)}"` : ''} paper:id="${opmlIdentity(backendId, feed.id)}"/>`
  }
  const body = navigation.folders.map(folder => `<outline text="${escapeXml(folder.title)}" title="${escapeXml(folder.title)}">${folder.feeds.map(outline).join('')}</outline>`).join('') + navigation.uncategorized.map(outline).join('')
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0" xmlns:paper="${PAPER}"><head><title>Paper subscriptions</title></head><body>${body}</body></opml>\n`, omitted }
}
