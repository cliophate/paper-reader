import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runModelProcess } from '../src/server/model-process.js'
import { createAiWorker } from '../src/server/ai-worker-server.js'
import { aiAvailability, aiExecutionConfigured, workerBatch, workerChat } from '../src/server/ai-client.js'
import { runCodex } from '../src/server/codex.js'
import { createChatModel } from '../src/server/chat-model.js'

const secret = 'synthetic-worker-secret-at-least-32-characters'
const body = { model: 'fixture', instruction: 'Return JSON.', input: 'private article', schema: { type: 'object' }, reasoningEffort: 'low' }
let directory: string, bin: string, url: string
let worker: ReturnType<typeof createAiWorker>
const config = () => ({ enabled: true, bin, configDir: directory, discussionModel: 'fixture', shortlistModel: 'fixture', editorModel: 'fixture' })

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-worker-test-'))
  bin = path.join(directory, 'cli')
  await fs.copyFile(new URL('./fixtures/worker-cli.mjs', import.meta.url), bin)
  await fs.chmod(bin, 0o700)
  vi.stubEnv('HOME', directory)
  vi.stubEnv('PAPER_SIGNING_SECRET', 'synthetic-paper-secret')
  vi.stubEnv('PAPER_AI_WORKER_SECRET', secret)
  vi.stubEnv('PAPER_AI_LOCAL', '')
  worker = createAiWorker({ secret, codexBin: bin, concurrency: 1 })
  await new Promise<void>(resolve => worker.server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(worker.server.address() as { port: number }).port}`
  vi.stubEnv('PAPER_AI_WORKER_URL', url)
})
afterEach(async () => { worker.stop(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }) })
const post = (payload: unknown = body, key = secret, endpoint = '/v1/codex') => fetch(url + endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paper-ai-secret': key }, body: JSON.stringify(payload),
})
async function running() {
  let capture: { pid: number } | undefined
  await vi.waitFor(async () => { capture = JSON.parse(await fs.readFile(path.join(directory, 'running.json'), 'utf8')); expect(capture).toBeTruthy() })
  return capture!
}
async function stopped(pid: number) { await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow()) }

describe('isolated AI protocol', () => {
  it('requires authentication for health, every endpoint and unknown routes', async () => {
    for (const key of ['', 'wrong', secret + 'extra']) expect((await post(body, key)).status).toBe(401)
    expect((await fetch(url + '/health')).status).toBe(401)
    expect((await post(body, secret, '/unknown')).status).toBe(404)
    expect((await aiAvailability()).available).toBe(true)
    expect(await aiAvailability(false)).toEqual({ available: false, message: 'AI is unavailable until Codex and AI features are enabled in Settings.' })
    expect(() => createAiWorker({ secret: '', codexBin: bin })).toThrow()
  })
  it('rejects oversized, malformed and invalid requests without echoing article text', async () => {
    const large = await post({ ...body, input: 'x'.repeat(2 * 1024 * 1024) })
    expect(large.status).toBe(413)
    const invalid = await post({ ...body, bin: 'private article' })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain('private article')
    const malformed = await fetch(url + '/v1/codex', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paper-ai-secret': secret }, body: '{private article' })
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).not.toContain('private article')
  })
  it('releases a slot when an incomplete request body disconnects', async () => {
    const partial = http.request(url + '/v1/codex', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paper-ai-secret': secret } })
    partial.on('error', () => {})
    partial.write('{')
    await vi.waitFor(async () => expect((await post()).status).toBe(429))
    partial.destroy()
    await vi.waitFor(async () => expect((await post()).status).toBe(200))
  })
  it('routes the Paper batch runner through the worker with the local env allowlist', async () => {
    const forbidden = { ...config(), bin: '/must-not-spawn-in-paper' }
    const result = await runCodex(forbidden, body.model, body.instruction, body.input, body.schema, 'low') as any
    {
      expect(result.input).toContain('private article')
      expect(result.env).toEqual({ HOME: directory, PATH: process.env.PATH, NO_COLOR: '1', CI: '1' })
      expect(result.env.PAPER_AI_WORKER_SECRET).toBeUndefined()
    }
  })
  it('relays incremental discussion deltas and preserves the ChatModel cumulative callback', async () => {
    const onText = vi.fn()
    expect(await createChatModel('/must-not-spawn-in-paper', 'fixture')({}, new AbortController().signal, onText)).toBe('Fixture reply.')
    expect(onText.mock.calls).toEqual([['Fixture '], ['Fixture reply.']])
  })
  it('kills a discussion CLI on cancellation and releases its concurrency slot', async () => {
    const controller = new AbortController()
    const result = workerChat('hang', {}, controller.signal, () => {}).catch(error => error)
    const { pid } = await running()
    expect((await post()).status).toBe(429)
    controller.abort()
    expect(String(await result)).toContain('Response stopped')
    await stopped(pid)
    await vi.waitFor(async () => expect((await post()).status).toBe(200))
  })
  it('kills a batch CLI when the caller disconnects', async () => {
    const controller = new AbortController()
    const result = workerBatch({ ...body, model: 'hang' }, controller.signal).catch(error => error)
    const { pid } = await running()
    controller.abort()
    expect(await result).toBeInstanceOf(Error)
    await stopped(pid)
  })
  it('kills active CLIs on worker shutdown', async () => {
    const result = workerBatch({ ...body, model: 'hang' }).catch(error => error)
    const { pid } = await running()
    worker.stop()
    expect(await result).toBeInstanceOf(Error)
    await stopped(pid)
  })
  it('kills a CLI that exceeds its execution deadline', async () => {
    await fs.writeFile(path.join(directory, 'input.json'), '{}')
    const result = runModelProcess(bin, ['run', '--model', 'hang', '--file', path.join(directory, 'input.json')], directory, 150).catch(error => error)
    const { pid } = await running()
    expect(String(await result)).toContain('timed out')
    await stopped(pid)
  })
  it('returns generic batch and stream errors, including malformed CLI output', async () => {
    for (const model of ['fail', 'invalid']) {
      const response = await post({ ...body, model })
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('private article')
    }
    await expect(workerChat('fail', {}, new AbortController().signal, () => {})).rejects.toThrow('AI worker discussion failed')
  })
  it('fails closed without a worker and never falls back when a configured worker is unavailable', async () => {
    vi.stubEnv('PAPER_AI_WORKER_URL', '')
    expect(aiExecutionConfigured()).toBe(false)
    expect((await aiAvailability()).message).toContain('AI is unavailable')
    await expect(runCodex(config(), body.model, '', {}, body.schema)).rejects.toThrow('AI is unavailable')
    await expect(createChatModel(bin)({}, new AbortController().signal, () => {})).rejects.toThrow('AI is unavailable')
    vi.stubEnv('PAPER_AI_LOCAL', 'unsafe')
    expect(aiExecutionConfigured()).toBe(true)
    vi.stubEnv('PAPER_AI_WORKER_URL', url)
    worker.stop()
    expect((await aiAvailability()).available).toBe(false)
    await expect(runCodex(config(), body.model, '', {}, body.schema)).rejects.toThrow('AI worker request failed')
  })
  it.each(['missing-result', 'oversized'])('rejects a %s batch response from the worker', async mode => {
    worker.stop()
    const payload = mode === 'oversized' ? JSON.stringify({ result: 'x'.repeat(4 * 1024 * 1024) }) : '{}'
    const server = http.createServer((_request, response) => response.end(payload))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('PAPER_AI_WORKER_URL', `http://127.0.0.1:${(server.address() as { port: number }).port}`)
    try { await expect(workerBatch(body)).rejects.toThrow('AI worker request failed') }
    finally { server.closeAllConnections(); server.close() }
  })
  it('rejects truncated or malformed worker streams without exposing their contents', async () => {
    worker.stop()
    const server = http.createServer((_request, response) => response.end('{"type":"delta","text":"private article"}\n'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('PAPER_AI_WORKER_URL', `http://127.0.0.1:${(server.address() as { port: number }).port}`)
    try { await expect(workerChat('fixture', {}, new AbortController().signal, () => {})).rejects.toThrow('AI worker discussion failed') }
    finally { server.closeAllConnections(); server.close() }
  })
})
