import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PaperDatabase } from './db.js'
import { DATABASE_VERSION } from './search-schema.js'
import { acquireStateLock, StateLockError, type StateLock } from './state-lock.js'
import { digest, openDatabase } from './migration-storage.js'

export interface CoordinatedStorage { database: PaperDatabase; stateDir: string; close(): void }

// Called only while holding a shared or exclusive coordination lock. Read-only
// inspection is safe during the shared-to-exclusive gap; app writes are not.
function needsInitialization(lock: StateLock): boolean {
  const filename = path.join(lock.stateDir, 'paper.sqlite')
  const manifestFile = path.join(lock.stateDir, 'migration.json')
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    version: number; id: string; phase: string; planDigest: string
  } : null
  if (manifest && (manifest.version !== 1 || !['active', 'aborted', 'rolled-back'].includes(manifest.phase) || !/^[0-9a-f-]{36}$/.test(manifest.id))) throw new Error('Finish offline migration recovery before starting Paper.')
  if (!fs.existsSync(filename)) {
    if (manifest) throw new Error('Migration storage is missing. Restore or recover it before starting Paper.')
    return true
  }
  if (!fs.lstatSync(filename).isFile()) throw new Error('Paper database must be a regular file.')
  const db = openDatabase(filename, true)
  try {
    if (manifest) {
      const plan = JSON.parse(fs.readFileSync(path.join(lock.stateDir, 'migrations', manifest.id, 'plan.json'), 'utf8')) as { id: string; sourceBackend: string; targetBackend: string }
      if (plan.id !== manifest.id || digest(plan) !== manifest.planDigest) throw new Error('Migration plan validation failed before startup.')
      const active = db.prepare("SELECT value FROM sync_state WHERE key = 'active_backend_id'").get()?.value
      const expected = manifest.phase === 'active' ? plan.targetBackend : plan.sourceBackend
      if (active !== expected) throw new Error('Database ownership does not match migration recovery state.')
      if (manifest.phase === 'active') {
        const run = db.prepare('SELECT status, plan_digest FROM migration_runs WHERE id = ?').get(manifest.id)
        if (run?.status !== 'complete' || run.plan_digest !== manifest.planDigest) throw new Error('Migration completion validation failed before startup.')
      }
    }
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
      // Reacquire shared and inspect again. Migration may have acquired the
      // exclusive lock after initialization; never open through that gap.
    } catch (error) {
      lock?.release()
      const busy = error instanceof StateLockError ? error.busy : (error as { errcode?: number }).errcode === 5
      if (!busy || Date.now() >= deadline) throw error
      await delay(10)
    }
  }
}
