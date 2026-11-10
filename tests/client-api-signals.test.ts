import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../src/client/api'

afterEach(() => vi.restoreAllMocks())

it.each(['any', 'timeout'] as const)('fetches sources and status without optional AbortSignal.%s', async method => {
  vi.spyOn(AbortSignal, method).mockImplementation(undefined as never)
  Object.defineProperty(AbortSignal, method, { configurable: true, value: undefined })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
  const controller = new AbortController()
  await api.organization(false, controller.signal)
  await api.status(controller.signal)
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const call of fetch.mock.calls) expect(call[1]?.signal).toBe(controller.signal)
})
