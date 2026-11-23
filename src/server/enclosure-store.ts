import { advanceReaderClock } from './greader-schema.js'
import type { DatabaseSync } from 'node:sqlite'
import type { Enclosure } from '../shared/enclosures.js'
import { transaction } from './transaction.js'

export const ENCLOSURE_SCHEMA_VERSION = 23

export function migrateEnclosures(db: DatabaseSync) {
  transaction(db, () => {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('entries') WHERE name = 'enclosures_checked'").get()) {
      db.exec('ALTER TABLE entries ADD COLUMN enclosures_checked INTEGER NOT NULL DEFAULT 0')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS article_enclosures (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        url TEXT NOT NULL, type TEXT NOT NULL, size INTEGER, duration REAL,
        ordinal INTEGER, position REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entry_id, url)
      ) WITHOUT ROWID;
      PRAGMA user_version = ${ENCLOSURE_SCHEMA_VERSION};
    `)
  })
}

export function entryEnclosures(db: DatabaseSync, id: string): Enclosure[] {
  return db.prepare('SELECT url, type, size, duration, position, updated_at FROM article_enclosures WHERE entry_id = ? AND ordinal IS NOT NULL ORDER BY ordinal').all(id)
    .map(row => ({ url: String(row.url), type: String(row.type), size: row.size === null ? undefined : Number(row.size),
      duration: row.duration === null ? undefined : Number(row.duration), position: Number(row.position), updatedAt: Number(row.updated_at) }))
}

// The caller owns the article import transaction. A repeated delivery keeps the listener's place.
export function replaceEnclosures(db: DatabaseSync, id: string, files: Enclosure[]) {
  const saved = entryEnclosures(db, id)
  const same = files.length === saved.length && files.every((file, i) => {
    const prior = saved[i]
    return prior.url === file.url && prior.type === file.type && prior.size === file.size && prior.duration === file.duration
  })
  if (same) return
  const urls = new Set(files.map(file => file.url))
  // Keep the position in case the feed lists this URL again.
  const retire = db.prepare('UPDATE article_enclosures SET ordinal = NULL WHERE entry_id = ? AND url = ?')
  for (const file of saved) {
    if (!urls.has(file.url)) retire.run(id, file.url)
  }
  const upsert = db.prepare(`INSERT INTO article_enclosures(entry_id, url, type, size, duration, ordinal) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id, url) DO UPDATE SET type = excluded.type, size = excluded.size,
      duration = excluded.duration, ordinal = excluded.ordinal`)
  files.forEach((file, ordinal) => upsert.run(id, file.url, file.type, file.size ?? null, file.duration ?? null, ordinal))
  db.prepare(`UPDATE entry_state SET ${advanceReaderClock} WHERE entry_id = ?`).run(id)
}
