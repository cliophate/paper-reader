import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export function migrateStandaloneSetup(db: DatabaseSync) {
  transaction(db, () => {
    const columns = db.prepare('PRAGMA table_info(undo_actions)').all().map(row => row.name)
    if (!columns.includes('backend_id')) db.exec("ALTER TABLE undo_actions ADD COLUMN backend_id TEXT NOT NULL DEFAULT ''")
    if (!columns.includes('expected_revisions_json')) db.exec('ALTER TABLE undo_actions ADD COLUMN expected_revisions_json TEXT')
    // Existing tokens remain intact. Without revision evidence they cannot undo
    // a later standalone write.
    db.exec('PRAGMA user_version = 10')
  })
}
