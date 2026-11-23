import { randomUUID } from 'node:crypto'
import { displayFeedUrl } from './feed-url-display.js'
import { subscriptionUrl } from './subscription-url.js'
import { asyncRoute } from './request-work.js'
import { Router, json } from 'express'
import { discoverFeeds, type DiscoveryTransport } from './feed-discovery.js'
import { exportOpml, SubscriptionInputError } from './opml.js'
import { ImportConflictError, SubscriptionImporter, type SubscriptionImportStore } from './subscription-import.js'

// Authentication and same-origin checks belong to the parent application.
export function subscriptionToolsRoutes(store: SubscriptionImportStore, transport: DiscoveryTransport) {
  const router = Router()
  const importer = new SubscriptionImporter(store)
  const privateCandidates = new Map<string, { url: string; expires: number }>()
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.use(json({ limit: '7mb' }))
  router.post('/discover', asyncRoute(async (request, response, next) => {
    try {
      if (typeof request.body?.url !== 'string' || request.body.url.length > 4096) throw new SubscriptionInputError('Enter a complete website or feed URL.')
      const found = await discoverFeeds(request.body.url, transport)
      const now = Date.now()
      for (const [ref, saved] of privateCandidates) if (saved.expires <= now) privateCandidates.delete(ref)
      const candidates = found.candidates.map(feed => {
        const url = displayFeedUrl(feed.url)
        if (url === feed.url) return feed
        // Keep at most eight full discovery pages of private addresses for ten minutes.
        if (privateCandidates.size >= 800) privateCandidates.delete(privateCandidates.keys().next().value!)
        const urlRef = randomUUID()
        privateCandidates.set(urlRef, { url: feed.url, expires: now + 10 * 60_000 })
        return { ...feed, url, urlRef }
      })
      response.json({ ...found, candidates })
    } catch (error) { next(error) }
  }))
  router.post('/preview', asyncRoute(async (request, response, next) => {
    try {
      if (typeof request.body?.xml !== 'string') throw new SubscriptionInputError('Choose or paste an OPML file.')
      response.json(await importer.preview(request.body.xml))
    } catch (error) { next(error) }
  }))
  router.post('/preview-feed', asyncRoute(async (request, response, next) => {
    try {
      let url = typeof request.body?.url === 'string' ? subscriptionUrl(request.body.url) : ''
      if (request.body?.urlRef !== undefined) {
        const saved = privateCandidates.get(request.body.urlRef)
        if (!saved || saved.expires <= Date.now() || displayFeedUrl(saved.url) !== url) throw new SubscriptionInputError('This feed selection expired. Find feeds again.')
        url = saved.url
      }
      if (!url || typeof request.body?.title !== 'string' || request.body.title.length > 240) throw new SubscriptionInputError('Choose a feed with a complete URL and a title of at most 240 characters.')
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      response.json(await importer.preview(`<opml version="2.0"><body><outline type="rss" text="${escape(request.body.title)}" xmlUrl="${escape(url)}"/></body></opml>`))
    } catch (error) { next(error) }
  }))
  router.post('/apply', asyncRoute(async (request, response, next) => {
    try {
      if (typeof request.body?.token !== 'string') throw new SubscriptionInputError('Make an import preview first.')
      response.json(await importer.apply(request.body.token, request.body.choices))
    } catch (error) { next(error) }
  }))
  router.get('/export', asyncRoute(async (_request, response, next) => {
    try {
      const { navigation } = await store.snapshot()
      const exported = exportOpml(navigation, store.backendId)
      response.json(exported)
    } catch (error) { next(error) }
  }))
  router.use((error: unknown, _request: import('express').Request, response: import('express').Response, _next: import('express').NextFunction) => {
    if ((error as { type?: string })?.type === 'entity.too.large') return response.status(413).json({ error: 'The import request is too large.' })
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Send a valid JSON subscription request.' })
    if (error instanceof ImportConflictError) return response.status(409).json({ code: error.code, error: error.message, currentRevision: error.currentRevision })
    if (error instanceof SubscriptionInputError) return response.status(400).json({ error: error.message })
    // Provider/transport exceptions can contain URLs or tokens. Never echo them.
    return response.status(502).json({ error: 'Could not complete the subscription request. Check the URL and connection, then try again.' })
  })
  return router
}
