import crypto from 'node:crypto'
import http from 'node:http'
import express, { type ErrorRequestHandler } from 'express'
import { runLocalCodex } from './codex.js'
import { createLocalChatModel } from './chat-model.js'

export interface WorkerOptions {
  secret: string
  codexBin: string
  concurrency?: number
}

export function createAiWorker(options: WorkerOptions) {
  if (options.secret.length < 32) throw new Error('PAPER_AI_WORKER_SECRET must contain at least 32 characters')
  const expected = crypto.createHash('sha256').update(options.secret).digest()
  const app = express()
  app.disable('x-powered-by')
  let active = 0
  const controllers = new Set<AbortController>()
  app.use((request, response, next) => {
    response.set('Cache-Control', 'no-store')
    const supplied = request.get('x-paper-ai-secret') || ''
    if (!crypto.timingSafeEqual(expected, crypto.createHash('sha256').update(supplied).digest())) {
      response.status(401).json({ error: 'Unauthorized' }); return
    }
    if (request.method === 'GET' && request.path === '/health') { response.json({ status: 'ok' }); return }
    if (request.method !== 'POST' || !['/v1/codex', '/v1/discussion'].includes(request.path)) {
      response.status(404).json({ error: 'Unknown worker endpoint' }); return
    }
    if (active >= (options.concurrency ?? 2)) { response.status(429).json({ error: 'AI worker is busy. Try again.' }); return }
    active++
    const bodyTimer = setTimeout(() => { response.status(408).json({ error: 'Request body timed out' }); request.destroy() }, 15_000)
    request.once('end', () => clearTimeout(bodyTimer))
    response.once('close', () => { clearTimeout(bodyTimer); active-- })
    next()
  })
  app.use(express.json({ limit: '2mb', strict: true }))
  app.post(['/v1/codex', '/v1/discussion'], async (request, response) => {
    const body = request.body
    const discussion = request.path === '/v1/discussion'
    if (!body || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200
      || !Object.hasOwn(body, 'input') || (!discussion && (typeof body.instruction !== 'string' || body.instruction.length > 100_000))
      || (request.path === '/v1/codex' && (!body.schema || typeof body.schema !== 'object' || Array.isArray(body.schema)))
      || (body.reasoningEffort !== undefined && !['low', 'medium'].includes(body.reasoningEffort))
      || Object.keys(body).some(key => !['model', 'instruction', 'input', 'schema', 'reasoningEffort'].includes(key))) {
      response.status(400).json({ error: 'Invalid model request' }); return
    }
    const controller = new AbortController()
    controllers.add(controller)
    const cancel = () => controller.abort()
    response.once('close', cancel)
    try {
      if (discussion) {
        response.set({ 'Content-Type': 'application/x-ndjson', 'X-Content-Type-Options': 'nosniff' })
        response.flushHeaders()
        let previous = ''
        await createLocalChatModel(options.codexBin, body.model)(body.input, controller.signal, text => {
          const delta = text.slice(previous.length)
          previous = text
          if (!response.write(JSON.stringify({ type: 'delta', text: delta }) + '\n') && response.writableLength > 256_000) controller.abort()
        })
        response.end(JSON.stringify({ type: 'done' }) + '\n')
      } else {
        const result = await runLocalCodex({ enabled: true, bin: options.codexBin }, body.model, body.instruction, body.input, body.schema, body.reasoningEffort, controller.signal)
        response.json({ result })
      }
    } catch {
      if (!response.destroyed) {
        const error = { error: 'Model request failed. Check the worker CLI login and model access.' }
        if (response.headersSent) response.end(JSON.stringify({ type: 'error', ...error }) + '\n')
        else response.status(502).json(error)
      }
    } finally {
      controller.abort()
      controllers.delete(controller)
      response.off('close', cancel)
    }
  })
  app.use(((error, _request, response, _next) => {
    if (response.headersSent || response.destroyed) return
    const tooLarge = error?.status === 413
    response.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Model request exceeded the size limit' : 'Invalid JSON request' })
  }) as ErrorRequestHandler)
  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, app)
  server.maxConnections = 64
  return { server, stop: () => { for (const controller of controllers) controller.abort(); server.close(); server.closeAllConnections() } }
}
