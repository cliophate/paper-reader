import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { defaultPolicy } from '../src/server/retention-store'
import { openCoordinatedStorage } from '../src/server/storage-bootstrap'
import { DatabaseSync } from 'node:sqlite'

let directory: string, database: PaperDatabase
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-auth-cli-')); database = new PaperDatabase(path.join(directory, 'paper.sqlite')) })
afterEach(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }) })
async function cli(action: string, input = '') {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/auth-cli.ts', action], { env: { PATH: process.env.PATH, STATE_DIR: directory }, stdio: 'pipe' })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { error += chunk }); child.stdin.end(input)
  const code = await new Promise<number | null>(resolve => child.on('exit', resolve))
  return { code, output: output.trim(), error }
}
it('issues codes and recovers a running database without backend credentials or secret output', async () => {
  const issued = await cli('setup-code'); expect(issued.code).toBe(0); expect(issued.output).toMatch(/^[\w-]{43}$/)
  await database.auth.setup(issued.output, 'owner', 'synthetic initial password')
  const token = database.auth.newSession('', 'browser'); await database.auth.createApp('Phone', token)
  const reset = await cli('reset-password', 'synthetic reset password\n')
  expect(reset.code).toBe(0); expect(reset.output + reset.error).not.toContain('synthetic reset password')
  await database.auth.passwordLogin('owner', 'synthetic reset password')
  expect(database.auth.session(token)).toBeUndefined(); expect(database.auth.apps()).toEqual([])
  database.auth.addPasskey({ id: 'test', publicKey: new Uint8Array([1]), counter: 0 }, 'Phone')
  expect((await cli('remove-passkeys')).code).toBe(0); expect(database.auth.passkeys()).toEqual([])
  const generation = database.auth.generation()
  expect((await cli('revoke-all')).code).toBe(0); expect(database.auth.generation()).toBe(generation + 1)
  expect((await cli('disable')).code).toBe(0); expect(database.auth.enabled()).toBe(false)
  expect((await cli('setup-code')).code).toBe(0)
}, 20000)
it.each([13, 14])('upgrades schema %i through retention v14 to login v15 and preserves credentials on restart', async version => {
  database.close()
  const file = path.join(directory, 'paper.sqlite'), raw = new DatabaseSync(file)
  raw.exec('DROP TABLE auth_meta; DROP TABLE auth_owner; DROP TABLE auth_setup; DROP TABLE auth_sessions; DROP TABLE auth_passkeys; DROP TABLE auth_challenges; DROP TABLE auth_apps; DROP TABLE auth_limits')
  if (version === 13) {
    for (const table of ['retention_auto_read', 'retention_removals', 'retention_settings', 'retention_runs', 'retention_feeds', 'retention_present', 'retention_tombstones', 'retention_briefing_entries']) raw.exec(`DROP TABLE ${table}`)
    for (const index of ['article_aliases_entry_idx', 'article_fingerprints_entry_idx', 'article_cache_age_idx', 'article_reports_entry_idx', 'reading_progress_recent_idx']) raw.exec(`DROP INDEX ${index}`)
  } else {
    raw.prepare('INSERT INTO retention_settings VALUES (1, 7, ?)').run(JSON.stringify({ ...defaultPolicy(), cacheDays: 30 }))
    raw.exec("INSERT INTO retention_removals VALUES (42, 1800000000000, 'synthetic-feed', 'Removed article')")
  }
  raw.exec(`PRAGMA user_version = ${version}`); raw.close()
  expect(() => new PaperDatabase(file, { readOnly: true })).toThrow(/current initialized/)
  expect(fs.readdirSync(directory).filter(name => name.includes('.before-'))).toEqual([])
  const storage = await openCoordinatedStorage(directory)
  storage.close()
  database = new PaperDatabase(file)
  const upgraded = new DatabaseSync(file, { readOnly: true })
  expect(upgraded.prepare('PRAGMA user_version').get()!.user_version).toBe(15)
  expect(upgraded.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
  upgraded.close()
  const loginBackup = file + '.before-owner-login-v15'
  const backup = new DatabaseSync(loginBackup, { readOnly: true })
  expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(14)
  expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'auth_owner'").get()).toBeUndefined()
  expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'retention_settings'").get()).toBeDefined()
  backup.close()
  expect(fs.statSync(loginBackup).mode & 0o777).toBe(0o600)
  expect(fs.readdirSync(directory).filter(name => name.includes('.before-')).sort()).toEqual([
    'paper.sqlite.before-owner-login-v15', ...(version === 13 ? ['paper.sqlite.before-retention-v14'] : []),
  ])
  if (version === 13) {
    const retentionBackup = new DatabaseSync(file + '.before-retention-v14', { readOnly: true })
    expect(retentionBackup.prepare('PRAGMA user_version').get()!.user_version).toBe(13)
    expect(retentionBackup.prepare("SELECT name FROM sqlite_master WHERE name = 'retention_settings'").get()).toBeUndefined()
    retentionBackup.close()
    expect(fs.statSync(file + '.before-retention-v14').mode & 0o777).toBe(0o600)
    expect(database.retention.settings().policy).toEqual(defaultPolicy())
  } else {
    expect(database.retention.settings()).toEqual({ revision: 7, policy: { ...defaultPolicy(), cacheDays: 30 } })
    expect(database.retention.removal(42)).toMatchObject({ title: 'Removed article' })
  }
  expect(database.auth.enabled()).toBe(false)
  const savedBackup = fs.readFileSync(loginBackup)
  await database.auth.setup(database.auth.setupCode(), 'owner', 'synthetic persisted password')
  const token = database.auth.newSession('', 'browser'), app = await database.auth.createApp('Phone', token)
  database.close(); database = new PaperDatabase(file)
  expect(fs.readFileSync(loginBackup)).toEqual(savedBackup)
  const reader = new PaperDatabase(file, { readOnly: true }); reader.close()
  await database.auth.passwordLogin('owner', 'synthetic persisted password')
  expect(database.auth.session(token)).toBeDefined()
  expect((await database.auth.checkApp('owner', app.password, 'ip')).generation).toBe(0)
})
