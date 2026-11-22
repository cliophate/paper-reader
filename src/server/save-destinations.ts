import type { DestinationSecret, DestinationUpdate, SaveDestinationId } from '../shared/connections.js'
import { type ApiRequest, boundedApiRequest, FeedHttpError } from './feed-http.js'

interface Article { url: string; title: string; tags: string[] }
type JsonObject = Record<string, unknown>
interface Service {
  name: string
  maxTitle?: number
  maxTag?: number
  maxUrl?: number
  countCodePoints?: boolean
  commaSeparatedTags?: boolean
  profile: string
  validProfile: (data: JsonObject) => boolean
  save: string
  payload: (article: Article) => object
  confirmed: (data: JsonObject, status: number) => boolean
}

function hasId(value: unknown): value is JsonObject & { id: number } {
  return !!value && typeof value === 'object' && 'id' in value && typeof value.id === 'number'
}

const services: Record<SaveDestinationId, Service> = {
  linkding: {
    name: 'Linkding', maxTitle: 512, maxTag: 64, maxUrl: 2048, countCodePoints: true, commaSeparatedTags: true,
    profile: 'api/user/profile/', validProfile: data => typeof data.theme === 'string',
    save: 'api/bookmarks/', payload: ({ url, title, tags }) => ({ url, title, tag_names: tags }), confirmed: hasId,
  },
  wallabag: {
    name: 'Wallabag', commaSeparatedTags: true, profile: 'api/user.json', validProfile: hasId,
    save: 'api/entries.json', payload: ({ url, title, tags }) => new URLSearchParams({ url, title, tags: tags.join(',') }), confirmed: hasId,
  },
  readeck: {
    name: 'Readeck', maxTitle: 1024, maxUrl: 1024, countCodePoints: true, profile: 'api/profile', validProfile: data => !!data.user && typeof data.user === 'object',
    save: 'api/bookmarks', payload: ({ url, title, tags }) => ({ url, title, labels: tags }), confirmed: (_data, status) => status === 202,
  },
  raindrop: {
    name: 'Raindrop.io', maxTitle: 1000, profile: 'rest/v1/user', validProfile: data => data.result === true && !!data.user,
    save: 'rest/v1/raindrop', payload: ({ url, title, tags }) => ({ link: url, title, tags }), confirmed: data => data.result === true,
  },
  linkwarden: {
    name: 'Linkwarden', maxTitle: 2048, maxTag: 50, maxUrl: 2048,
    profile: 'api/v1/collections', validProfile: data => Array.isArray(data.response),
    save: 'api/v1/links', payload: ({ url, title, tags }) => ({ url, name: title, tags: tags.map(name => ({ name })) }),
    confirmed: data => hasId(data.response),
  },
}

export const destinationIds = Object.keys(services) as SaveDestinationId[]
export const isDestination = (id: string): id is SaveDestinationId => Object.hasOwn(services, id)
export const secretFields = (id: SaveDestinationId): DestinationSecret[] =>
  id === 'wallabag' ? ['clientId', 'clientSecret', 'username', 'password'] : ['token']

export class DestinationError extends Error {}

function jsonObject(text: string) {
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* The remote body can contain credentials. */ }
  return null
}

