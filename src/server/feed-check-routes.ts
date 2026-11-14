import { Router } from 'express'
import type { PaperDatabase } from './db.js'
import type { StandaloneRuntime } from './standalone-runtime.js'
import type { BackendIdentity } from './identity.js'
import type { FeedChecksView } from '../shared/feed-checks.js'
import { OrganizationError } from './organization.js'
import { MANUAL_CHECK_COOLDOWN_MS } from './feed-check-settings.js'

export function feedCheckRouter(database: PaperDatabase, backend: BackendIdentity, runtime?: StandaloneRuntime) {
  const router = Router()
  const snapshot = (): FeedChecksView => {
    if (!runtime) return { backend: 'freshrss', enabled: false, revision: 0, organizationRevision: 0, intervalMinutes: 15, feeds: [], folders: [] }
    const organization = database.organization.snapshot(backend.id)
    const feeds = [...new Map([...organization.navigation.uncategorized, ...organization.navigation.folders.flatMap(folder => folder.feeds)].map(feed => [feed.id, feed])).values()]
    return { backend: 'standalone', enabled: runtime.checksEnabled(), ...database.feedFetch.settings(backend.id),
      organizationRevision: organization.revision,
      folders: organization.navigation.folders.map(({ id, title }) => ({ id, title })),
      feeds: feeds.flatMap(feed => {
        const state = database.feedFetch.get(backend.id, feed.id)
        if (!state) return []
        return [{ feedId: feed.id, lastSuccessAt: state.lastSuccessAt, nextFetchAt: state.nextFetchAt,
          failures: state.failures, lastError: state.lastError, lastStatus: state.lastStatus,
          retryAfterUntil: state.retryAfterUntil, cooldownUntil: state.lastAttemptAt ? state.lastAttemptAt + MANUAL_CHECK_COOLDOWN_MS : 0,
          intervalMinutes: state.intervalMinutes, state: state.leaseUntil > Date.now() ? 'running' : runtime.checkState(feed.id) }]
      }) }
  }
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.get('/', (_request, response) => response.json(snapshot()))
  router.post('/:action', (request, response) => {
    try {
      if (!runtime) { response.status(400).json({ error: 'FreshRSS manages feed checks and intervals.' }); return }
      const results = database.transaction(() => {
        const view = snapshot()
        const body = request.body
        if (!body || !Number.isSafeInteger(body.expectedRevision) || !Number.isSafeInteger(body.expectedOrganizationRevision)) {
          throw new OrganizationError('invalid', 'Reload feed checks before making changes.')
        }
        if (body.expectedRevision !== view.revision || body.expectedOrganizationRevision !== view.organizationRevision) {
          throw new OrganizationError('conflict', 'Subscriptions or check settings changed. Reload before trying again.')
        }
        if (body.feedId !== undefined && (typeof body.feedId !== 'string' || !view.feeds.some(feed => feed.feedId === body.feedId))) {
          throw new OrganizationError('not-found', 'This feed is no longer subscribed.')
        }
        if (request.params.action === 'interval') {
          database.feedFetch.setInterval(backend.id, view.revision, body.intervalMinutes, body.feedId)
          return undefined
        }
        if (request.params.action !== 'now') throw new OrganizationError('invalid', 'Unknown feed check action.')
        if (!view.enabled) throw new OrganizationError('invalid', 'Feed collection is disabled by the server.')
        if (body.feedId !== undefined && body.folderId !== undefined) throw new OrganizationError('invalid', 'Choose one feed or folder.')
        let feedIds: string[]
        if (body.feedId !== undefined) feedIds = [body.feedId]
        else {
          const navigation = database.organization.snapshot(backend.id).navigation
          const folder = navigation.folders.find(folder => folder.id === body.folderId)
          if (body.folderId !== null && !folder) throw new OrganizationError('not-found', 'Choose an existing folder.')
          feedIds = (body.folderId === null ? navigation.uncategorized : folder!.feeds).map(feed => feed.id)
        }
        return runtime.checkNow(feedIds)
      })
      response.json({ ...(results === undefined ? {} : { results }), snapshot: snapshot() })
    } catch (error) {
      if (error instanceof OrganizationError) response.status(error.code === 'conflict' ? 409 : 400).json({ error: error.message, code: error.code })
      else response.status(503).json({ error: 'Could not update feed checks. Reload before retrying.' })
    }
  })
  return router
}
