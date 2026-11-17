const SHELL = 'paper-shell-v5'
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
    event.respondWith(fetch(request).catch(async () => {
      if (url.pathname === '/subscribe') return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paper · Offline</title><main><h1>You are offline</h1><p>Connect to Paper to discover feeds and subscribe. Your link is still in the address bar.</p><p><a href="">Try again</a></p><a href="/">Open Paper</a></main></html>', {
        status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" },
      })
      return (await (await caches.open(SHELL)).match('/')) || Response.error()
    }))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(SHELL).then(async cache => (await cache.match(request)) || fetch(request)))
  }
})
