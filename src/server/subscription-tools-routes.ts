import { Router } from 'express'
import { discoverFeeds, type DiscoveryTransport } from './feed-discovery.js'
import { exportOpml, portableUrl, SubscriptionInputError } from './opml.js'
import { ImportConflictError, SubscriptionImporter, type SubscriptionImportStore } from './subscription-import.js'

// Authentication and same-origin checks belong to the parent application.
export function subscriptionToolsRoutes(store: SubscriptionImportStore, transport: DiscoveryTransport) {
  const router = Router()
  const importer = new SubscriptionImporter(store)
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.post('/discover', async (request, response, next) => {
    try {
      if (typeof request.body?.url !== 'string' || request.body.url.length > 4096) throw new SubscriptionInputError('Enter a complete website or feed URL.')
      response.json(await discoverFeeds(request.body.url, transport))
    } catch (error) { next(error) }
  })
  router.post('/preview', async (request, response, next) => {
    try {
      if (typeof request.body?.xml !== 'string') throw new SubscriptionInputError('Choose or paste an OPML file.')
      response.json(await importer.preview(request.body.xml))
    } catch (error) { next(error) }
  })
  router.post('/preview-feed', async (request, response, next) => {
    try {
      if (typeof request.body?.url !== 'string' || !portableUrl(request.body.url) || request.body.url.length > 4096 || typeof request.body?.title !== 'string' || request.body.title.length > 240) throw new SubscriptionInputError('Choose a feed with a complete URL and a title of at most 240 characters.')
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
      response.json(await importer.preview(`<opml version="2.0"><body><outline type="rss" text="${escape(request.body.title)}" xmlUrl="${escape(request.body.url)}"/></body></opml>`))
    } catch (error) { next(error) }
  })
  router.post('/apply', async (request, response, next) => {
    try {
      if (typeof request.body?.token !== 'string') throw new SubscriptionInputError('Make an import preview first.')
      response.json(await importer.apply(request.body.token, request.body.choices))
    } catch (error) { next(error) }
  })
  router.get('/export', async (_request, response, next) => {
    try {
      const { navigation } = await store.snapshot()
      const exported = exportOpml(navigation, store.backendId)
      response.json(exported)
    } catch (error) { next(error) }
  })
  router.use((error: unknown, _request: import('express').Request, response: import('express').Response, _next: import('express').NextFunction) => {
    if (error instanceof ImportConflictError) return response.status(409).json({ code: error.code, error: error.message, currentRevision: error.currentRevision })
    if (error instanceof SubscriptionInputError) return response.status(400).json({ error: error.message })
    // Provider/transport exceptions can contain URLs or tokens. Never echo them.
    return response.status(502).json({ error: 'Could not complete the subscription request. Check the URL and connection, then try again.' })
  })
  return router
}
