import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './transaction.js'

export const DATABASE_VERSION = 15

export function migrateAuth(db: DatabaseSync) {
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS auth_meta (id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO auth_meta(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS auth_owner (id INTEGER PRIMARY KEY CHECK(id = 1), username TEXT NOT NULL, password_hash TEXT NOT NULL,
      password_enabled INTEGER NOT NULL DEFAULT 1, user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_setup (id INTEGER PRIMARY KEY CHECK(id = 1), hash TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, created INTEGER NOT NULL,
      seen INTEGER NOT NULL, agent TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_passkeys (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
      transports TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER);
    CREATE TABLE IF NOT EXISTS auth_challenges (hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL,
      session_hash TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope = 'reader-sync'),
      hash TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, used INTEGER, revoked INTEGER);
    CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    PRAGMA user_version = 15;
  `))
}
