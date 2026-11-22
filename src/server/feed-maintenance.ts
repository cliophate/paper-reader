import type { DatabaseSync } from 'node:sqlite'
import type { FeedMove, FeedRedirect, StaleDays } from '../shared/feed-checks.js'
import type { FeedFetchState } from './feed-fetch-state.js'
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

export function feedMove(state: FeedFetchState): FeedMove | undefined {
  const redirects: FeedRedirect[] = JSON.parse(state.redirectsJson)
  const current = subscriptionUrl(state.url)
  const declaredUrl = state.declaredUrl === current ? '' : state.declaredUrl
  if (!redirects.length && !declaredUrl) return
  let permanentUrl = ''
  for (const hop of redirects) {
    if (hop.status !== 301 && hop.status !== 308) break
    permanentUrl = hop.url
  }
  return { redirects, declaredUrl, suggestedUrl: declaredUrl || (permanentUrl !== current ? permanentUrl : '') }
}
