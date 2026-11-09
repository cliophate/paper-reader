import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArticleNavigation } from '../src/client/articleNavigation'
import { createArticleBoundaryStore } from '../src/client/articleBoundaryStore'

afterEach(() => vi.useRealTimers())

describe('article navigation', () => {
  it('waits for content, ignores repeated swipes, then commits without animation frames', async () => {
    const navigation = createArticleNavigation()
    const commit = vi.fn()
    const busy = vi.fn()
    const error = vi.fn()
    let resolve!: (commit: () => void) => void
    const pending = navigation.run(() => new Promise(done => { resolve = done }), busy, error)
    expect(commit).not.toHaveBeenCalled()
    expect(busy).toHaveBeenCalledWith(true)
    const repeated = vi.fn()
    expect(await navigation.run(repeated, busy, error)).toBe(false)
    expect(repeated).not.toHaveBeenCalled()
    resolve(commit)
    expect(await pending).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(error).not.toHaveBeenCalled()
  })

  it('times out even if the loader ignores abort, and never commits a late result', async () => {
    vi.useFakeTimers()
    const navigation = createArticleNavigation(100)
    const commit = vi.fn()
    const busy = vi.fn()
    const error = vi.fn()
    let resolve!: (commit: () => void) => void
    let signal!: AbortSignal
    const pending = navigation.run(current => {
      signal = current
      return new Promise(done => { resolve = done })
    }, busy, error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toBe(false)
    expect(signal.aborted).toBe(true)
    expect(busy).toHaveBeenLastCalledWith(false)
    expect(error.mock.calls[0][0].message).toContain('too long')
    resolve(commit)
    await Promise.resolve()
    expect(commit).not.toHaveBeenCalled()
    expect(await navigation.run(async () => commit, busy, error)).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels navigation silently when leaving the reader', async () => {
    const navigation = createArticleNavigation()
    const commit = vi.fn()
    const error = vi.fn()
    const busy = vi.fn()
    let resolve!: (commit: () => void) => void
    const pending = navigation.run(() => new Promise(done => { resolve = done }), busy, error)
    navigation.cancel()
    expect(await pending).toBe(false)
    resolve(commit)
    await Promise.resolve()
    expect(commit).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(busy).toHaveBeenLastCalledWith(false)
  })

  it('releases the lock after a failed load or an empty stream', async () => {
    const navigation = createArticleNavigation()
    const busy = vi.fn()
    const error = vi.fn()
    expect(await navigation.run(async () => { throw new Error('Offline') }, busy, error)).toBe(false)
    expect(error.mock.calls[0][0].message).toBe('Offline')
    expect(await navigation.run(async () => null, busy, error)).toBe(false)
    const commit = vi.fn()
    expect(await navigation.run(async () => commit, busy, error)).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(busy).toHaveBeenLastCalledWith(false)
  })
})

describe('isolated swipe indicators', () => {
  it('notifies only subscribers, ignores jitter, and always reports threshold changes', () => {
    const store = createArticleBoundaryStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.set({ direction: 'next', progress: 0.5, ready: false })
    store.set({ direction: 'next', progress: 0.505, ready: false })
    expect(listener).toHaveBeenCalledTimes(1)
    store.set({ direction: 'next', progress: 0.51, ready: true })
    expect(listener).toHaveBeenCalledTimes(2)
    store.set(null)
    expect(store.getSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    store.set({ direction: 'previous', progress: 1, ready: true })
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
