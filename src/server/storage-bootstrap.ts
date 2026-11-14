import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDatabase } from './db.js'
import { DATABASE_VERSION } from './auth-schema.js'
import { acquireStateLock, StateLockError, type StateLock } from './state-lock.js'

export interface CoordinatedStorage { database: PaperDatabase; stateDir: string; close(): void }

// Called only while holding a shared or exclusive coordination lock. Read-only
// inspection is safe during the shared-to-exclusive gap; app writes are not.
function needsInitialization(lock: StateLock): boolean {
  const filename = path.join(lock.stateDir, 'paper.sqlite')
  if (!fs.existsSync(filename)) return true
  if (!fs.lstatSync(filename).isFile()) throw new Error('Paper database must be a regular file.')
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0)
    if (version > DATABASE_VERSION) throw new Error('This database was created by a newer Paper version')
    return version < DATABASE_VERSION || db.prepare("SELECT value FROM sync_state WHERE key = 'fulltext_search_v1'").get()?.value !== 'true'
  } finally { db.close() }
}

// Briefing can join a running server without an exclusive-lock attempt when
// the schema is current. Competing first starts retry inspection after a busy
// exclusive attempt, so they can join once the first upgrade finishes.
export async function openCoordinatedStorage(directory: string, options: {
  timeoutMs?: number; onUpgrade?: () => void
} = {}): Promise<CoordinatedStorage> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while (true) {
    let lock: StateLock | undefined
    try {
      lock = acquireStateLock(directory, 'shared')
      if (!needsInitialization(lock)) {
        const database = new PaperDatabase(path.join(lock.stateDir, 'paper.sqlite'))
        const held = lock
        let closed = false
        return { database, stateDir: held.stateDir, close() {
          if (closed) return
          closed = true
          try { database.close() } finally { held.release() }
        } }
      }
      lock.release(); lock = undefined
      lock = acquireStateLock(directory, 'exclusive')
      if (needsInitialization(lock)) {
        options.onUpgrade?.()
        new PaperDatabase(path.join(lock.stateDir, 'paper.sqlite')).close()
      }
      lock.release(); lock = undefined
      // Reacquire shared and inspect again before opening application storage.
    } catch (error) {
      lock?.release()
      const busy = error instanceof StateLockError ? error.busy : (error as { errcode?: number }).errcode === 5
      if (!busy || Date.now() >= deadline) throw error
      await delay(10)
    }
  }
}
