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
