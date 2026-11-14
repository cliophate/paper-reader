import { GreaderAuth } from './greader-auth.js'
import { greaderRoutes } from './greader-routes.js'
import { RetentionService } from './retention.js'
import { retentionRouter } from './retention-routes.js'
import { AuthConnections } from './auth-connections.js'
import { authGate, authRoutes, cookie, trustedProxyHops } from './auth-routes.js'
import { feedCheckRouter } from './feed-check-routes.js'
import { withRequestSignal } from './request-signal.js'
import { AI_UNAVAILABLE, warnUnsafeAi } from './ai-client.js'
import { StateConflictError, UndoExpiredError } from './state-errors.js'
import { organizationRouter } from './organization-routes.js'
import crypto from 'node:crypto'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { BriefingService } from './briefing.js'
import { createAiChatModel, providerConfigured, providerAvailability, runAiBatch, aiEnabled } from './ai-provider.js'
import { testOpenaiConnection } from './openai.js'
import { DiscussionService, discussionSource } from './discussion.js'
import { HeadlineService } from './headlines.js'
import { openRuntimeStorage } from './runtime-storage.js'
import { StandaloneBackend } from './standalone-backend.js'
import { StandaloneRuntime } from './standalone-runtime.js'
import { localImportStore } from './subscription-import-local.js'
import { asyncRoute, drainRequests } from './request-work.js'
import { ConnectionSettings, SettingsValidationError } from './connections.js'
import { KirbyPublisher } from './kirby.js'
import { PaperRepository, switchingEntrySource } from './repository.js'
import { requireAllowedHost, requireSameOrigin } from './request-origin.js'
import { preventFraming } from './response-headers.js'
import { previewFeed } from './feed-repair.js'
import { FeedHttpError } from './feed-http.js'
import { subscriptionToolsRoutes } from './subscription-tools-routes.js'
import { freshRssImportStore } from './subscription-import-freshrss.js'
import { discoveryTransport } from './discovery-transport.js'
import { ReaderService } from './reader.js'
import { fullTextRoute } from './fulltext-route.js'
import { ReadwiseClient } from './readwise.js'
import { SearchService, SearchUnavailableError } from './search-service.js'
import { entryMatchesSearch } from './search.js'
import { BackendSynchronizer } from './sync.js'
import { escapeHtml } from './text.js'
import { TopicService } from './topics.js'
import { PulseService } from './pulse.js'
import { streamXMedia } from './x-media.js'
import { XThreadService } from './x-thread.js'
import { BackendValidationError, type EntryStateOperation } from './backend.js'
import type { Entry } from './types.js'
import type { StreamKind, StreamRef } from './types.js'

const ENTRY_PAGE_SIZE = 80
const SEARCH_SCAN_SIZE = 80
const UNDO_LIFETIME_MS = 20_000

warnUnsafeAi()
const storage = await openRuntimeStorage()
const { config, database, backend } = storage
// Bulk Reader writes run elsewhere. Web requests must fail promptly on contention.
database.greaderDatabase.exec('PRAGMA busy_timeout = 50')
let shuttingDown = false
const eventResponses = new Set<Response>()
const authConnections = new AuthConnections(database.auth)
const connectionSettings = new ConnectionSettings(config)
const connectionListeners = new Set<() => void>()
const discussionEnabled = () => providerConfigured(config) && config.ai.discussionEnabled
logMemory('database ready')
const repository = new PaperRepository(database)
const search = new SearchService(database)
const standalone = backend instanceof StandaloneBackend ? backend : null
const synchronizer = standalone ? new StandaloneRuntime(database, standalone, config.sync.enabled, config.trustedFeedOrigins)
  : new BackendSynchronizer(database, backend, config.sync.enabled, config.sync.minutes)
const readwise = new ReadwiseClient(config.readwise)
const kirby = new KirbyPublisher(config.kirby)
const retention = new RetentionService(database, backend.identity, standalone?.state)
retention.start()
const reader = new ReaderService(database, config.readerFallbackEnabled)
const headlines = new HeadlineService(database, url => reader.fetch(url, 0), (stage, prompt, input, schema) =>
  runAiBatch(config, 'headlines', stage === 'write' ? config.headlines.writerModel : config.headlines.reviewerModel,
    prompt, input, schema, 'medium'), providerConfigured(config) && config.headlines.enabled,
  () => config.ai.provider === 'openai' ? `openai:${config.openai.baseUrl}:${config.openai.headlinesModel}` : `${config.headlines.writerModel}:${config.headlines.reviewerModel}`)
const xThreads = new XThreadService(config.rssHub.baseUrl)
let localReadsActive = Boolean(standalone) || config.sync.localReads && database.getSyncValue('backfill_complete') === 'true'
const entriesSource = switchingEntrySource(() => localReadsActive, repository, backend)
const pulse = new PulseService(database, (prompt, input, schema) => runAiBatch(config, 'grouping', config.collections.model, prompt, input, schema, 'medium'),
  providerConfigured(config) && config.collections.enabled)
const topics = new TopicService(database, entriesSource, () => pulse.list().collections)
const briefings = new BriefingService(config, database, entriesSource, reader, topics)
const app = express()
const discussions = new DiscussionService(database, createAiChatModel(config))
logMemory('services ready')

synchronizer.onSyncCompleted(() => {
  if (shuttingDown) return
  localReadsActive = Boolean(standalone) || config.sync.localReads && database.getSyncValue('backfill_complete') === 'true'
  void headlines.run()
  void pulse.refresh()
  topics.invalidate()
  void topics.refresh().catch(error => console.error('Coverage index refresh failed', error))
})
synchronizer.start()
headlines.start()
logMemory('headlines started')
pulse.start()
logMemory('pulse started')
const memoryTimer = setInterval(() => logMemory('running'), 60_000)
memoryTimer.unref()

