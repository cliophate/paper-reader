import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export function migrateStandaloneSetup(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS migration_runs (
        id TEXT PRIMARY KEY, source_backend TEXT NOT NULL, target_backend TEXT NOT NULL,
        source_digest TEXT NOT NULL, plan_digest TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migration_provenance (
        migration_id TEXT NOT NULL REFERENCES migration_runs(id), source_backend TEXT NOT NULL,
        subscription_id TEXT NOT NULL, source_table TEXT NOT NULL, row_key TEXT NOT NULL, row_json TEXT NOT NULL,
        PRIMARY KEY(migration_id, source_table, row_key)
      );
      CREATE TABLE IF NOT EXISTS migration_subscriptions (
        migration_id TEXT NOT NULL REFERENCES migration_runs(id), subscription_id TEXT NOT NULL,
        PRIMARY KEY(migration_id, subscription_id)
      );
      CREATE TABLE IF NOT EXISTS migration_decisions (
        migration_id TEXT NOT NULL REFERENCES migration_runs(id), subscription_id TEXT NOT NULL,
        external_id TEXT NOT NULL, entry_id TEXT NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY(migration_id, subscription_id, external_id)
      );
    `)
    for (const [table, fields] of Object.entries({
      migration_runs: 'id, source_backend, target_backend, source_digest, plan_digest, status',
      migration_provenance: 'migration_id, source_backend, subscription_id, source_table, row_key, row_json',
      migration_subscriptions: 'migration_id, subscription_id',
      migration_decisions: 'migration_id, subscription_id, external_id, entry_id, evidence',
    })) {
      if (db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table)?.type !== 'table') throw new Error('Migration journal schema is invalid.')
      db.prepare(`SELECT ${fields} FROM ${table} LIMIT 0`).all()
    }
    const columns = db.prepare('PRAGMA table_info(undo_actions)').all().map(row => row.name)
    if (!columns.includes('backend_id')) db.exec("ALTER TABLE undo_actions ADD COLUMN backend_id TEXT NOT NULL DEFAULT ''")
    if (!columns.includes('expected_revisions_json')) db.exec('ALTER TABLE undo_actions ADD COLUMN expected_revisions_json TEXT')
    // Existing tokens remain intact. Without revision evidence they cannot undo
    // a later standalone write after migration.
    db.exec('PRAGMA user_version = 10')
  })
}
