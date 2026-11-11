import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { openCoordinatedStorage } from '../src/server/storage-bootstrap.js'
import { acquireStateLock } from '../src/server/state-lock.js'

let directory: string
const children: ChildProcess[] = []
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-bootstrap-')) })
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }))
  fs.rmSync(directory, { recursive: true, force: true })
})
async function participant() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/storage-bootstrap-worker.ts', directory], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
  })
  children.push(child)
  const [message] = await once(child, 'message') as [{ ready: boolean; upgrades: number }]
  return { child, ...message }
}
function schemaVersion() {
  const db = new DatabaseSync(path.join(directory, 'paper.sqlite'), { readOnly: true })
  try { return db.prepare('PRAGMA schema_version').get()?.schema_version } finally { db.close() }
}

describe('coordinated storage bootstrap', () => {
  it('lets simultaneous first starts initialize once and then coexist', async () => {
    const starts = await Promise.all([participant(), participant()])
    expect(starts.map(start => start.ready)).toEqual([true, true])
    expect(starts.reduce((count, start) => count + start.upgrades, 0)).toBe(1)
    expect(() => acquireStateLock(directory, 'exclusive')).toThrow(/in use/)
  })

  it('lets an already-current briefing participant join a held server lock without exclusive bootstrap or DDL', async () => {
    const server = await participant()
    expect(server.ready).toBe(true)
    const before = schemaVersion()
    const briefing = await participant()
    expect(briefing).toMatchObject({ ready: true, upgrades: 0 })
    expect(schemaVersion()).toBe(before)
  })

  it('upgrades an old schema once under exclusive ownership and retains its pre-upgrade backup', async () => {
    const filename = path.join(directory, 'paper.sqlite')
    new PaperDatabase(filename).close()
    const old = new DatabaseSync(filename)
    old.exec(`ALTER TABLE undo_actions DROP COLUMN backend_id; ALTER TABLE undo_actions DROP COLUMN expected_revisions_json; PRAGMA user_version = 9`)
    old.close()
    const starts = await Promise.all([participant(), participant()])
    expect(starts.every(start => start.ready)).toBe(true)
    expect(starts.reduce((count, start) => count + start.upgrades, 0)).toBe(1)
    const saved = new DatabaseSync(filename + '.before-standalone-setup-v10', { readOnly: true })
    expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(9)
    saved.close()
    const upgraded = new DatabaseSync(filename, { readOnly: true })
    expect(upgraded.prepare('PRAGMA table_info(undo_actions)').all().map(row => row.name))
      .toEqual(expect.arrayContaining(['backend_id', 'expected_revisions_json']))
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'migration_*'").all()).toEqual([])
    upgraded.close()
  })

  it('closes initialization failures before any application file exists', async () => {
    await expect(openCoordinatedStorage(directory, { onUpgrade() { throw new Error('Synthetic initialization failure') } })).rejects.toThrow('Synthetic initialization failure')
    expect(fs.existsSync(path.join(directory, 'paper.sqlite'))).toBe(false)
    const storage = await openCoordinatedStorage(directory)
    expect(storage.database.entryCount()).toBe(0)
    storage.close(); storage.close()
    acquireStateLock(directory, 'exclusive').release()
  })

  it('does not open application storage while an exclusive lock is held', async () => {
    const lock = acquireStateLock(directory, 'exclusive')
    try {
      await expect(openCoordinatedStorage(directory, { timeoutMs: 0 })).rejects.toThrow(/in use/)
      expect(fs.existsSync(path.join(directory, 'paper.sqlite'))).toBe(false)
    } finally { lock.release() }
  })

  it.each(['active', 'activating'])('ignores leftover %s migration files during initialization and restart', async phase => {
    const id = '00000000-0000-0000-0000-000000000000'
    fs.writeFileSync(path.join(directory, 'migration.json'), JSON.stringify({ version: 1, id, phase }))
    const plans = path.join(directory, 'migrations', id)
    fs.mkdirSync(plans, { recursive: true })
    fs.writeFileSync(path.join(plans, 'plan.json'), 'obsolete plan')
    const first = await openCoordinatedStorage(directory)
    const identity = first.database.bindStandalone()
    first.close()
    const restarted = await openCoordinatedStorage(directory, { onUpgrade() { throw new Error('Unexpected upgrade') } })
    expect(restarted.database.bindStandalone()).toEqual(identity)
    restarted.close()
    acquireStateLock(directory, 'exclusive').release()
  })
})