app.disable('x-powered-by')
app.set('trust proxy', trustedProxyHops())
app.use(preventFraming)
app.use(requireAllowedHost(config.publicUrl))
app.use((_request, response, next) => {
  if (shuttingDown) return response.status(503).json({ error: 'Paper is shutting down.' })
  next()
})
app.use(requireSameOrigin(config.publicUrl))
app.use(authGate(database.auth, authConnections))
const readerAuth = new GreaderAuth(database.greaderDatabase, database.auth, !!standalone, config.publicUrl)
const greader = greaderRoutes(database, readerAuth, backend.identity.id, standalone?.state, authConnections, discoveryTransport(config.trustedFeedOrigins))
app.use(greader.handler)
app.use('/api/auth', authRoutes(database.auth, config.publicUrl, readerAuth))
app.use('/api/subscription-tools', subscriptionToolsRoutes(standalone ? localImportStore(database, backend.identity.id) : freshRssImportStore(backend, synchronizer), discoveryTransport(config.trustedFeedOrigins)))
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: false }))
app.use('/api/settings/connections', (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  // Body-parser errors can quote submitted JSON. Do not log or return tokens.
  const tooLarge = (error as { status?: number })?.status === 413
  response.status(tooLarge ? 413 : 400).set('Cache-Control', 'no-store').json({ error: tooLarge ? 'Connection settings are too large.' : 'Could not read connection settings. Send valid JSON.' })
})

app.get('/health', (_request, response) => response.json({ status: 'ok' }))

// Article discussion has no subscription, read-state or publishing capabilities.
app.get('/api/discussion', (request, response) => response.json({ discussion: discussions.get(String(request.query.entryId || '')), enabled: discussionEnabled(), provider: connectionSettings.discussionProvider() }))
app.get('/api/discussion/events', (request, response) => {
  if (!authConnections.register(cookie(request), response)) return
  const id = String(request.query.entryId || '')
  response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': database.auth.enabled() ? 'no-store' : 'no-cache', Connection: 'keep-alive' })
  response.flushHeaders()
  eventResponses.add(response)
  response.on('close', () => eventResponses.delete(response))
  const send = (discussion: unknown) => response.write(`data: ${JSON.stringify(discussion)}\n\n`)
  const unsubscribe = discussions.subscribe(id, send)
  send(discussions.get(id))
  const timer = setInterval(() => response.write(': keepalive\n\n'), 15000)
  response.on('close', () => { clearInterval(timer); unsubscribe() })
})
app.post('/api/discussion', asyncRoute(async (request, response) => {
  if (!discussionEnabled()) return response.status(503).json({ error: providerConfigured(config) ? 'Enable article discussions and select an AI provider in Settings.' : AI_UNAVAILABLE })
  const entry = database.localEntry(String(request.body?.entryId || ''))
  if (!entry) return response.status(404).json({ error: 'Article is not available in Paper.' })
  const full = request.body?.fullText === true ? database.getArticleForEntry(entry.id) : null
  if (request.body?.fullText === true && !full) return response.status(409).json({ error: 'Reload the full article before starting its discussion.' })
  try {
    const source = discussionSource(entry.title, entry.author, entry.url, full?.contentHtml || entry.contentHtml, full ? 'fulltext' : 'feed')
    response.json(discussions.create(entry.id, source))
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Could not open discussion' }) }
}))
app.post('/api/discussion/message', (request, response) => {
  if (!discussionEnabled()) return response.status(503).json({ error: providerConfigured(config) ? 'Article discussion is disabled.' : AI_UNAVAILABLE })
  try { response.json(discussions.send(String(request.body?.entryId || ''), String(request.body?.requestId || ''), String(request.body?.question || ''), String(request.body?.quote || ''))) }
  catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Could not send message' }) }
})
app.post('/api/discussion/stop', (request, response) => { discussions.stop(String(request.body?.entryId || '')); response.json({ ok: true }) })
app.delete('/api/discussion', (request, response) => {
  try { discussions.remove(String(request.body?.entryId || '')); response.json({ ok: true }) }
  catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Could not delete discussion' }) }
})

app.get('/api/status', (_request, response) => response.json({
  backend: backend.identity.kind,
  backendInstance: backend.identity.id,
  discussionConfigured: discussionEnabled(),
  rssHubConfigured: Boolean(config.rssHub.baseUrl),
  readwiseConfigured: readwise.configured,
  kirbyConfigured: kirby.configured,
  briefingConfigured: providerConfigured(config) && config.ai.briefingsEnabled,
  localReadsConfigured: config.sync.localReads,
  localReadsActive,
  sync: synchronizer.status(),
  storage: database.storageStatus(),
  muteFilters: database.muteFilters().length,
  openReports: database.openArticleReportCount(),
  headlines: headlines.status(),
}))

app.get('/api/settings/connections', async (_request, response) => {
  response.set('Cache-Control', 'no-store').json({ ...connectionSettings.view(), aiRuntime: await providerAvailability(config) })
})
app.patch('/api/settings/connections', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  try {
    const settings = connectionSettings.update(request.body)
    headlines.setEnabled(providerConfigured(config) && config.headlines.enabled)
    pulse.setEnabled(providerConfigured(config) && config.collections.enabled)
    if (!discussionEnabled()) discussions.stopAll()
    for (const listener of connectionListeners) listener()
    response.json({ ...settings, aiRuntime: await providerAvailability(config) })
  } catch (error) {
    response.status(error instanceof SettingsValidationError ? 400 : 500).json({
      error: error instanceof SettingsValidationError ? error.message : 'Could not save connection settings. Check the data directory permissions.',
    })
  }
})

