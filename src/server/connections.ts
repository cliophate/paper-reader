import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'
import type { ConnectionsSettings, ConnectionsUpdate, DestinationUpdate, SaveDestinationId } from '../shared/connections.js'
import type { BriefingSchedule, SmtpUpdate } from '../shared/briefing-delivery.js'
import { DestinationClient, destinationIds, isDestination, secretFields } from './save-destinations.js'
import { isIP } from 'node:net'

const address = String.raw`[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*`
const mailbox = new RegExp(`^${address}$`, 'i')
// A display name for the From header, such as Paper <briefings@example.com>.
const namedMailbox = new RegExp(`^[^<>@"\\\\]{1,100}\\s<${address}>$`, 'i')

export class SettingsValidationError extends Error {}

const aiKeys = ['enabled', 'codexEnabled', 'discussionEnabled', 'briefingsEnabled', 'headlinesEnabled', 'collectionsEnabled'] as const
const openaiKeys = ['baseUrl', 'token', 'discussionModel', 'headlinesModel', 'groupingModel', 'shortlistModel', 'editorModel'] as const
const maxSettingsBytes = 256 * 1024
const locations = new Set(['new', 'later', 'archive', 'feed'])

function sameSmtpConnection(a: Config['smtp'], b: Config['smtp']): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.security === b.security && a.user === b.user
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsValidationError('Settings must be an object.')
  return value as Record<string, unknown>
}

function validateSmtp(raw: unknown): SmtpUpdate {
  const checked: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object(raw))) {
    if (key === 'port') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new SettingsValidationError('Enter an SMTP port from 1 to 65535.')
    } else if (key === 'security') {
      if (value !== 'tls' && value !== 'starttls' && value !== 'none') throw new SettingsValidationError('Choose TLS, STARTTLS, or none for SMTP security.')
    } else if (key === 'password') {
      if (value !== null && (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) throw new SettingsValidationError('Enter the SMTP password on one line.')
      if (value === '') continue
    } else if (key === 'host' || key === 'user' || key === 'from' || key === 'to') {
      if (typeof value !== 'string' || value.length > 254 || /[\x00-\x1f\x7f]/.test(value)) throw new SettingsValidationError('Enter SMTP fields on one line.')
      const field = value.trim()
      if (key === 'host' && field && !isIP(field) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(field)) throw new SettingsValidationError('Enter an SMTP hostname or IP address without a URL or port.')
      if (key === 'from' && field && !mailbox.test(field) && !namedMailbox.test(field)) throw new SettingsValidationError('Enter the sender as an email address or as Name <address>.')
      if (key === 'to' && field && !mailbox.test(field)) throw new SettingsValidationError('Enter a single email address for the recipient.')
      checked[key] = field
      continue
    } else throw new SettingsValidationError('Unknown SMTP setting.')
    checked[key] = value
  }
  return checked
}

function validateSchedule(raw: unknown): Partial<BriefingSchedule> {
  const checked: Partial<BriefingSchedule> = {}
  for (const [key, value] of Object.entries(object(raw))) {
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw new SettingsValidationError('The delivery switch must be true or false.')
      checked.enabled = value
    } else if (key === 'morning' || key === 'evening') {
      if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new SettingsValidationError('Enter each briefing time in 24-hour HH:MM format.')
      checked[key] = value
    } else throw new SettingsValidationError('Unknown briefing schedule setting.')
  }
  return checked
}

