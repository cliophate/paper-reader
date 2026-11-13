import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export const DATABASE_VERSION = 12

export function migrateLinkNumbers(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS link_numbers (
      number INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      UNIQUE(kind, target_id)
    )`)
    for (const [kind, table] of [['feed', 'feeds'], ['folder', 'folders'], ['collection', 'pulse_collections']]) {
      db.exec(`INSERT OR IGNORE INTO link_numbers(kind, target_id) SELECT '${kind}', id FROM ${table} ORDER BY id;
        CREATE TRIGGER IF NOT EXISTS ${table}_link_number AFTER INSERT ON ${table} BEGIN
          INSERT OR IGNORE INTO link_numbers(kind, target_id) VALUES ('${kind}', new.id);
        END;`)
    }
    db.exec('PRAGMA user_version = 12')
  })
}