app.post('/api/settings/connections/test-ai', async (request, response) => {
  response.set('Cache-Control', 'no-store')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  response.once('close', cancel)
  try {
    const result = await testOpenaiConnection(connectionSettings.openaiTestConfig(request.body?.openai ?? {}), controller.signal)
    response.json(result)
  } catch (error) {
    response.json({ available: false, message: error instanceof Error ? error.message : 'AI connection failed.' })
  } finally { response.off('close', cancel) }
})

app.get('/api/events', (request, response) => {
  if (!authConnections.register(cookie(request), response)) return
  response.status(200)
  response.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': database.auth.enabled() ? 'no-store, no-transform' : 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  response.flushHeaders()
  eventResponses.add(response)
  response.on('close', () => eventResponses.delete(response))
  response.write('retry: 3000\n\n')

  const unsubscribe = synchronizer.onSyncCompleted(completedAt => {
    response.write(`event: sync\ndata: ${JSON.stringify({ completedAt })}\n\n`)
  })
  const unsubscribeState = synchronizer.onStateChanged(change => response.write(`event: state\ndata: ${JSON.stringify(change)}\n\n`))
  const unsubscribePulse = pulse.onUpdated(() => { response.write('event: pulse\ndata: {}\n\n') })
  const connectionsChanged = () => response.write('event: connections\ndata: {}\n\n')
  connectionListeners.add(connectionsChanged)
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000)
  keepAlive.unref()
  request.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
    unsubscribePulse()
    connectionListeners.delete(connectionsChanged)
    unsubscribeState()
  })
})

app.use('/api/retention', retentionRouter(retention))
app.use('/api/feed-checks', feedCheckRouter(database, backend.identity, synchronizer instanceof StandaloneRuntime ? synchronizer : undefined))

app.use('/api/organization', organizationRouter({ database, backend, synchronizer, navigation: () => entriesSource.navigation() }))

app.get('/api/navigation', asyncRoute(async (_request, response) => {
  response.json(database.numberNavigation(await entriesSource.navigation()))
}))

app.post('/api/reload', asyncRoute(async (_request, response) => {
  if (!(synchronizer instanceof StandaloneRuntime)) await synchronizer.syncNow('manual')
  response.json({ ok: true, sync: synchronizer.status() })
}))

app.post('/api/sync', asyncRoute(async (_request, response) => {
  await synchronizer.syncNow('manual')
  response.json({ ok: true, sync: synchronizer.status() })
}))

app.get('/api/sync/parity', asyncRoute(async (_request, response) => {
  response.json(await synchronizer.parity())
}))

app.get('/api/sync/history', (request, response) => {
  response.json(database.syncAudit(Number(request.query.limit) || 100))
})

app.get('/api/activity', (request, response) => {
  response.json(database.activity(Number(request.query.limit) || 100))
})

app.get('/api/filters', (_request, response) => {
  response.json(database.muteFilters())
})

app.post('/api/filters', asyncRoute(async (request, response) => {
  const phrase = String(request.body?.phrase || '').trim().slice(0, 240)
  const scope = String(request.body?.scope || 'title')
  const feedId = String(request.body?.feedId || '').trim()
  if (phrase.length < 2) return response.status(400).json({ error: 'Enter at least two characters to mute' })
  if (!['title', 'content', 'any'].includes(scope)) return response.status(400).json({ error: 'Unknown filter scope' })
  try { if (feedId) backend.validateFeedId(feedId, 'filter') }
  catch (error) {
    if (error instanceof BackendValidationError) return response.status(400).json({ error: 'Unknown feed' })
    throw error
  }
  const filter = await database.createMuteFilter(phrase, scope as import('./db.js').MuteFilterScope, feedId)
  response.status(201).json(filter)
}))

app.delete('/api/filters/:id', (request, response) => {
  const id = String(request.params.id)
  const filter = database.muteFilters().find(item => item.id === id)
  if (!filter || !database.deleteMuteFilter(id)) return response.status(404).json({ error: 'Filter not found' })
  database.recordActivity({ kind: 'filter', origin: 'settings', summary: `Removed mute filter "${filter.phrase}"`, count: filter.matchCount, details: { filterId: id } })
  response.json({ ok: true })
})

app.post('/api/filters/preview', asyncRoute(async (request, response) => {
  const phrase = String(request.body?.phrase || '').trim().slice(0, 240)
  const scope = String(request.body?.scope || 'title')
  if (phrase.length < 2 || !['title', 'content', 'any'].includes(scope)) return response.status(400).json({ error: 'Enter a phrase and choose where to match it.' })
  response.json(await database.previewMuteFilter(phrase, scope as 'title' | 'content' | 'any', String(request.body?.feedId || '')))
}))

app.get('/api/reading', (_request, response) => response.json(database.recentReading()))
app.post('/api/reading', (request, response) => {
  const position = Number(request.body?.position)
  if (!Number.isFinite(position) || position < 0 || position > 1) return response.status(400).json({ error: 'Invalid reading position' })
  database.saveReadingProgress(String(request.body?.id || ''), position)
  response.json({ ok: true })
})

app.get('/api/reports', (request, response) => {
  response.json(database.articleReports(Number(request.query.limit) || 100))
})

