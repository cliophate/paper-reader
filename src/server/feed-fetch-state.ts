import { DEFAULT_CHECK_INTERVAL, MANUAL_CHECK_COOLDOWN_MS, validateCheckInterval } from './feed-check-settings.js'
import { OrganizationError } from './organization.js'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export interface FeedFetchState {
  backendId: string
  subscriptionId: string
  endpointGeneration: string
  url: string
  host: string
  nextFetchAt: number
  availableAt: number
  retryAfterUntil: number
  lastAttemptAt: number
  intervalMinutes: number | null
  failures: number
  etag: string
  lastModified: string
  validatorUrl: string
  lastSuccessAt: number
  lastStatus: number
  lastError: string
  ambiguous: number
  leaseToken: string
  leaseUntil: number
}
export type FeedLease = FeedFetchState
export interface FetchCompletion {
  retryAfterUntil?: number
  nextFetchAt: number
  failures: number
  lastStatus: number
  lastError: string
  etag?: string
  lastModified?: string
  validatorUrl?: string
  lastSuccessAt?: number
  ambiguous?: number
}
function host(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}
const projection = `backend_id AS backendId, subscription_id AS subscriptionId,
  endpoint_generation AS endpointGeneration, endpoint_url AS url, host,
  next_fetch_at AS nextFetchAt, available_at AS availableAt, failures,
  etag, last_modified AS lastModified, validator_url AS validatorUrl,
  last_success_at AS lastSuccessAt, last_status AS lastStatus, last_error AS lastError,
  retry_after_until AS retryAfterUntil, last_attempt_at AS lastAttemptAt, interval_minutes AS intervalMinutes,
  ambiguous, lease_token AS leaseToken, lease_until AS leaseUntil`

