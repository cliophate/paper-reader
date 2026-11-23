import { Router, type Response } from 'express'
import { SettingsValidationError } from './connections.js'
import type { Webhooks } from './webhooks.js'

export function webhookRoutes(hooks: Webhooks, changed: () => void) {
  const router = Router()
  function respond(res: Response, action: () => unknown) {
    res.set('Cache-Control', 'no-store')
    try { res.json(action() ?? { ok: true }) }
    catch (error) {
      const invalid = error instanceof SettingsValidationError
      res.status(invalid ? 400 : 500).json({ error: invalid ? error.message : 'Could not update webhook settings.' })
    }
  }
  router.get('/', (_req, res) => respond(res, () => ({ targets: hooks.store.targets(), deliveries: hooks.store.history() })))
  router.post('/', (req, res) => respond(res, () => {
    const result = hooks.create(req.body)
    changed()
    return result
  }))
  router.patch('/:id', (req, res) => respond(res, () => { hooks.update(req.params.id, req.body); changed() }))
  router.delete('/:id', (req, res) => respond(res, () => { hooks.remove(req.params.id); changed() }))
  router.post('/:id/rotate', (req, res) => respond(res, () => hooks.rotate(req.params.id)))
  router.post('/:id/test', (req, res) => respond(res, () => hooks.test(req.params.id)))
  router.post('/deliveries/:id/retry', (req, res) => respond(res, () => {
    if (!hooks.store.retry(req.params.id)) throw new SettingsValidationError('Only a failed delivery or a scheduled retry can be retried.')
  }))
  return router
}