app.post('/api/reports', asyncRoute(async (request, response) => {
  const entryId = String(request.body?.entryId || '')
  const issue = String(request.body?.issue || 'other')
  const note = String(request.body?.note || '').trim().slice(0, 4000)
  if (!['content', 'media', 'metadata', 'social', 'other'].includes(issue)) return response.status(400).json({ error: 'Choose a report type' })
  const entry = database.localEntry(entryId) || await entriesSource.entry(entryId)
  if (!entry) return response.status(404).json({ error: 'Paper could not find that article' })
  const rawClient = request.body?.client && typeof request.body.client === 'object' ? request.body.client as Record<string, unknown> : {}
  const client = {
    location: String(rawClient.location || '').slice(0, 1000),
    viewport: String(rawClient.viewport || '').slice(0, 80),
    userAgent: String(rawClient.userAgent || '').slice(0, 500),
    theme: String(rawClient.theme || '').slice(0, 80),
    fullText: Boolean(rawClient.fullText),
  }
  const report = database.createArticleReport({ entry, issue: issue as import('./db.js').ArticleReportIssue, note, client })
  database.recordActivity({ kind: 'report', origin: 'reader', summary: `Reported ${entry.feedTitle}: ${entry.title}`, count: 1, details: { reportId: report.id, entryId, issue } })
  response.status(201).json(report)
}))

app.patch('/api/reports/:id', (request, response) => {
  const id = String(request.params.id)
  const status = String(request.body?.status || '')
  if (!['open', 'resolved'].includes(status)) return response.status(400).json({ error: 'Unknown report status' })
  if (!database.setArticleReportStatus(id, status as 'open' | 'resolved')) return response.status(404).json({ error: 'Report not found' })
  response.json({ ok: true })
})

app.get('/api/briefings', (_request, response) => {
  response.json(database.listBriefings().map(briefingSummary))
})

app.get('/api/topics', asyncRoute(async (request, response) => {
  response.json(await topics.list(Number(request.query.hours) || 24))
}))

// Tabs loaded before the collections update use the hours query and old payload.
app.get('/api/pulse', asyncRoute(async (request, response) => {
  response.json(request.query.hours !== undefined ? await topics.list(Number(request.query.hours) || 24) : pulse.list())
}))

app.post('/api/pulse/visit', (request, response) => {
  try { response.json(pulse.visit(String(request.body?.collectionId || ''), Number(request.body?.sequence))) }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Could not save visit' }) }
})

app.post('/api/pulse/feedback', asyncRoute(async (request, response) => {
  const action = String(request.body?.action || '')
  const clusterId = String(request.body?.clusterId || '')
  const entryId = String(request.body?.entryId || '')
  const targetClusterId = String(request.body?.targetClusterId || '')
  if (!['not_same', 'not_useful', 'merge'].includes(action)) return response.status(400).json({ error: 'Unknown Pulse feedback' })
  if (!clusterId) return response.status(400).json({ error: 'Choose a Pulse cluster' })
  try {
    const input = { action: action as import('./db.js').CoverageFeedbackAction, clusterId, entryId, targetClusterId }
    response.status(201).json(clusterId.startsWith('collection-') ? pulse.feedback(input) : await topics.feedback(input))
  }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Could not save correction' }) }
}))

app.delete('/api/pulse/feedback/:id', (request, response) => {
  if (!pulse.removeFeedback(String(request.params.id))) return response.status(404).json({ error: 'Pulse feedback not found' })
  response.json({ ok: true })
})

app.get('/api/briefings/:id', (request, response) => {
  const briefing = database.getBriefing(String(request.params.id))
  if (!briefing) return response.status(404).json({ error: 'Briefing not found' })
  response.json({ ...briefingSummary(briefing), html: briefing.html, text: briefing.text })
})

app.post('/api/briefings/:id/feedback', (request, response) => {
  const id = String(request.params.id)
  if (!database.getBriefing(id)) return response.status(404).json({ error: 'Briefing not found' })
  const feedback = String(request.body?.feedback || '')
  if (!['useful', 'too_broad', 'missed'].includes(feedback)) return response.status(400).json({ error: 'Unknown briefing feedback' })
  database.setBriefingFeedback(id, feedback as import('./db.js').BriefingFeedback)
  response.json({ ok: true, feedback })
})

app.post('/api/streams/order', (request, response) => {
  const input = request.body?.stream
  if (!input || !['all', 'starred', 'feed', 'category'].includes(input.kind) || typeof input.id !== 'string' || !input.id || input.id.length > 512) return response.status(400).json({ error: 'Choose a feed or folder' })
  const order = request.body?.order
  if (!['newest', 'oldest'].includes(order)) return response.status(400).json({ error: 'Unknown article order' })
  if (!localReadsActive) return response.status(409).json({ error: 'Article ordering needs the local Paper index' })
  database.setStreamOrder(parseStreamBody(input), order)
  response.json({ ok: true, order })
})

