import path from 'node:path'
import { ReaderError } from './greader-auth.js'
import { acquireStateLock } from './state-lock.js'
import { PaperDatabase } from './db.js'

// Checkpoints run outside the HTTP process. No bulk article writes ship in v1.
process.once('message', (job: { path: string; kind: 'checkpoint' }) => {
  const lock = acquireStateLock(path.dirname(job.path), 'shared')
  const db = new PaperDatabase(job.path)
  db.greaderDatabase.exec('PRAGMA busy_timeout = 50; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = -262144')
  let message: { body?: string; error?: string; status?: number }
  try {
    db.greaderDatabase.exec('PRAGMA wal_checkpoint(PASSIVE)')
    message = { body: 'OK' }
  } catch (error) { message = error instanceof ReaderError ? { error: error.message, status: error.status } : { error: 'Reader writer is busy.', status: 503 } }
  finally { try { db.close() } finally { lock.release() } }
  process.send?.(message, () => process.disconnect())
})
