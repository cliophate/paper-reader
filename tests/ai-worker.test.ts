import fs from 'node:fs/promises'
import http from 'node:http'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runModelProcess } from '../src/server/model-process.js'
import { createAiWorker, type WorkerOptions } from '../src/server/ai-worker-server.js'
import { listenAiSocket } from '../src/server/ai-socket.js'
import { classifyModelFailure } from '../src/server/ai-errors.js'
import { aiAvailability, aiExecutionConfigured, workerBatch, workerChat } from '../src/server/ai-client.js'
import { runCodex } from '../src/server/codex.js'
import { createChatModel } from '../src/server/chat-model.js'

const secret = 'synthetic-worker-secret-at-least-32-characters'
const body = { model: 'fixture', instruction: 'Return JSON.', input: 'private article', schema: { type: 'object' }, reasoningEffort: 'low' }
let directory: string, bin: string, socketPath: string, sequence: number
let worker: ReturnType<typeof createAiWorker>
let logs: ReturnType<typeof vi.spyOn>
const config = () => ({ enabled: true, bin, configDir: directory, discussionModel: 'fixture', shortlistModel: 'fixture', editorModel: 'fixture' })
async function start(options: Partial<WorkerOptions> = {}) {
  worker?.stop()
  socketPath = path.join(directory, `worker-${sequence++}.sock`)
  worker = createAiWorker({ secret, codexBin: bin, ...options })
  await listenAiSocket(worker.server, socketPath)
  vi.stubEnv('PAPER_AI_WORKER_SOCKET', socketPath)
}
beforeEach(async () => {
  sequence = 0
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-worker-test-'))
  bin = path.join(directory, 'cli')
  await fs.copyFile(new URL('./fixtures/worker-cli.mjs', import.meta.url), bin)
  await fs.chmod(bin, 0o700)
  vi.stubEnv('HOME', directory)
  vi.stubEnv('PAPER_SIGNING_SECRET', 'synthetic-paper-secret')
  vi.stubEnv('PAPER_AI_WORKER_SECRET', secret)
  vi.stubEnv('PAPER_AI_LOCAL', '')
  vi.stubEnv('PAPER_AI_WORKER_URL', '')
  logs = vi.spyOn(console, 'error').mockImplementation(() => {})
  await start()
})
afterEach(async () => { worker.stop(); logs.mockRestore(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }) })
function request(endpoint: string, payload?: unknown, key = secret, raw?: string) {
  return new Promise<Response>((resolve, reject) => {
    const call = http.request({ socketPath, path: endpoint, method: payload === undefined && raw === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paper-ai-secret': key },
    }, response => resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
      status: response.statusCode, headers: response.headers as Record<string, string>,
    })))
    call.on('error', reject)
    call.end(raw ?? (payload === undefined ? undefined : JSON.stringify(payload)))
  })
}
const post = (payload: unknown = body, key = secret, endpoint = '/v1/codex') => request(endpoint, payload, key)
async function starts(count: number) {
  let records: { pid: number; args: string[] }[] = []
  await vi.waitFor(async () => {
    records = (await fs.readFile(path.join(directory, 'starts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records.length).toBe(count)
  })
  return records
}
async function stopped(pid: number) { await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow()) }
function hang() {
  const controller = new AbortController()
  const result = workerBatch({ ...body, model: 'hang' }, controller.signal).catch(error => error)
  return { controller, result }
}

describe('isolated AI protocol', () => {
  it('requires authentication and caches the CLI startup health check', async () => {
    for (const key of ['', 'wrong', secret + 'extra']) expect((await post(body, key)).status).toBe(401)
    expect((await request('/health', undefined, '')).status).toBe(401)
    expect((await post(body, secret, '/unknown')).status).toBe(404)
    expect((await aiAvailability()).available).toBe(true)
    await fs.chmod(bin, 0o600)
    expect((await aiAvailability()).available).toBe(true)
    expect(await aiAvailability(false)).toEqual({ available: false, message: 'AI is unavailable until Codex and AI features are enabled in Settings.' })
    expect(() => createAiWorker({ secret: '', codexBin: bin })).toThrow()
  })
  it('reports a CLI that cannot start through health and Settings', async () => {
    await start({ codexBin: path.join(directory, 'missing') })
    expect((await request('/health')).status).toBe(503)
    expect(await aiAvailability()).toEqual({ available: false, message: 'The AI worker could not start Codex. Check its CLI installation.' })
  })
  it('rejects oversized, malformed and invalid requests without echoing article text or consuming slots', async () => {
    expect((await post({ ...body, input: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413)
    const invalid = await post({ ...body, bin: 'private article' })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain('private article')
    const malformed = await request('/v1/codex', undefined, secret, '{private article')
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).not.toContain('private article')
    expect((await post()).status).toBe(200)
  })
  it('does not reserve execution slots for incomplete request bodies', async () => {
    const partial = http.request({ socketPath, path: '/v1/codex', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paper-ai-secret': secret } })
    partial.on('error', () => {})
    partial.write('{')
    try { expect((await post()).status).toBe(200) } finally { partial.destroy() }
  })
  it('routes batch and discussion calls through the socket with the model environment allowlist', async () => {
    const result = await runCodex({ ...config(), bin: '/must-not-spawn-in-paper' }, body.model, body.instruction, body.input, body.schema, 'low') as any
    expect(result.input).toContain('private article')
    expect(result.env).toEqual({ HOME: directory, PATH: process.env.PATH, NO_COLOR: '1', CI: '1' })
    const onText = vi.fn()
    expect(await createChatModel('/must-not-spawn-in-paper', 'fixture')({}, new AbortController().signal, onText)).toBe('Fixture reply.')
    expect(onText.mock.calls).toEqual([['Fixture '], ['Fixture reply.']])
  })
  it('lets a discussion wait behind two active runs and complete when a slot opens', async () => {
    const first = hang()
    const [record] = await starts(1)
    const second = hang()
    await starts(2)
    let done = false
    const discussion = workerChat('fixture', {}, new AbortController().signal, () => {}).then(result => { done = true; return result })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(done).toBe(false)
    expect(await starts(2)).toHaveLength(2)
    first.controller.abort()
    await first.result
    await stopped(record.pid)
    expect(await discussion).toBe('Fixture reply.')
    second.controller.abort()
    await second.result
  })
  it('returns a distinct busy error and Retry-After when the queue fills', async () => {
    await start({ concurrency: 1, queueCapacity: 1 })
    const active = hang()
    await starts(1)
    const queued = hang()
    await new Promise(resolve => setTimeout(resolve, 80))
    const full = await post()
    expect(full.status).toBe(503)
    expect(full.headers.get('retry-after')).toBe('5')
    expect((await full.json()).category).toBe('busy')
    await expect(workerBatch(body)).rejects.toThrow('AI is busy, try again shortly')
    queued.controller.abort(); active.controller.abort()
    await Promise.all([queued.result, active.result])
    await vi.waitFor(async () => expect((await post()).status).toBe(200))
  })
  it('expires queued requests without starting a CLI or stopping the active run', async () => {
    await start({ concurrency: 1, queueWaitMs: 50 })
    const active = hang()
    const [record] = await starts(1)
    await expect(workerBatch(body)).rejects.toThrow('AI is busy')
    expect(await starts(1)).toHaveLength(1)
    expect(() => process.kill(record.pid, 0)).not.toThrow()
    active.controller.abort()
    await active.result
    expect((await post()).status).toBe(200)
  })
  it('removes an aborted queued request so it never spawns and the next request can run', async () => {
    await start({ concurrency: 1, queueCapacity: 1 })
    const active = hang()
    await starts(1)
    const queued = hang()
    await new Promise(resolve => setTimeout(resolve, 80))
    queued.controller.abort()
    await queued.result
    await new Promise(resolve => setTimeout(resolve, 40))
    const next = workerBatch(body)
    active.controller.abort()
    await active.result
    expect(await next).toHaveProperty('input')
    expect(await starts(2)).toHaveLength(2)
  })
  it('kills a discussion on cancellation and releases its slot after process exit', async () => {
    await start({ concurrency: 1 })
    const controller = new AbortController()
    const result = workerChat('hang', {}, controller.signal, () => {}).catch(error => error)
    const [record] = await starts(1)
    controller.abort()
    expect(String(await result)).toContain('Response stopped')
    await stopped(record.pid)
    expect((await post()).status).toBe(200)
  })
  it('kills active CLIs and cancels queued work on worker shutdown', async () => {
    await start({ concurrency: 1 })
    const active = hang()
    const [record] = await starts(1)
    const queued = hang()
    worker.stop()
    expect(await active.result).toBeInstanceOf(Error)
    expect(await queued.result).toBeInstanceOf(Error)
    await stopped(record.pid)
    expect(await starts(1)).toHaveLength(1)
  })
  it('kills a CLI that exceeds its execution deadline', async () => {
    await fs.writeFile(path.join(directory, 'input.json'), '{}')
    const result = runModelProcess(bin, ['run', '--model', 'hang', '--file', path.join(directory, 'input.json')], directory, 150).catch(error => error)
    const [record] = await starts(1)
    expect((await result).category).toBe('timeout')
    await stopped(record.pid)
  })
  it('logs safe categories and timings for failed runs and releases their slots', async () => {
    await start({ concurrency: 1 })
    for (const [model, category] of [['fail', 'unknown'], ['invalid', 'schema'], ['stderr:401 invalid_api_key fake-token-123 fake-prompt-456', 'auth']]) {
      const response = await post({ ...body, model })
      expect(response.status).toBe(502)
      const payload = await response.json()
      expect(payload.category).toBe(category)
      expect(payload.requestId).toMatch(/^[a-f0-9-]{36}$/)
      expect((await post()).status).toBe(200)
    }
    await expect(workerChat('fail', {}, new AbortController().signal, () => {})).rejects.toThrow('AI request failed')
    const records = logs.mock.calls.map(call => JSON.parse(String(call[0])))
    const failures = records.filter(record => record.event === 'ai_worker_failed')
    expect(failures).toHaveLength(4)
    expect(failures[2]).toMatchObject({ category: 'auth', exitCode: 1, signal: null, endpoint: '/v1/codex', queueWaitMs: expect.any(Number), runDurationMs: expect.any(Number) })
    expect(records.at(-1)).toMatchObject({ event: 'ai_request_failed', requestId: failures.at(-1).requestId, category: 'unknown' })
    for (const text of ['private article', secret, 'fake-token-123', 'fake-prompt-456']) expect(JSON.stringify(records)).not.toContain(text)
  })
  it('classifies malformed discussion events and stderr without leaking diagnostics', async () => {
    await expect(workerChat('invalid', {}, new AbortController().signal, () => {})).rejects.toMatchObject({ category: 'schema' })
    await expect(workerChat('stderr:403 model access denied fake-token-123 fake-prompt-456', {}, new AbortController().signal, () => {})).rejects.toMatchObject({ category: 'model_access' })
    for (const text of ['fake-token-123', 'fake-prompt-456']) expect(JSON.stringify(logs.mock.calls)).not.toContain(text)
    expect((await post()).status).toBe(200)
  })
  it('reports spawn and output limit failures with safe metadata', async () => {
    await expect(runModelProcess(path.join(directory, 'missing'), [], directory, 1000)).rejects.toMatchObject({ category: 'spawn' })
    await expect(runModelProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(5*1024*1024))"], directory, 1000)).rejects.toMatchObject({ category: 'output_limit' })
    await fs.chmod(bin, 0o600)
    const response = await post()
    expect((await response.json()).category).toBe('spawn')
    await fs.chmod(bin, 0o700)
    expect((await post()).status).toBe(200)
  })
  it('fails closed without a socket, including obsolete URL configuration with unsafe mode', async () => {
    vi.stubEnv('PAPER_AI_WORKER_SOCKET', '')
    expect(aiExecutionConfigured()).toBe(false)
    await expect(runCodex(config(), body.model, '', {}, body.schema)).rejects.toThrow('AI is unavailable')
    await expect(createChatModel(bin)({}, new AbortController().signal, () => {})).rejects.toThrow('AI is unavailable')
    vi.stubEnv('PAPER_AI_LOCAL', 'unsafe')
    expect(aiExecutionConfigured()).toBe(true)
    vi.stubEnv('PAPER_AI_WORKER_URL', 'http://obsolete-worker')
    expect(aiExecutionConfigured()).toBe(false)
    await expect(runCodex(config(), body.model, '', {}, body.schema)).rejects.toThrow('AI is unavailable')
    vi.stubEnv('PAPER_AI_WORKER_SOCKET', socketPath)
    worker.stop()
    expect((await aiAvailability()).available).toBe(false)
    await expect(workerBatch(body)).rejects.toThrow('AI is unavailable')
  })
  it.each(['missing-result', 'oversized', 'truncated-stream', 'empty-status'])('rejects a %s response without exposing its contents', async mode => {
    const payload = mode === 'oversized' ? JSON.stringify({ result: 'x'.repeat(4 * 1024 * 1024) }) : mode === 'truncated-stream' ? '{"type":"delta","text":"private article"}\n' : '{}'
    const server = http.createServer((_request, response) => response.writeHead(mode === 'empty-status' ? 204 : 200).end(payload))
    const otherSocket = path.join(directory, 'other.sock')
    await listenAiSocket(server, otherSocket)
    vi.stubEnv('PAPER_AI_WORKER_SOCKET', otherSocket)
    try {
      await expect(mode === 'truncated-stream' ? workerChat('fixture', {}, new AbortController().signal, () => {}) : workerBatch(body)).rejects.toThrow('AI returned an invalid response')
    } finally { server.closeAllConnections(); server.close() }
  })
  it('replaces a stale socket and restricts the socket to the shared UID', async () => {
    const stale = path.join(directory, 'stale.sock')
    execFileSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))", stale])
    const server = http.createServer()
    try {
      await listenAiSocket(server, stale)
      expect((await fs.stat(stale)).mode & 0o777).toBe(0o600)
      await expect(listenAiSocket(http.createServer(), stale)).rejects.toThrow('still in use')
    } finally { server.closeAllConnections(); server.close() }
  })
})

it.each([
  ['401 Unauthorized fake-token-123 fake-prompt-456', 'auth'],
  ['Your token has expired', 'auth'],
  ['model_not_found: model does not exist', 'model_access'],
  ['403 model permission denied', 'model_access'],
  ['Invalid schema for response_format', 'schema'],
  ['request timed out', 'timeout'],
  ['unexpected failure fake-token-123 fake-prompt-456', 'unknown'],
  ['401 ' + 'x'.repeat(8192), 'unknown'],
])('classifies bounded synthetic diagnostics without retaining them', (stderr, category) => {
  expect(classifyModelFailure(stderr)).toBe(category)
  expect(logs).not.toHaveBeenCalled()
})
