import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { cookie } from './auth-routes.js'
import type { ReaderBackend } from './backend.js'
import type { Config } from './config.js'
import type { PaperDatabase } from './db.js'
import { parseSource, savedSource, saveSource, SourceError } from './reader-source.js'
import { probeSource } from './source-probe.js'
import { withRequestSignal } from './request-signal.js'
import { StandaloneBackend } from './standalone-backend.js'

export function mountSourceRoutes(app: Express, config: Config, database: PaperDatabase, finish?: (backend?: ReaderBackend) => Promise<void>) {
  const router = express.Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(express.json({ limit: '16kb' }))
  router.post('/test', async (req, res) => {
    const source = finish ? parseSource(req.body) : parseSource({ backend: config.backend, ...(config.backend === 'freshrss' ? config.freshRss : config.miniflux) })
    if (source.backend === 'standalone') throw new SourceError('Standalone mode has no remote connection.')
    const trusted = finish || config.sourceFromBrowser ? config.trustedFeedOrigins : [new URL(source.baseUrl).origin]
    const remote = await withRequestSignal(req, res, signal => probeSource(source, trusted, signal))
    const active = database.getSyncValue('active_backend_id')
    if (active && active !== remote.identity.id) throw new SourceError('This data directory belongs to another account or server.', 409)
    res.json({ ok: true })
  })
  router.post('/', async (req, res) => {
    if (!finish) return res.status(409).json({ code: 'source-configured', error: 'A feed source is already configured.' })
    if (savedSource(config.stateDir)) {
      await finish()
      return res.json({ ok: true })
    }
    const source = parseSource(req.body)
    if (source.backend === 'standalone' && !config.sync.localReads) throw new SourceError('Standalone mode requires PAPER_LOCAL_READS=true.')
    const revision = database.auth.revision()
    const remote = source.backend === 'standalone' ? null
      : await withRequestSignal(req, res, signal => probeSource(source, config.trustedFeedOrigins, signal))
    if (res.destroyed) return
    const backend = database.transaction(() => {
      if (savedSource(config.stateDir)) return undefined
      if (database.auth.revision() !== revision || (database.auth.enabled() && !database.auth.session(cookie(req)))) {
        throw new SourceError('Access changed. Reload Paper and try again.', 403)
      }
      let selected: ReaderBackend
      try {
        selected = remote ?? new StandaloneBackend(database)
        database.bindBackend(selected.identity)
      } catch { throw new SourceError('This data directory belongs to another source. Use its original account or a new data directory.', 409) }
      saveSource(config.stateDir, source)
      return selected
    })
    await finish(backend)
    res.json({ ok: true })
  })
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.destroyed) return
    if (error instanceof SourceError) return res.status(error.status).json({ error: error.message })
    const status = (error as { status?: number })?.status
    if (status === 400 || status === 413) return res.status(status).json({ error: 'Send valid connection settings under 16 KB.' })
    res.status(500).json({ error: 'Paper could not complete the connection request. Check the data directory and try again.' })
  })
  app.use('/api/settings/source', router)
}
