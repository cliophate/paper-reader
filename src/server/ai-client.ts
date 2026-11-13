export const AI_UNAVAILABLE = 'AI is unavailable. Configure and start the isolated AI worker. See Settings > Reading & connections.'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export function aiExecutionConfigured() {
  return Boolean(process.env.PAPER_AI_WORKER_URL?.trim() && process.env.PAPER_AI_WORKER_SECRET?.trim())
    || (!process.env.PAPER_AI_WORKER_URL?.trim() && process.env.PAPER_AI_LOCAL === 'unsafe')
}

export function warnUnsafeAi() {
  if (!process.env.PAPER_AI_WORKER_URL?.trim() && process.env.PAPER_AI_LOCAL === 'unsafe') {
    console.warn('WARNING: PAPER_AI_LOCAL=unsafe lets model processes read Paper data and secrets. Use only with synthetic development feeds.')
  }
}

export function requireLocalAi() {
  if (process.env.PAPER_AI_WORKER_URL?.trim() || process.env.PAPER_AI_LOCAL !== 'unsafe') throw new Error(AI_UNAVAILABLE)
}

async function request(endpoint: string, body: unknown, signal: AbortSignal) {
  try {
    const url = new URL(process.env.PAPER_AI_WORKER_URL || '')
    const secret = process.env.PAPER_AI_WORKER_SECRET?.trim()
    if (!secret || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
    const response = await fetch(new URL(endpoint, url), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'x-paper-ai-secret': secret },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error()
    }
    return response
  } catch { throw new Error(AI_UNAVAILABLE) }
}

export async function aiAvailability(codexEnabled = true): Promise<{ available: boolean; message: string }> {
  if (process.env.PAPER_AI_WORKER_URL?.trim()) {
    try {
      const response = await request('/health', undefined, AbortSignal.timeout(2000))
      await response.body?.cancel()
      return codexEnabled ? { available: true, message: 'AI worker connected.' }
        : { available: false, message: 'AI is unavailable until Codex and AI features are enabled in Settings.' }
    } catch { return { available: false, message: AI_UNAVAILABLE } }
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

export async function workerBatch(body: unknown, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(305_000)
  try {
    const response = await request('/v1/codex', body, signal ? AbortSignal.any([signal, timeout]) : timeout)
    const payload = JSON.parse(await readResponse(response))
    if (!payload || !Object.hasOwn(payload, 'result')) throw new Error()
    return payload.result
  } catch { throw new Error('AI worker request failed. Check the worker and CLI login, then try again.') }
}

export async function workerChat(model: string, input: unknown, signal: AbortSignal, onText: (text: string) => void): Promise<string> {
  const controller = new AbortController()
  try {
    const response = await request('/v1/discussion', { model, input }, AbortSignal.any([signal, controller.signal, AbortSignal.timeout(125_000)]))
    let text = '', completed = false
    await readResponse(response, line => {
      const event = JSON.parse(line)
      if (completed) throw new Error()
      if (event.type === 'delta' && typeof event.text === 'string') {
        text += event.text
        if (text.length > 24000) throw new Error()
        onText(text)
      } else if (event.type === 'done') completed = true
      else throw new Error()
    })
    if (!completed || !text.trim()) throw new Error()
    return text
  } catch { throw new Error(signal.aborted ? 'Response stopped' : 'AI worker discussion failed. Check the worker and CLI login, then try again.') }
  finally { controller.abort() }
}
