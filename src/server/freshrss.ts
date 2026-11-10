import type { Config } from './config.js'
import { BackendValidationError } from './backend.js'
import type { FeedOperation, BackendPageOptions, EntryOptions, EntryPage, EntryStateOperation, ReaderBackend } from './backend.js'
import { detectKind } from './entry-kind.js'
import { normalizeFeedContent, normalizeFeedThumbnail } from './feed-content.js'
import type { Entry, Feed, Folder, NavigationPayload, StreamRef } from './types.js'
import { SocialAvatarService } from './social-avatar.js'
import { cleanArticleHtml, decodeHtmlText, excerpt, firstImage, readingMinutes } from './text.js'

const READ = 'user/-/state/com.google/read'
const STARRED = 'user/-/state/com.google/starred'

interface GReaderSubscription {
  id: string
  title: string
  url?: string
  htmlUrl?: string
  iconUrl?: string
  categories?: Array<{ id: string; label?: string }>
}

interface GReaderItem {
  id?: string
  title?: string
  author?: string
  published?: number
  crawlTimeMsec?: string
  timestampUsec?: string
  categories?: string[]
  origin?: { streamId?: string; title?: string; htmlUrl?: string }
  canonical?: Array<{ href?: string }>
  alternate?: Array<{ href?: string }>
  content?: { content?: string }
  summary?: { content?: string }
  enclosure?: Array<{ href?: string; type?: string }>
}

interface FeedHealth {
  id: string
  broken: boolean
  lastCheckedAt: string | null
  lastErrorAt: string | null
}

interface FeedMetadata {
  feeds: FeedHealth[]
  folderOrder: string[]
}

export { detectKind, isEditorialLinkedFeed } from './entry-kind.js'
export type { EntryPage } from './backend.js'

export class FreshRssClient implements ReaderBackend {
  private authToken = ''
  private editToken = ''
  private readonly baseUrl: string
  private readonly rootUrl: string
  private readonly socialAvatars: SocialAvatarService

  constructor(private readonly config: Config['freshRss'], trustedOrigins: string[] = []) {
    this.socialAvatars = new SocialAvatarService(trustedOrigins)
    this.rootUrl = config.baseUrl
    this.baseUrl = `${config.baseUrl}/api/greader.php`
  }

  validateFeedId(id: string, operation: FeedOperation): void {
    if (operation === 'repair') {
      if (!/^feed\/\d+$/.test(id)) throw new BackendValidationError('Choose a FreshRSS feed')
    } else if (!id.startsWith('feed/')) {
      throw new BackendValidationError('A FreshRSS feed ID is required')
    }
  }

