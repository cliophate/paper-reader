import { DATABASE_VERSION } from './auth-schema.js'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

// Keep the first deletion backup off the HTTP thread. VACUUM INTO includes
// committed WAL pages. The completed file is private and never overwritten.
const source = new DatabaseSync(workerData.databasePath, { readOnly: true })
const destination = `${workerData.databasePath}.before-retention-first-delete`
try {
  if (fs.existsSync(destination)) {
    const saved = new DatabaseSync(destination, { readOnly: true })
    try {
      const version = Number(saved.prepare('PRAGMA user_version').get()?.user_version)
      if (saved.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
        || version < 14 || version > DATABASE_VERSION) throw new Error('Invalid retention backup')
    } finally { saved.close() }
  } else {
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`
    fs.closeSync(fs.openSync(temporary, 'wx', 0o600))
    try {
      source.prepare('VACUUM INTO ?').run(temporary)
      try { fs.linkSync(temporary, destination) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally { fs.rmSync(temporary, { force: true }) }
  }
  parentPort!.postMessage('ready')
} finally { source.close() }
