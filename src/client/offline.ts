import type { Entry } from './types'
let locked = false
let generation = 0
export function setOfflineLocked(value: boolean) { if (value !== locked) generation++; locked = value }
const ARTICLES = 'paper-offline-articles-v1'
const MEDIA = 'paper-offline-media-v1'
const key = (id: string) => new URL(`/_offline/articles/${encodeURIComponent(id)}`, location.origin).href
export async function offlineArticles(): Promise<Entry[]> {
  if (locked || !('caches' in window)) return []
  const started = generation
  const cache = await caches.open(ARTICLES)
  const items = await Promise.all((await cache.keys()).map(async request => (await cache.match(request))!.json() as Promise<Entry>))
  return locked || started !== generation ? [] : items
}
export async function saveOffline(entry: Entry) {
  if (locked) throw new Error('Sign in before saving offline articles.')
  const started = generation
  if (!('caches' in window)) throw new Error('Offline storage is not available in this browser.')
  const cache = await caches.open(ARTICLES)
  if (locked || started !== generation) return
  await cache.put(key(entry.id), new Response(JSON.stringify(entry), { headers: { 'Content-Type': 'application/json' } }))
  if (locked || started !== generation) { await clearOffline(); return }
  const document = new DOMParser().parseFromString(entry.contentHtml, 'text/html')
  const images = [...new Set([entry.thumbnailUrl, ...[...document.querySelectorAll('img')].map(img => img.getAttribute('src') || '')])].filter(Boolean).slice(0, 30)
  const media = await caches.open(MEDIA)
  await Promise.allSettled(images.map(async source => {
    const url = new URL(source, entry.url)
    if (!['https:', 'http:'].includes(url.protocol)) return
    const request = new Request(url, { mode: 'no-cors', credentials: 'omit' })
    const response = await fetch(request, { signal: AbortSignal.timeout(10000) })
    if (!locked && started === generation && (response.ok || response.type === 'opaque')) await media.put(request, response)
  }))
  if (locked || started !== generation) await clearOffline()
}
export async function removeOffline(id: string) { return (await caches.open(ARTICLES)).delete(key(id)) }
export async function clearOffline() { if (!('caches' in window)) return; await Promise.all([caches.delete(ARTICLES), caches.delete(MEDIA)]) }
