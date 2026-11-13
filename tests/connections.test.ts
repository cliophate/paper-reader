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
    expect(config.ai).toEqual({ discussionEnabled: false, briefingsEnabled: false })
    expect(config.headlines.enabled).toBe(false)
    expect(config.collections.enabled).toBe(false)
    expect(config.codex.enabled).toBe(false)
    settings.update({ ai: { enabled: false } })
  })

  it.each([
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
