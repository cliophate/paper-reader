import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireStateLock } from '../src/server/state-lock.js'

let directory: string
const children: ChildProcess[] = []
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-test-')) })
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }))
  fs.rmSync(directory, { recursive: true, force: true })
})
async function worker(mode: 'shared' | 'exclusive') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/state-lock-worker.ts', directory, mode], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
  })
  children.push(child)
  const [chunk] = await once(child.stdout!, 'data')
  return { child, status: String(chunk).trim() }
}
async function kill(child: ChildProcess) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }

describe('process coordination', () => {
  it('allows server and briefing participants together, excludes exclusive access, and releases after crashes', async () => {
    const server = await worker('shared')
    const briefing = await worker('shared')
    expect(server.status).toBe('held'); expect(briefing.status).toBe('held')
    expect((await worker('exclusive')).status).toBe('blocked')
    await kill(server.child)
    expect((await worker('exclusive')).status).toBe('blocked')
    await kill(briefing.child)
    const exclusive = await worker('exclusive')
    expect(exclusive.status).toBe('held')
    expect((await worker('shared')).status).toBe('blocked')
    expect((await worker('exclusive')).status).toBe('blocked')
    await kill(exclusive.child)
    expect((await worker('shared')).status).toBe('held')
  })

  it('closes failed initialization handles and keeps the permanent lock file', () => {
    const filename = path.join(directory, 'paper-lock.sqlite')
    const blocker = new DatabaseSync(filename)
    blocker.exec('BEGIN EXCLUSIVE')
    expect(() => acquireStateLock(directory, 'shared')).toThrow(/in use/)
    blocker.close()
    const inode = fs.statSync(filename).ino
    const lock = acquireStateLock(directory, 'exclusive')
    lock.release(); lock.release()
    expect(fs.statSync(filename).ino).toBe(inode)
    acquireStateLock(directory, 'shared').release()
  })

  it('rejects WAL coordination and malformed initialized schemas without mutating them', () => {
    const filename = path.join(directory, 'paper-lock.sqlite')
    const db = new DatabaseSync(filename)
    db.exec('PRAGMA journal_mode = WAL')
    expect(() => acquireStateLock(directory, 'shared')).toThrow(/unavailable/)
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE paper_lock (id INTEGER); PRAGMA user_version = 1')
    expect(() => acquireStateLock(directory, 'exclusive')).toThrow(/unavailable/)
    db.exec('BEGIN EXCLUSIVE; ROLLBACK'); db.close()
  })
})
