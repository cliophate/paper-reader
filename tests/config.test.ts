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
describe('backend configuration', () => {
  it('selects standalone explicitly without FreshRSS credentials and refuses disabling local reads', () => {
    configured()
    vi.stubEnv('PAPER_BACKEND', 'standalone')
    for (const key of ['FRESHRSS_BASE_URL', 'FRESHRSS_USERNAME', 'FRESHRSS_API_PASSWORD']) vi.stubEnv(key, '')
    expect(loadConfig().backend).toBe('standalone')
    expect(loadConfig().freshRss.baseUrl).toBe('')
    vi.stubEnv('PAPER_LOCAL_READS', 'false')
    expect(loadConfig).toThrow(/requires PAPER_LOCAL_READS/)
    vi.stubEnv('PAPER_BACKEND', 'invalid')
    expect(loadConfig).toThrow(/PAPER_BACKEND must/)
  })
  it('starts without optional credentials and enables no AI provider by default', () => {
    configured()
    for (const key of ['CODEX_ENABLED', 'KIRBY_PUBLISH_URL', 'KIRBY_PUBLISH_TOKEN', 'READWISE_TOKEN', 'RSSHUB_BASE_URL', 'PAPER_TRUSTED_FEED_ORIGINS', 'HOST']) vi.stubEnv(key, '')
    const config = loadConfig()
    expect(config.codex.enabled).toBe(false)
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
  it('uses the documented sync schedule when the setting is empty', () => {
    configured()
    vi.stubEnv('PAPER_SYNC_MINUTES', '')
    expect(loadConfig().sync.minutes).toEqual([28, 58])
  })
  it('validates the configured email time zone before running a briefing', () => {
    configured()
    vi.stubEnv('TZ', 'Pacific/Auckland')
    expect(loadConfig().timeZone).toBe('Pacific/Auckland')
    vi.stubEnv('TZ', 'not-a-time-zone')
    expect(loadConfig).toThrow('TZ must be a supported IANA time zone')
  })
})
