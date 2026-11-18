import { createHmac } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FeedIconImage, FeedIconSources } from './feed-icon-discovery.js'
import { MAX_FEED_ICON_BYTES, type FeedIconExtension } from './feed-icon-format.js'
import { transaction } from './transaction.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const REFRESH_MS = 30 * DAY_MS
export const FEED_ICON_CACHE_SECONDS = 365 * DAY_MS / 1000

export function migrateFeedIcons(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feed_icons (
        hash TEXT PRIMARY KEY,
        extension TEXT NOT NULL CHECK(extension IN ('png', 'ico', 'gif', 'jpg', 'webp')),
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND ${MAX_FEED_ICON_BYTES}),
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS feed_icons_last_used ON feed_icons(last_used_at);
      CREATE TABLE IF NOT EXISTS feed_icon_state (
        feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
        icon_hash TEXT REFERENCES feed_icons(hash),
        next_attempt_at INTEGER NOT NULL,
        last_failure_at INTEGER NOT NULL,
        failures INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS feed_icon_state_hash ON feed_icon_state(icon_hash);
      INSERT OR IGNORE INTO sync_state (key, value) VALUES ('feed_icon_key', lower(hex(randomblob(32))));
      DROP TRIGGER IF EXISTS greader_feed;
      CREATE TRIGGER greader_feed AFTER UPDATE OF title, url, site_url, active, icon_url ON feeds
      WHEN old.title IS NOT new.title OR old.url IS NOT new.url OR old.site_url IS NOT new.site_url
        OR old.active IS NOT new.active OR old.icon_url IS NOT new.icon_url
      BEGIN UPDATE feeds SET greader_modified_ms = max(greader_modified_ms + 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = new.id; END;
      PRAGMA user_version = 18;
    `)
  })
}

export interface FeedIconAttempt extends FeedIconSources {
  id: string
  generation: string | null
  hash: string | null
  nextAttemptAt: number | null
  failures: number
}

const projection = `f.id, f.url, f.site_url AS siteUrl, f.icon_url AS iconUrl,
  ff.endpoint_generation AS generation, s.icon_hash AS hash, s.next_attempt_at AS nextAttemptAt, coalesce(s.failures, 0) AS failures`
const iconState = `FROM feeds f
  LEFT JOIN feed_fetch_state ff ON ff.backend_id = ? AND ff.subscription_id = f.id
  LEFT JOIN feed_icon_state s ON s.feed_id = f.id`

export class FeedIconStore {
  constructor(private readonly db: DatabaseSync, private readonly subscriptionChanged: (backendId: string) => void,
    private readonly assertLocal: (backendId: string) => void) {}

  due(backendId: string, now: number, limit: number): FeedIconAttempt[] {
    this.assertLocal(backendId)
    return this.db.prepare(`SELECT ${projection} ${iconState}
      WHERE f.active = 1 AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= ?)
      ORDER BY coalesce(s.next_attempt_at, 0), f.rowid DESC LIMIT ?`).all(backendId, now, limit) as unknown as FeedIconAttempt[]
  }

  reschedule(feedId: string) {
    this.db.prepare('UPDATE feed_icon_state SET next_attempt_at = 0, last_failure_at = 0, failures = 0 WHERE feed_id = ?').run(feedId)
  }

  complete(backendId: string, attempt: FeedIconAttempt, image: FeedIconImage | null, publicUrl: string, now: number): boolean {
    return transaction(this.db, () => {
      this.assertLocal(backendId)
      const current = this.db.prepare(`SELECT ${projection} ${iconState} WHERE f.id = ? AND f.active = 1`)
        .get(backendId, attempt.id) as unknown as FeedIconAttempt | undefined
      if (!current || current.url !== attempt.url || current.siteUrl !== attempt.siteUrl || current.iconUrl !== attempt.iconUrl
          || current.generation !== attempt.generation || current.nextAttemptAt !== attempt.nextAttemptAt) return false
      let hash = current.hash
      let changed = false
      if (image) {
        // A plain digest would let anyone check whether a known icon is in this library.
        const key = String(this.db.prepare("SELECT value FROM sync_state WHERE key = 'feed_icon_key'").get()!.value)
        hash = createHmac('sha256', Buffer.from(key, 'hex')).update(image.bytes).digest('hex')
        this.db.prepare('INSERT OR IGNORE INTO feed_icons VALUES (?, ?, ?, ?)').run(hash, image.extension, image.bytes, now)
        if (current.hash && current.hash !== hash) {
          this.db.prepare('UPDATE feed_icons SET last_used_at = ? WHERE hash = ?').run(now, current.hash)
        }
        const url = new URL(`/feed-icons/${hash}.${image.extension}`, publicUrl).href
        if (current.iconUrl !== url) {
          this.db.prepare('UPDATE feeds SET icon_url = ?, synced_at = ? WHERE id = ?').run(url, new Date(now).toISOString(), attempt.id)
          this.subscriptionChanged(backendId)
          changed = true
        }
      }
      const failures = image ? 0 : Math.min(current.failures + 1, 9)
      const nextAttempt = now + (image ? REFRESH_MS : Math.min(7 * DAY_MS, HOUR_MS * 2 ** (failures - 1)))
      this.db.prepare(`INSERT INTO feed_icon_state VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(feed_id) DO UPDATE SET icon_hash = excluded.icon_hash, next_attempt_at = excluded.next_attempt_at,
        last_failure_at = excluded.last_failure_at, failures = excluded.failures`)
        .run(attempt.id, hash, nextAttempt, image ? 0 : now, failures)
      return changed
    })
  }

  get(hash: string, extension: FeedIconExtension): Buffer | undefined {
    const row = this.db.prepare('SELECT bytes FROM feed_icons WHERE hash = ? AND extension = ?').get(hash, extension)
    return row ? Buffer.from(row.bytes as Uint8Array) : undefined
  }

  prune(backendId: string, now: number): number {
    this.assertLocal(backendId)
    return Number(this.db.prepare(`DELETE FROM feed_icons WHERE hash IN (
      SELECT hash FROM feed_icons WHERE last_used_at <= ?
      AND NOT EXISTS (SELECT 1 FROM feed_icon_state WHERE icon_hash = feed_icons.hash)
      ORDER BY last_used_at LIMIT 100
    )`).run(now - FEED_ICON_CACHE_SECONDS * 1000).changes)
  }
}