app.get('/api/entries', asyncRoute(async (request, response) => {
  const stream = parseStream(request)
  const unreadOnly = (stream.kind !== 'starred' || Boolean(request.query.q)) && request.query.unread !== '0'
  const query = String(request.query.q || '').trim().toLowerCase()
  let continuation = String(request.query.continuation || '')
  const reverse = request.query.reverse === '1'
  if (reverse && query) return response.status(400).json({ error: 'Backward paging is only available outside search.' })
  if (!localReadsActive && (request.query.after || request.query.before)) return response.status(409).json({ error: 'Date filters need the local Paper index.' })
  if (localReadsActive) {
    const order = database.streamOrder(stream)
    // Scope continuation tokens to their order, including changes from another device.
    if (continuation) {
      const prefix = `${order}|`
      if (!continuation.startsWith(prefix)) return response.status(409).json({ error: 'Article order changed. Refresh this list to continue.' })
      continuation = continuation.slice(prefix.length)
    }
    const controller = new AbortController()
    const disconnected = () => { if (!response.writableEnded) controller.abort() }
    if (query) {
      response.once('close', disconnected)
      if (response.destroyed) controller.abort()
    }
    try {
      const options = {
        unreadOnly,
        limit: ENTRY_PAGE_SIZE,
        reverse,
        continuation,
        query,
        after: String(request.query.after || ''),
        before: String(request.query.before || ''),
      }
      const page = query ? await search.search(stream, options, controller.signal) : await repository.entriesPage(stream, options)
      if (response.destroyed) return
      if (database.streamOrder(stream) !== order) return response.status(409).json({ error: 'Article order changed. Refresh this list to continue.' })
      const cursor = page.continuation ? `${order}|${page.continuation}` : ''
      const decorated = headlines.page(page)
      return response.json({ ...decorated, order, items: reverse ? decorated.items.reverse() : decorated.items, continuation: reverse ? '' : cursor, previousContinuation: reverse ? cursor : '' })
    } finally { response.removeListener('close', disconnected) }
  }
  if (!query) {
    const page = await backend.entriesPage(stream, { unreadOnly, limit: ENTRY_PAGE_SIZE, continuation, reverse })
    return response.json({ ...headlines.page({ ...page, items: database.numberEntries(reverse ? page.items.reverse() : page.items) }), continuation: reverse ? '' : page.continuation, previousContinuation: reverse ? page.continuation : '' })
  }

  const items: Entry[] = []
  const seenContinuations = new Set<string>()
  for (let pages = 0; pages < 10 && items.length < ENTRY_PAGE_SIZE; pages += 1) {
    const page = await backend.entriesPage(stream, { unreadOnly, limit: SEARCH_SCAN_SIZE, continuation })
    items.push(...page.items.filter(entry => entryMatchesSearch(entry, query)))
    if (!page.continuation || page.continuation === continuation || seenContinuations.has(page.continuation)) {
      continuation = ''
      break
    }
    seenContinuations.add(page.continuation)
    continuation = page.continuation
  }
  response.json(headlines.page({ items: database.numberEntries(items), continuation }))
}))

app.get('/api/entries/number/:number', asyncRoute(async (request, response) => {
  const number = Number(request.params.number)
  if (!/^[1-9][0-9]*$/.test(String(request.params.number)) || !Number.isSafeInteger(number)) return response.status(400).json({ error: 'Invalid article number' })
  const cached = database.entryByNumber(number)
  const entry = cached && (localReadsActive ? cached : await entriesSource.entry(cached.id))
  if (!entry) {
    const removal = standalone && database.retention.removal(number)
    if (removal) return response.status(410).json({ code: 'removed_by_retention', removal,
      error: `This article was removed by your retention settings on ${new Date(removal.removedAt).toISOString().slice(0, 10)}.` })
    return response.status(404).json({ error: 'Article not found' })
  }
  response.json({ entry: headlines.decorate(database.numberEntry(entry)) })
}))

app.post('/api/entries/item', asyncRoute(async (request, response) => {
  const entry = await entriesSource.entry(String(request.body?.id || ''))
  if (!entry) return response.status(404).json({ error: 'Paper could not find this article' })
  response.json({ entry: headlines.decorate(database.numberEntries([entry])[0]) })
}))

app.post('/api/entries/state', asyncRoute(async (request, response) => {
  const ids = stringArray(request.body?.ids)
  if (ids.length > 1000) return response.status(400).json({ error: 'Send at most 1000 article IDs per state request.' })
  const operation = String(request.body?.operation || '')
  if (!['read', 'unread', 'star', 'unstar'].includes(operation)) return response.status(400).json({ error: 'Unknown state operation' })
  const origin = ['reader', 'pulse', 'automatic'].includes(String(request.body?.origin)) ? String(request.body.origin) : 'reader'
  if (standalone) {
    const expectedRevisions = parseRevisions(request.body?.expectedRevisions)
    const undo = request.body?.undo === true ? { token: crypto.randomBytes(24).toString('base64url'), expiresAt: new Date(Date.now() + UNDO_LIFETIME_MS).toISOString() } : undefined
    const change = standalone.state.editEntries(ids, operation as EntryStateOperation, { expectedRevisions, origin, undo })
    return response.json({ ok: true, ...change })
  }
  await synchronizer.editEntries(ids, operation as EntryStateOperation, origin)
  response.json({ ok: true })
}))

const bulkPreviews = new Map<string, { ids: string[]; expires: number; revisions?: Record<string, number> }>()
app.post('/api/streams/preview-read', asyncRoute(async (request, response) => {
  const input = request.body || {}
  const stream = parseStreamBody(input.stream)
  if (!localReadsActive && (input.query || input.after || input.before)) return response.status(409).json({ error: 'Search actions need the local Paper index.' })
  const ids = localReadsActive ? database.matchingEntryIds(stream, { unreadOnly: true, query: String(input.query || ''), after: String(input.after || ''), before: String(input.before || '') }) : await backend.entryIds(stream, true)
  for (const [key, preview] of bulkPreviews) if (preview.expires < Date.now()) bulkPreviews.delete(key)
  const token = crypto.randomUUID()
  bulkPreviews.set(token, { ids, expires: Date.now() + 60000, revisions: standalone ? currentRevisions(ids) : undefined })
  response.json({ token, count: ids.length })
}))
app.post('/api/streams/confirm-read', asyncRoute(async (request, response) => {
  const token = String(request.body?.token || '')
  const preview = bulkPreviews.get(token)
  if (!preview || preview.expires < Date.now()) return response.status(409).json({ error: 'The preview expired. Check the count again.' })
  bulkPreviews.delete(token)
  const ids = localReadsActive && !standalone ? preview.ids.filter(id => database.localEntry(id)?.read === false) : preview.ids
  const result = await markReadWithUndo(ids, preview.revisions)
  response.json(result)
}))

