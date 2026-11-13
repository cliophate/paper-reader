import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import { AiError } from './ai-errors.js'
import { AiQueue } from './ai-queue.js'
import { runModelProcess } from './model-process.js'
import express, { type ErrorRequestHandler } from 'express'
import { runLocalCodex } from './codex.js'
import { createLocalChatModel } from './chat-model.js'

export interface WorkerOptions {
  secret: string
  codexBin: string
  concurrency?: number
  queueCapacity?: number
  queueWaitMs?: number
}

export function createAiWorker(options: WorkerOptions) {
  if (options.secret.length < 32) throw new Error('PAPER_AI_WORKER_SECRET must contain at least 32 characters')
  const expected = crypto.createHash('sha256').update(options.secret).digest()
  const app = express()
  app.disable('x-powered-by')
  const queue = new AiQueue(options.concurrency, options.queueCapacity, options.queueWaitMs)
  const ready = runModelProcess(options.codexBin, ['--version'], os.tmpdir(), 5000).then(() => true, () => false)
  const controllers = new Set<AbortController>()
  app.use(async (request, response, next) => {
    response.set('Cache-Control', 'no-store')
    const supplied = request.get('x-paper-ai-secret') || ''
    if (!crypto.timingSafeEqual(expected, crypto.createHash('sha256').update(supplied).digest())) {
      response.status(401).json({ error: 'Unauthorized' }); return
    }
    if (request.method === 'GET' && request.path === '/health') {
      if (await ready) response.json({ status: 'ok', cli: 'ready' })
      else response.status(503).json({ status: 'error', cli: 'unavailable', category: 'spawn' })
      return
    }
    if (request.method !== 'POST' || !['/v1/codex', '/v1/discussion'].includes(request.path)) {
      response.status(404).json({ error: 'Unknown worker endpoint' }); return
    }
    const bodyTimer = setTimeout(() => { response.status(408).json({ error: 'Request body timed out' }); request.destroy() }, 15_000)
    request.once('end', () => clearTimeout(bodyTimer))
    response.once('close', () => clearTimeout(bodyTimer))
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
    const requestId = crypto.randomUUID()
    response.set('x-paper-ai-request-id', requestId)
    const queuedAt = performance.now()
    let startedAt: number | undefined
    let release: (() => void) | undefined
    const controller = new AbortController()
    controllers.add(controller)
    const cancel = () => controller.abort()
    response.once('close', cancel)
    try {
      if (response.destroyed) controller.abort()
      release = await queue.acquire(controller.signal)
      if (controller.signal.aborted) throw new AiError('cancelled')
      startedAt = performance.now()
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
    } catch (error) {
      const failure = error instanceof AiError ? error : new AiError('unknown')
      const now = performance.now()
      console.error(JSON.stringify({ event: 'ai_worker_failed', requestId, endpoint: request.path,
        queueWaitMs: Math.round((startedAt ?? now) - queuedAt), runDurationMs: startedAt === undefined ? 0 : Math.round(now - startedAt),
        exitCode: failure.exitCode, signal: failure.signal, category: failure.category }))
      if (!response.destroyed) {
        const payload = { category: failure.category, requestId }
        if (response.headersSent) response.end(JSON.stringify({ type: 'error', ...payload }) + '\n')
        else {
          if (failure.category === 'busy') response.set('Retry-After', '5')
          response.status(failure.category === 'busy' ? 503 : 502).json(payload)
        }
      }
    } finally {
      release?.()
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