// Django and Readeck count code points. JavaScript validators count UTF-16 units.
function shorten(value: string, limit: number | undefined, countCodePoints = false) {
  if (limit === undefined || value.length <= limit) return value
  if (countCodePoints) return Array.from(value).slice(0, limit).join('')
  const prefix = value.slice(0, limit)
  const last = prefix.charCodeAt(prefix.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix
}

export class DestinationClient {
  private readonly pendingLinkdingSaves = new Map<string, Promise<string | undefined>>()
  private readonly service: Service
  private session?: { access: string; refresh?: string; expires: number }
  private refreshing?: Promise<string>

  constructor(readonly id: SaveDestinationId, private readonly settings: DestinationUpdate, private readonly trustedOrigins: readonly string[]) {
    this.service = services[id]
  }

  get name() { return this.service.name }
  get configured() { return !!this.settings.enabled && this.ready }

  view() {
    return { id: this.id, name: this.name, enabled: !!this.settings.enabled, baseUrl: this.settings.baseUrl ?? '',
      savedSecrets: secretFields(this.id).filter(key => !!this.settings[key]) }
  }

  get ready() {
    return (this.id === 'raindrop' || !!this.settings.baseUrl) && secretFields(this.id).every(key => !!this.settings[key])
  }

  private async request(path: string, authorization?: string, payload?: object, method?: ApiRequest['method']) {
    if (!this.ready) throw new DestinationError(`Finish setting up ${this.service.name} in Reading & connections.`)
    const base = this.id === 'raindrop' ? 'https://api.raindrop.io' : this.settings.baseUrl!
    const url = new URL(path, base.replace(/\/+$/, '') + '/')
    const form = payload instanceof URLSearchParams
    try {
      return await boundedApiRequest(url, this.trustedOrigins, { method, authorization, body: form ? payload.toString() : JSON.stringify(payload),
        contentType: form ? 'application/x-www-form-urlencoded' : 'application/json' })
    } catch (error) {
      if (error instanceof FeedHttpError && error.code === 'policy') throw new DestinationError('Use public HTTPS or ask the administrator to add the exact origin to PAPER_TRUSTED_SAVE_ORIGINS.')
      if (error instanceof FeedHttpError && error.code === 'redirect') throw new DestinationError(`${this.service.name} redirected the request. Check the base URL.`)
      throw new DestinationError(`Could not complete the request to ${this.service.name}. Check the connection.`)
    }
  }

  private check(status: number) {
    if (status === 401 || status === 403) throw new DestinationError(`${this.service.name} denied access. Check the credentials and permissions in Settings.`)
    if (status < 200 || status >= 300) throw new DestinationError(`${this.service.name} returned HTTP ${status}.`)
  }

  private async exchange() {
    const credentials = { client_id: this.settings.clientId!, client_secret: this.settings.clientSecret! }
    const token = (fields: Record<string, string>) => this.request('oauth/v2/token', undefined, new URLSearchParams({ ...credentials, ...fields }))
    let response
    if (this.session?.refresh) response = await token({ grant_type: 'refresh_token', refresh_token: this.session.refresh })
    if (!response || response.status === 400 || response.status === 401) {
      response = await token({ grant_type: 'password', username: this.settings.username!, password: this.settings.password! })
    }
    if (response.status === 400) throw new DestinationError('Wallabag rejected the login. Check the client and account credentials.')
    this.check(response.status)
    const data = jsonObject(response.text)
    if (typeof data?.access_token !== 'string' || !/^[\x21-\x7e]+$/.test(data.access_token) || !(Number(data.expires_in) > 0)) {
      throw new DestinationError('Wallabag returned an invalid access token.')
    }
    this.session = { access: data.access_token, expires: Date.now() + Number(data.expires_in) * 1000,
      refresh: typeof data.refresh_token === 'string' ? data.refresh_token : undefined }
    return this.session.access
  }

  private async wallabagToken() {
    if (this.session && this.session.expires > Date.now() + 5000) return this.session.access
    this.refreshing ??= this.exchange().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async authenticated(path: string, payload?: object, method?: ApiRequest['method']) {
    const token = this.id === 'wallabag' ? await this.wallabagToken() : this.settings.token
    const scheme = this.id === 'linkding' ? 'Token' : 'Bearer'
    let response = await this.request(path, `${scheme} ${token}`, payload, method)
    if (this.id === 'wallabag' && response.status === 401) {
      if (this.session && this.session.access === token) this.session.expires = 0
      response = await this.request(path, `Bearer ${await this.wallabagToken()}`, payload, method)
    }
    this.check(response.status)
    return response
  }

  async test() {
    const response = await this.authenticated(this.service.profile)
    const profile = jsonObject(response.text)
    if (profile && this.service.validProfile(profile)) return
    throw new DestinationError(`${this.name} returned an unexpected response. Check the connection settings.`)
  }

  private async existingLinkdingBookmark(url: string) {
    const response = await this.authenticated(`api/bookmarks/check/?${new URLSearchParams({ url })}`)
    const bookmark = jsonObject(response.text)?.bookmark
    if (bookmark === null) return null
    if (!hasId(bookmark) || !Number.isSafeInteger(bookmark.id) || bookmark.id <= 0 ||
        !Array.isArray(bookmark.tag_names) || !bookmark.tag_names.every(tag => typeof tag === 'string')) {
      throw new DestinationError('Linkding could not confirm whether this URL is already bookmarked.')
    }
    return { id: bookmark.id, tags: bookmark.tag_names }
  }

  async save(article: Article) {
    if (this.id !== 'linkding') return this.saveBookmark(article)
    // Two saves of the same URL must each see the tags from the previous write.
    const pending = this.pendingLinkdingSaves.get(article.url)
    const save = async () => this.saveBookmark(article)
    const next = pending ? pending.then(save, save) : save()
    this.pendingLinkdingSaves.set(article.url, next)
    try { return await next } finally {
      if (this.pendingLinkdingSaves.get(article.url) === next) this.pendingLinkdingSaves.delete(article.url)
    }
  }

  private async saveBookmark(article: Article) {
    const { maxTitle, maxTag, maxUrl, countCodePoints, commaSeparatedTags } = this.service
    if (shorten(article.url, maxUrl, countCodePoints) !== article.url) {
      throw new DestinationError(`${this.name} accepts article URLs up to ${maxUrl} characters long.`)
    }
    const notes = new Set<string>()
    const tags = article.tags.map(tag => {
      const name = commaSeparatedTags ? tag.replace(/\s*,\s*/g, '-') : tag
      const short = shorten(name, maxTag, countCodePoints)
      if (short !== name) notes.add(`Paper shortened tags to fit the ${maxTag}-character limit.`)
      return short
    })
    const existing = this.id === 'linkding' ? await this.existingLinkdingBookmark(article.url) : null
    let response
    if (existing) {
      const merged = new Set(existing.tags)
      if (tags.every(tag => merged.has(tag))) return [...notes].join(' ') || undefined
      for (const tag of tags) merged.add(tag)
      response = await this.authenticated(`api/bookmarks/${existing.id}/`, { tag_names: [...merged] }, 'PATCH')
    } else {
      const title = shorten(article.title, maxTitle, countCodePoints)
      if (title !== article.title) notes.add(`Paper shortened the title to fit the ${maxTitle}-character limit.`)
      response = await this.authenticated(this.service.save, this.service.payload({ ...article, title, tags: [...new Set(tags)] }))
    }
    if (!this.service.confirmed(jsonObject(response.text) ?? {}, response.status)) {
      throw new DestinationError(`${this.name} did not confirm the save. Check the destination before trying again.`)
    }
    return [...notes].join(' ') || undefined
  }
}
