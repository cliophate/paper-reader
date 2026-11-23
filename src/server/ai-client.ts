import { tokenUsage, type Admit, type ReportUsage } from './ai-usage.js'
import http from 'node:http'
import { AiLimitError } from './ai-activity.js'
import { Readable } from 'node:stream'
import { AiError, AI_FAILURES, AI_QUEUE_WAIT_MS, type AiFailure } from './ai-errors.js'
export const AI_UNAVAILABLE = 'AI is unavailable. Select and configure an AI provider. See Settings > Reading & connections.'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export function aiExecutionConfigured() {
  return Boolean(process.env.PAPER_AI_WORKER_SOCKET?.trim() && process.env.PAPER_AI_WORKER_SECRET?.trim())
    || (!process.env.PAPER_AI_WORKER_SOCKET?.trim() && !process.env.PAPER_AI_WORKER_URL?.trim() && process.env.PAPER_AI_LOCAL === 'unsafe')
}

export function warnUnsafeAi() {
  if (!process.env.PAPER_AI_WORKER_SOCKET?.trim() && !process.env.PAPER_AI_WORKER_URL?.trim() && process.env.PAPER_AI_LOCAL === 'unsafe') {
    console.warn('WARNING: PAPER_AI_LOCAL=unsafe lets model processes read Paper data and secrets. Use only with synthetic development feeds.')
  }
}

export function requireLocalAi() {
  if (process.env.PAPER_AI_WORKER_SOCKET?.trim() || process.env.PAPER_AI_WORKER_URL?.trim() || process.env.PAPER_AI_LOCAL !== 'unsafe') throw new Error(AI_UNAVAILABLE)
}

function remoteFailure(payload: unknown, requestId: string | null) {
  const category = payload && typeof payload === 'object' && 'category' in payload && AI_FAILURES.includes(payload.category as AiFailure)
    ? payload.category as AiFailure : 'unknown'
  const id = requestId && /^[a-f0-9-]{36}$/.test(requestId) ? requestId : null
  console.error(JSON.stringify({ event: 'ai_request_failed', requestId: id, category }))
  return new AiError(category)
}

async function request(endpoint: string, body: unknown, signal: AbortSignal, slot?: string, method = body === undefined ? 'GET' : 'POST') {
  try {
    const socketPath = process.env.PAPER_AI_WORKER_SOCKET?.trim()
    const secret = process.env.PAPER_AI_WORKER_SECRET?.trim()
    if (!socketPath?.startsWith('/') || !secret) throw new Error()
    const response = await new Promise<Response>((resolve, reject) => {
      const call = http.request({ socketPath, path: endpoint, method, signal,
        headers: { 'Content-Type': 'application/json', 'x-paper-ai-secret': secret, ...(slot ? { 'x-paper-ai-slot': slot } : {}) },
      }, incoming => {
        const headers = new Headers()
        for (const name of ['content-type', 'x-paper-ai-request-id']) {
          const value = incoming.headers[name]
          if (typeof value === 'string') headers.set(name, value)
        }
        if (incoming.statusCode === 204) incoming.resume()
        try { resolve(new Response(incoming.statusCode === 204 ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers })) }
        catch { incoming.destroy(); reject(new AiError('schema')) }
      })
      call.once('error', reject)
      call.end(body === undefined ? undefined : JSON.stringify(body))
    })
    if (!response.ok) {
      const payload = JSON.parse(await readResponse(response))
      throw remoteFailure(payload, response.headers.get('x-paper-ai-request-id'))
    }
    return response
  } catch (error) {
    if (error instanceof AiError) throw error
    throw new Error(AI_UNAVAILABLE)
  }
}

export async function aiAvailability(codexEnabled = true): Promise<{ available: boolean; message: string }> {
  if (process.env.PAPER_AI_WORKER_SOCKET?.trim()) {
    try {
      const response = await request('/health', undefined, AbortSignal.timeout(2000))
      await response.body?.cancel()
      return codexEnabled ? { available: true, message: 'AI worker connected.' }
        : { available: false, message: 'AI is unavailable until Codex and AI features are enabled in Settings.' }
    } catch (error) { return { available: false, message: error instanceof AiError ? error.message : AI_UNAVAILABLE } }
  }
  if (aiExecutionConfigured() && !codexEnabled) return { available: false, message: 'AI is unavailable until Codex and AI features are enabled in Settings.' }
  return aiExecutionConfigured()
    ? { available: true, message: 'Unsafe local AI is enabled. Model processes can read Paper data and secrets.' }
    : { available: false, message: AI_UNAVAILABLE }
}

async function readResponse(response: Response, onLine?: (line: string) => void) {
  if (!response.body) throw new Error('AI worker returned an empty response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('AI worker response exceeded the size limit')
      buffer += decoder.decode(value, { stream: true })
      if (onLine) {
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          onLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
        }
      }
    }
    buffer += decoder.decode()
    if (onLine && buffer) throw new Error('AI worker returned an incomplete response')
    return buffer
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function workerBatch(body: unknown, signal?: AbortSignal, report?: ReportUsage, admit?: Admit): Promise<unknown> {
  const timeout = AbortSignal.timeout(AI_QUEUE_WAIT_MS + 320_000)
  try {
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    let slot: string | undefined
    if (admit) {
      const reservation = await request('/v1/slot', undefined, deadline)
      const { token } = JSON.parse(await readResponse(reservation))
      if (typeof token !== 'string' || !token) throw new AiError('schema')
      slot = token
      try {
        await admit(deadline, async () => { await request('/v1/slot', undefined, deadline, token, 'PUT') })
        deadline.throwIfAborted()
      }
      catch (error) {
        await request('/v1/slot', undefined, AbortSignal.timeout(1000), slot, 'DELETE').catch(() => {})
        throw error
      }
    }
    const response = await request('/v1/codex', body, deadline, slot)
    const payload = JSON.parse(await readResponse(response))
    if (!payload || !Object.hasOwn(payload, 'result')) throw new Error()
    const usage = tokenUsage(payload.usage?.input, payload.usage?.output, payload.usage?.total)
    if (usage) report?.(usage)
    return payload.result
  } catch (error) {
    if (signal?.aborted) throw new AiError('cancelled')
    if (error instanceof AiLimitError || error instanceof AiError || (error instanceof Error && error.message === AI_UNAVAILABLE)) throw error
    throw new AiError('schema')
  }
}

export async function workerChat(model: string, input: unknown, signal: AbortSignal, onText: (text: string) => void, report?: ReportUsage): Promise<string> {
  const controller = new AbortController()
  try {
    const response = await request('/v1/discussion', { model, input }, AbortSignal.any([signal, controller.signal, AbortSignal.timeout(AI_QUEUE_WAIT_MS + 140_000)]))
    let text = '', completed = false
    await readResponse(response, line => {
      const event = JSON.parse(line)
      if (completed) throw new Error()
      if (event.type === 'delta' && typeof event.text === 'string') {
        text += event.text
        if (text.length > 24000) throw new Error()
        onText(text)
      } else if (event.type === 'error') throw remoteFailure(event, response.headers.get('x-paper-ai-request-id'))
      else if (event.type === 'done') {
        completed = true
        const usage = tokenUsage(event.usage?.input, event.usage?.output, event.usage?.total)
        if (usage) report?.(usage)
      }
      else throw new Error()
    })
    if (!completed || !text.trim()) throw new Error()
    return text
  } catch (error) {
    if (signal.aborted) throw new AiError('cancelled')
    if (error instanceof AiError || (error instanceof Error && error.message === AI_UNAVAILABLE)) throw error
    throw new AiError('schema')
  }
  finally { controller.abort() }
}
