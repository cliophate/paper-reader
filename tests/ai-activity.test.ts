import { DATABASE_VERSION } from '../src/server/auth-schema.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ACTIVITY_MAX_AGE, AI_ACTIVITY_VERSION, AiActivityStore, AiLimitError, MAX_ACTIVITY_ROWS } from '../src/server/ai-activity'
import { PulseService } from '../src/server/pulse'
import { HeadlineService } from '../src/server/headlines'
import { PaperDatabase } from '../src/server/db'

let db: PaperDatabase
beforeEach(() => { db = new PaperDatabase(':memory:') })
afterEach(() => db.close())

it('reserves background attempts across callers and resets at local midnight', async () => {
  let now = new Date(2026, 9, 24, 23, 59, 59, 999).getTime()
  const log = new AiActivityStore(db.greaderDatabase, () => now)
  log.savePolicy({ ...log.policy(), daily: 2, featureLimits: { headlines: 1 } })
  const model = vi.fn(async () => 'ok')
  const headlines = () => log.attempt('headlines', 'codex', 'fixture')(model)
  const run = () => log.withTrigger('sync', headlines)
  const [first, second] = await Promise.allSettled([run(), run()])
  expect(first.status).toBe('fulfilled')
  expect(second).toMatchObject({ status: 'rejected', reason: expect.any(AiLimitError) })
  await log.withTrigger('scheduled', () => log.attempt('briefing', 'codex', 'fixture')(model))
  const group = () => log.withTrigger('scheduled', () => log.attempt('grouping', 'codex', 'fixture')(model))
  await expect(group()).rejects.toThrow(AiLimitError)
  await headlines()
  expect(model).toHaveBeenCalledTimes(3)
  expect(log.view().used).toEqual({ headlines: 1, briefing: 1 })
  expect(log.view('headlines', 'limited').items).toMatchObject([{ trigger: 'sync' }])
  expect(log.view('headlines', 'ok').items.map(row => row.trigger)).toEqual(['manual', 'sync'])
  expect(log.paused('headlines')).toBe(true)
  now++
  expect(log.paused('headlines')).toBe(false)
  await run()
  expect(log.view().used).toEqual({ headlines: 1 })
})

it('bounds activity by age and count without losing quota usage', async () => {
  let now = Date.now()
  const log = new AiActivityStore(db.greaderDatabase, () => now)
  log.savePolicy({ ...log.policy(), daily: 1 })
  const run = () => log.attempt('briefing', 'codex', 'fixture')(async () => {})
  await log.withTrigger('scheduled', run)
  for (let i = 0; i < MAX_ACTIVITY_ROWS; i++) await run()
  const count = () => db.greaderDatabase.prepare('SELECT COUNT(*) AS n FROM ai_activity').get()!.n
  expect(count()).toBe(MAX_ACTIVITY_ROWS)
  expect(log.view().used).toEqual({ briefing: 1 })
  await expect(log.withTrigger('scheduled', run)).rejects.toThrow(AiLimitError)
  now += ACTIVITY_MAX_AGE + 1
  expect(log.view().items).toEqual([])
  await log.pruneActivity()
  expect(count()).toBe(0)
})

it('estimates only priced API usage and omits error diagnostics', async () => {
  const log = db.aiActivity
  log.savePolicy({ ...log.policy(), prices: [{ model: 'fixture', input: 2, output: 4 }] })
  for (const [provider, model, input] of [['openai', 'fixture', 100], ['codex', 'fixture', 100],
    ['openai', 'unpriced', 100], ['openai', 'fixture', -1]] as const) {
    await log.attempt('discussion', provider, model)(async report => report({ input, output: 50 }))
  }
  await expect(log.attempt('connection', 'openai', 'fixture')(async () => { throw new Error('Synthetic private diagnostic') })).rejects.toThrow()
  const items = log.view().items.reverse()
  expect(items.map(item => item.estimatedUsd)).toEqual([0.0004, null, null, null, null])
  expect(items[1]).toMatchObject({ inputTokens: 100, outputTokens: 50 })
  expect(JSON.stringify(items)).not.toContain('Synthetic private diagnostic')
})