  private async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.authToken) await this.login()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `GoogleLogin auth=${this.authToken}`)
    const response = await this.fetchBuffered(`${this.baseUrl}${path}`, { ...init, headers })
    if (response.status === 401 && retry) {
      this.authToken = ''
      this.editToken = ''
      await this.login()
      return this.request(path, init, false)
    }
    if (!response.ok) throw new Error(`FreshRSS request failed with ${response.status} for ${path}`)
    return response
  }

  private async login() {
    const body = new URLSearchParams({ Email: this.config.username, Passwd: this.config.apiPassword })
    const response = await this.fetchBuffered(`${this.baseUrl}/accounts/ClientLogin`, {
      method: 'POST',
      body,
    })
    if (!response.ok) throw new Error(`FreshRSS login failed with ${response.status}`)
    const match = (await response.text()).match(/^Auth=(.+)$/m)
    if (!match) throw new Error('FreshRSS login returned no authentication token')
    this.authToken = match[1].trim()
  }

  private async getEditToken(): Promise<string> {
    if (this.editToken) return this.editToken
    const response = await this.request('/reader/api/0/token')
    this.editToken = (await response.text()).trim()
    if (!this.editToken) throw new Error('FreshRSS returned no edit token')
    return this.editToken
  }

  private async feedMetadata(retry = true): Promise<FeedMetadata> {
    if (!this.authToken) await this.login()
    const response = await this.fetchBuffered(`${this.rootUrl}/api/paper-feed-health.php`, {
      headers: { Authorization: `GoogleLogin auth=${this.authToken}` },
    })
    if (response.status === 401 && retry) {
      this.authToken = ''
      this.editToken = ''
      return this.feedMetadata(false)
    }
    if (!response.ok) throw new Error(`FreshRSS feed health failed with ${response.status}`)
    const payload = await response.json() as { feeds?: FeedHealth[]; folderOrder?: string[] }
    return {
      feeds: payload.feeds || [],
      folderOrder: payload.folderOrder || [],
    }
  }

  async repairFeed(id: string, url: string, expectedUrl: string, retry = true): Promise<void> {
    if (!this.authToken) await this.login()
    const response = await this.fetchBuffered(`${this.rootUrl}/api/paper-feed-repair.php`, {
      method: 'POST', headers: { Authorization: `GoogleLogin auth=${this.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, url, expectedUrl }),
    }, 0)
    if (response.status === 401 && retry) { this.authToken = ''; return this.repairFeed(id, url, expectedUrl, false) }
    if (response.status === 404) throw new Error('Install the Paper feed repair integration in FreshRSS first.')
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) throw new Error(payload?.error || 'FreshRSS could not repair this feed')
  }

  private async fetchBuffered(url: string, init: RequestInit, retries = 2): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
        const body = await response.arrayBuffer()
        const buffered = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        if (response.status < 500 || attempt === retries) return buffered
        lastError = new Error(`FreshRSS returned ${response.status}`)
      } catch (error) {
        lastError = error
        if (attempt === retries) throw error
      }
      await delay(250 * (attempt + 1))
    }
    throw lastError instanceof Error ? lastError : new Error('FreshRSS request failed')
  }

  async navigation(): Promise<NavigationPayload> {
    const [subscriptionsResponse, unreadResponse, starredIds, metadata] = await Promise.all([
      this.request('/reader/api/0/subscription/list?output=json'),
      this.request('/reader/api/0/unread-count?output=json'),
      this.entryIds({ kind: 'starred', id: 'starred', title: 'Starred' }),
      this.feedMetadata().catch(() => ({ feeds: [], folderOrder: [] })),
    ])
    const subscriptions = (await subscriptionsResponse.json() as { subscriptions?: GReaderSubscription[] }).subscriptions || []
    const unreadRows = (await unreadResponse.json() as { unreadcounts?: Array<{ id: string; count: number; newestItemTimestampUsec?: string }> }).unreadcounts || []
    const unreadById = new Map(unreadRows.map(row => [row.id, Number(row.count) || 0]))
    const newestById = new Map(unreadRows.map(row => [row.id, usecToIso(row.newestItemTimestampUsec)]))
    const healthById = new Map(metadata.feeds.map(row => [row.id, row]))
    const preferredIcons = await Promise.all(subscriptions.map(subscription => this.socialAvatars.iconForFeed(
      subscription.url || subscription.id.replace(/^feed\//, ''),
      subscription.iconUrl || '',
    )))
    const folderMap = new Map<string, Folder>()
    const uncategorized: Feed[] = []

    for (const [index, subscription] of subscriptions.entries()) {
      const categories = (subscription.categories || [])
        .map(category => category.label || labelFromId(category.id))
        .filter(Boolean)
      const feed: Feed = {
        id: subscription.id,
        title: decodeHtmlText(subscription.title),
        url: subscription.url || subscription.id.replace(/^feed\//, ''),
        siteUrl: subscription.htmlUrl || '',
        iconUrl: preferredIcons[index],
        categories,
        unread: unreadById.get(subscription.id) || 0,
        lastPublishedAt: newestById.get(subscription.id) || null,
        lastCheckedAt: healthById.get(subscription.id)?.lastCheckedAt || null,
        lastErrorAt: healthById.get(subscription.id)?.lastErrorAt || null,
        broken: healthById.get(subscription.id)?.broken || false,
      }
      if (!categories.length) uncategorized.push(feed)
      for (const title of categories) {
        const id = `user/-/label/${title}`
        const folder = folderMap.get(title) || { id, title, unread: unreadById.get(id) || 0, feeds: [] }
        folder.feeds.push(feed)
        folderMap.set(title, folder)
      }
    }

    const folders = sortFolders([...folderMap.values()]
      .map(folder => ({ ...folder, feeds: folder.feeds.sort((a, b) => a.title.localeCompare(b.title)) }))
      , metadata.folderOrder)

    return {
      unread: unreadById.get('user/-/state/com.google/reading-list') || folders.reduce((sum, folder) => sum + folder.unread, 0),
      starred: starredIds.length,
      folders,
      uncategorized: uncategorized.sort((a, b) => a.title.localeCompare(b.title)),
    }
  }

  async entries(stream: StreamRef, options: EntryOptions = {}): Promise<Entry[]> {
    const result: Entry[] = []
    const requested = Math.min(Math.max(options.limit || 200, 1), 1000)
    let continuation = ''
    while (result.length < requested) {
      const page = await this.entriesPage(stream, {
        ...options,
        limit: Math.min(250, requested - result.length),
        continuation,
      })
      result.push(...page.items)
      if (!page.continuation || page.continuation === continuation) break
      continuation = page.continuation
    }
    return result.slice(0, requested)
  }

  async entriesPage(stream: StreamRef, options: BackendPageOptions = {}): Promise<EntryPage> {
    const params = new URLSearchParams({
      output: 'json',
      n: String(Math.min(Math.max(options.limit || 100, 1), 1000)),
      r: 'n',
    })
    if (options.unreadOnly) params.append('xt', READ)
    if (options.after) params.set('ot', String(Math.floor(options.after.getTime() / 1000)))
    if (options.before) params.set('nt', String(Math.floor(options.before.getTime() / 1000)))
    if (/^\d+$/.test(options.continuation || '')) params.set('c', options.continuation!)
    const path = streamPath(stream)
    const response = await this.request(`/reader/api/0/stream/contents/${path}?${params}`)
    const payload = await response.json() as { items?: GReaderItem[]; continuation?: string }
    return {
      items: (payload.items || []).map(item => mapEntry(item)),
      continuation: String(payload.continuation || ''),
    }
  }

  async entry(id: string): Promise<Entry | null> {
    if (!id) return null
    return (await this.entriesByIds([id]))[0] || null
  }

  async entriesByIds(ids: string[]): Promise<Entry[]> {
    if (!ids.length) return []
    const body = new URLSearchParams()
    for (const id of ids) body.append('i', id)
    const response = await this.request('/reader/api/0/stream/items/contents?output=json', { method: 'POST', body })
    const payload = await response.json() as { items?: GReaderItem[] }
    return (payload.items || []).map(item => mapEntry(item))
  }

  async entryIds(stream: StreamRef, unreadOnly = false): Promise<string[]> {
    const result: string[] = []
    const seenContinuations = new Set<string>()
    let continuation = ''
    while (true) {
      const params = new URLSearchParams({ output: 'json', n: '1000', s: streamId(stream), r: 'n' })
      if (unreadOnly) params.append('xt', READ)
      if (continuation) params.set('c', continuation)
      const response = await this.request(`/reader/api/0/stream/items/ids?${params}`)
      const payload = await response.json() as { itemRefs?: Array<{ id: string }>; continuation?: string }
      result.push(...(payload.itemRefs || []).map(item => canonicalItemId(item.id)))
      const next = String(payload.continuation || '')
      if (!next || seenContinuations.has(next)) break
      seenContinuations.add(next)
      continuation = next
    }
    return result
  }

  async editEntries(ids: string[], operation: EntryStateOperation) {
    if (!ids.length) return
    const token = await this.getEditToken()
    for (let offset = 0; offset < ids.length; offset += 500) {
      const body = new URLSearchParams()
      for (const id of ids.slice(offset, offset + 500)) body.append('i', id)
      if (operation === 'read') body.append('a', READ)
      if (operation === 'unread') body.append('r', READ)
      if (operation === 'star') body.append('a', STARRED)
      if (operation === 'unstar') body.append('r', STARRED)
      body.append('T', token)
      const response = await this.request('/reader/api/0/edit-tag', { method: 'POST', body })
      const text = (await response.text()).trim()
      if (text !== 'OK') throw new Error(`FreshRSS rejected edit operation ${operation}`)
    }
  }

  async addFeed(url: string, title = '', folder = '') {
    const body = new URLSearchParams({ quickadd: url })
    const response = await this.request('/reader/api/0/subscription/quickadd', { method: 'POST', body })
    const payload = await response.json() as { numResults?: number; streamId?: string; streamName?: string; error?: string }
    if (!payload.numResults || !payload.streamId) {
      throw new Error(payload.error || 'FreshRSS rejected the subscription')
    }
    if (title || folder) await this.editFeed(payload.streamId, title || payload.streamName || url, folder, '')
  }

  async editFeed(id: string, title: string, folder: string, currentFolder: string) {
    const token = await this.getEditToken()
    const body = new URLSearchParams({ ac: 'edit', s: id, t: title, T: token })
    if (folder) body.set('a', folderTag(folder))
    else if (currentFolder) body.set('r', folderTag(currentFolder))
    const response = await this.request('/reader/api/0/subscription/edit', { method: 'POST', body })
    if ((await response.text()).trim() !== 'OK') throw new Error('FreshRSS rejected the feed changes')
  }

  async removeFeed(id: string) {
    const token = await this.getEditToken()
    const body = new URLSearchParams({ ac: 'unsubscribe', s: id, T: token })
    const response = await this.request('/reader/api/0/subscription/edit', { method: 'POST', body })
    if ((await response.text()).trim() !== 'OK') throw new Error('FreshRSS rejected the unsubscribe request')
  }
}

export function sortFolders(folders: Folder[], preferredOrder: string[]): Folder[] {
  const positions = new Map(preferredOrder.map((title, index) => [title, index]))
  return folders.sort((a, b) => {
    const aPosition = positions.get(a.title)
    const bPosition = positions.get(b.title)
    if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition
    if (aPosition !== undefined) return -1
    if (bPosition !== undefined) return 1
    return a.title.localeCompare(b.title)
  })
}

function usecToIso(value: string | undefined): string | null {
  const usec = Number(value || 0)
  if (!Number.isFinite(usec) || usec <= 0) return null
  return new Date(Math.floor(usec / 1000)).toISOString()
}

function labelFromId(id: string): string {
  return decodeURIComponent(id.replace(/^user\/[^/]+\/label\//, '').replace(/^user\/-\/label\//, ''))
}

function folderTag(folder: string): string {
  return `user/-/label/${folder.trim()}`
}

export function streamPath(stream: StreamRef): string {
  if (stream.kind === 'all') return 'reading-list'
  if (stream.kind === 'starred') return STARRED
  if (stream.kind === 'category') return `user/-/label/${encodeURIComponent(stream.id.replace(/^user\/-\/label\//, ''))}`
  return `feed/${encodeURIComponent(stream.id.replace(/^feed\//, ''))}`
}

export function canonicalItemId(id: string): string {
  const value = String(id || '')
  if (!/^\d+$/.test(value)) return value
  return `tag:google.com,2005:reader/item/${BigInt(value).toString(16).padStart(16, '0')}`
}

function streamId(stream: StreamRef): string {
  if (stream.kind === 'all') return 'user/-/state/com.google/reading-list'
  if (stream.kind === 'starred') return STARRED
  return stream.id
}

function mapEntry(item: GReaderItem): Entry {
  const rawHtml = item.content?.content || item.summary?.content || ''
  const url = item.canonical?.[0]?.href || item.alternate?.[0]?.href || ''
  const timestamp = item.published
    ? item.published * 1000
    : Number(item.crawlTimeMsec || 0) || Math.floor(Number(item.timestampUsec || 0) / 1000)
  const crawledAt = Number(item.crawlTimeMsec || 0) || Math.floor(Number(item.timestampUsec || 0) / 1000) || timestamp
  const feedTitle = decodeHtmlText(item.origin?.title || '')
  const sanitizedHtml = cleanArticleHtml(rawHtml)
  const contentHtml = normalizeFeedContent({ contentHtml: sanitizedHtml, feedTitle, url, title: decodeHtmlText(item.title || '') })
  const thumbnailUrl = normalizeFeedThumbnail({
    url,
    thumbnailUrl: firstImage(contentHtml) || bestImageEnclosure(item.enclosure || []),
    contentHtml,
    originalContentHtml: sanitizedHtml,
  })
  return {
    id: item.id || '',
    feedId: item.origin?.streamId || '',
    feedTitle,
    feedUrl: item.origin?.htmlUrl || '',
    title: decodeHtmlText(item.title || 'Untitled'),
    author: decodeHtmlText(item.author || ''),
    url,
    contentHtml,
    excerpt: excerpt(contentHtml),
    publishedAt: new Date(timestamp || Date.now()).toISOString(),
    timestamp: timestamp || Date.now(),
    crawledAt: crawledAt || Date.now(),
    read: (item.categories || []).includes(READ),
    starred: (item.categories || []).includes(STARRED),
    readingMinutes: readingMinutes(contentHtml),
    thumbnailUrl,
    kind: detectKind(feedTitle, url, item.origin?.htmlUrl || ''),
  }
}

function bestImageEnclosure(enclosures: Array<{ href?: string; type?: string }>): string {
  const candidates = enclosures
    .filter(value => value.href && (!value.type || value.type.startsWith('image/')) && isLikelyImage(value.href, value.type || ''))
    .map(value => value.href!)
  return candidates.sort((left, right) => imageScore(right) - imageScore(left))[0] || ''
}

function isLikelyImage(url: string, type: string): boolean {
  if (type.startsWith('image/')) return true
  try {
    const parsed = new URL(url)
    return /\.(?:avif|gif|jpe?g|png|webp)(?:$|\?)/i.test(parsed.pathname + parsed.search)
      || /(?:^|\.)images?\./i.test(parsed.hostname)
  } catch { return false }
}

function imageScore(url: string): number {
  let score = 0
  if (/\.(?:avif|jpe?g|png|webp)(?:$|\?)/i.test(url)) score += 20
  if (/-\d{2,4}x\d{2,4}\.(?:avif|jpe?g|png|webp)(?:$|\?)/i.test(url)) score -= 80
  if (/(?:thumbnail|thumb|small|low[_-]?res)/i.test(url)) score -= 40
  return score
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
