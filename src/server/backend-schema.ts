import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

// Rebuild only the referenced parent table. Renaming the old table would also
// rewrite child references; leaving foreign keys enabled would reject its drop.
export function migrateBackendKinds(db: DatabaseSync) {
  if (db.isTransaction) throw new Error('Backend schema upgrade requires its own transaction')
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0)
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE reader_backends_v14 (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('freshrss', 'standalone', 'miniflux'))
        );
        INSERT INTO reader_backends_v14 SELECT id, kind FROM reader_backends;
        DROP TABLE reader_backends;
        ALTER TABLE reader_backends_v14 RENAME TO reader_backends;
      `)
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backend schema upgrade found invalid references')
      db.exec('PRAGMA user_version = 14')
    })
  } finally { db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`) }
}
