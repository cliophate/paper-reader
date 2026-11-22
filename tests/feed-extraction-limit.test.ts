import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { extractWithOverrides } from '../src/server/feed-extraction.js'

const workers: FakeWorker[] = []
class FakeWorker extends EventEmitter {
  postMessage = vi.fn()
  constructor() { super(); workers.push(this) }
  ref() {}
  unref() {}
  async terminate() { this.emit('exit', 0) }
}
vi.mock('node:worker_threads', () => ({ get Worker() { return FakeWorker } }))

it('shares two workers across feeds and articles and honors aborts and deadlines in the queue', async () => {
  const rules = { contentSelector: 'main', removeSelectors: [], lazyImages: false, stripTracking: false }
  const task = { kind: 'article', url: 'https://example.test/story', body: '<main>Story</main>' } as const
  const first = extractWithOverrides(task, rules, vi.fn())
  const second = extractWithOverrides({ ...task, kind: 'feed' }, rules, vi.fn())
  const controller = new AbortController()
  const cancelled = extractWithOverrides(task, rules, vi.fn(), controller.signal)
  controller.abort(new Error('Preview closed'))
  await expect(cancelled).rejects.toThrow('Preview closed')

  const warning = Promise.withResolvers<string>()
  const retry = extractWithOverrides(task, rules, warning.resolve, undefined, 10)
  expect(await warning.promise).toContain('timed out')
  expect(workers).toHaveLength(2)
  expect(workers.map(worker => worker.postMessage.mock.calls.length)).toEqual([1, 1])

  workers[0].emit('message', { value: 'first' })
  await expect(first).resolves.toBe('first')
  expect(workers[0].postMessage.mock.lastCall?.[0]).toMatchObject({ kind: 'article', rules: undefined })
  workers[0].emit('message', { value: 'fallback' })
  workers[1].emit('message', { value: 'feed' })
  await expect(retry).resolves.toBe('fallback')
  await expect(second).resolves.toBe('feed')
  expect(workers).toHaveLength(2)
})
