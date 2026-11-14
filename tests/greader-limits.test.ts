import { afterEach, expect, it, vi } from 'vitest'
import { GreaderLimits } from '../src/server/greader-limits'

afterEach(() => vi.useRealTimers())
it('shapes 200 sequential pages and eight downloads without rejection at the app budget', async () => {
  vi.useFakeTimers()
  const limits = new GreaderLimits(), signal = new AbortController().signal
  let completed = 0
  const sync = (async () => {
    for (let i = 0; i < 200; i++) { await limits.acquire('app', false, signal); completed++ }
    await Promise.all(Array.from({ length: 8 }, () => limits.acquire('app', false, signal)))
  })()
  await vi.advanceTimersByTimeAsync(16_800)
  await sync
  expect(completed).toBe(200)
  limits.close()
})
it('keeps FIFO order, caps app waiters, reports their wait and releases disconnected requests', async () => {
  vi.useFakeTimers()
  const limits = new GreaderLimits(), signal = new AbortController().signal
  for (let i = 0; i < 40; i++) await limits.acquire('app', false, signal)
  const order: number[] = [], cancel = new AbortController()
  const abandoned = limits.acquire('app', false, cancel.signal).catch(error => error)
  const waiting = Array.from({ length: 63 }, (_, i) => limits.acquire('app', false, signal).then(() => order.push(i)))
  await expect(limits.acquire('app', false, signal)).rejects.toMatchObject({ status: 429, retryAfter: 7 })
  cancel.abort(); expect((await abandoned).status).toBe(503)
  const replacement = limits.acquire('app', false, signal).then(() => order.push(63))
  await vi.advanceTimersByTimeAsync(6400)
  await Promise.all([...waiting, replacement])
  expect(order).toEqual(Array.from({ length: 64 }, (_, i) => i))
  limits.close()
})
it('bounds the account queue and write wait, without spending partial budgets on rejection', async () => {
  vi.useFakeTimers()
  const limits = new GreaderLimits(), signal = new AbortController().signal
  for (let i = 0; i < 80; i++) await limits.acquire(String(i), false, signal)
  const waiting = Array.from({ length: 128 }, (_, i) => limits.acquire(String(i), false, signal))
  await expect(limits.acquire('extra', false, signal)).rejects.toMatchObject({ status: 429, retryAfter: 7 })
  await vi.advanceTimersByTimeAsync(6400); await Promise.all(waiting); limits.close()
  const writes = new GreaderLimits()
  for (let i = 0; i < 10; i++) await writes.acquire('app', true, signal)
  const pending = Array.from({ length: 20 }, () => writes.acquire('app', true, signal))
  await expect(writes.acquire('app', true, signal)).rejects.toMatchObject({ status: 429, retryAfter: 11 })
  await vi.advanceTimersByTimeAsync(10_000); await Promise.all(pending); writes.close()
})
it('keeps discovery reject-style and rejects queued requests on shutdown', async () => {
  vi.useFakeTimers()
  const limits = new GreaderLimits(), signal = new AbortController().signal
  for (let i = 0; i < 10; i++) limits.discovery()
  expect(() => limits.discovery()).toThrow(expect.objectContaining({ status: 429, retryAfter: 6 }))
  for (let i = 0; i < 40; i++) await limits.acquire('app', false, signal)
  const queued = limits.acquire('app', false, signal)
  const rejected = expect(queued).rejects.toMatchObject({ status: 503 })
  limits.close(); await rejected
})
