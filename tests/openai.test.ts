import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startOpenaiFixture } from './fixtures/openai-provider.mjs'
import { openaiBatch, openaiChat, testOpenaiConnection } from '../src/server/openai.js'
import { createAiChatModel, providerConfigured, runAiBatch } from '../src/server/ai-provider.js'
import { loadConfig } from '../src/server/config.js'
import * as networkPolicy from '../src/server/network-policy.js'
import { modelEnvironment } from '../src/server/model-process.js'
import { PULSE_SCHEMA, validatePulseBatch } from '../src/server/pulse.js'

let fixture: Awaited<ReturnType<typeof startOpenaiFixture>>
let config: ReturnType<typeof loadConfig>
const schema = { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' } } }, required: ['groups'], additionalProperties: false }
const batch = (model: string, signal?: AbortSignal) => openaiBatch(config.openai, model, 'Synthetic instruction', { article: 'Synthetic article' }, schema, signal)
const chat = (model: string, signal = new AbortController().signal, onText = (_text: string) => {}) => openaiChat(config.openai, model, 'Synthetic discussion', {}, signal, onText)

beforeEach(async () => {
  fixture = await startOpenaiFixture()
  for (const [key, value] of Object.entries({ PAPER_BACKEND: 'standalone', PAPER_AI_PROVIDER: 'openai', PAPER_OPENAI_BASE_URL: `${fixture.origin}/v1`,
    PAPER_TRUSTED_AI_ORIGINS: fixture.origin, PAPER_OPENAI_API_KEY: 'synthetic-secret', PAPER_INTERNAL_SECRET: 'fixture', PAPER_SIGNING_SECRET: 'fixture' })) vi.stubEnv(key, value)
  config = loadConfig()
})
afterEach(async () => { await fixture.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('OpenAI-compatible HTTP provider', () => {
  it('sends structured JSON with no tools, cookies or CLI environment', async () => {
    expect(await batch('json')).toMatchObject({ groups: [] })
    const call = fixture.requests[0]
    expect(call.path).toBe('/v1/chat/completions')
    expect(call.authorization).toBe('Bearer synthetic-secret')
    expect(call.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'paper_result', strict: true, schema } })
    expect(call.body.messages[1].content).toContain('Synthetic article')
    expect(call.body).not.toHaveProperty('tools')
    expect(JSON.stringify(call.body)).not.toContain('synthetic-secret')
    expect(JSON.stringify(modelEnvironment())).not.toContain('synthetic-secret')
  })

  it('falls back once to JSON mode and keeps the schema in the prompt', async () => {
    expect(await batch('fallback')).toMatchObject({ groups: [] })
    expect(fixture.requests.map(call => call.body.response_format.type)).toEqual(['json_schema', 'json_object'])
    expect(fixture.requests[1].body.messages[0].content).toContain(JSON.stringify(schema))
  })

  it('passes fallback results through existing batch validation', async () => {
    const result = await openaiBatch(config.openai, 'fallback-invalid', 'Group articles', {}, PULSE_SCHEMA)
    expect(() => validatePulseBatch(result, [], [])).toThrow()
  })

  it('streams cumulative UTF-8 text from SSE with CRLF and comments', async () => {
    const updates: string[] = []
    expect(await chat('stream', undefined, text => updates.push(text))).toBe('Hello café 🌱')
    expect(updates).toContain('Hello ')
    expect(updates.at(-1)).toBe('Hello café 🌱')
    expect(fixture.requests[0].body.stream).toBe(true)
    expect(fixture.requests[0].body).not.toHaveProperty('tools')
  })

  it.each(['stream-error', 'stream-invalid', 'stream-truncated', 'stream-length', 'stream-tools'])('rejects %s without returning provider diagnostics', async model => {
    await expect(chat(model)).rejects.toThrow(/AI/)
    try { await chat(model) } catch (error) { expect(String(error)).not.toContain('synthetic-secret') }
  })

  it.each([['status-401', 'auth'], ['status-403', 'model_access'], ['status-404', 'model_access'], ['status-429', 'busy'], ['status-500', 'unknown'],
    ['broken-json', 'schema'], ['invalid-json-content', 'schema'], ['truncated', 'schema'], ['refused', 'schema']])('classifies %s without reflecting errors or logging the key', async (model, category) => {
    const errorLog = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn')
    await expect(batch(model)).rejects.toMatchObject({ category })
    expect(fixture.requests).toHaveLength(1)
    expect(errorLog).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled()
    try { await batch(model) } catch (error) { expect(String(error)).not.toContain('synthetic-secret') }
  })

  it.each(['size-header', 'size-body'])('bounds %s', async model => { await expect(batch(model)).rejects.toMatchObject({ category: 'output_limit' }) })
  it('bounds discussion text', async () => { await expect(chat('stream-large')).rejects.toMatchObject({ category: 'output_limit' }) })
  it('bounds the request before sending it', async () => {
    await expect(openaiBatch(config.openai, 'json', '', 'x'.repeat(2 * 1024 * 1024), schema)).rejects.toMatchObject({ category: 'output_limit' })
    expect(fixture.requests).toHaveLength(0)
  })

  it.each(['hang', 'slow-body', 'stream-hang'])('aborts %s and closes the socket', async model => {
    const controller = new AbortController()
    const pending = (model.startsWith('stream') ? chat(model, controller.signal) : batch(model, controller.signal)).catch(error => error)
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
    controller.abort()
    expect(await pending).toMatchObject({ category: 'cancelled' })
    await vi.waitFor(() => expect(fixture.closed).toContain(model))
  })

  it('removes cancelled requests from the shared queue and releases active slots', async () => {
    const active = [new AbortController(), new AbortController()]
    const running = active.map(controller => batch('hang', controller.signal).catch(error => error))
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(2))
    const queued = new AbortController()
    const waiting = batch('json', queued.signal).catch(error => error)
    queued.abort()
    expect(await waiting).toMatchObject({ category: 'cancelled' })
    expect(fixture.requests).toHaveLength(2)
    active.forEach(controller => controller.abort())
    expect(await Promise.all(running)).toEqual([expect.objectContaining({ category: 'cancelled' }), expect.objectContaining({ category: 'cancelled' })])
    expect(await batch('json')).toMatchObject({ groups: [] })
    expect(fixture.requests).toHaveLength(3)
  })

  it('does not connect after a cancelled DNS lookup resolves late', async () => {
    let resolve!: (value: { address: string; family: number }[]) => void
    const lookup = vi.spyOn(networkPolicy, 'resolveHttpUrl').mockImplementation(() => new Promise(done => { resolve = done }))
    const controller = new AbortController()
    const pending = batch('json', controller.signal).catch(error => error)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce())
    controller.abort()
    expect(await pending).toMatchObject({ category: 'cancelled' })
    resolve([{ address: '127.0.0.1', family: 4 }])
    await new Promise<void>(done => setImmediate(done))
    expect(fixture.requests).toHaveLength(0)
  })

  it('does not send an already cancelled request', async () => {
    await expect(batch('json', AbortSignal.abort())).rejects.toMatchObject({ category: 'cancelled' })
    expect(fixture.requests).toHaveLength(0)
  })

  it('enforces the deadline while waiting for headers', async () => {
    const original = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => original(30))
    await expect(batch('hang')).rejects.toMatchObject({ category: 'timeout' })
  })

  it('blocks private URLs unless their exact origin is administrator trusted', async () => {
    config.openai.trustedOrigins = []
    await expect(batch('json')).rejects.toThrow('PAPER_TRUSTED_AI_ORIGINS')
    config.openai.trustedOrigins = ['http://127.0.0.1:1']
    await expect(batch('json')).rejects.toThrow('PAPER_TRUSTED_AI_ORIGINS')
    config.openai.baseUrl = 'https://127.0.0.1/v1'
    await expect(batch('json')).rejects.toThrow('PAPER_TRUSTED_AI_ORIGINS')
    expect(fixture.requests).toHaveLength(0)
  })

  it('refuses redirects even within a trusted origin', async () => {
    await expect(batch('redirect')).rejects.toThrow('PAPER_TRUSTED_AI_ORIGINS')
    expect(fixture.requests).toHaveLength(1)
  })

  it('allows a trusted server without a key', async () => {
    config.openai.token = ''
    await batch('json')
    expect(fixture.requests[0].authorization).toBeUndefined()
  })

  it('tests the discussion model with exactly one tiny request', async () => {
    expect(await testOpenaiConnection(config.openai)).toMatchObject({ available: true })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0].body).toEqual({ model: config.openai.discussionModel, messages: [{ role: 'user', content: 'Reply OK.' }] })
  })

  it('routes every feature to its saved API model even with a worker configured', async () => {
    vi.stubEnv('PAPER_AI_WORKER_SOCKET', '/no-worker-must-be-used')
    expect(providerConfigured(config)).toBe(true)
    for (const feature of ['headlines', 'grouping', 'shortlist', 'editor'] as const) {
      config.openai[`${feature}Model`] = feature
      expect(await runAiBatch(config, feature, 'must-not-use-codex', '', {}, schema)).toMatchObject({ model: feature })
    }
    const model = createAiChatModel(config)
    config.openai.discussionModel = 'stream'
    expect(await model({}, new AbortController().signal, () => {})).toBe('Hello café 🌱')
    config.ai.provider = 'none'
    expect(providerConfigured(config)).toBe(false)
    expect(() => runAiBatch(config, 'headlines', '', '', {}, schema)).toThrow('AI is unavailable')
    expect(() => model({}, new AbortController().signal, () => {})).toThrow('AI is unavailable')
  })
})