export function migrateFeedFetchState(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS feed_fetch_state (
      backend_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
      endpoint_generation TEXT NOT NULL, endpoint_url TEXT NOT NULL, host TEXT NOT NULL,
      next_fetch_at INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, etag TEXT NOT NULL DEFAULT '',
      last_modified TEXT NOT NULL DEFAULT '', validator_url TEXT NOT NULL DEFAULT '',
      last_success_at INTEGER NOT NULL DEFAULT 0, last_status INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', ambiguous INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(backend_id, subscription_id),
      FOREIGN KEY(backend_id, subscription_id) REFERENCES subscription_identities(backend_id, id)
    );
    CREATE INDEX IF NOT EXISTS feed_fetch_due ON feed_fetch_state(backend_id, available_at, subscription_id);
    CREATE TABLE IF NOT EXISTS feed_http_slots (
      token TEXT PRIMARY KEY, backend_id TEXT NOT NULL REFERENCES reader_backends(id),
      host TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feed_http_slots_expiry ON feed_http_slots(backend_id, expires_at);
    CREATE INDEX IF NOT EXISTS feed_http_slots_host ON feed_http_slots(backend_id, host, expires_at);`)
    const insert = db.prepare(`INSERT OR IGNORE INTO feed_fetch_state
      (backend_id, subscription_id, endpoint_generation, endpoint_url, host) VALUES (?, ?, ?, ?, ?)`)
    for (const row of db.prepare(`SELECT s.backend_id, f.id, f.url FROM feeds f
      JOIN subscription_identities s ON s.id = f.id JOIN reader_backends b ON b.id = s.backend_id
      WHERE b.kind = 'standalone'`).iterate()) {
      insert.run(String(row.backend_id), String(row.id), randomUUID(), String(row.url), host(String(row.url)))
    }
    db.exec('PRAGMA user_version = 9')
  })
}

export class FeedFetchStore {
  constructor(private readonly db: DatabaseSync, private readonly assertLocal: (backendId: string) => void) {}

  // Called inside saveLocalSubscription's transaction. Metadata-only changes
  // preserve validators and generation. A -> B -> A creates three generations.
  saveEndpoint(backendId: string, subscriptionId: string, url: string) {
    this.assertLocal(backendId)
    this.db.prepare(`INSERT INTO feed_fetch_state
      (backend_id, subscription_id, endpoint_generation, endpoint_url, host) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, subscription_id) DO UPDATE SET
        endpoint_generation = excluded.endpoint_generation, endpoint_url = excluded.endpoint_url, host = excluded.host,
        next_fetch_at = 0, available_at = 0, retry_after_until = 0, last_attempt_at = 0, failures = 0, etag = '', last_modified = '', validator_url = '',
        last_success_at = 0, last_status = 0, last_error = '', ambiguous = 0, lease_token = '', lease_until = 0
      WHERE endpoint_url != excluded.endpoint_url`).run(backendId, subscriptionId, randomUUID(), url, host(url))
  }

  get(backendId: string, subscriptionId: string): FeedFetchState | null {
    this.assertLocal(backendId)
    return this.db.prepare(`SELECT ${projection} FROM feed_fetch_state WHERE backend_id = ? AND subscription_id = ?`)
      .get(backendId, subscriptionId) as unknown as FeedFetchState || null
  }

  claim(backendId: string, now: number, leaseMs: number, subscriptionId?: string): FeedLease | null {
    return transaction(this.db, () => {
      this.assertLocal(backendId)
      const row = this.db.prepare(`SELECT ${projection} FROM feed_fetch_state s
        WHERE backend_id = ? AND ${subscriptionId === undefined ? 'available_at <= ?' : 'subscription_id = ? AND lease_until <= ? AND retry_after_until <= ? AND (last_attempt_at = 0 OR last_attempt_at <= ?)'} AND EXISTS
          (SELECT 1 FROM feeds f WHERE f.id = s.subscription_id AND f.active = 1 AND f.url = s.endpoint_url)
        ORDER BY available_at, subscription_id LIMIT 1`).get(...(subscriptionId === undefined ? [backendId, now] : [backendId, subscriptionId, now, now, now - MANUAL_CHECK_COOLDOWN_MS])) as unknown as FeedFetchState | undefined
      if (!row) return null
      const leaseToken = randomUUID()
      const leaseUntil = now + leaseMs
      this.db.prepare(`UPDATE feed_fetch_state SET lease_token = ?, lease_until = ?, available_at = ?, last_attempt_at = ?
        WHERE backend_id = ? AND subscription_id = ?`).run(leaseToken, leaseUntil, leaseUntil, now, backendId, row.subscriptionId)
      return { ...row, leaseToken, leaseUntil, availableAt: leaseUntil, lastAttemptAt: now }
    })
  }

  // The synchronous callback may ingest content, but must never perform I/O.
  // Its nested transactions are savepoints under this write transaction.
  complete<T>(lease: FeedLease, now: number, update: FetchCompletion, commit: () => T): { committed: true; value: T } | { committed: false } {
    return transaction(this.db, () => {
      this.assertLocal(lease.backendId)
      const current = this.db.prepare(`SELECT 1 FROM feed_fetch_state s JOIN feeds f ON f.id = s.subscription_id
        WHERE s.backend_id = ? AND s.subscription_id = ? AND s.endpoint_generation = ?
          AND s.endpoint_url = ? AND f.url = s.endpoint_url AND f.active = 1
          AND s.lease_token = ? AND s.lease_until > ?`).get(lease.backendId, lease.subscriptionId, lease.endpointGeneration, lease.url, lease.leaseToken, now)
      if (!current) return { committed: false }
      const value = commit()
      this.db.prepare(`UPDATE feed_fetch_state SET next_fetch_at = ?, available_at = ?, failures = ?,
        last_status = ?, last_error = ?, etag = ?, last_modified = ?, validator_url = ?,
        last_success_at = ?, ambiguous = ?, retry_after_until = ?, lease_token = '', lease_until = 0
        WHERE backend_id = ? AND subscription_id = ?`).run(update.nextFetchAt, update.nextFetchAt, update.failures,
          update.lastStatus, update.lastError, update.etag ?? lease.etag, update.lastModified ?? lease.lastModified,
          update.validatorUrl ?? lease.validatorUrl, update.lastSuccessAt ?? lease.lastSuccessAt,
          update.ambiguous ?? lease.ambiguous, update.retryAfterUntil ?? lease.retryAfterUntil, lease.backendId, lease.subscriptionId)
      const checkedAt = new Date(now).toISOString()
      if (update.failures > 0) {
        this.db.prepare('UPDATE feeds SET broken = 1, last_error_at = ? WHERE id = ?').run(checkedAt, lease.subscriptionId)
      } else {
        this.db.prepare('UPDATE feeds SET broken = 0, last_checked_at = ? WHERE id = ?').run(checkedAt, lease.subscriptionId)
      }
      return { committed: true, value }
    })
  }

  settings(backendId: string): { revision: number; intervalMinutes: number } {
    this.assertLocal(backendId)
    return this.db.prepare('SELECT revision, interval_minutes AS intervalMinutes FROM feed_check_settings WHERE backend_id = ?')
      .get(backendId) as { revision: number; intervalMinutes: number } | undefined ?? { revision: 0, intervalMinutes: DEFAULT_CHECK_INTERVAL }
  }

  setInterval(backendId: string, expectedRevision: number, minutes: number | null, feedId?: string) {
    if (minutes !== null) validateCheckInterval(minutes)
    else if (feedId === undefined) throw new OrganizationError('invalid', 'The global interval is required.')
    transaction(this.db, () => {
      const current = this.settings(backendId)
      if (current.revision !== expectedRevision) throw new OrganizationError('conflict', 'Check settings changed. Reload before saving.')
      if (feedId !== undefined && !this.get(backendId, feedId)) throw new OrganizationError('not-found', 'This feed is no longer subscribed.')
      this.db.prepare(`INSERT INTO feed_check_settings (backend_id, revision, interval_minutes) VALUES (?, ?, ?)
        ON CONFLICT(backend_id) DO UPDATE SET revision = excluded.revision, interval_minutes = excluded.interval_minutes`)
        .run(backendId, current.revision + 1, feedId === undefined ? minutes : current.intervalMinutes)
      if (feedId !== undefined) this.db.prepare('UPDATE feed_fetch_state SET interval_minutes = ? WHERE backend_id = ? AND subscription_id = ?').run(minutes, backendId, feedId)
      // Recalculate successful schedules only. Failures retain their backoff,
      // and active leases retain their fencing deadline.
      this.db.prepare(`UPDATE feed_fetch_state SET
        next_fetch_at = MAX(last_success_at + COALESCE(interval_minutes, ?) * 60000, retry_after_until),
        available_at = MAX(last_success_at + COALESCE(interval_minutes, ?) * 60000, retry_after_until)
        WHERE backend_id = ? AND failures = 0 AND last_success_at > 0 AND lease_until = 0
          AND (? IS NULL OR subscription_id = ?)`).run(
          feedId === undefined ? minutes : current.intervalMinutes, feedId === undefined ? minutes : current.intervalMinutes,
          backendId, feedId ?? null, feedId ?? null)
    })
  }

  reserveHttp(backendId: string, hostname: string, now: number, expiresAt: number, globalLimit: number, hostLimit: number): string | null {
    return transaction(this.db, () => {
      this.assertLocal(backendId)
      this.db.prepare('DELETE FROM feed_http_slots WHERE expires_at <= ?').run(now)
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM feed_http_slots WHERE backend_id = ?').get(backendId)
      const perHost = this.db.prepare('SELECT COUNT(*) AS count FROM feed_http_slots WHERE backend_id = ? AND host = ?').get(backendId, hostname)
      if (Number(count?.count) >= globalLimit || Number(perHost?.count) >= hostLimit) return null
      const token = randomUUID()
      this.db.prepare('INSERT INTO feed_http_slots VALUES (?, ?, ?, ?)').run(token, backendId, hostname, expiresAt)
      return token
    })
  }

  releaseHttp(token: string) { this.db.prepare('DELETE FROM feed_http_slots WHERE token = ?').run(token) }
}