app.post('/api/streams/mark-read', asyncRoute(async (request, response) => {
  const stream = parseStreamBody(request.body)
  const remoteIds = await backend.entryIds(stream, true)
  const localIds = localReadsActive ? database.localEntryIds(stream, true) : []
  const ids = [...new Set([...remoteIds, ...localIds])]
  const result = await markReadWithUndo(ids)
  response.json({ ok: true, ...result })
}))

app.post('/api/streams/mark-relative-read', asyncRoute(async (request, response) => {
  const stream = parseStreamBody(request.body?.stream)
  const anchorId = String(request.body?.anchorId || '')
  const direction = String(request.body?.direction || '')
  const unreadOnly = (stream.kind !== 'starred' || Boolean(request.body?.query)) && request.body?.unreadOnly !== false
  const query = String(request.body?.query || '').trim().toLowerCase()
  if (request.body?.order && request.body.order !== database.streamOrder(stream)) return response.status(409).json({ error: 'Article order changed. Refresh before marking above or below.' })
  if (!anchorId) return response.status(400).json({ error: 'An article is required' })
  if (!['above', 'below'].includes(direction)) return response.status(400).json({ error: 'Unknown relative direction' })

  let ids: string[]
  if (localReadsActive) {
    ids = database.localRelativeUnreadEntryIds(stream, anchorId, direction as 'above' | 'below', { unreadOnly, query, after: String(request.body?.after || ''), before: String(request.body?.before || '') })
  } else {
    if (query) return response.status(409).json({ error: 'Relative read actions need the local Paper index while searching' })
    const [orderedIds, unreadIds] = await Promise.all([
      backend.entryIds(stream, false),
      backend.entryIds(stream, true),
    ])
    const anchorIndex = orderedIds.indexOf(anchorId)
    const candidates = anchorIndex < 0 ? [] : direction === 'above' ? orderedIds.slice(0, anchorIndex) : orderedIds.slice(anchorIndex + 1)
    const unreadSet = new Set(unreadIds)
    ids = candidates.filter(id => unreadSet.has(id))
  }

  const result = await markReadWithUndo(ids)
  response.json({ ok: true, ...result, ids })
}))

app.post('/api/undo', asyncRoute(async (request, response) => {
  const token = String(request.body?.token || '')
  if (standalone) {
    const change = standalone.state.undo(token)
    return response.json({ ok: true, count: change.ids.length, ...change })
  }
  const undo = database.getUndo(token)
  if (!undo) return response.status(410).json({ error: 'That undo has expired' })
  await synchronizer.editEntries(undo.entryIds, undo.operation, 'undo')
  database.deleteUndo(token)
  response.json({ ok: true, count: undo.entryIds.length })
}))

