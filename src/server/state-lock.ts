import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class StateLockError extends Error {
  constructor(readonly busy = false) { super('Paper storage is in use or its coordination lock is unavailable. Stop Paper before running migration commands.') }
}

export interface StateLock {
  readonly stateDir: string
  readonly mode: 'shared' | 'exclusive'
  release(): void
}

// This permanent database is separate from application backups and replacements.
// Normal processes share a read lock; migration requires exclusive access.
export function acquireStateLock(directory: string, mode: StateLock['mode']): StateLock {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stateDir = fs.realpathSync(directory)
  const filename = path.join(stateDir, 'paper-lock.sqlite')
  let db: DatabaseSync | undefined
  try {
    try { fs.closeSync(fs.openSync(filename, 'wx', 0o600)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (!fs.lstatSync(filename).isFile()) throw new Error('Invalid lock file')
    db = new DatabaseSync(filename)
    db.exec('PRAGMA busy_timeout = 0')
    const journal = db.prepare('PRAGMA journal_mode').get()?.journal_mode
    // Never change journal mode beneath another participant.
    if (journal !== 'delete') throw new Error('Coordination requires rollback journaling')
    const initialized = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paper_lock'").get()
    if (!initialized) {
      db.exec('BEGIN EXCLUSIVE')
      db.exec('CREATE TABLE IF NOT EXISTS paper_lock (id INTEGER PRIMARY KEY CHECK(id = 1)); INSERT OR IGNORE INTO paper_lock VALUES (1); PRAGMA user_version = 1; COMMIT')
    }
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Unsupported coordination schema')
    db.exec(mode === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN')
    if (!db.prepare('SELECT id FROM paper_lock WHERE id = 1').get()) throw new Error('Invalid coordination schema')
    const held = db
    let released = false
    return { stateDir, mode, release() {
      if (released) return
      released = true
      try { held.exec('ROLLBACK') } finally { held.close() }
    } }
  } catch (error) {
    db?.close()
    throw new StateLockError((error as { errcode?: number }).errcode === 5)
  }
}
