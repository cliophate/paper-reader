import { api, playback } from './api'
import { articleEditsLocked, clearArticleEdits, lockArticleEdits, overlayQueuedEdits } from './offlineQueue'
import type { Entry, Feed, Folder, NavigationPayload, StreamRef } from './types'

let locked = false
let generation = 0
export function setOfflineLocked(value: boolean) {
  if (value !== locked) generation++
  locked = value
  playback.setLocked(value)
  lockArticleEdits(value)
}
const ARTICLES = 'paper-offline-articles-v1'
const MEDIA = 'paper-offline-media-v1'
const key = (id: string) => new URL(`/_offline/articles/${encodeURIComponent(id)}`, location.origin).href
const json = (entry: Entry) => new Response(JSON.stringify(entry), { headers: { 'Content-Type': 'application/json' } })

function write<T>(run: () => Promise<T>) {
  return navigator.locks ? navigator.locks.request('paper-offline-copies', run) : run()
}

async function copies(cache: Cache): Promise<Entry[]> {
  const requests = await cache.keys()
  const items = await Promise.all(requests.map(async request => (await cache.match(request))?.json() as Promise<Entry | undefined>))
  return items.filter((item): item is Entry => Boolean(item))
}

function imageUrls(entry: Entry) {
  const template = document.createElement('template')
  template.innerHTML = entry.contentHtml
  const enclosures = new Set(entry.enclosures?.map(file => file.url))
  const urls = new Set<string>()
  for (const src of [entry.thumbnailUrl, ...Array.from(template.content.querySelectorAll('img[src]'), img => img.getAttribute('src'))]) {
    if (!src) continue
    try {
      const url = new URL(src, entry.url)
      if (/^https?:$/.test(url.protocol) && !enclosures.has(url.href)) urls.add(url.href)
    } catch { /* Ignore malformed feed URLs. */ }
  }
  return [...urls]
}

function offlineMarkup(entry: Entry) {
  const template = document.createElement('template')
  template.innerHTML = entry.contentHtml
  // Keep one image per picture so the offline reader never picks an unsaved srcset candidate.
  for (const image of template.content.querySelectorAll('img')) {
    const srcset = image.getAttribute('srcset') || image.closest('picture')?.querySelector('source[srcset]')?.getAttribute('srcset')
    const source = image.getAttribute('src') || srcset?.split(',')[0].trim().split(/\s+/)[0]
    if (source) {
      try { image.setAttribute('src', new URL(source, entry.url).href) } catch { /* Keep malformed URLs out of the download. */ }
    }
    image.removeAttribute('srcset')
    image.removeAttribute('sizes')
  }
  for (const source of template.content.querySelectorAll('picture > source')) source.remove()
  return template.innerHTML
}

async function verifyImage(url: string, signal: AbortSignal) {
  if (!navigator.serviceWorker?.controller) return false
  const image = new Image()
  const abort = () => { image.removeAttribute('src') }
  signal.addEventListener('abort', abort, { once: true })
  try {
    image.src = '/_offline/image?' + new URLSearchParams({ url })
    await image.decode()
    return true
  } finally { signal.removeEventListener('abort', abort) }
}

export async function offlineArticles(): Promise<Entry[]> {
  if (articleEditsLocked() || !('caches' in window)) return []
  const started = generation
  const items = await copies(await caches.open(ARTICLES))
  const media = await caches.open(MEDIA)
  const assets = new Set((await media.keys()).map(request => request.url))
  for (const entry of items) {
    const images = imageUrls(entry)
    const cached = images.filter(url => assets.has(url))
    const verified = new Set(entry.offline?.verified)
    entry.offline = { folders: [], ...entry.offline, images: images.length, cached: cached.length, unverified: cached.filter(url => !verified.has(url)).length }
  }
  await overlayQueuedEdits(items)
  return articleEditsLocked() || started !== generation ? [] : items.sort((a, b) => b.timestamp - a.timestamp)
}