// Never include submitted values in validation errors. They may contain credentials.
function validate(input: unknown): ConnectionsUpdate {
  const result: ConnectionsUpdate = {}
  for (const [section, raw] of Object.entries(object(input))) {
    if (section === 'smtp') { result.smtp = validateSmtp(raw); continue }
    if (section === 'briefingSchedule') { result.briefingSchedule = validateSchedule(raw); continue }
    const destination = isDestination(section) ? section : undefined
    if (!destination && section !== 'ai' && section !== 'readwise' && section !== 'kirby' && section !== 'openai') throw new SettingsValidationError('Unknown connection.')
    const fields = object(raw)
    const allowed: readonly string[] = destination
      ? ['enabled', ...(destination === 'raindrop' ? [] : ['baseUrl']), ...secretFields(destination)]
      : section === 'ai' ? [...aiKeys, 'provider'] : section === 'openai' ? openaiKeys : section === 'readwise' ? ['enabled', 'location', 'token'] : ['enabled', 'publishUrl', 'token']
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
      } else if (destination === 'wallabag' && key !== 'baseUrl') {
        if (value === null) { checked[key] = null; continue }
        if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new SettingsValidationError('Enter Wallabag credentials on one line.')
        if (value) checked[key] = value
      } else if (section === 'openai' && key !== 'baseUrl') {
        if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new SettingsValidationError('Enter a model name on one line, up to 200 characters.')
        checked[key] = value.trim()
      } else if (key === 'location') {
        if (typeof value !== 'string' || !locations.has(value)) throw new SettingsValidationError('Choose a supported Reader location.')
        checked.location = value
      } else {
        if (typeof value !== 'string' || value.length > 2048) throw new SettingsValidationError('Enter a valid URL.')
        checked[key] = value.trim()
        if (!value.trim() && (key === 'publishUrl' || destination)) continue
        try {
          const url = new URL(value.trim())
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
          if (destination) checked[key] = url.href.replace(/\/+$/, '')
        } catch { throw new SettingsValidationError('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.') }
      }
    }
    Object.assign(result, { [section]: checked })
  }
  return result
}

export class ConnectionSettings {
  private saved: ConnectionsUpdate = {}
  private readonly defaults: Omit<ConnectionsSettings, 'briefingDelivery' | 'saveDestinations'> & { readwiseToken: string; kirbyToken: string; openaiToken: string }
  private readonly filename: string
  private readonly destinationClients = new Map<SaveDestinationId, DestinationClient>()
  private readonly smtpDefaults: Config['smtp']
  private readonly scheduleDefaults: Config['briefingSchedule']