app.post('/api/readwise', asyncRoute(async (request, response) => {
  if (!readwise.configured) return response.status(503).json({ error: 'Readwise is not configured.' })
  const url = String(request.body?.url || '')
  const title = String(request.body?.title || '')
  if (!/^https?:\/\//i.test(url)) return response.status(400).json({ error: 'A valid article URL is required' })
  const result = await readwise.save(url, title)
  database.recordReadwiseSave(url)
  response.json({ ok: true, result, savedAt: new Date().toISOString() })
}))

app.post('/api/notes', asyncRoute(async (request, response) => {
  if (!kirby.configured) return response.status(503).json({ error: 'Kirby note publishing is not configured.' })
  const title = String(request.body?.title || '').trim().slice(0, 240)
  const sourceUrl = String(request.body?.sourceUrl || '').trim()
  const quote = String(request.body?.quote || '').trim().slice(0, 50_000)
  if (!title) return response.status(400).json({ error: 'The source article needs a title' })
  if (!/^https?:\/\//i.test(sourceUrl)) return response.status(400).json({ error: 'The source article needs a valid URL' })
  if (!quote) return response.status(400).json({ error: 'Select some article text first' })
  response.status(201).json({ ok: true, result: await kirby.createNote({ title, sourceUrl, quote }) })
}))

app.post('/api/fulltext', fullTextRoute(reader))

app.post('/api/x/thread', asyncRoute(async (request, response) => {
  if (!config.rssHub.baseUrl) return response.status(503).json({ error: 'X threads need an RSSHub connection.' })
  response.json({ posts: await xThreads.load(String(request.body?.url || '')) })
}))

app.get('/api/x/media', asyncRoute(async (request, response) => {
  if (!authConnections.register(cookie(request), response)) return
  await streamXMedia(String(request.query.url || ''), String(request.header('range') || ''), response)
}))

app.post('/api/feeds/preview', asyncRoute(async (request, response) => {
  response.json(await previewFeed(String(request.body?.url || ''), config.trustedFeedOrigins))
}))
app.post('/api/feeds/repair', asyncRoute(async (request, response) => {
  const id = String(request.body?.id || '')
  backend.validateFeedId(id, 'repair')
  const preview = await previewFeed(String(request.body?.url || ''), config.trustedFeedOrigins)
  await synchronizer.repairFeed(id, preview.url, String(request.body?.expectedUrl || ''))
  response.json({ ok: true })
}))

app.post('/api/feeds', asyncRoute(async (request, response) => {
  const url = String(request.body?.url || '').trim()
  const title = String(request.body?.title || '').trim().slice(0, 240)
  const folder = String(request.body?.folder || '').trim().slice(0, 120)
  if (!/^https?:\/\//i.test(url)) return response.status(400).json({ error: 'Enter a complete feed URL' })
  await synchronizer.addFeed(url, title, folder)
  response.status(201).json({ ok: true })
}))

app.patch('/api/feeds', asyncRoute(async (request, response) => {
  const id = String(request.body?.id || '').trim()
  const title = String(request.body?.title || '').trim().slice(0, 240)
  const folder = String(request.body?.folder || '').trim().slice(0, 120)
  const currentFolder = String(request.body?.currentFolder || '').trim().slice(0, 120)
  backend.validateFeedId(id, 'edit')
  if (!title) return response.status(400).json({ error: 'The feed needs a title' })
  await synchronizer.editFeed(id, title, folder, currentFolder)
  response.json({ ok: true })
}))

app.delete('/api/feeds', asyncRoute(async (request, response) => {
  const id = String(request.body?.id || '').trim()
  backend.validateFeedId(id, 'remove')
  await synchronizer.removeFeed(id)
  response.json({ ok: true })
}))

app.post('/api/internal/briefings/generate', requireInternalSecret, asyncRoute(async (request, response) => {
  if (!providerConfigured(config)) return response.status(503).json({ error: AI_UNAVAILABLE })
  if (!config.ai.briefingsEnabled || !aiEnabled(config)) return response.status(503).json({ error: 'Briefing generation is disabled. Enable it in Settings.' })
  const kind = request.body?.kind === 'evening' ? 'evening' : 'morning'
  const briefing = await withRequestSignal(request, response, signal => briefings.generate(kind, false, signal))
  response.json({
    id: briefing.id,
    subject: briefing.subject,
    html: briefing.html,
    text: briefing.text,
    entryCount: database.entryIdsForBriefing(briefing.id).length,
    cutoff: briefing.cutoff,
  })
}))

app.post('/api/internal/briefings/:id/render', requireInternalSecret, asyncRoute(async (request, response) => {
  const rendered = await briefings.renderExisting(String(request.params.id))
  if (!rendered) return response.status(404).json({ error: 'Briefing not found' })
  response.json({
    id: String(request.params.id),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    entryCount: database.entryIdsForBriefing(String(request.params.id)).length,
  })
}))

app.post('/api/internal/briefings/:id/delivered', requireInternalSecret, asyncRoute(async (request, response) => {
  const briefing = database.getBriefing(String(request.params.id))
  if (!briefing) return response.status(404).json({ error: 'Briefing not found' })
  database.markDelivered(briefing.id)
  response.json({ ok: true })
}))

app.get('/briefings/:id/confirm', (request, response) => {
  const briefing = database.getBriefing(String(request.params.id))
  const token = String(request.query.token || '')
  if (!briefing || !token || !briefings.verifyToken(briefing, token)) return response.status(404).send(messagePage('This link is not valid.', 'Paper could not find this briefing.'))
  const count = database.entryIdsForBriefing(briefing.id).length
  if (briefing.acknowledgedAt) return response.send(messagePage('Already marked read.', `${count} entries from this briefing are read in Paper.`))
  response.send(confirmPage(briefing.id, token, count, briefing.kind))
})

app.post('/briefings/:id/confirm', asyncRoute(async (request, response) => {
  const briefing = database.getBriefing(String(request.params.id))
  const token = String(request.body?.token || '')
  if (!briefing || !token || !briefings.verifyToken(briefing, token)) return response.status(404).send(messagePage('This link is not valid.', 'Paper did not change article state.'))
  if (!briefing.acknowledgedAt) {
    const ids = database.entryIdsForBriefing(briefing.id)
    await synchronizer.editEntries(ids, 'read', 'briefing')
    database.markAcknowledged(briefing.id)
  }
  response.send(messagePage('You are caught up.', 'Paper marked the entries in this briefing as read.'))
}))

const clientPath = path.resolve('dist')
app.use(express.static(clientPath, { index: false, maxAge: '1h' }))
app.use(['/api', '/_offline', '/assets', '/health'], (_request, response) => {
  response.set('Content-Security-Policy', "default-src 'none'").sendStatus(404)
})
app.get('*splat', (_request, response) => response.sendFile('index.html', { root: clientPath }))

app.use((error: Error, request: Request, response: Response, _next: NextFunction) => {
  if (response.destroyed) return
  if ([5, 6].includes((error as Error & { errcode?: number }).errcode || 0)) return response.status(503).set('Retry-After', '1').json({ error: 'The library is busy. Try again.' })
  if (error instanceof SearchUnavailableError) return response.status(503).json({ error: error.message })
  if (error instanceof StateConflictError) return response.status(409).json({ code: 'state-conflict', error: error.message, states: error.states })
  if (error instanceof UndoExpiredError) return response.status(410).json({ error: error.message })
  if (error instanceof BackendValidationError || (error instanceof FeedHttpError && error.code === 'policy')) return response.status(400).json({ error: error.message })
  console.error(`${request.method} ${request.path}`, error)
  response.status(500).json({ error: error.message || 'Paper could not complete the request' })
})

const server = app.listen(config.port, config.host, () => {
  console.log(`Paper is listening on port ${(server.address() as { port: number }).port}`)
  if (!database.auth.enabled()) console.log(`Paper owner setup code, valid for 15 minutes: ${database.auth.setupCode()}`)
  logMemory('listening')
  void database.backfillMuteFilters().catch(error => console.error('Mute filter backfill failed; it will resume after restart.', error))
})

function parseRevisions(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(revision => !Number.isSafeInteger(revision) || Number(revision) < 0)) throw new BackendValidationError('Send valid article revisions.')
  return value as Record<string, number>
}
function currentRevisions(ids: string[]) { return Object.fromEntries(ids.map(id => [id, database.entryState(id)?.revision ?? -1])) }
async function markReadWithUndo(ids: string[], expectedRevisions?: Record<string, number>) {
  const token = crypto.randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + UNDO_LIFETIME_MS).toISOString()
  if (standalone) {
    const change = standalone.state.editEntries(ids, 'read', { origin: 'stream', expectedRevisions, undo: { token, expiresAt } })
    return { count: change.ids.length, undoToken: change.undoToken }
  }
  await synchronizer.editEntries(ids, 'read', 'stream')
  if (ids.length) database.createUndo({ token, operation: 'unread', entryIds: ids, expiresAt })
  return { count: ids.length, undoToken: ids.length ? token : '' }
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await greader.close()
  clearInterval(memoryTimer)
  // Native SQLite can delay both worker termination and process.exit(). At the
  // deadline, OS teardown kills every thread and releases its locks without
  // cleanup. SQLite crash recovery applies on the next open.
  const deadline = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 30_000)
  const stopped = new Promise<void>(resolve => server.close(() => resolve()))
  const searchStopped = search.close()
  for (const response of eventResponses) response.end()
  headlines.setEnabled(false)
  pulse.setEnabled(false)
  discussions.stopAll()
  await retention.stop()
  await synchronizer.stop()
  await stopped
  await drainRequests()
  await Promise.all([headlines.drain(), pulse.drain(), topics.drain(), discussions.drain()])
  await searchStopped
  storage.close()
  clearTimeout(deadline)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void shutdown().catch(() => {
    // Keep the referenced deadline and storage lock alive. process.exit() here
    // could block the main thread while joining a busy native worker.
    console.error('Paper could not finish shutdown; waiting for forced termination.')
    process.exitCode = 1
  })
})

