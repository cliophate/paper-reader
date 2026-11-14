import path from 'node:path'
import type { AiProvider } from '../shared/connections.js'

function value(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

function required(name: string): string {
  const result = value(name)
  if (!result) throw new Error(`Missing required environment variable ${name}`)
  return result
}

function optionalDate(name: string): Date | null {
  const raw = value(name)
  if (!raw) return null
  const result = new Date(raw)
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date in environment variable ${name}`)
  return result
}

function minuteList(name: string, fallback: number[]): number[] {
  const minutes = value(name)
    .split(',')
    .filter(part => part.trim())
    .map(part => Number(part.trim()))
    .filter(minute => Number.isInteger(minute) && minute >= 0 && minute <= 59)
  return minutes.length ? [...new Set(minutes)].sort((left, right) => left - right) : fallback
}

function trustedOrigins(name: string): string[] {
  return value(name).split(',').filter(part => part.trim()).map(part => {
    const url = new URL(part.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${name} must contain HTTP/HTTPS origins without credentials or paths`)
    }
    return url.origin
  })
}

function timeZone(): string {
  const result = value('TZ', 'UTC')
  try { new Intl.DateTimeFormat('en', { timeZone: result }) }
  catch { throw new Error('TZ must be a supported IANA time zone') }
  return result
}

export type Config = ReturnType<typeof loadConfig>

export function stateDirectory() { return value('STATE_DIR', path.resolve('data')) }

let warnedOpenCode = false

export function loadConfig(secrets?: { internalSecret: string; signingSecret: string }) {
  if (!warnedOpenCode && Object.keys(process.env).some(key => key.startsWith('OPENCODE_'))) {
    console.warn('OpenCode support was removed. Its environment variables are ignored. Enable Codex in Settings to use AI.')
    warnedOpenCode = true
  }
  const backend = value('PAPER_BACKEND', 'freshrss')
  if (backend !== 'freshrss' && backend !== 'standalone') throw new Error('PAPER_BACKEND must be freshrss or standalone')
  if (backend === 'standalone' && value('PAPER_LOCAL_READS', 'true') !== 'true') throw new Error('Standalone mode requires PAPER_LOCAL_READS=true')
  const provider = value('PAPER_AI_PROVIDER', value('CODEX_ENABLED') === 'true' ? 'codex' : 'none') as AiProvider
  if (!['none', 'codex', 'openai'].includes(provider)) throw new Error('PAPER_AI_PROVIDER must be none, codex or openai')
  const stateDir = stateDirectory()
  return {
    backend,
    port: Number(value('PORT', '8080')),
    host: value('HOST', '127.0.0.1'),
    readerFallbackEnabled: value('PAPER_READER_FALLBACK_ENABLED', 'false') === 'true',
    timeZone: timeZone(),
    trustedFeedOrigins: trustedOrigins('PAPER_TRUSTED_FEED_ORIGINS'),
    openai: {
      baseUrl: value('PAPER_OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      token: value('PAPER_OPENAI_API_KEY'),
      trustedOrigins: trustedOrigins('PAPER_TRUSTED_AI_ORIGINS'),
      discussionModel: value('PAPER_OPENAI_DISCUSSION_MODEL', 'gpt-6-luna'),
      headlinesModel: value('PAPER_OPENAI_HEADLINES_MODEL', 'gpt-6-luna'),
      groupingModel: value('PAPER_OPENAI_GROUPING_MODEL', 'gpt-6-luna'),
      shortlistModel: value('PAPER_OPENAI_SHORTLIST_MODEL', 'gpt-6-luna'),
      editorModel: value('PAPER_OPENAI_EDITOR_MODEL', 'gpt-6-luna'),
    },
    publicUrl: value('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, ''),
    stateDir,
    databasePath: path.join(stateDir, 'paper.sqlite'),
    freshRss: {
      baseUrl: (backend === 'freshrss' ? required('FRESHRSS_BASE_URL') : '').replace(/\/$/, ''),
      username: backend === 'freshrss' ? required('FRESHRSS_USERNAME') : '',
      apiPassword: backend === 'freshrss' ? required('FRESHRSS_API_PASSWORD') : '',
    },
    rssHub: {
      baseUrl: value('RSSHUB_BASE_URL').replace(/\/$/, ''),
    },
    readwise: {
      token: value('READWISE_TOKEN'),
      location: value('READWISE_LOCATION', 'later'),
    },
    kirby: {
      publishUrl: value('KIRBY_PUBLISH_URL'),
      token: value('KIRBY_PUBLISH_TOKEN'),
    },
    internalSecret: value('PAPER_INTERNAL_SECRET', secrets?.internalSecret) || required('PAPER_INTERNAL_SECRET'),
    ai: { provider, enabled: provider !== 'none', discussionEnabled: true, briefingsEnabled: true },
    collections: {
      enabled: value('PAPER_COLLECTIONS_ENABLED', 'true') === 'true',
      model: value('PAPER_COLLECTION_MODEL', value('CODEX_SHORTLIST_MODEL', 'gpt-5.6-luna')),
    },
    headlines: {
      enabled: value('PAPER_CLEAR_HEADLINES', 'true') === 'true',
      writerModel: value('PAPER_HEADLINE_WRITER_MODEL', 'gpt-5.6-terra'),
      reviewerModel: value('PAPER_HEADLINE_REVIEWER_MODEL', 'gpt-5.6-sol'),
    },
    signingSecret: value('PAPER_SIGNING_SECRET', secrets?.signingSecret) || required('PAPER_SIGNING_SECRET'),
    briefing: {
      includeReadUntil: optionalDate('PAPER_BRIEFING_INCLUDE_READ_UNTIL'),
    },
    sync: {
      enabled: value('PAPER_SYNC_ENABLED', 'true') === 'true',
      localReads: value('PAPER_LOCAL_READS', 'true') === 'true',
      minutes: minuteList('PAPER_SYNC_MINUTES', [28, 58]),
    },
    codex: {
      enabled: value('CODEX_ENABLED', 'false') === 'true',
      bin: value('CODEX_BIN', '/usr/local/bin/codex'),
      discussionModel: value('PAPER_DISCUSSION_MODEL', 'gpt-5.6-sol'),
      configDir: value('CODEX_BRIEFING_CONFIG_DIR', path.resolve('recap')),
      shortlistModel: value('CODEX_SHORTLIST_MODEL', 'gpt-5.6-luna'),
      editorModel: value('CODEX_EDITOR_MODEL', 'gpt-5.6-sol'),
    },

  }
}
