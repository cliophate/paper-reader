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


it('preserves the full-text capacity error for the reader', async () => {
  const message = 'Paper is fetching too many full articles. Try again shortly.'
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: message }), { status: 503 }))
  await expect(api.fullText('https://example.test/article')).rejects.toMatchObject({ message, status: 503 })
})
