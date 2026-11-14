import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/server/config'
import { ConnectionSettings } from '../src/server/connections'
import { ReadwiseClient } from '../src/server/readwise'
import { KirbyPublisher } from '../src/server/kirby'

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-connections-test-'))
  for (const [key, value] of Object.entries({
    STATE_DIR: directory, FRESHRSS_BASE_URL: 'https://rss.example.test', FRESHRSS_USERNAME: 'fixture',
    FRESHRSS_API_PASSWORD: 'synthetic-password', PAPER_INTERNAL_SECRET: 'synthetic-internal', PAPER_SIGNING_SECRET: 'synthetic-signing',
    READWISE_TOKEN: 'synthetic-reader-token', READWISE_LOCATION: 'later', KIRBY_PUBLISH_TOKEN: 'synthetic-kirby-token', KIRBY_PUBLISH_URL: 'https://example.test/publish',
    CODEX_ENABLED: 'true', PAPER_CLEAR_HEADLINES: 'true', PAPER_COLLECTIONS_ENABLED: 'true',
  })) vi.stubEnv(key, value)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('private connection settings', () => {
  it('exposes only the active discussion provider and model', () => {
    vi.stubEnv('PAPER_DISCUSSION_MODEL', 'custom-codex-model')
    const settings = new ConnectionSettings(loadConfig())
    expect(settings.discussionProvider()).toEqual({ provider: 'codex', model: 'custom-codex-model' })
    settings.update({ ai: { provider: 'openai' }, openai: { discussionModel: 'custom-api-model', token: 'synthetic-secret', baseUrl: 'https://provider.test/v1' } })
    expect(settings.discussionProvider()).toEqual({ provider: 'openai', model: 'custom-api-model' })
  })

  it('uses existing environment configuration without writing or exposing credentials', () => {
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    const view = settings.view()
    expect(view.readwise).toMatchObject({ enabled: true, tokenConfigured: true, tokenSource: 'environment' })
    expect(view.ai).toMatchObject({ enabled: true, codexEnabled: true })
    expect(JSON.stringify(view)).not.toContain('synthetic-reader-token')
    expect(JSON.stringify(view)).not.toContain('synthetic-kirby-token')
    expect(fs.readdirSync(directory)).toEqual([])
    expect(config.readwise.token).toBe('synthetic-reader-token')
  })

  it('keeps API keys private, persists them, and removes environment fallback', () => {
    vi.stubEnv('PAPER_OPENAI_API_KEY', 'synthetic-api-environment')
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    expect(settings.view().openai).toMatchObject({ tokenConfigured: true, tokenSource: 'environment' })
    settings.update({ ai: { enabled: true, provider: 'openai' }, openai: { token: 'synthetic-api-saved', discussionModel: 'local/model', baseUrl: 'http://localhost:11434/v1' } })
    expect(config.codex.enabled).toBe(false)
    expect(config.ai.provider).toBe('openai')
    expect(settings.view().openai).toMatchObject({ tokenConfigured: true, tokenSource: 'settings', discussionModel: 'local/model' })
    expect(JSON.stringify(settings.view())).not.toContain('synthetic-api')
    settings.update({ openai: { token: '' } })
    expect(config.openai.token).toBe('synthetic-api-saved')
    const restoredConfig = loadConfig()
    const restored = new ConnectionSettings(restoredConfig)
    expect(restoredConfig.openai.token).toBe('synthetic-api-saved')
    expect(restoredConfig.ai.provider).toBe('openai')
    expect(fs.statSync(path.join(directory, 'connections.json')).mode & 0o777).toBe(0o600)
    restored.update({ ai: { enabled: false } })
    expect(restored.view().openai.tokenConfigured).toBe(true)
    restored.update({ openai: { token: null }, ai: { enabled: true, provider: 'codex' } })
    expect(restoredConfig.codex.enabled).toBe(true)
    expect(restoredConfig.openai.token).toBe('')
    const clearedConfig = loadConfig()
    expect(new ConnectionSettings(clearedConfig).view().openai).toMatchObject({ tokenConfigured: false, tokenSource: null })
    expect(clearedConfig.openai.token).toBe('')
  })

  it('tests form values without saving or changing credentials and switches', () => {
    vi.stubEnv('PAPER_OPENAI_API_KEY', 'synthetic-api-environment')
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    const original = settings.view()
    expect(settings.openaiTestConfig({ token: 'synthetic-unsaved', discussionModel: 'local' })).toMatchObject({ token: 'synthetic-unsaved', discussionModel: 'local' })
    expect(settings.openaiTestConfig({ token: '' }).token).toBe('synthetic-api-environment')
    expect(settings.openaiTestConfig({ token: null }).token).toBe('')
    expect(() => settings.openaiTestConfig({ trustedOrigins: ['http://localhost'] })).toThrow('Unknown connection setting')
    expect(settings.view()).toEqual(original)
    expect(config.openai.token).toBe('synthetic-api-environment')
    expect(fs.readdirSync(directory)).toEqual([])
  })

  it('keeps a saved key on its origin', () => {
    vi.stubEnv('PAPER_OPENAI_API_KEY', 'synthetic-api-environment')
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    const moved = { openai: { baseUrl: 'https://models.example.test/v1' } }
    expect(() => settings.openaiTestConfig(moved.openai)).toThrow('Enter the API key again')
    expect(() => settings.update(moved)).toThrow('Enter the API key again')
    expect(settings.openaiTestConfig({ baseUrl: 'https://api.openai.com/other' }).token).toBe('synthetic-api-environment')
    expect(settings.openaiTestConfig({ ...moved.openai, token: 'synthetic-new' }).token).toBe('synthetic-new')
    settings.update({ openai: { ...moved.openai, token: null } })
    expect(config.openai).toMatchObject({ baseUrl: 'https://models.example.test/v1', token: '' })
    settings.update({ openai: { baseUrl: 'https://other.example.test/v1' } })
    expect(config.openai.token).toBe('')
  })

  it('requires explicit provider selection on a new installation', () => {
    vi.stubEnv('CODEX_ENABLED', 'false')
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    settings.update({ ai: { enabled: true } })
    expect(settings.view().ai.provider).toBe('none')
    expect(config.codex.enabled).toBe(false)
    settings.update({ ai: { provider: 'openai' } })
    expect(config.ai.provider).toBe('openai')
    settings.update({ ai: { provider: 'none' } })
    expect(new ConnectionSettings(loadConfig()).view().ai.provider).toBe('none')
  })

  it('does not expose malformed API environment configuration', () => {
    vi.stubEnv('PAPER_OPENAI_BASE_URL', 'https://user:synthetic-secret@example.test/v1')
    expect(() => new ConnectionSettings(loadConfig())).toThrow('Invalid OpenAI-compatible API configuration')
    try { new ConnectionSettings(loadConfig()) } catch (error) { expect(String(error)).not.toContain('synthetic-secret') }
  })

  it('keeps every optional connection off for a new installation', () => {
    for (const key of ['READWISE_TOKEN', 'KIRBY_PUBLISH_TOKEN', 'KIRBY_PUBLISH_URL', 'CODEX_ENABLED']) vi.stubEnv(key, '')
    const config = loadConfig()
    const view = new ConnectionSettings(config).view()
    expect([view.ai.enabled, view.readwise.enabled, view.kirby.enabled]).toEqual([false, false, false])
    expect(config.codex.enabled).toBe(false)
  })

  it('disables clients immediately, persists through restart, and retains tokens for re-enabling', () => {
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    const readwise = new ReadwiseClient(config.readwise)
    const kirby = new KirbyPublisher(config.kirby)
    settings.update({ ai: { enabled: false }, readwise: { enabled: false }, kirby: { enabled: false } })
    expect([readwise.configured, kirby.configured, config.codex.enabled]).toEqual([false, false, false])
    expect(settings.view().readwise.tokenConfigured).toBe(true)
    const restarted = loadConfig()
    const restored = new ConnectionSettings(restarted)
    expect(restarted.codex.enabled).toBe(false)
    expect(restarted.readwise.token).toBe('')
    restored.update({ ai: { enabled: true }, readwise: { enabled: true }, kirby: { enabled: true } })
    expect(restarted.codex.enabled).toBe(true)
    expect(restarted.readwise.token).toBe('synthetic-reader-token')
    expect(restarted.kirby.token).toBe('synthetic-kirby-token')
  })

  it('replaces tokens, preserves blanks, and clears tokens without falling back to environment values', () => {
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    settings.update({ readwise: { token: ' synthetic-replacement ', location: 'archive' } })
    settings.update({ readwise: { token: '' }, kirby: { token: '   ' } })
    expect(config.readwise.token).toBe('synthetic-replacement')
    expect(config.kirby.token).toBe('synthetic-kirby-token')
    expect(settings.view().readwise.tokenSource).toBe('settings')
    expect(JSON.stringify(settings.view())).not.toContain('synthetic-replacement')
    const filename = path.join(directory, 'connections.json')
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(filename, 'utf8')).readwise).toMatchObject({ token: 'synthetic-replacement', location: 'archive' })
    settings.update({ readwise: { token: null }, kirby: { token: null } })
    const restarted = loadConfig()
    const restored = new ConnectionSettings(restarted)
    expect(restored.view().readwise).toMatchObject({ tokenConfigured: false, tokenSource: null })
    restored.update({ readwise: { enabled: true }, kirby: { enabled: true } })
    expect(restarted.readwise.token).toBe('')
    expect(restarted.kirby.token).toBe('')
  })

  it('loads removed-provider settings without enabling Codex or keeping the old switch', () => {
    vi.stubEnv('CODEX_ENABLED', 'false')
    vi.stubEnv('OPENCODE_ENABLED', 'true')
    fs.writeFileSync(path.join(directory, 'connections.json'), JSON.stringify({
      ai: { enabled: true, codexEnabled: false, openCodeEnabled: true },
    }))
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    expect(config.codex.enabled).toBe(false)
    expect(settings.view().ai).not.toHaveProperty('openCodeEnabled')
    settings.update({ ai: { codexEnabled: true } })
    expect(config.codex.enabled).toBe(true)
  })

  it('applies feature and provider switches separately', () => {
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    settings.update({ ai: { discussionEnabled: false, briefingsEnabled: false, headlinesEnabled: false, collectionsEnabled: false, codexEnabled: false } })
    expect(config.ai).toMatchObject({ discussionEnabled: false, briefingsEnabled: false })
    expect(config.headlines.enabled).toBe(false)
    expect(config.collections.enabled).toBe(false)
    expect(config.codex.enabled).toBe(false)
    settings.update({ ai: { enabled: false } })
  })

  it.each([
    { openai: { trustedOrigins: ['http://localhost'] } }, { ai: { provider: 'unsupported' } },
    { openai: { token: 'synthetic-secret\nheader' } }, { openai: { token: 42 } },
    { openai: { baseUrl: 'https://user:synthetic-secret@example.test/v1' } }, { openai: { baseUrl: 'https://example.test/?token=synthetic-secret' } },
    { openai: { baseUrl: 'file:///tmp/fixture' } }, { openai: { editorModel: '' } }, { openai: { groupingModel: 'bad\nmodel' } },
    null, [], { unknown: {} }, { ai: { enabled: 'false' } }, { ai: { bin: '/bin/sh' } },
    { readwise: { location: 'invalid' } }, { readwise: { token: 42 } }, { readwise: { token: 'synthetic-secret\nheader' } },
    { kirby: { publishUrl: 'file:///tmp/publish' } }, { kirby: { publishUrl: 'https://user:synthetic-secret@example.test/publish' } },
    { kirby: { publishUrl: 'https://example.test/publish?token=synthetic-secret' } },
    JSON.parse('{"__proto__":{"enabled":true}}'),
  ])('rejects invalid updates without persisting or reflecting submitted values %#', input => {
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    expect(() => settings.update(input)).toThrow()
    try { settings.update(input) } catch (error) { expect(String(error)).not.toContain('synthetic-secret') }
    expect(fs.readdirSync(directory)).toEqual([])
    expect(config.codex.enabled).toBe(true)
    expect(config.readwise.token).toBe('synthetic-reader-token')
  })

  it('keeps the last saved settings and runtime configuration if an atomic write fails', () => {
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    settings.update({ readwise: { location: 'archive' } })
    const before = fs.readFileSync(path.join(directory, 'connections.json'), 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic failure') })
    expect(() => settings.update({ readwise: { token: 'synthetic-not-saved', enabled: false } })).toThrow()
    expect(config.readwise.token).toBe('synthetic-reader-token')
    expect(fs.readFileSync(path.join(directory, 'connections.json'), 'utf8')).toBe(before)
    expect(fs.readdirSync(directory)).toEqual(['connections.json'])
  })

  it('fails closed on a corrupt settings file without quoting its contents', () => {
    fs.writeFileSync(path.join(directory, 'connections.json'), 'synthetic-secret: broken json')
    expect(() => new ConnectionSettings(loadConfig())).toThrow('Could not load private connection settings.')
    try { new ConnectionSettings(loadConfig()) } catch (error) { expect(String(error)).not.toContain('synthetic-secret') }
  })

  it('scrubs credentials from legacy publishing URLs returned to the browser', () => {
    vi.stubEnv('KIRBY_PUBLISH_URL', 'https://user:synthetic-secret@example.test/publish?token=synthetic-secret#private')
    expect(new ConnectionSettings(loadConfig()).view().kirby.publishUrl).toBe('https://example.test/publish')
  })

  it('uses changed credentials in existing clients and makes no network requests while disabled', async () => {
    const config = loadConfig()
    const settings = new ConnectionSettings(config)
    const readwise = new ReadwiseClient(config.readwise)
    const kirby = new KirbyPublisher(config.kirby)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 'notes/fixture' }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    settings.update({ readwise: { enabled: false }, kirby: { enabled: false } })
    await expect(readwise.save('https://article.test', 'Fixture')).rejects.toThrow()
    await expect(kirby.createNote({ title: 'Fixture', sourceUrl: 'https://article.test', quote: 'Synthetic quote' })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    settings.update({ readwise: { enabled: true, token: 'synthetic-new-reader', location: 'archive' }, kirby: { enabled: true, token: 'synthetic-new-kirby', publishUrl: 'http://kirby:8080/publish' } })
    await readwise.save('https://article.test', 'Fixture')
    await kirby.createNote({ title: 'Fixture', sourceUrl: 'https://article.test', quote: 'Synthetic quote' })
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Token synthetic-new-reader' } })
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).location).toBe('archive')
    expect(fetcher.mock.calls[1][0]).toBe('http://kirby:8080/publish')
    expect(fetcher.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer synthetic-new-kirby' } })
  })
})
