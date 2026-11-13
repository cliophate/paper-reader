const SHELL = 'paper-shell-v3'
const MEDIA = 'paper-offline-media-v1'
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const assets = await fetch('/offline-assets.json').then(response => { if (!response.ok) throw new Error('Offline manifest unavailable'); return response.json() })
    const cache = await caches.open(SHELL)
    await cache.addAll(['/', '/manifest.webmanifest', '/favicon.svg', '/brand/paper-logo.svg', '/brand/paper-logo-light.svg', ...assets])
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith('paper-shell-') && key !== SHELL).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})
self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || /^\/(?:api|_offline|health)(?:\/|$)/.test(url.pathname)) return
  if (request.destination === 'image') {
    event.respondWith(caches.open(MEDIA).then(cache => cache.match(request)).then(cached => cached || fetch(request)))
    return
  }
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    if (/^\/assets(?:\/|$)/.test(url.pathname)) return
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(SHELL)).match('/')) || Response.error()))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(SHELL).then(async cache => (await cache.match(request)) || fetch(request)))
  }
})