function logMemory(stage: string) {
  const { rss, heapUsed, heapTotal } = process.memoryUsage()
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)
  console.log(`Paper memory ${stage}: rss=${mb(rss)}MB heap=${mb(heapUsed)}/${mb(heapTotal)}MB`)
}

function parseStream(request: Request): StreamRef {
  return parseStreamBody({ kind: request.query.kind, id: request.query.id, title: request.query.title })
}

function parseStreamBody(input: Record<string, unknown> | undefined): StreamRef {
  const kind = String(input?.kind || 'all') as StreamKind
  if (!['all', 'starred', 'category', 'feed'].includes(kind)) throw new BackendValidationError('Unknown stream')
  return { kind, id: String(input?.id || kind), title: String(input?.title || '') }
}

function stringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.map(String).filter(Boolean) : []
}

function briefingSummary(briefing: import('./db.js').BriefingRecord) {
  return {
    id: briefing.id,
    kind: briefing.kind,
    subject: briefing.subject,
    status: briefing.status,
    windowStart: briefing.windowStart,
    cutoff: briefing.cutoff,
    createdAt: briefing.createdAt,
    deliveredAt: briefing.deliveredAt,
    acknowledgedAt: briefing.acknowledgedAt,
    feedback: database.getBriefingFeedback(briefing.id),
    entryCount: database.entryIdsForBriefing(briefing.id).length,
  }
}

function requireInternalSecret(request: Request, response: Response, next: NextFunction) {
  const supplied = String(request.header('x-paper-secret') || '')
  const actual = Buffer.from(supplied)
  const expected = Buffer.from(config.internalSecret)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return response.status(401).json({ error: 'Unauthorized' })
  next()
}


function confirmPage(id: string, token: string, count: number, kind: string): string {
  return pageShell(`
    <p class="eyebrow">Paper ${escapeHtml(kind)} briefing</p>
    <h1>Mark this briefing read?</h1>
    <p>Paper will mark ${count} represented ${count === 1 ? 'entry' : 'entries'} as read. Other unread entries will stay untouched.</p>
    <form method="post" action="/briefings/${escapeHtml(id)}/confirm">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit">Mark ${count} ${count === 1 ? 'entry' : 'entries'} read</button>
    </form>
    <a class="quiet" href="/">Go to Paper</a>
  `)
}

function messagePage(title: string, copy: string): string {
  return pageShell(`<p class="eyebrow">Paper</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(copy)}</p><a class="button" href="/">Open Paper</a>`)
}

function pageShell(content: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paper</title><style>
    *{box-sizing:border-box}body{margin:0;background:#efeee9;color:#171714;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(560px,100%);background:#fbfaf7;border:1px solid #d9d8d2;border-radius:24px;padding:42px;box-shadow:0 20px 60px rgba(30,30,25,.1)}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.14em;font-weight:800;margin:0 0 28px}h1{font-size:36px;line-height:1.05;letter-spacing:-.04em;margin:0 0 16px}p{font-size:17px;line-height:1.55;color:#55544e}button,.button{display:inline-block;border:0;border-radius:9px;background:#171714;color:white;font:700 15px inherit;padding:14px 18px;text-decoration:none;cursor:pointer;margin:16px 0}.quiet{display:block;color:#66655f;margin-top:8px}@media(max-width:600px){.card{padding:30px 24px}h1{font-size:31px}}
  </style></head><body><main class="card">${content}</main></body></html>`
}
