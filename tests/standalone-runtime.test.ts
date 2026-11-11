import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { StandaloneBackend } from '../src/server/standalone-backend.js'
import { StandaloneFeedScheduler } from '../src/server/feed-scheduler.js'
import { StandaloneRuntime } from '../src/server/standalone-runtime.js'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }))
const empty = { attempted: 0, fetched: 0, notModified: 0, failed: 0, stale: 0, ambiguous: 0 }
let db: PaperDatabase
let runtime: StandaloneRuntime
let resume: () => void
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
beforeEach(() => {
  db = new PaperDatabase(':memory:')
  runtime = new StandaloneRuntime(db, new StandaloneBackend(db), true, [])
  vi.mocked(delay).mockImplementation((_ms, value, options) => new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('Synthetic abort'))
    resume = () => { options?.signal?.removeEventListener('abort', aborted); resolve(value) }
    if (options?.signal?.aborted) aborted()
    else options?.signal?.addEventListener('abort', aborted, { once: true })
  }))
})
afterEach(async () => { await runtime.stop(); db.close(); vi.restoreAllMocks(); vi.clearAllMocks() })

it('records a failed pass, retries with capped backoff, and resets after success', async () => {
  const run = vi.spyOn(StandaloneFeedScheduler.prototype, 'runDue').mockRejectedValue(new Error('Synthetic collection failure'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  runtime.start(); await flush()
  expect(runtime.status().lastError).toBe('Synthetic collection failure')
  for (const ms of [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
    expect(vi.mocked(delay).mock.lastCall?.[0]).toBe(ms)
    resume(); await flush()
  }
  run.mockResolvedValueOnce(empty)
  resume(); await flush()
  expect(runtime.status().lastError).toBeNull()
  expect(vi.mocked(delay).mock.lastCall?.[0]).toBe(1000)
  resume(); await flush()
  expect(runtime.status().lastError).toBe('Synthetic collection failure')
  expect(vi.mocked(delay).mock.lastCall?.[0]).toBe(5000)
  const calls = run.mock.calls.length
  await runtime.stop()
  expect(run).toHaveBeenCalledTimes(calls)
})

it('records manual sync failures and clears them after an empty successful pass', async () => {
  const run = vi.spyOn(StandaloneFeedScheduler.prototype, 'runDue').mockRejectedValueOnce(new Error('Synthetic manual failure')).mockResolvedValue(empty)
  await expect(runtime.syncNow()).rejects.toThrow('Synthetic manual failure')
  expect(runtime.status().lastError).toBe('Synthetic manual failure')
  await runtime.syncNow()
  expect(runtime.status().lastError).toBeNull()
  expect(run).toHaveBeenCalledTimes(2)
})

it('aborts an active pass without recording a shutdown error or starting another pass', async () => {
  const run = vi.spyOn(StandaloneFeedScheduler.prototype, 'runDue').mockImplementation(({ signal } = {}) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(new Error('Synthetic shutdown')), { once: true })
  }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  runtime.start(); await flush()
  await runtime.stop()
  expect(runtime.status().lastError).toBeNull()
  expect(run).toHaveBeenCalledOnce()
  expect(delay).not.toHaveBeenCalled()
})
