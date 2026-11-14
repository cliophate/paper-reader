import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'
import type { ConnectionsSettings, ConnectionsUpdate } from '../shared/connections.js'

export class SettingsValidationError extends Error {}

const aiKeys = ['enabled', 'codexEnabled', 'discussionEnabled', 'briefingsEnabled', 'headlinesEnabled', 'collectionsEnabled'] as const
const openaiKeys = ['baseUrl', 'token', 'discussionModel', 'headlinesModel', 'groupingModel', 'shortlistModel', 'editorModel'] as const
const locations = new Set(['new', 'later', 'archive', 'feed'])

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsValidationError('Settings must be an object.')
  return value as Record<string, unknown>
}

// Never include submitted values in validation errors. They may contain credentials.
function validate(input: unknown): ConnectionsUpdate {
  const result: ConnectionsUpdate = {}
  for (const [section, raw] of Object.entries(object(input))) {
    if (section !== 'ai' && section !== 'readwise' && section !== 'kirby' && section !== 'openai') throw new SettingsValidationError('Unknown connection.')
    const fields = object(raw)
    const allowed: readonly string[] = section === 'ai' ? [...aiKeys, 'provider'] : section === 'openai' ? openaiKeys : section === 'readwise' ? ['enabled', 'location', 'token'] : ['enabled', 'publishUrl', 'token']
    const checked: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      // Accept old saved settings without restoring the removed provider.
      if (section === 'ai' && key === 'openCodeEnabled' && typeof value === 'boolean') continue
      if (!allowed.includes(key)) throw new SettingsValidationError('Unknown connection setting.')
      if (key === 'provider') {
        if (!['none', 'codex', 'openai'].includes(value as string)) throw new SettingsValidationError('Choose an AI provider.')
        checked.provider = value
      } else if (key === 'enabled' || section === 'ai') {
        if (typeof value !== 'boolean') throw new SettingsValidationError('Switches must be true or false.')
        checked[key] = value
      } else if (key === 'token') {
        if (value === null) { checked.token = null; continue }
        if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]/.test(value.trim())) throw new SettingsValidationError('Enter a valid token on one line without spaces.')
        if (value.trim()) checked.token = value.trim()
      } else if (section === 'openai' && key !== 'baseUrl') {
        if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new SettingsValidationError('Enter a model name on one line, up to 200 characters.')
        checked[key] = value.trim()
      } else if (key === 'location') {
        if (typeof value !== 'string' || !locations.has(value)) throw new SettingsValidationError('Choose a supported Reader location.')
        checked.location = value
      } else {
        if (typeof value !== 'string' || value.length > 2048) throw new SettingsValidationError('Enter a valid URL.')
        checked[key] = value.trim()
        if (!value.trim() && key === 'publishUrl') continue
        try {
          const url = new URL(value.trim())
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
        } catch { throw new SettingsValidationError('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.') }
      }
    }
    Object.assign(result, { [section]: checked })
  }
  return result
}

export class ConnectionSettings {
  private saved: ConnectionsUpdate = {}
  private readonly defaults: ConnectionsSettings & { readwiseToken: string; kirbyToken: string; openaiToken: string }
  private readonly filename: string