it('cancels a prepared batch when an exclusion changes before dispatch', async () => {
  const log = db.aiActivity
  const model = vi.fn(async () => {})
  await log.withTrigger('scheduled', async () => {
    log.savePolicy({ ...log.policy(), feeds: ['synthetic-feed'] })
    await expect(log.attempt('briefing', 'codex', 'fixture')(model)).rejects.toMatchObject({ category: 'cancelled' })
  })
  expect(model).not.toHaveBeenCalled()
  expect(log.view().items).toMatchObject([{ outcome: 'cancelled', feature: 'briefing' }])
  expect(log.view().used).toEqual({})
})

it('checks live folder membership again at admission with no local membership rows', async () => {
  const log = db.aiActivity
  log.savePolicy({ ...log.policy(), folders: ['remote'] })
  log.navigation = vi.fn()
    .mockResolvedValueOnce({ folders: [{ id: 'remote', feeds: [] }] })
    .mockResolvedValueOnce({ folders: [{ id: 'remote', feeds: [{ id: 'moved' }] }] })
  const model = vi.fn(async () => {})
  await expect(log.withTrigger('scheduled', () => log.attempt('grouping', 'codex', 'fixture')(model)))
    .rejects.toMatchObject({ category: 'cancelled' })
  expect(model).not.toHaveBeenCalled()
  expect(log.view().used).toEqual({})
})

it('stores total-only usage and cancelled outcomes without estimating a price', async () => {
  const log = db.aiActivity
  log.savePolicy({ ...log.policy(), prices: [{ model: 'fixture', input: 2, output: 4 }] })
  const controller = new AbortController()
  await expect(log.attempt('discussion', 'openai', 'fixture', controller.signal)(async report => {
    report({ total: 27 })
    controller.abort()
    controller.signal.throwIfAborted()
  })).rejects.toThrow()
  expect(log.view().items[0]).toMatchObject({ outcome: 'cancelled', totalTokens: 27, inputTokens: null, outputTokens: null, estimatedUsd: null })
})

it('finishes recording a cancelled CLI attempt before closing storage', async () => {
  const log = db.aiActivity
  const controller = new AbortController()
  const started = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>()
  const result = log.withTrigger('scheduled', () => log.attempt('briefing', 'codex', 'fixture', controller.signal)(async () => {
    started.resolve()
    await stopped.promise
    controller.signal.throwIfAborted()
  })).catch(error => error)
  await started.promise
  controller.abort()
  const finish = log.finishPendingAttempts().then(() => log.view())
  await new Promise<void>(resolve => setImmediate(resolve))
  stopped.resolve()
  expect(await result).toBe(controller.signal.reason)
  const view = await finish
  expect(view.items).toMatchObject([{ outcome: 'cancelled' }])
  expect(view.used).toEqual({ briefing: 1 })
})

