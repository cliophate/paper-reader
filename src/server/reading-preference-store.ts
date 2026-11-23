import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ReadingKey, ReadingSnapshot, ReadingWrite, ReadingWriteResult } from './reading-preference-values.js'
import { transaction } from './transaction.js'

export const READING_PREFERENCES_VERSION = 25

export function migrateReadingPreferences(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reading_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_preference_devices (device TEXT PRIMARY KEY, sequence INTEGER NOT NULL, tokens TEXT);
      INSERT OR IGNORE INTO sync_state (key, value) VALUES ('reading_preferences_revision', '0');
      INSERT OR IGNORE INTO sync_state (key, value) SELECT 'reading_preferences_generation', value FROM sync_state WHERE key = 'reading_preferences_revision';
      INSERT OR IGNORE INTO sync_state (key, value) VALUES ('reading_preferences_id', lower(hex(randomblob(16))));
      PRAGMA user_version = ${READING_PREFERENCES_VERSION};
    `)
    // The pre-release schema numbered values and kept only the receipt revision.
    if (!db.prepare("SELECT 1 FROM pragma_table_info('reading_preferences') WHERE name = 'token'").get()) {
      db.exec("ALTER TABLE reading_preferences ADD COLUMN token TEXT NOT NULL DEFAULT ''; UPDATE reading_preferences SET token = lower(hex(randomblob(16)))")
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('reading_preference_devices') WHERE name = 'tokens'").get()) {
      db.exec('ALTER TABLE reading_preference_devices ADD COLUMN tokens TEXT')
    }
  })
}

export class ReadingPreferenceConflict extends Error {
  constructor(readonly code: 'reading-reset' | 'reading-key' | 'reading-restored', message: string, readonly snapshot: ReadingSnapshot) { super(message) }
}

export class ReadingPreferenceStore {
  constructor(private readonly db: DatabaseSync) {}

  snapshot(): ReadingSnapshot {
    const rows = this.db.prepare(`SELECT i.value AS storeId, s.value AS revision, g.value AS generation, p.key, p.value, p.revision AS changed, p.token
      FROM sync_state s JOIN sync_state i ON i.key = 'reading_preferences_id'
      JOIN sync_state g ON g.key = 'reading_preferences_generation' LEFT JOIN reading_preferences p ON 1 WHERE s.key = 'reading_preferences_revision'`).all()
    const values: ReadingSnapshot['values'] = {}
    for (const row of rows) {
      if (row.key !== null) values[row.key as ReadingKey] = { value: String(row.value), revision: Number(row.changed), token: String(row.token) }
    }
    return { storeId: String(rows[0].storeId), revision: Number(rows[0].revision), generation: Number(rows[0].generation), values }
  }

  write({ storeId, knownRevision, device, writer, sequence, generation, base, action, values }: ReadingWrite): ReadingWriteResult {
    return transaction(this.db, () => {
      const current = this.snapshot()
      if ((storeId !== undefined && storeId !== current.storeId) || (knownRevision ?? 0) > current.revision || generation > current.generation) {
        throw new ReadingPreferenceConflict('reading-restored', 'Paper restored shared reading preferences.', current)
      }
      const writerId = device === writer ? device : `${device}:${writer}`
      const receipt = this.db.prepare('SELECT sequence, tokens FROM reading_preference_devices WHERE device = ?').get(writerId)
      if (receipt && Number(receipt.sequence) >= sequence) {
        return receipt.sequence === sequence && receipt.tokens !== null ? { ...current, appliedTokens: JSON.parse(String(receipt.tokens)) } : current
      }

      if (generation !== current.generation) throw new ReadingPreferenceConflict('reading-reset', 'Shared reading preferences were reset.', current)
      if (action === 'edit') {
        for (const key of Object.keys(values) as ReadingKey[]) {
          if (base[key] !== (current.values[key]?.token ?? 'none')) {
            throw new ReadingPreferenceConflict('reading-key', `A newer value from another device replaced your offline change to ${key}.`, current)
          }
        }
      }

      const saveReceipt = this.db.prepare('INSERT OR REPLACE INTO reading_preference_devices (device, sequence, tokens) VALUES (?, ?, ?)')
      if (action === 'import' && current.revision !== 0) {
        saveReceipt.run(writerId, sequence, null)
        return current
      }
      const revision = current.revision + 1
      if (action === 'reset') {
        this.db.exec('DELETE FROM reading_preferences')
        this.db.prepare("UPDATE sync_state SET value = ? WHERE key = 'reading_preferences_generation'").run(String(generation + 1))
      }
      const appliedTokens: ReadingWrite['base'] = {}
      const save = this.db.prepare('INSERT OR REPLACE INTO reading_preferences (key, value, revision, token) VALUES (?, ?, ?, ?)')
      for (const [key, value] of Object.entries(values)) {
        const token = randomBytes(16).toString('hex')
        appliedTokens[key as ReadingKey] = token
        save.run(key, value!, revision, token)
      }
      this.db.prepare("UPDATE sync_state SET value = ? WHERE key = 'reading_preferences_revision'").run(String(revision))
      saveReceipt.run(writerId, sequence, JSON.stringify(appliedTokens))
      return { ...this.snapshot(), appliedTokens }
    })
  }
}
