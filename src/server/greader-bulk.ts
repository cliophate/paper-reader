import path from 'node:path'
import { markReaderStreamRead, type MarkReadStream } from './greader-mark-read.js'
import { editReaderTags } from './greader-organization.js'
import { importReaderOpml } from './subscription-import-local.js'
import { ImportConflictError } from './subscription-import.js'
import { SubscriptionInputError } from './opml.js'
import { OrganizationError } from './organization.js'
import { assertReaderCredential, ReaderError } from './greader-auth.js'
import { acquireStateLock } from './state-lock.js'
import { PaperDatabase } from './db.js'

type WriteJob = { path: string; kind: 'checkpoint' } | ({
  path: string; backend: string; app: Parameters<typeof assertReaderCredential>[1]
} & ({ kind: 'mark-read'; stream: MarkReadStream; cutoff?: string } | { kind: 'import'; xml: string } | { kind: 'rename-tag' | 'disable-tag'; params: string }))

process.once('message', (job: WriteJob) => {
  const lock = acquireStateLock(path.dirname(job.path), 'shared')
  const db = new PaperDatabase(job.path)
  db.greaderDatabase.exec('PRAGMA busy_timeout = 50; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = -262144')
  let message: { body?: string; error?: string; status?: number }
  try {
    let body = 'OK'
    if (job.kind === 'checkpoint') db.greaderDatabase.exec('PRAGMA wal_checkpoint(PASSIVE)')
    else if (job.kind === 'mark-read') body = String(markReaderStreamRead(db, job.backend, job.stream, job.cutoff, job.app))
    else {
      const authorize = () => assertReaderCredential(db.greaderDatabase, job.app)
      if (job.kind === 'import') importReaderOpml(db, job.backend, job.xml, authorize)
      else editReaderTags(db, job.backend, job.kind, 'label', new URLSearchParams(job.params), authorize)
    }
    message = { body }
  } catch (error) {
    if (error instanceof ReaderError) message = { error: error.message, status: error.status }
    else if (error instanceof SubscriptionInputError) message = { error: error.message, status: 400 }
    else if (error instanceof ImportConflictError || error instanceof OrganizationError) message = { error: error.message, status: 409 }
    else message = { error: 'Reader writer is busy.', status: 503 }
  }
  finally { try { db.close() } finally { lock.release() } }
  process.send?.(message, () => process.disconnect())
})