export function inOfflineStream(entry: Entry, stream: StreamRef) {
  if (stream.kind === 'starred') return entry.starred
  if (stream.kind === 'feed') return entry.feedId === stream.id
  return stream.kind !== 'category' || entry.offline?.folders.some(folder => folder.id === stream.id)
}

export function offlineNavigation(items: Entry[]): NavigationPayload {
  const feeds = new Map<string, Feed>()
  const folders = new Map<string, Folder>()
  for (const entry of items) {
    let feed = feeds.get(entry.feedId)
    if (!feed) {
      feed = { id: entry.feedId, title: entry.feedTitle, linkNumber: entry.offline?.feedNumber, url: entry.feedUrl, siteUrl: '', iconUrl: '',
        categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }
      feeds.set(feed.id, feed)
    }
    if (!entry.read) feed.unread++
    for (const source of entry.offline?.folders || []) {
      let folder = folders.get(source.id)
      if (!folder) { folder = { ...source, feeds: [], unread: 0 }; folders.set(source.id, folder) }
      if (!feed.categories.includes(source.title)) { feed.categories.push(source.title); folder.feeds.push(feed) }
      if (!entry.read) folder.unread++
    }
  }
  return { unread: items.filter(entry => !entry.read).length, starred: items.filter(entry => entry.starred).length,
    folders: [...folders.values()], uncategorized: [...feeds.values()].filter(feed => !feed.categories.length) }
}

export async function patchOffline(id: string, patch: Partial<Entry>) {
  const started = generation
  if (articleEditsLocked() || !Object.keys(patch).length || !('caches' in window) || !await caches.has(ARTICLES)) return
  await write(async () => {
    const cache = await caches.open(ARTICLES)
    const old = await cache.match(key(id))
    if (!old) return
    const entry = await old.json()
    if (!articleEditsLocked() && started === generation) await cache.put(key(id), json({ ...entry, ...patch }))
  })
}

export const offlineLimitKey = 'paper-offline-limit-mib'
export function offlineLimit() { return Number(localStorage.getItem(offlineLimitKey)) || 0 }
export async function storageUsed(): Promise<number | undefined> { return (await navigator.storage?.estimate?.())?.usage }

async function checkLimit(extra: number) {
  const limit = offlineLimit()
  if (!limit) return
  const used = await storageUsed()
  if (used === undefined) throw new Error('This browser cannot measure storage. Clear the download limit to continue.')
  if (used + extra > limit * 1024 * 1024) throw new DOMException('Download limit reached.', 'QuotaExceededError')
}

export interface DownloadQuery { stream: StreamRef; unread: boolean; query: string; dates?: { after?: string; before?: string } }
export async function* downloadPages(scope: DownloadQuery, signal: AbortSignal) {
  let cursor = ''
  const seen = new Set<string>()
  do {
    signal.throwIfAborted()
    const page = await api.entries(scope.stream, scope.unread, scope.query, cursor, signal, scope.dates)
    yield* page.items
    cursor = page.continuation
    if (cursor && seen.has(cursor)) throw new Error('The server repeated a page. Retry the download.')
    seen.add(cursor)
  } while (cursor)
}

async function prune(media: Cache, articles: Cache, urls: string[]) {
  if (!urls.length) return
  const used = new Set((await copies(articles)).flatMap(imageUrls))
  for (const url of urls) if (!used.has(url)) await media.delete(url)
}

