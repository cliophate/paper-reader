import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'
import { OrganizationError } from './organization.js'

export const DATABASE_VERSION = 13
export const DEFAULT_CHECK_INTERVAL = 15
export const MANUAL_CHECK_COOLDOWN_MS = 60_000

export function validateCheckInterval(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 5 || Number(value) > 1440) {
    throw new OrganizationError('invalid', 'Use a whole number from 5 to 1440 minutes.')
  }
}

export function migrateFeedCheckSettings(db: DatabaseSync) {
  transaction(db, () => {
    const columns = new Set(db.prepare('PRAGMA table_info(feed_fetch_state)').all().map(row => row.name))
    for (const [name, definition] of [
      ['retry_after_until', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_attempt_at', 'INTEGER NOT NULL DEFAULT 0'],
      ['interval_minutes', 'INTEGER DEFAULT NULL CHECK (interval_minutes BETWEEN 5 AND 1440)'],
    ]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE feed_fetch_state ADD COLUMN ${name} ${definition}`)
    }
    // Older schedules cannot distinguish backoff from Retry-After. Preserve the
    // whole existing wait once, so an upgrade cannot bypass a publisher delay.
    if (!columns.has('retry_after_until')) db.exec('UPDATE feed_fetch_state SET retry_after_until = next_fetch_at')
    db.exec(`CREATE TABLE IF NOT EXISTS feed_check_settings (
      backend_id TEXT PRIMARY KEY REFERENCES reader_backends(id),
      revision INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 15 CHECK (interval_minutes BETWEEN 5 AND 1440)
    ); PRAGMA user_version = 13`)
  })
}
