import { displayFeedUrl } from './feed-url-display.js'
import type { DatabaseSync } from 'node:sqlite'
import type { FeedMove, FeedRedirect, StaleDays } from '../shared/feed-checks.js'
import type { FeedFetchState } from './feed-fetch-state.js'
import { createHmac, randomBytes } from 'node:crypto'
import { BackendValidationError } from './backend.js'
import { feedUrlKeys } from './feed-url-comparison.js'
import { subscriptionUrl } from './opml.js'
import { transaction } from './transaction.js'
import { FEED_MAINTENANCE_VERSION } from './auth-schema.js'

export const DEFAULT_STALE_DAYS: StaleDays = [90, 182, 365]

export function migrateFeedMaintenance(db: DatabaseSync) {
  transaction(db, () => {
    for (const [table, column, definition] of [
      ['feed_fetch_state', 'redirects_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['feed_fetch_state', 'publisher_site_url', "TEXT NOT NULL DEFAULT ''"],
      ['feed_fetch_state', 'declared_url', "TEXT NOT NULL DEFAULT ''"],
      ['feeds', 'parsing_error_count', 'INTEGER'],
      ['feeds', 'parsing_error_message', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      }
    }
    db.exec(`PRAGMA user_version = ${FEED_MAINTENANCE_VERSION}`)
  })
}

export function validStaleDays(value: unknown): value is StaleDays {
  return Array.isArray(value) && value.length === 3 && value.every((day, index) =>
    Number.isSafeInteger(day) && day > 0 && day <= 36500 && (!index || day > value[index - 1]))
}

// References expire on restart. A fresh poll supplies new ones.
const referenceKey = randomBytes(32)
function reference(...parts: string[]) {
  return createHmac('sha256', referenceKey).update(JSON.stringify(parts)).digest('base64url')
}

export function privateFeedRef(id: string, url: string) {
  return reference('subscription', id, url)
}

export function endpointKeys(state: FeedFetchState) {
  const urls = new Set([state.url])
  if (state.lastSuccessAt && state.validatorUrl) urls.add(state.validatorUrl)
  return [...urls].flatMap(url => {
    const keys = feedUrlKeys(url)
    return keys ? [{ exact: reference('exact', keys.exact), possible: reference('possible', keys.possible) }] : []
  })
}

function moveAddresses(state: FeedFetchState) {
  const redirects: FeedRedirect[] = JSON.parse(state.redirectsJson)
  const current = subscriptionUrl(state.url)
  const declaredUrl = state.declaredUrl === current ? '' : state.declaredUrl
  let permanentUrl = ''
  for (const hop of redirects) {
    if (hop.status !== 301 && hop.status !== 308) break
    permanentUrl = hop.url
  }
  return { redirects, declaredUrl, suggestedUrl: declaredUrl || (permanentUrl !== current ? permanentUrl : '') }
}

const REPAIR_REFERENCE_TTL_MS = 60 * 60_000
function repairReference(state: FeedFetchState, url: string, expires: number) {
  const mac = reference('repair', state.subscriptionId, state.endpointGeneration, String(state.lastAttemptAt), url, String(expires))
  return `${expires}.${mac}`
}

export function feedMove(state: FeedFetchState): FeedMove | undefined {
  const { redirects, declaredUrl, suggestedUrl } = moveAddresses(state)
  if (!redirects.length && !declaredUrl) return
  return {
    redirects: redirects.map(hop => ({ status: hop.status, url: displayFeedUrl(hop.url, true) })),
    declaredUrl: displayFeedUrl(declaredUrl, true),
    suggestedUrl: displayFeedUrl(suggestedUrl, true),
    ...(suggestedUrl && { repairRef: repairReference(state, suggestedUrl, Date.now() + REPAIR_REFERENCE_TTL_MS) }),
  }
}

export function resolveFeedRepair(state: FeedFetchState | null, ref: unknown) {
  const url = state && moveAddresses(state).suggestedUrl
  const expires = typeof ref === 'string' ? Number(ref.split('.', 1)[0]) : NaN
  if (!state || !url || !Number.isSafeInteger(expires) || repairReference(state, url, expires) !== ref) {
    throw new BackendValidationError('The suggested address changed. Refresh feed details and try again.')
  }
  if (expires <= Date.now()) throw new BackendValidationError('The suggested address expired. Refresh feed details and try again.')
  return url
}
