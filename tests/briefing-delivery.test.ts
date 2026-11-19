import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingDelivery, senderDomain } from '../src/server/briefing-delivery'
import { BriefingClock } from '../src/server/briefing-schedule'
import { loadConfig, type Config } from '../src/server/config'
import { PaperDatabase, type BriefingRecord } from '../src/server/db'
import { sendSmtp } from '../src/server/smtp'
import { openCoordinatedStorage } from '../src/server/storage-bootstrap'
import type { BriefingKind } from '../src/shared/briefing-delivery'
import { startSmtpFixture } from './fixtures/smtp.mjs'

const minute = 60_000
const at = Date.parse
let directory: string
let db: PaperDatabase
let config: Config
let smtp: Awaited<ReturnType<typeof startSmtpFixture>>
let now: number

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-briefing-delivery-'))
  for (const [key, value] of Object.entries({ STATE_DIR: directory, PAPER_BACKEND: 'standalone', TZ: 'UTC', PAPER_AI_PROVIDER: 'none', PAPER_BRIEFING_DELIVERY: 'false' })) vi.stubEnv(key, value)
  config = loadConfig({ internalSecret: 'synthetic-internal', signingSecret: 'synthetic-signing' })
  config.ai.enabled = true
  config.ai.provider = 'openai'
  config.briefingSchedule = { enabled: true, morning: '07:30', evening: '18:30' }
  config.briefingGraceMs = 180 * minute
  now = at('2026-04-02T07:30:00Z')
  db = new PaperDatabase(config.databasePath)
  smtp = await startSmtpFixture()
  config.smtp = { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'paper@example.test', to: 'reader@example.test', user: '', password: '' }
})
afterEach(async () => {
  await smtp.close()
  db.close()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

function save(kind: BriefingKind, database = db): BriefingRecord {
  const date = new Date(now).toISOString()
  const record = {
    id: randomUUID(), kind, status: 'generated', cutoff: date, createdAt: date, windowStart: date,
    subject: 'Synthetic briefing', text: 'Synthetic text', html: '<p>Synthetic body</p>',
    tokenHash: 'fixture', selection: { news: [], social: [], worthNoticing: [] },
    deliveredAt: null, acknowledgedAt: null,
  }
  database.createBriefing(record, [])
  return record
}
const generator = (database?: PaperDatabase) => ({
  generateScheduled: vi.fn(async (kind: BriefingKind, _signal: AbortSignal, onSaved: (record: BriefingRecord) => void) => {
    const owner = database ?? db
    return owner.transaction(() => {
      const record = save(kind, owner)
      onSaved(record)
      return record
    })
  }),
})
const scheduler = (service = generator(), database = db) => new BriefingDelivery(config, database, service, () => now)
function reopen() {
  db.close()
  db = new PaperDatabase(config.databasePath)
}

describe('wall clock scheduling', () => {
  it('moves a spring gap forward by its length', () => {
    expect(new BriefingClock('America/New_York').at('2026-03-08', '02:30')).toBe(at('2026-03-08T07:30:00Z'))
    expect(new BriefingClock('Australia/Lord_Howe').at('2026-10-04', '02:15')).toBe(at('2026-10-03T15:45:00Z'))
  })

  it.each([
    ['spring gap', '02:30', '2026-03-08T07:30:00Z', '2026-03-08T08:30:00Z'],
    ['fall fold', '01:30', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'],
  ])('sends once at the chosen instant across the %s', async (_name, time, first, second) => {
    config.timeZone = 'America/New_York'
    config.briefingSchedule.morning = time
    const service = generator()
    now = at(first) - minute
    await scheduler(service).tick()
    expect(db.briefingDelivery.history()).toEqual([])
    now = at(first)
    await scheduler(service).tick()
    now = at(second)
    reopen()
    await scheduler(service).tick()
    expect(smtp.messages).toHaveLength(1)
    expect(service.generateScheduled).toHaveBeenCalledOnce()
    expect(db.briefingDelivery.history()).toMatchObject([{ state: 'delivered', scheduledAt: at(first) }])
  })
})

it('catches up across local midnight and records runs outside grace', async () => {
  config.briefingSchedule.evening = '23:45'
  now = at('2026-04-03T00:10:00Z')
  const service = generator()
  await scheduler(service).tick()
  expect(db.briefingDelivery.history()).toMatchObject([{ kind: 'evening', state: 'delivered', scheduledAt: at('2026-04-02T23:45:00Z') }])
  reopen()
  now = at('2026-04-04T09:00:00Z')
  await scheduler(service).tick()
  expect(db.briefingDelivery.history()).toMatchObject([
    { kind: 'morning', state: 'delivered' }, { kind: 'evening', state: 'missed' },
    { kind: 'morning', state: 'missed' }, { kind: 'evening', state: 'delivered' },
  ])
  expect(service.generateScheduled).toHaveBeenCalledTimes(2)
})

it('enforces one job and one SMTP send across concurrent ticks and a restart', async () => {
  const service = generator()
  const other = new PaperDatabase(config.databasePath)
  const otherService = generator(other)
  const first = scheduler(service), second = scheduler(otherService, other)
  try {
    await Promise.all([first.tick(), second.tick(), first.tick()])
    expect(service.generateScheduled).toHaveBeenCalledOnce()
    expect(otherService.generateScheduled).not.toHaveBeenCalled()
  } finally { other.close() }
  reopen()
  await scheduler(service).tick()
  expect(smtp.messages).toHaveLength(1)
  expect(db.briefingDelivery.history()).toMatchObject([{ state: 'delivered', attempts: 1 }])
})

it('retries only SMTP after backoff across restart and marks delivery after the final reply', async () => {
  const service = generator()
  smtp.mode = 'drop'
  await scheduler(service).tick()
  const id = db.listBriefings()[0].id
  expect(db.getBriefing(id)?.deliveredAt).toBeNull()
  expect(db.briefingDelivery.history()).toMatchObject([{ state: 'retrying', attempts: 1, lastError: expect.stringContaining('connection closed') }])
  reopen()
  now += minute - 1
  await scheduler(service).tick()
  expect(smtp.connections).toBe(1)

  smtp.mode = 'accept'
  const { promise: received, resolve: receivedData } = Promise.withResolvers<void>()
  const { promise: accept, resolve: acceptData } = Promise.withResolvers<void>()
  smtp.beforeAccept = () => { receivedData(); return accept }
  now++
  const retry = scheduler(service).tick()
  await received
  try {
    expect(db.getBriefing(id)?.deliveredAt).toBeNull()
    expect(db.briefingDelivery.history()).toMatchObject([{ state: 'sending', attempts: 2 }])
  } finally { acceptData(); await retry }
  expect(smtp.messages).toHaveLength(1)
  expect(smtp.messages[0]).toContain('Synthetic body')
  expect(db.getBriefing(id)?.deliveredAt).toBeTruthy()
  expect(service.generateScheduled).toHaveBeenCalledOnce()
})

it('resumes an interrupted attempt before DATA and stops if the relay might already have the message', async () => {
  const service = generator()
  smtp.mode = 'drop'
  await scheduler(service).tick()
  const [{ id }] = db.briefingDelivery.history()
  db.briefingDelivery.startAttempt(id, now)
  reopen()
  smtp.mode = 'drop-after-data'
  await scheduler(service).tick()
  expect(db.briefingDelivery.history()).toMatchObject([{ state: 'unconfirmed', attempts: 3 }])
  expect(db.listBriefings()[0].deliveredAt).toBeNull()
  // Simulate process loss after the DATA checkpoint with no recorded reply.
  db.briefingDelivery.startAttempt(id, now)
  db.briefingDelivery.startData(id, now)
  reopen()
  smtp.mode = 'accept'
  await scheduler(service).tick()
  expect(db.briefingDelivery.history()).toMatchObject([{ state: 'unconfirmed', attempts: 4 }])
  expect(smtp.messages).toHaveLength(1)
  expect(service.generateScheduled).toHaveBeenCalledOnce()
})

it('skips an earlier externally delivered edition and a saved retry delivered in the meantime', async () => {
  const service = generator()
  const morning = save('morning')
  db.markDelivered(morning.id)
  await scheduler(service).tick()
  expect(smtp.connections).toBe(0)
  expect(service.generateScheduled).not.toHaveBeenCalled()
  now = at('2026-04-02T18:30:00Z')
  smtp.mode = 'drop'
  await scheduler(service).tick()
  const evening = db.listBriefings().find(record => record.kind === 'evening')!
  db.markDelivered(evening.id)
  now += minute
  await scheduler(service).tick()
  expect(db.briefingDelivery.history()).toMatchObject([
    { kind: 'evening', state: 'skipped', lastError: 'This edition was already delivered.' },
    { kind: 'morning', state: 'skipped', attempts: 0 },
  ])
  expect(smtp.connections).toBe(1)
})

it.each(['ai', 'briefings', 'delivery'] as const)('respects the %s switch', async key => {
  const service = generator()
  if (key === 'ai') config.ai.enabled = false
  if (key === 'briefings') config.ai.briefingsEnabled = false
  if (key === 'delivery') config.briefingSchedule.enabled = false
  await scheduler(service).tick()
  expect(db.briefingDelivery.history()).toMatchObject(key === 'delivery' ? [] : [{ state: 'skipped', attempts: 0, lastError: expect.stringContaining('is off') }])
  expect(service.generateScheduled).not.toHaveBeenCalled()
  expect(smtp.connections).toBe(0)
})

it.each([
  ['auth', 'SMTP authentication failed (SMTP 535)'],
  ['recipient', 'SMTP rejected the recipient (SMTP 550)'],
] as const)('records the SMTP %s error without relaying diagnostics or marking delivery', async (mode, message) => {
  smtp.mode = mode
  Object.assign(config.smtp, { user: 'fixture', password: 'synthetic-private-echo' })
  await scheduler().tick()
  expect(smtp.messages).toHaveLength(0)
  expect(db.listBriefings()[0].deliveredAt).toBeNull()
  const [job] = db.briefingDelivery.history()
  expect(job).toMatchObject({ state: 'failed', attempts: 1, lastError: expect.stringContaining(message) })
  expect(job.lastError).not.toContain('synthetic-private-echo')
})

it('explains a STARTTLS mismatch', async () => {
  await expect(sendSmtp({ ...config.smtp, security: 'starttls' }, { subject: 'Test', text: 'Synthetic' })).rejects.toThrow(/TLS handshake failed/)
})

it('explains a refused connection', async () => {
  await smtp.close()
  await expect(sendSmtp(config.smtp, { subject: 'Test', text: 'Synthetic' })).rejects.toThrow(/SMTP connection refused/)
})

it('backs up schema v19 privately before migration and preserves saved briefings', async () => {
  const briefing = save('morning')
  db.greaderDatabase.exec('DROP TABLE briefing_delivery_jobs; DROP INDEX briefing_edition; PRAGMA user_version = 19')
  db.close()
  const storage = await openCoordinatedStorage(directory)
  try {
    expect(storage.database.getBriefing(briefing.id)).toEqual(briefing)
    expect(storage.database.briefingDelivery.history()).toEqual([])
    expect(storage.database.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(20)
  } finally { storage.close() }
  const name = config.databasePath + '.before-briefing-delivery-v20'
  expect(fs.statSync(name).mode & 0o777).toBe(0o600)
  const backup = new DatabaseSync(name, { readOnly: true })
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(19)
    expect(backup.prepare("SELECT id FROM briefings WHERE id = ?").get(briefing.id)).toEqual({ id: briefing.id })
    expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'briefing_delivery_jobs'").get()).toBeUndefined()
  } finally { backup.close(); db = new PaperDatabase(config.databasePath) }
})

it('uses the sender domain for the Message-ID', async () => {
  expect(senderDomain('Paper <Briefings@Example.TEST>')).toBe('example.test')
  expect(senderDomain('paper@mail.example.test')).toBe('mail.example.test')
  expect(senderDomain('no address')).toBe('paper.invalid')
  await scheduler().tick()
  expect(smtp.messages[0]).toMatch(/^Message-ID: <[^@>]+@example\.test>/mi)
})
