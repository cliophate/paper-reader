import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/server/config'

afterEach(() => vi.unstubAllEnvs())
function configured() {
  for (const [key, value] of Object.entries({
    FRESHRSS_BASE_URL: 'https://rss.example.test', FRESHRSS_USERNAME: 'reader',
    FRESHRSS_API_PASSWORD: 'synthetic-password', PAPER_INTERNAL_SECRET: 'synthetic-internal-secret',
    PAPER_SIGNING_SECRET: 'synthetic-signing-secret',
  })) vi.stubEnv(key, value)
}
describe('standalone configuration', () => {
  it('starts without optional credentials and enables no AI provider by default', () => {
    configured()
    for (const key of ['CODEX_ENABLED', 'OPENCODE_ENABLED', 'KIRBY_PUBLISH_URL', 'KIRBY_PUBLISH_TOKEN', 'READWISE_TOKEN', 'RSSHUB_BASE_URL', 'PAPER_TRUSTED_FEED_ORIGINS', 'HOST']) vi.stubEnv(key, '')
    const config = loadConfig()
    expect(config.codex.enabled).toBe(false)
    expect(config.openCode.enabled).toBe(false)
    expect(config.kirby.publishUrl).toBe('')
    expect(config.readwise.token).toBe('')
    expect(config.host).toBe('127.0.0.1')
    expect(config.trustedFeedOrigins).toEqual([])
  })
  it('requires explicit exact origins for private feed proxies', () => {
    configured()
    vi.stubEnv('PAPER_TRUSTED_FEED_ORIGINS', 'https://feeds.example.test, http://rsshub:1200')
    expect(loadConfig().trustedFeedOrigins).toEqual(['https://feeds.example.test', 'http://rsshub:1200'])
    vi.stubEnv('PAPER_TRUSTED_FEED_ORIGINS', 'https://user:password@feeds.example.test')
    expect(loadConfig).toThrow('origins without credentials or paths')
    vi.stubEnv('PAPER_TRUSTED_FEED_ORIGINS', 'https://feeds.example.test/private')
    expect(loadConfig).toThrow('origins without credentials or paths')
  })
  it('reports missing FreshRSS credentials before starting the server', () => {
    configured()
    vi.stubEnv('FRESHRSS_API_PASSWORD', '')
    expect(loadConfig).toThrow('Missing required environment variable FRESHRSS_API_PASSWORD')
  })
})