  constructor(private readonly config: Config) {
    this.filename = path.join(config.stateDir, 'connections.json')
    validateSmtp(config.smtp)
    validateSchedule(config.briefingSchedule)
    this.smtpDefaults = { ...config.smtp }
    this.scheduleDefaults = { ...config.briefingSchedule }
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
      if (!stat.isFile() || stat.size > maxSettingsBytes) throw new Error()
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

  discussionProvider() {
    const provider = this.config.ai.provider
    return { provider, model: provider === 'openai' ? this.config.openai.discussionModel : provider === 'codex' ? this.config.codex.discussionModel : '' }
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
    const { password, ...smtp } = this.smtpConfig()
    return {
      saveDestinations: destinationIds.map(id => this.destination(id).view()),
      briefingDelivery: {
        smtp: { ...smtp, passwordConfigured: Boolean(password), passwordSource: password ? (this.saved.smtp?.password ? 'settings' : 'environment') : null },
        schedule: { ...this.scheduleDefaults, ...this.saved.briefingSchedule },
        timeZone: this.config.timeZone,
      },
      ai,
      openai: { ...Object.fromEntries(openaiKeys.filter(key => key !== 'token').map(key => [key, this.saved.openai?.[key] ?? this.defaults.openai[key]])) as Omit<ConnectionsSettings['openai'], 'tokenConfigured' | 'tokenSource'>,
        tokenConfigured: Boolean(this.token('openai')), tokenSource: this.token('openai') ? (this.saved.openai?.token ? 'settings' : 'environment') : null },
      readwise: { ...connection('readwise'), location: this.saved.readwise?.location ?? this.defaults.readwise.location },
      kirby: { ...connection('kirby'), publishUrl },
    }
  }

  destination(id: SaveDestinationId) {
    let client = this.destinationClients.get(id)
    if (!client) {
      client = new DestinationClient(id, this.saved[id] ?? {}, this.config.trustedSaveOrigins)
      this.destinationClients.set(id, client)
    }
    return client
  }

  private checkDestinationUrl(id: SaveDestinationId, patch: DestinationUpdate) {
    const saved = this.saved[id]
    if (patch.baseUrl !== undefined && patch.baseUrl !== saved?.baseUrl && secretFields(id).some(key => saved?.[key] && patch[key] === undefined)) {
      throw new SettingsValidationError('Enter the credentials again for the new base URL, or remove them.')
    }
  }

  destinationTestClient(id: SaveDestinationId, input: unknown) {
    const patch = validate({ [id]: input })[id]!
    this.checkDestinationUrl(id, patch)
    return new DestinationClient(id, { ...this.saved[id], ...patch }, this.config.trustedSaveOrigins)
  }

  // A key only goes to the origin it was saved for. A new scheme, host or port
  // needs the key again or an explicit removal, so the environment key can't return either.
  private requireKeyForOrigin(patch: ConnectionsUpdate['openai']) {
    if (patch?.baseUrl === undefined || patch.token !== undefined || !this.token('openai')) return
    const origin = (value: string) => { try { return new URL(value).origin } catch { return '' } }
    if (origin(patch.baseUrl) !== origin(this.config.openai.baseUrl)) {
      throw new SettingsValidationError('Enter the API key again for the new base URL, or remove the saved key.')
    }
  }

  openaiTestConfig(input: unknown): Config['openai'] {
    const patch = validate({ openai: input }).openai!
    this.requireKeyForOrigin(patch)
    return { ...this.config.openai, ...patch, token: patch.token === null ? '' : patch.token ?? this.token('openai') }
  }

  private smtpConfig(patch?: SmtpUpdate): Config['smtp'] {
    const config = { ...this.smtpDefaults, ...this.saved.smtp, ...patch, password: '' }
    const password = patch?.password === undefined ? this.saved.smtp?.password : patch.password
    config.password = password === undefined && sameSmtpConnection(config, this.smtpDefaults) ? this.smtpDefaults.password : password ?? ''
    return config
  }

  private requirePasswordForServer(patch: SmtpUpdate | undefined) {
    if (!patch || patch.password !== undefined || !this.config.smtp.password) return
    const next = this.smtpConfig(patch)
    if (!sameSmtpConnection(next, this.config.smtp)) {
      throw new SettingsValidationError('Enter the SMTP password again for the new connection, or remove it.')
    }
  }

  smtpTestConfig(input: unknown): Config['smtp'] {
    const patch = validateSmtp(input)
    this.requirePasswordForServer(patch)
    return this.smtpConfig(patch)
  }

  update(input: unknown): ConnectionsSettings {
    const patch = validate(input)
    for (const id of destinationIds) if (patch[id]) this.checkDestinationUrl(id, patch[id])
    this.requireKeyForOrigin(patch.openai)
    this.requirePasswordForServer(patch.smtp)
    if (patch.smtp?.password) {
      const { host, port, security, user } = this.smtpConfig(patch.smtp)
      patch.smtp = { ...patch.smtp, host, port, security, user }
    }
    if (patch.ai?.provider === undefined && patch.ai?.codexEnabled !== undefined) {
      patch.ai.provider = patch.ai.codexEnabled ? 'codex' : 'none'
    }
    const next = { ...this.saved }
    for (const section of ['ai', 'readwise', 'kirby', 'openai', 'smtp', 'briefingSchedule', ...destinationIds] as const) {
      if (patch[section]) Object.assign(next, { [section]: { ...this.saved[section], ...patch[section] } })
    }
    const contents = JSON.stringify(next, null, 2) + '\n'
    if (Buffer.byteLength(contents) > maxSettingsBytes) throw new SettingsValidationError('Connection settings are too large.')
    fs.mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, this.filename)
    } finally { fs.rmSync(temporary, { force: true }) }
    for (const id of destinationIds) if (patch[id]) this.destinationClients.delete(id)
    this.saved = next
    this.apply()
    return this.view()
  }

  private apply() {
    const view = this.view()
    this.config.smtp = this.smtpConfig()
    this.config.briefingSchedule = view.briefingDelivery.schedule
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