export async function saveOffline(source: Entry, folders: NonNullable<Entry['offline']>['folders'] = [], signal = new AbortController().signal, feedNumber?: number) {
  if (articleEditsLocked() || !('caches' in window)) throw new Error('Offline storage is unavailable.')
  const started = generation
  function check() {
    signal.throwIfAborted()
    if (articleEditsLocked() || generation !== started) throw new Error('Offline download stopped.')
  }
  check()
  let entry = { ...source }
  if (entry.kind === 'article' && !entry.fullText && navigator.onLine) {
    try {
      const article = await api.fullText(entry.url, false, entry.id, signal)
      if (article.contentHtml) entry = { ...entry, contentHtml: article.contentHtml, excerpt: article.excerpt || entry.excerpt,
        author: entry.author || article.byline, readingMinutes: article.readingMinutes, fullText: true }
    } catch { check() } // The feed copy still works when extraction fails.
  }
  return write(async () => {
    check()
    const cache = await caches.open(ARTICLES), media = await caches.open(MEDIA)
    const previous: Entry | undefined = await (await cache.match(key(entry.id)))?.json()
    if (previous?.lastReadAt && previous.lastReadAt > (entry.lastReadAt || '')) {
      entry.lastReadAt = previous.lastReadAt
      entry.readingPosition = previous.readingPosition
    }
    if (previous?.modifiedAtMs !== undefined && entry.modifiedAtMs !== undefined && previous.modifiedAtMs > entry.modifiedAtMs) {
      entry.read = previous.read
      entry.starred = previous.starred
      entry.stateRevision = previous.stateRevision
      entry.modifiedAtMs = previous.modifiedAtMs
    }
    if (previous?.fullText && !entry.fullText) entry = { ...entry, contentHtml: previous.contentHtml, fullText: true, readingMinutes: previous.readingMinutes }
    entry.contentHtml = offlineMarkup(entry)
    if (entry.thumbnailUrl) {
      try { entry.thumbnailUrl = new URL(entry.thumbnailUrl, entry.url).href } catch { entry.thumbnailUrl = '' }
    }
    const urls = imageUrls(entry)
    entry.offline = { folders, feedNumber, images: urls.length, cached: 0 }
    const body = json(entry)
    await checkLimit(new Blob([JSON.stringify(entry)]).size)
    check()
    await cache.put(key(entry.id), body)
    // Commit the readable text first. After a cancellation the library counts
    // the media keys that actually exist, including images shared by two articles.
    if (previous) await prune(media, cache, imageUrls(previous).filter(url => !urls.includes(url)))
    let cached = 0, unverified = 0, skippedForStorage = 0
    const verified: string[] = []
    for (const url of urls) {
      check()
      let response = await media.match(url)
      if (!response) {
        try {
          await checkLimit(0)
          const timeout = AbortSignal.any([signal, AbortSignal.timeout(10000)])
          response = await fetch(url, { credentials: 'omit', mode: 'no-cors', signal: timeout })
          if (response.type !== 'opaque' && (!response.ok || !response.headers.get('content-type')?.startsWith('image/'))) continue
          const size = Number(response.headers.get('content-length')) || 0
          await checkLimit(size)
          check()
          await media.put(url, response)
          if (!size) {
            try { await checkLimit(0) }
            catch (error) {
              await media.delete(url)
              throw error
            }
          }
        } catch (error) {
          check()
          if ((error as Error).name === 'QuotaExceededError') skippedForStorage++
          continue
        }
      }
      try {
        if (await verifyImage(url, signal)) verified.push(url)
        else unverified++
      } catch {
        check()
        await media.delete(url)
        continue
      }
      cached++
    }
    check()
    entry.offline = { folders, feedNumber, images: urls.length, cached, unverified, verified, skippedForStorage }
    await cache.put(key(entry.id), json(entry))
    return { missing: urls.length - cached - skippedForStorage, skippedForStorage, unverified, feedOnly: entry.kind === 'article' && !entry.fullText }
  })
}

export async function removeOffline(id: string) {
  return write(async () => {
    if (articleEditsLocked()) return
    const cache = await caches.open(ARTICLES)
    const entry: Entry | undefined = await (await cache.match(key(id)))?.json()
    if (!entry) return
    await cache.delete(key(id))
    await prune(await caches.open(MEDIA), cache, imageUrls(entry))
  })
}

export async function clearOffline() {
  generation++
  const clearing: Promise<unknown>[] = []
  if (locked) {
    playback.clear()
    clearing.push(clearArticleEdits())
    try { localStorage.removeItem('paper-reading-positions') } catch { /* Storage can be disabled. */ }
  }
  if ('caches' in window) clearing.push(write(() => Promise.all([caches.delete(ARTICLES), caches.delete(MEDIA)])))
  await Promise.all(clearing)
}
