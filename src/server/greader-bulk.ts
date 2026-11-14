import path from 'node:path'
import { assertReaderCredential, ReaderError } from './greader-auth.js'
import type { AppCredential } from './auth-store.js'
import { acquireStateLock } from './state-lock.js'
import { PaperDatabase } from './db.js'
import { scanFrom, where, type Query } from './greader-query.js'

// One process owns the transaction. The parent can kill it to interrupt SQLite.
process.once('message', (job: { path: string; kind?: string; query: Query; ts: string; credential: AppCredential }) => {
  const lock = acquireStateLock(path.dirname(job.path), 'shared')
  const db = new PaperDatabase(job.path)
  db.greaderDatabase.exec('PRAGMA busy_timeout = 50; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = -262144')
  let message: { body?: string; error?: string; status?: number }
  try {
    if (job.kind === 'checkpoint') db.greaderDatabase.exec('PRAGMA wal_checkpoint(PASSIVE)')
    else {
      const cutoff = BigInt(job.ts || '0')
      const unread = { ...job.query, it: [...job.query.it, { kind: 'state' as const, id: 'unread' }] }
      const filter = where(unread), scan = scanFrom(unread)
      db.transaction(() => {
        assertReaderCredential(db.greaderDatabase, job.credential)
        db.commitReaderBulk(job.query.backend, `SELECT e.rowid ${scan.from} WHERE ${filter.sql}${scan.extra} AND e.read = 0 AND e.first_seen_at * 1000 <= CASE WHEN ? = 0 THEN CAST(unixepoch('subsec') * 1000000 AS INTEGER) ELSE ? END`, [...filter.args, cutoff, cutoff])
      })
    }
    message = { body: 'OK' }
  } catch (error) { message = error instanceof ReaderError ? { error: error.message, status: error.status } : { error: 'Reader writer is busy.', status: 503 } }
  finally { try { db.close() } finally { lock.release() } }
  process.send?.(message, () => process.disconnect())
})