  constructor(private readonly config: Config) {
    this.filename = path.join(config.stateDir, 'connections.json')
    this.defaults = {
      ai: {
        enabled: config.ai.enabled,
        provider: config.ai.provider,
        codexEnabled: true,
        discussionEnabled: config.ai.discussionEnabled,
        briefingsEnabled: config.ai.briefingsEnabled,
        headlinesEnabled: config.headlines.enabled,
        collectionsEnabled: config.collections.enabled,
      },
      openai: { ...Object.fromEntries(openaiKeys.filter(key => key !== 'token').map(key => [key, config.openai[key]])) as Omit<ConnectionsSettings['openai'], 'tokenConfigured' | 'tokenSource'>, tokenConfigured: false, tokenSource: null },
      openaiToken: config.openai.token,
      readwise: { enabled: Boolean(config.readwise.token), location: config.readwise.location, tokenConfigured: false, tokenSource: null },
      kirby: { enabled: Boolean(config.kirby.token && config.kirby.publishUrl), publishUrl: config.kirby.publishUrl, tokenConfigured: false, tokenSource: null },
      readwiseToken: config.readwise.token,
      kirbyToken: config.kirby.token,
    }
    try { validate({ openai: { ...Object.fromEntries(openaiKeys.map(key => [key, config.openai[key]])) } }) }
    catch { throw new Error('Invalid OpenAI-compatible API configuration. Check its URL, key and model names.') }
    try {
      const stat = fs.lstatSync(this.filename)
      if (!stat.isFile() || stat.size > 32_768) throw new Error()
      fs.chmodSync(this.filename, 0o600)
      this.saved = validate(JSON.parse(fs.readFileSync(this.filename, 'utf8')))
      // Migrate the old switch once. New settings always choose a provider explicitly.
      if (this.saved.ai && !this.saved.ai.provider) this.saved.ai.provider = (this.saved.ai.codexEnabled ?? true) ? 'codex' : 'none'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load private connection settings. Check connections.json and its permissions.')
    }
    this.apply()
  }

  private token(section: 'readwise' | 'kirby' | 'openai'): string {
    const saved = this.saved[section]?.token
    return saved === null ? '' : saved ?? this.defaults[`${section}Token`]
  }

  view(): ConnectionsSettings {
    const ai = { ...this.defaults.ai, ...this.saved.ai }
    ai.codexEnabled = ai.provider === 'codex'
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
      openai: { ...Object.fromEntries(openaiKeys.filter(key => key !== 'token').map(key => [key, this.saved.openai?.[key] ?? this.defaults.openai[key]])) as Omit<ConnectionsSettings['openai'], 'tokenConfigured' | 'tokenSource'>,
        tokenConfigured: Boolean(this.token('openai')), tokenSource: this.token('openai') ? (this.saved.openai?.token ? 'settings' : 'environment') : null },
      readwise: { ...connection('readwise'), location: this.saved.readwise?.location ?? this.defaults.readwise.location },
      kirby: { ...connection('kirby'), publishUrl },
    }
  }

  openaiTestConfig(input: unknown): Config['openai'] {
    const patch = validate({ openai: input }).openai!
    return { ...this.config.openai, ...patch, token: patch.token === null ? '' : patch.token ?? this.token('openai') }
  }

  update(input: unknown): ConnectionsSettings {
    const patch = validate(input)
    if (patch.ai?.provider === undefined && patch.ai?.codexEnabled !== undefined) {
      patch.ai.provider = patch.ai.codexEnabled ? 'codex' : 'none'
    }
    const next = { ...this.saved }
    for (const section of ['ai', 'readwise', 'kirby', 'openai'] as const) {
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
    this.config.ai.enabled = view.ai.enabled
    this.config.ai.provider = view.ai.provider
    this.config.codex.enabled = view.ai.enabled && view.ai.provider === 'codex'
    for (const key of openaiKeys) {
      if (key !== 'token') this.config.openai[key] = view.openai[key]
    }
    this.config.openai.token = this.token('openai')
    this.config.ai.discussionEnabled = view.ai.discussionEnabled
    this.config.ai.briefingsEnabled = view.ai.briefingsEnabled
    this.config.headlines.enabled = view.ai.headlinesEnabled
    this.config.collections.enabled = view.ai.collectionsEnabled
    Object.assign(this.config.readwise, { token: view.readwise.enabled ? this.token('readwise') : '', location: view.readwise.location })
    Object.assign(this.config.kirby, { token: view.kirby.enabled ? this.token('kirby') : '', publishUrl: this.saved.kirby?.publishUrl ?? this.defaults.kirby.publishUrl })
  }
}
