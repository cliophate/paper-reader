import type { ReaderService } from './reader.js'
import { asyncRoute } from './request-work.js'

const MAX_ACTIVE_EXTRACTIONS = 4

export function fullTextRoute(reader: Pick<ReaderService, 'fetch'>) {
  let active = 0
  return asyncRoute(async (request, response) => {
    if (active >= MAX_ACTIVE_EXTRACTIONS) return response.status(503).json({ error: 'Paper is fetching too many full articles. Try again shortly.' })
    active++
    const controller = new AbortController()
    const disconnected = () => { if (!response.writableEnded) controller.abort() }
    response.once('close', disconnected)
    if (response.destroyed) controller.abort()
    try {
      const { entryId, preview } = request.body || {}
      if (entryId !== undefined && typeof entryId !== 'string' || preview !== undefined && (!preview || typeof preview.feedId !== 'string')) {
        return response.status(400).json({ error: 'Choose an article from this feed.' })
      }
      const article = await reader.fetch(String(request.body?.url || ''), request.body?.refresh === true ? 0 : undefined, controller.signal, entryId, preview)
      if (!response.destroyed) response.json(article)
    } finally {
      response.removeListener('close', disconnected)
      active--
    }
  })
}
