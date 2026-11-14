import { PaperDatabase } from './db.js'
import { scanFrom, where, type Query } from './greader-query.js'

// One process owns the transaction. The parent can kill it to interrupt SQLite.
process.once('message', (job: { path: string; query: Query; ts: string }) => {
  const db = new PaperDatabase(job.path)
  db.greaderDatabase.exec('PRAGMA busy_timeout = 50')
  let message: { body?: string; error?: string; status?: number }
  try {
    db.transaction(() => {
      const cutoff = job.ts && job.ts !== '0' ? BigInt(job.ts) : BigInt(Date.now()) * 1000n
      const unread = { ...job.query, it: [...job.query.it, { kind: 'state' as const, id: 'unread' }] }
      const filter = where(unread), scan = scanFrom(unread)
      db.commitReaderBulk(job.query.backend, `SELECT e.rowid, e.id ${scan.from} WHERE ${filter.sql}${scan.extra} AND e.read = 0 AND e.first_seen_at * 1000 <= ?`, [...filter.args, cutoff])
    })
    message = { body: 'OK' }
  } catch { message = { error: 'Reader writer is busy.', status: 503 } }
  finally { db.close() }
  process.send?.(message, () => process.disconnect())
})