it('backs up schema v27 before creating the v28 activity tables', () => {
  expect(AI_ACTIVITY_VERSION).toBe(28)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ai-migration-'))
  const file = path.join(directory, 'paper.sqlite')
  try {
    const original = new PaperDatabase(file)
    original.setSyncValue('fixture', 'preserved')
    original.greaderDatabase.exec(`DROP TABLE ai_activity; DROP TABLE ai_daily_usage; PRAGMA user_version = ${AI_ACTIVITY_VERSION - 1}`)
    original.close()
    const upgraded = new PaperDatabase(file)
    try {
      expect(upgraded.aiActivity.view().items).toEqual([])
      expect(upgraded.getSyncValue('fixture')).toBe('preserved')
      expect(upgraded.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(AI_ACTIVITY_VERSION)
    } finally { upgraded.close() }
    const name = file + '.before-ai-activity-v' + AI_ACTIVITY_VERSION
    expect(fs.statSync(name).mode & 0o777).toBe(0o600)
    const previous = new DatabaseSync(name, { readOnly: true })
    try {
      expect(previous.prepare('PRAGMA user_version').get()?.user_version).toBe(AI_ACTIVITY_VERSION - 1)
      expect(previous.prepare("SELECT name FROM sqlite_master WHERE name='ai_activity'").get()).toBeUndefined()
    } finally { previous.close() }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

it.each([21, 22])('preserves activity from the earlier v%i branch alongside feed migrations', version => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ai-upgrade-'))
  const file = path.join(directory, 'paper.sqlite')
  try {
    const previous = new PaperDatabase(file)
    previous.greaderDatabase.exec(`
      INSERT INTO ai_activity(feature,trigger,provider,model,started,duration,outcome) VALUES('briefing','manual','codex','fixture',0,0,'ok');
      ALTER TABLE ai_activity DROP COLUMN ownerPid;
      ALTER TABLE ai_activity DROP COLUMN ownerId;
      DROP TABLE feed_overrides;
      ${version === 21 ? 'ALTER TABLE ai_activity DROP COLUMN reason; ALTER TABLE feed_fetch_state DROP COLUMN declared_url;' : ''}
      PRAGMA user_version = ${version};
    `)
    previous.close()
    const current = new PaperDatabase(file)
    try {
      expect(current.greaderDatabase.prepare('SELECT reason, outcome FROM ai_activity').get()).toMatchObject({ reason: null, outcome: 'ok' })
      expect(current.greaderDatabase.prepare("SELECT name FROM pragma_table_info('feed_fetch_state') WHERE name='declared_url'").get()).toBeDefined()
      expect(current.greaderDatabase.prepare('SELECT revision FROM feed_overrides').all()).toEqual([])
      expect(current.greaderDatabase.prepare('SELECT ownerPid,ownerId FROM ai_activity').get()).toEqual({ ownerPid: null, ownerId: null })
      expect(current.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
    } finally { current.close() }
  } finally { fs.rmSync(directory, { recursive: true }) }
})

it('keeps the service quota day across CLI time zones and retains the two previous days', async () => {
  vi.stubEnv('TZ', 'America/Los_Angeles')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-quota-zone-'))
  const file = path.join(directory, 'paper.sqlite')
  const server = new PaperDatabase(file)
  vi.stubEnv('TZ', 'UTC')
  const cli = new PaperDatabase(file)
  try {
    let now = Date.parse('2026-06-18T01:00:00Z')
    const service = new AiActivityStore(server.greaderDatabase, () => now)
    const command = new AiActivityStore(cli.greaderDatabase, () => now)
    service.savePolicy({ ...service.policy(), daily: 1 })
    const run = (log: AiActivityStore) => log.withTrigger('scheduled', () => log.attempt('briefing', 'codex', 'test')(async () => {}))
    await run(service)
    expect(command.view().timeZone).toBe('America/Los_Angeles')
    await expect(run(command)).rejects.toThrow(AiLimitError)
    now += 2 * 86_400_000
    await run(command)
    now -= 2 * 86_400_000
    await expect(run(service)).rejects.toThrow(AiLimitError)
  } finally { server.close(); cli.close(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true }) }
})

it('returns a successful result and completes its running activity row after a writer releases its lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ai-lock-'))
  const file = path.join(directory, 'paper.sqlite')
  const server = new PaperDatabase(file)
  const writer = new DatabaseSync(file)
  const log = server.aiActivity
  server.greaderDatabase.exec('PRAGMA busy_timeout = 5')
  try {
    const result = await log.withTrigger('sync', () => log.attempt('headlines', 'codex', 'fixture')(async report => {
      expect(log.view().items[0].outcome).toBe('running')
      writer.exec('BEGIN IMMEDIATE')
      setTimeout(() => writer.exec('COMMIT'), 80)
      report({ total: 10 })
      return 'successful result'
    }))
    expect(result).toBe('successful result')
    expect(log.view().items).toMatchObject([{ outcome: 'ok', totalTokens: 10 }])
    expect(log.view().used).toEqual({ headlines: 1 })
  } finally { writer.close(); server.close(); fs.rmSync(directory, { recursive: true }) }
})

it('records the missing folder at preflight and dispatch, then resumes after removal', async () => {
  const log = db.aiActivity
  log.savePolicy({ ...log.policy(), folders: ['category/4'], folderNames: { 'category/4': 'Old news' } })
  const empty = { folders: [] }
  log.navigation = vi.fn().mockResolvedValueOnce(empty)
    .mockResolvedValueOnce({ folders: [{ id: 'category/4', feeds: [] }] }).mockResolvedValue(empty)
  const model = vi.fn(async () => 'ok')
  const run = () => log.withTrigger('sync', () => log.attempt('grouping', 'openai', 'fixture')(model), 'grouping')
  for (let i = 0; i < 2; i++) await expect(run()).rejects.toThrow('excluded folder not found: Old news')
  expect(log.view().items.map(row => row.reason)).toEqual(Array(2).fill('excluded folder not found: Old news'))
  expect(log.view().used).toEqual({})
  expect(model).not.toHaveBeenCalled()
  log.savePolicy({ ...log.policy(), folders: [] })
  await expect(run()).resolves.toBe('ok')
})

