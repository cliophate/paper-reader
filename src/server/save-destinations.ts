import type { DestinationSecret, DestinationUpdate, SaveDestinationId } from '../shared/connections.js'
import { boundedApiRequest, FeedHttpError } from './feed-http.js'

interface Article { url: string; title: string; tags: string[] }
type JsonObject = Record<string, unknown>
interface Service {
  name: string
  profile: string
  validProfile: (data: JsonObject) => boolean
  save: string
  payload: (article: Article) => object
  confirmed: (data: JsonObject, status: number) => boolean
}

function hasId(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'id' in value && typeof value.id === 'number'
}

const services: Record<SaveDestinationId, Service> = {
  linkding: {
    name: 'Linkding', profile: 'api/user/profile/', validProfile: data => typeof data.theme === 'string',
    save: 'api/bookmarks/', payload: ({ url, title, tags }) => ({ url, title, tag_names: tags }), confirmed: hasId,
  },
  wallabag: {
    name: 'Wallabag', profile: 'api/user.json', validProfile: hasId,
    save: 'api/entries.json', payload: ({ url, title, tags }) => new URLSearchParams({ url, title, tags: tags.join(',') }), confirmed: hasId,
  },
  readeck: {
    name: 'Readeck', profile: 'api/profile', validProfile: data => !!data.user && typeof data.user === 'object',
    save: 'api/bookmarks', payload: ({ url, title, tags }) => ({ url, title, labels: tags }), confirmed: (_data, status) => status === 202,
  },
  raindrop: {
    name: 'Raindrop.io', profile: 'rest/v1/user', validProfile: data => data.result === true && !!data.user,
    save: 'rest/v1/raindrop', payload: ({ url, title, tags }) => ({ link: url, title, tags }), confirmed: data => data.result === true,
  },
  linkwarden: {
    name: 'Linkwarden', profile: 'api/v1/users/me', validProfile: data => hasId(data.response),
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

export class DestinationClient {
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

  private async request(path: string, authorization?: string, payload?: object | URLSearchParams) {
    if (!this.ready) throw new DestinationError(`Finish setting up ${this.service.name} in Reading & connections.`)
    const base = this.id === 'raindrop' ? 'https://api.raindrop.io' : this.settings.baseUrl!
    const url = new URL(base)
    url.pathname = url.pathname.replace(/\/+$/, '') + '/' + path
    const form = payload instanceof URLSearchParams
    try {
      return await boundedApiRequest(url, this.trustedOrigins, { authorization, body: form ? payload.toString() : JSON.stringify(payload),
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

  private async authenticated(path: string, payload?: object) {
    const token = this.id === 'wallabag' ? await this.wallabagToken() : this.settings.token
    const scheme = this.id === 'linkding' ? 'Token' : 'Bearer'
    let response = await this.request(path, `${scheme} ${token}`, payload)
    if (this.id === 'wallabag' && response.status === 401) {
      if (this.session && this.session.access === token) this.session.expires = 0
      response = await this.request(path, `Bearer ${await this.wallabagToken()}`, payload)
    }
    this.check(response.status)
    return response
  }

  async test() {
    const response = await this.authenticated(this.service.profile)
    const profile = jsonObject(response.text)
    if (profile && this.service.validProfile(profile)) return
    throw new DestinationError(`${this.name} returned an unexpected profile. Check the connection settings.`)
  }

  async save(article: Article) {
    const response = await this.authenticated(this.service.save, this.service.payload(article))
    if (this.service.confirmed(jsonObject(response.text) ?? {}, response.status)) return
    throw new DestinationError(`${this.service.name} did not confirm the save. Check the destination before trying again.`)
  }
}
