import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { domainToASCII } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { feedFragment, supportedSelector } from './feed-rewrites.js'
import type { FeedOverrideOptions, FeedOverrideUpdate, FeedOverrideView } from '../shared/feed-overrides.js'
import { BackendValidationError } from './backend.js'
import { validateRequestHeader } from './feed-http.js'
import { runtimeSecrets } from './runtime-secrets.js'
import { transaction } from './transaction.js'
import { FEED_OVERRIDE_VERSION } from './auth-schema.js'

const defaults: FeedOverrideOptions = { userAgent: '', articleCookieOrigin: '', contentSelector: '', removeSelectors: [], lazyImages: false, stripTracking: false }

export function migrateFeedOverrides(db: DatabaseSync) {
  transaction(db, () => db.exec(`CREATE TABLE IF NOT EXISTS feed_overrides (
    feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
    revision TEXT NOT NULL UNIQUE, options TEXT NOT NULL, cookie TEXT NOT NULL, cookie_origin TEXT NOT NULL
  ); PRAGMA user_version = ${FEED_OVERRIDE_VERSION}`))
}

export function validateOverrides(input: unknown): FeedOverrideUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BackendValidationError('Enter feed overrides.')
  const rules = input as Record<string, unknown>
  const { userAgent, cookie, expectedCookieOrigin, contentSelector, removeSelectors, lazyImages, stripTracking } = rules
  if (expectedCookieOrigin !== undefined && typeof expectedCookieOrigin !== 'string') throw new BackendValidationError('Choose a valid feed origin.')
  validateRequestHeader(userAgent, 'User agent', 512)
  if (cookie !== undefined && cookie !== null) validateRequestHeader(cookie, 'Cookie', 4096)
  if (typeof lazyImages !== 'boolean' || typeof stripTracking !== 'boolean') throw new BackendValidationError('Choose valid rewrite settings.')
  if (typeof contentSelector !== 'string' || !Array.isArray(removeSelectors) || removeSelectors.length > 12) throw new BackendValidationError('Use at most 12 removal selectors.')
  const hosts = rules.trackingExcludedHosts ?? []
  if (!Array.isArray(hosts) || hosts.length > 32) throw new BackendValidationError('Enter at most 32 hosts for link cleanup.')
  const trackingExcludedHosts = [...new Set(hosts.map(host => {
    const name = typeof host === 'string' && host.length <= 253 && !/[\s\\/?#@*%]/.test(host) && domainToASCII(host)
    if (!name) throw new BackendValidationError('Enter one hostname per line for link cleanup.')
    return name.replace(/\.$/, '')
  }))]
  let articleCookieOrigin = ''
  if (rules.articleCookieOrigin !== undefined && rules.articleCookieOrigin !== '') {
    const value = rules.articleCookieOrigin
    const origin = typeof value === 'string' && value.length <= 512 ? URL.parse(value) : null
    if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
      throw new BackendValidationError('Enter the article site origin, including http or https, without a path.')
    }
    articleCookieOrigin = origin.origin
  }
  let fragment: DocumentFragment | undefined
  let count = 0
  for (const selector of [contentSelector, ...removeSelectors]) {
    if (typeof selector !== 'string' || selector.length > 256 || /[\x00-\x1f\x7f]/.test(selector)) throw new BackendValidationError('Use a single line of up to 256 characters per selector.')
    if (!selector.trim()) continue
    count += selector.split(',').length
    if (count > 12 + Number(Boolean(contentSelector.trim()))) throw new BackendValidationError('Use at most 12 removal selectors and one content selector.')
    if (!supportedSelector(selector)) throw new BackendValidationError('Use simple CSS selectors without escapes, comments or functional pseudo-classes such as :has().')
    fragment ??= feedFragment('<p></p>')
    try { fragment.querySelector(selector) } catch { throw new BackendValidationError('Enter a valid CSS selector.') }
  }
  return { trackingExcludedHosts, userAgent: userAgent.trim(), articleCookieOrigin, expectedCookieOrigin, cookie: cookie?.trim() || (cookie === undefined ? undefined : null),
    contentSelector: contentSelector.trim(), removeSelectors: removeSelectors.map(value => value.trim()).filter(Boolean), lazyImages, stripTracking }
}

export interface SavedOverrides extends FeedOverrideOptions {
  revision: string
  cookie: string
  cookieOrigin: string
}

export function hasFeedOverrides(options: FeedOverrideOptions, cookie: string): boolean {
  return Boolean(cookie || options.userAgent || options.contentSelector || options.removeSelectors.length || options.stripTracking || options.lazyImages)
}

export class FeedOverrideStore {
  constructor(private readonly db: DatabaseSync, private readonly directory: string) {}

  private cookieKey?: Buffer

  private key() {
    return this.cookieKey ??= createHmac('sha256', runtimeSecrets(this.directory).signingSecret).update('Paper feed cookies v1').digest()
  }

