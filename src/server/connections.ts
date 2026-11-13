import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'
import type { ConnectionsSettings, ConnectionsUpdate } from '../shared/connections.js'

export class SettingsValidationError extends Error {}

const aiKeys = ['enabled', 'codexEnabled', 'discussionEnabled', 'briefingsEnabled', 'headlinesEnabled', 'collectionsEnabled'] as const
const locations = new Set(['new', 'later', 'archive', 'feed'])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsValidationError('Settings must be an object.')
  return value as Record<string, unknown>
}

// Never include submitted values in validation errors. They may contain credentials.
function validate(input: unknown): ConnectionsUpdate {
  const result: ConnectionsUpdate = {}
  for (const [section, raw] of Object.entries(object(input))) {
    if (section !== 'ai' && section !== 'readwise' && section !== 'kirby') throw new SettingsValidationError('Unknown connection.')
    const fields = object(raw)
    const allowed: readonly string[] = section === 'ai' ? aiKeys : section === 'readwise' ? ['enabled', 'location', 'token'] : ['enabled', 'publishUrl', 'token']
    const checked: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      // Accept old saved settings without restoring the removed provider.
      if (section === 'ai' && key === 'openCodeEnabled' && typeof value === 'boolean') continue
      if (!allowed.includes(key)) throw new SettingsValidationError('Unknown connection setting.')
      if (key === 'enabled' || section === 'ai') {
        if (typeof value !== 'boolean') throw new SettingsValidationError('Switches must be true or false.')
        checked[key] = value
      } else if (key === 'token') {
        if (value === null) { checked.token = null; continue }
        if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]/.test(value.trim())) throw new SettingsValidationError('Enter a valid token on one line without spaces.')
        if (value.trim()) checked.token = value.trim()
      } else if (key === 'location') {
        if (typeof value !== 'string' || !locations.has(value)) throw new SettingsValidationError('Choose a supported Reader location.')
        checked.location = value
      } else {
        if (typeof value !== 'string' || value.length > 2048) throw new SettingsValidationError('Enter a valid publishing URL.')
        checked.publishUrl = value.trim()
        if (!value.trim()) continue
        try {
          const url = new URL(value.trim())
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
        } catch { throw new SettingsValidationError('Use an HTTP or HTTPS publishing URL without credentials, query parameters, or a fragment.') }
      }
    }
    Object.assign(result, { [section]: checked })
  }
  return result
}

export class ConnectionSettings {
  private saved: ConnectionsUpdate = {}
  private readonly defaults: ConnectionsSettings & { readwiseToken: string; kirbyToken: string }
  private readonly filename: string

  constructor(private readonly config: Config) {
    this.filename = path.join(config.stateDir, 'connections.json')
    this.defaults = {
      ai: {
        enabled: config.codex.enabled,
        codexEnabled: true,
        discussionEnabled: config.ai.discussionEnabled,
        briefingsEnabled: config.ai.briefingsEnabled,
        headlinesEnabled: config.headlines.enabled,
        collectionsEnabled: config.collections.enabled,
      },
      readwise: { enabled: Boolean(config.readwise.token), location: config.readwise.location, tokenConfigured: false, tokenSource: null },
      kirby: { enabled: Boolean(config.kirby.token && config.kirby.publishUrl), publishUrl: config.kirby.publishUrl, tokenConfigured: false, tokenSource: null },
      readwiseToken: config.readwise.token,
      kirbyToken: config.kirby.token,
    }
    try {
      const stat = fs.lstatSync(this.filename)
      if (!stat.isFile() || stat.size > 32_768) throw new Error()
      fs.chmodSync(this.filename, 0o600)
      this.saved = validate(JSON.parse(fs.readFileSync(this.filename, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load private connection settings. Check connections.json and its permissions.')
    }
    this.apply()
  }

  private token(section: 'readwise' | 'kirby'): string {
    const saved = this.saved[section]?.token
    return saved === null ? '' : saved ?? this.defaults[`${section}Token`]
  }

  view(): ConnectionsSettings {
    const ai = { ...this.defaults.ai, ...this.saved.ai }
    const connection = (section: 'readwise' | 'kirby') => ({
      enabled: this.saved[section]?.enabled ?? this.defaults[section].enabled,
      tokenConfigured: Boolean(this.token(section)),
      tokenSource: this.token(section) ? (this.saved[section]?.token ? 'settings' as const : 'environment' as const) : null,
    })
    // Old environment URLs might contain credentials. Never echo those parts.
    let publishUrl = this.saved.kirby?.publishUrl ?? this.defaults.kirby.publishUrl
    try {
      const url = new URL(publishUrl)
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      publishUrl = url.toString()
    } catch { publishUrl = '' }
    return {
      ai,
      readwise: { ...connection('readwise'), location: this.saved.readwise?.location ?? this.defaults.readwise.location },
      kirby: { ...connection('kirby'), publishUrl },
    }
  }

  update(input: unknown): ConnectionsSettings {
    const patch = validate(input)
    const next = { ...this.saved }
    for (const section of ['ai', 'readwise', 'kirby'] as const) {
      if (patch[section]) Object.assign(next, { [section]: { ...this.saved[section], ...patch[section] } })
    }
    fs.mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, this.filename)
    } finally { fs.rmSync(temporary, { force: true }) }
    this.saved = next
    this.apply()
    return this.view()
  }

  private apply() {
    const view = this.view()
    this.config.codex.enabled = view.ai.enabled && view.ai.codexEnabled
    this.config.ai.discussionEnabled = view.ai.discussionEnabled
    this.config.ai.briefingsEnabled = view.ai.briefingsEnabled
    this.config.headlines.enabled = view.ai.headlinesEnabled
    this.config.collections.enabled = view.ai.collectionsEnabled
    Object.assign(this.config.readwise, { token: view.readwise.enabled ? this.token('readwise') : '', location: view.readwise.location })
    Object.assign(this.config.kirby, { token: view.kirby.enabled ? this.token('kirby') : '', publishUrl: this.saved.kirby?.publishUrl ?? this.defaults.kirby.publishUrl })
  }
}
