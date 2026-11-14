import { Router } from 'express'
import type { RetentionService } from './retention.js'

export function retentionRouter(service: RetentionService) {
  const router = Router()
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next() })
  router.get('/', (_request, response) => response.json(service.view()))
  router.post('/preview', async (request, response) => {
    try { response.json(await service.preview(request.body?.policy)) }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Could not preview retention.' }) }
  })
  router.post('/', (request, response) => {
    try {
      service.save(request.body?.policy, request.body?.revision, request.body?.token)
      response.json(service.view())
    } catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Could not save retention.' }) }
  })
  return router
}