  private seal(feedId: string, origin: string, articleOrigin: string, value: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    cipher.setAAD(Buffer.from(JSON.stringify([feedId, origin, articleOrigin])))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
  }

  get(feedId: string): SavedOverrides | undefined {
    const row = this.db.prepare('SELECT * FROM feed_overrides WHERE feed_id = ?').get(feedId)
    if (!row) return
    const options = JSON.parse(String(row.options)) as FeedOverrideOptions
    let cookie = ''
    const cookieOrigin = String(row.cookie_origin)
    if (row.cookie) {
      const data = Buffer.from(String(row.cookie), 'base64')
      const cipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12))
      cipher.setAAD(Buffer.from(JSON.stringify([feedId, cookieOrigin, options.articleCookieOrigin])))
      cipher.setAuthTag(data.subarray(12, 28))
      cookie = Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString()
    }
    return { ...options, revision: String(row.revision), cookie, cookieOrigin }
  }

  warn(revision: string, reason: string) {
    this.db.prepare("UPDATE feed_overrides SET options = json_set(options, '$.overrideWarning', ?) WHERE revision = ?").run(reason, revision)
  }

  article(entryId: string) {
    return this.db.prepare('SELECT url, feed_id AS feedId FROM entries WHERE id = ?').get(entryId) as
      { url: string; feedId: string } | undefined
  }

  private feedUrl(feedId: string) {
    const feed = this.db.prepare('SELECT url FROM feeds WHERE id = ? AND active = 1').get(feedId)
    if (!feed) throw new BackendValidationError('Select an active feed.')
    return String(feed.url)
  }

  view(feedId: string): FeedOverrideView {
    this.feedUrl(feedId)
    const row = this.db.prepare("SELECT options, cookie != '' AS cookieSet, cookie_origin FROM feed_overrides WHERE feed_id = ?").get(feedId)
    const articles = this.db.prepare(`SELECT id, title FROM entries WHERE feed_id = ? AND kind = 'article' AND url != ''
      ORDER BY timestamp DESC, id DESC LIMIT 10`).all(feedId) as Array<{ id: string; title: string }>
    return { ...(row ? JSON.parse(String(row.options)) : defaults), cookieSet: Boolean(row?.cookieSet), cookieOrigin: String(row?.cookie_origin || ''), articles }
  }

  draft(feedId: string, input: unknown): SavedOverrides {
    return this.resolveDraft(feedId, validateOverrides(input))
  }

  private resolveDraft(feedId: string, { cookie, expectedCookieOrigin, ...options }: FeedOverrideUpdate): SavedOverrides {
    const url = this.feedUrl(feedId)
    const saved = cookie === undefined ? this.get(feedId) : undefined
    if (saved?.cookie && options.articleCookieOrigin && options.articleCookieOrigin !== saved.articleCookieOrigin) {
      throw new BackendValidationError('Enter the cookie again to send it to a different article site.')
    }
    if (!saved?.cookie && !cookie) options.articleCookieOrigin = ''
    const feedOrigin = URL.parse(url)?.origin
    if (cookie && (!feedOrigin || feedOrigin === 'null' || expectedCookieOrigin !== feedOrigin)) {
      throw new BackendValidationError('Check the feed origin and enter the cookie again.')
    }
    return { ...options, revision: '', cookie: cookie === undefined ? saved?.cookie || '' : cookie || '',
      cookieOrigin: cookie === undefined ? saved?.cookieOrigin || '' : cookie ? feedOrigin! : '' }
  }

  save(feedId: string, input: unknown) {
    const inputRules = validateOverrides(input)
    transaction(this.db, () => {
      const { cookie, cookieOrigin, revision: _, ...rules } = this.resolveDraft(feedId, inputRules)
      const previous = this.db.prepare('SELECT revision FROM feed_overrides WHERE feed_id = ?').get(feedId)
      this.db.prepare('DELETE FROM feed_overrides WHERE feed_id = ?').run(feedId)
      if (previous) {
        this.db.prepare('DELETE FROM article_cache WHERE url GLOB ?').run(`paper-feed:${previous.revision}:*`)
        this.db.prepare("UPDATE entries SET full_content_text = '' WHERE feed_id = ? AND full_content_text != ''").run(feedId)
      }
      if (hasFeedOverrides(rules, cookie)) {
        this.db.prepare('INSERT INTO feed_overrides (feed_id, revision, options, cookie, cookie_origin) VALUES (?, ?, ?, ?, ?)')
          .run(feedId, randomUUID(), JSON.stringify(rules), cookie ? this.seal(feedId, cookieOrigin, rules.articleCookieOrigin, cookie) : '', cookieOrigin)
      }
      // A changed representation needs a fresh response. Fence any in-flight collection.
      this.db.prepare(`UPDATE feed_fetch_state SET etag = '', last_modified = '', validator_url = '',
        lease_token = '', lease_until = 0, available_at = max(next_fetch_at, retry_after_until) WHERE subscription_id = ?`).run(feedId)
    })
    return this.view(feedId)
  }
}
