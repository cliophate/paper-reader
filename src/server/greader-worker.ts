import path from 'node:path'
import { acquireStateLock } from './state-lock.js'
import { DatabaseSync } from 'node:sqlite'
import { explicit, metadata, page, type Query } from './greader-query.js'
import { ReaderError } from './greader-auth.js'

process.once('message', async (job: { path: string; kind: string; backend: string; query: Query; ids: string[]; order: string }) => {
  const lock = acquireStateLock(path.dirname(job.path), 'shared')
  const db = new DatabaseSync(job.path, { readOnly: true, timeout: 50 })
  let message: { body?: string; error?: string; status?: number }
  try {
    db.exec('PRAGMA query_only = ON; BEGIN')
    const result = job.kind === 'organization' ? await (async () => {
      const { PaperDatabase } = await import('./db.js')
      const paper = new PaperDatabase(job.path, { readOnly: true })
      try {
        paper.greaderDatabase.exec('PRAGMA busy_timeout = 50; BEGIN')
        const snapshot = paper.organization.snapshot(job.backend)
        paper.greaderDatabase.exec('COMMIT')
        return snapshot
      } finally { paper.close() }
    })() : job.kind === 'ids' || job.kind === 'page' ? page(db, job.query, job.kind === 'page')
      : job.kind === 'contents' ? explicit(db, job.backend, job.ids, job.order) : metadata(db, job.kind, job.backend)
    db.exec('COMMIT')
    const body = JSON.stringify(result)
    const limit = job.kind === 'ids' ? 128 * 1024 : ['page', 'contents'].includes(job.kind) ? 20 * 1024 * 1024 : 4 * 1024 * 1024
    if (Buffer.byteLength(body) > limit) throw new ReaderError('Response is too large.', 413)
    message = { body }
  } catch (error) { message = { error: error instanceof ReaderError ? error.message : 'Reader job failed.', status: error instanceof ReaderError ? error.status : 503 } }
  finally { try { db.close() } finally { lock.release() } }
  process.send?.(message, () => process.disconnect())
})