it('retries a locked skip log and preserves the outage reason when logging fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-skip-lock-'))
  const file = path.join(directory, 'paper.sqlite')
  const server = new PaperDatabase(file)
  const writer = new DatabaseSync(file)
  const log = server.aiActivity
  try {
    server.greaderDatabase.exec('PRAGMA busy_timeout = 5')
    log.savePolicy({ ...log.policy(), folders: ['unavailable'] })
    log.navigation = vi.fn().mockRejectedValue(new Error('backend offline'))
    writer.exec('BEGIN IMMEDIATE')
    setTimeout(() => writer.exec('COMMIT'), 80)
    const run = () => log.withTrigger('sync', async () => {}, 'grouping')
    await expect(run()).rejects.toThrow(AiLimitError)
    expect(log.view().items).toMatchObject([{ outcome: 'limited', reason: 'Background AI skipped: exclusions unresolved.' }])
    writer.exec("CREATE TRIGGER fail_log BEFORE INSERT ON ai_activity BEGIN SELECT RAISE(ABORT, 'log unavailable'); END")
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(run()).rejects.toThrow(AiLimitError)
      await expect(log.attempt('discussion', 'codex', 'fixture')(async () => 'result')).resolves.toBe('result')
      expect(warn).toHaveBeenCalledWith('Could not write the AI activity log.')
    } finally { warn.mockRestore() }
  } finally { writer.close(); server.close(); fs.rmSync(directory, { recursive: true }) }
})

it('logs errors from the initial and later timer-driven AI jobs', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(db.aiActivity, 'withTrigger').mockRejectedValue(new Error('database unavailable'))
  const pulse = new PulseService(db, vi.fn())
  const headlines = new HeadlineService(db, vi.fn(), vi.fn())
  try {
    pulse.start()
    headlines.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(warn.mock.calls.filter(([message]) => message === 'Pulse refresh failed.')).toHaveLength(2)
    expect(warn.mock.calls.filter(([message]) => message === 'Headline refresh failed.')).toHaveLength(6)
  } finally { pulse.stop(); headlines.stop(); warn.mockRestore(); vi.useRealTimers() }
})

it('preserves a live CLI request on server startup and recovers previous, dead and stale owners', async () => {
  const log = db.aiActivity
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const cli = log.withTrigger('scheduled', () => log.attempt('briefing', 'codex', 'cli')(async () => {
    started.resolve()
    await finish.promise
  }))
  await started.promise
  try {
    const raw = db.greaderDatabase
    expect(raw.prepare("SELECT ownerPid,ownerId FROM ai_activity WHERE model='cli'").get())
      .toMatchObject({ ownerPid: process.pid, ownerId: expect.any(String) })
    db.setSyncValue('ai_server_process', 'previous-server')
    const insert = raw.prepare("INSERT INTO ai_activity(feature,trigger,provider,model,started,duration,outcome,ownerPid,ownerId) VALUES('briefing','scheduled','codex',?,?,0,'running',?,?)")
    insert.run('previous', Date.now(), process.pid, 'previous-server')
    insert.run('dead', Date.now(), 2147483647, 'exited-process')
    insert.run('stale', Date.now() - 15 * 60_000, process.pid, 'stale-process')
    await log.attempt('discussion', 'codex', 'finished')(async () => {})
    await log.recoverInterrupted()
    await log.recoverInterrupted()
    expect(Object.fromEntries(log.view().items.map(item => [item.model, item.outcome]))).toEqual({
      cli: 'running', previous: 'interrupted', dead: 'interrupted', stale: 'interrupted', finished: 'ok',
    })
  } finally { finish.resolve(); await cli }
  expect(log.view('briefing', 'ok').items).toMatchObject([{ model: 'cli' }])
  expect(log.view().used).toEqual({ briefing: 1 })
})

it('restores the current schema version after rebuilding the search index', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-ai-search-'))
  const file = path.join(directory, 'paper.sqlite')
  try {
    const original = new PaperDatabase(file)
    original.setSyncValue('fulltext_search_v1', '')
    original.close()
    const repaired = new PaperDatabase(file)
    expect(repaired.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(AI_ACTIVITY_VERSION)
    repaired.close()
    new PaperDatabase(file, { readOnly: true }).close()
  } finally { fs.rmSync(directory, { recursive: true }) }
})
