import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export function migratePulseCatchUps(db: DatabaseSync) {
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS pulse_catch_ups (
      collection_id TEXT PRIMARY KEY REFERENCES pulse_collections(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );
    PRAGMA user_version = 19;
  `))
}

export const STORY_CHOICES_VERSION = 27

export function migrateStoryChoices(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pulse_story_choices (
        collection_id TEXT PRIMARY KEY REFERENCES pulse_collections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('follow', 'mute', 'snooze')),
        until_ms INTEGER,
        CHECK ((kind = 'snooze') = (until_ms IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS pulse_merge_choices (
        feedback_id TEXT PRIMARY KEY REFERENCES coverage_feedback(id) ON DELETE CASCADE,
        choices_json TEXT NOT NULL
      );
    `)
    if (!db.prepare("SELECT 1 FROM pragma_table_info('pulse_story_choices') WHERE name = 'orphaned_since'").get()) {
      db.exec('ALTER TABLE pulse_story_choices ADD COLUMN orphaned_since INTEGER')
    }
    // Retire combined undo tokens from the preview before the ordinary Undo handler sees them.
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'pulse_mute_undo'").get()) {
      db.exec('DELETE FROM undo_actions WHERE token IN (SELECT token FROM pulse_mute_undo); DROP TABLE pulse_mute_undo')
    }
    db.exec(`DROP TABLE IF EXISTS pulse_pending_reads; PRAGMA user_version = ${STORY_CHOICES_VERSION}`)
  })
}
