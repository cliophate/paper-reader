import type { DatabaseSync } from 'node:sqlite'
import type { BriefingSelection } from './types.js'
import { transaction } from './transaction.js'

export const DATABASE_VERSION = 14

export function migrateRetention(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS retention_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, policy_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS retention_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER,
      policy_json TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, ceiling INTEGER NOT NULL,
      marked INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, batches INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS retention_one_active_idx ON retention_runs((1)) WHERE finished_at IS NULL;
    CREATE TABLE IF NOT EXISTS retention_briefing_entries (
      entry_id TEXT NOT NULL, briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
      PRIMARY KEY(entry_id, briefing_id)
    );
    CREATE TABLE IF NOT EXISTS retention_feeds (feed_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS retention_present (
      feed_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(feed_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS retention_tombstones (
      entry_id TEXT PRIMARY KEY REFERENCES article_identities(id), feed_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS article_aliases_entry_idx ON article_aliases(entry_id);
    CREATE INDEX IF NOT EXISTS article_fingerprints_entry_idx ON article_fingerprints(entry_id);
    CREATE INDEX IF NOT EXISTS article_cache_age_idx ON article_cache(fetched_at, url);
    CREATE INDEX IF NOT EXISTS article_reports_entry_idx ON article_reports(entry_id);
    CREATE INDEX IF NOT EXISTS reading_progress_recent_idx ON reading_progress(updated_at DESC, entry_id);
    PRAGMA user_version = 14;
  `)
    for (const row of db.prepare('SELECT id, selection_json FROM briefings').iterate()) {
      saveRetentionBriefingReferences(db, String(row.id), JSON.parse(String(row.selection_json)))
    }
  })
}

export function saveRetentionBriefingReferences(db: DatabaseSync, id: string, selection: BriefingSelection) {
  const insert = db.prepare('INSERT OR IGNORE INTO retention_briefing_entries VALUES (?, ?)')
  for (const item of selection.news || []) {
    for (const entryId of [...(item.backgroundEntryIds || []), item.imageEntryId].filter(Boolean)) insert.run(entryId!, id)
  }
}
