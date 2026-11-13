import fs from 'node:fs/promises'
import { runCodex } from '../src/server/codex.js'
import { TopicService } from '../src/server/topics.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingService } from '../src/server/briefing.js'
import { PaperDatabase } from '../src/server/db.js'
import type { EntrySource } from '../src/server/backend.js'
import type { Config } from '../src/server/config.js'
import type { NavigationPayload } from '../src/server/types.js'

vi.mock('../src/server/codex.js', () => ({ runCodex: vi.fn() }))

const config = { ai: { briefingsEnabled: true }, codex: { enabled: true, configDir: '/synthetic-profile' }, briefing: {}, publicUrl: 'http://fixture.test', timeZone: 'UTC' } as Config
const navigation: NavigationPayload = { folders: [], uncategorized: [], unread: 0, starred: 0 }
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function observe<T>(promise: Promise<T>) {
  const settled = vi.fn()
  void promise.then(value => settled({ value }), error => settled({ error }))
  return settled
}

describe('briefing cancellation before model work', () => {
  let db: PaperDatabase
  let source: EntrySource
  let service: BriefingService
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(runCodex).mockReset()
    db = new PaperDatabase(':memory:')
    source = {
      navigation: vi.fn(async () => navigation),
      entries: vi.fn(async () => { throw new Error('Synthetic candidate stop') }),
      entriesPage: async () => ({ items: [], continuation: '' }), entry: async () => null, entryIds: async () => [],
    }
    service = new BriefingService(config, db, source)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close() })

  it('ends every caller at the deadline even when navigation never resolves', async () => {
    vi.mocked(source.navigation).mockReturnValue(new Promise(() => {}))
    const first = observe(service.generate('morning', true))
    await vi.advanceTimersByTimeAsync(599_000)
    const joined = observe(service.generate('morning', true))
    expect(first).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(first).toHaveBeenCalledWith({ error: expect.objectContaining({ category: 'timeout' }) })
    expect(joined).toHaveBeenCalledWith({ error: expect.objectContaining({ category: 'timeout' }) })
  })

  it('lets a joined caller leave while keeping the shared job for the remaining caller', async () => {
    const backend = pending<NavigationPayload>()
    vi.mocked(source.navigation).mockReturnValue(backend.promise)
    const first = observe(service.generate('morning', true))
    const controller = new AbortController()
    const joined = observe(service.generate('morning', true, controller.signal))
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(joined).toHaveBeenCalledWith({ error: expect.objectContaining({ category: 'cancelled' }) })
    expect(first).not.toHaveBeenCalled()
    expect(source.navigation).toHaveBeenCalledTimes(1)
    backend.resolve(navigation)
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledWith({ error: expect.objectContaining({ message: 'Synthetic candidate stop' }) })
  })

  it.each(['deadline', 'last caller'] as const)('starts fresh after %s cancellation and ignores the old navigation result', async reason => {
    const old = pending<NavigationPayload>(), fresh = pending<NavigationPayload>()
    vi.mocked(source.navigation).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const controller = new AbortController()
    const first = observe(service.generate('morning', true, controller.signal))
    if (reason === 'deadline') await vi.advanceTimersByTimeAsync(600_000)
    else { controller.abort(); await vi.advanceTimersByTimeAsync(0) }
    const next = observe(service.generate('morning', true))
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledWith({ error: expect.objectContaining({ category: reason === 'deadline' ? 'timeout' : 'cancelled' }) })
    expect(source.navigation).toHaveBeenCalledTimes(2)
    old.resolve(navigation)
    await vi.advanceTimersByTimeAsync(0)
    expect(source.entries).not.toHaveBeenCalled()
    const joined = observe(service.generate('morning', true))
    expect(source.navigation).toHaveBeenCalledTimes(2)
    fresh.resolve(navigation)
    await vi.advanceTimersByTimeAsync(0)
    expect(next).toHaveBeenCalledTimes(1)
    expect(joined).toHaveBeenCalledTimes(1)
  })

  it('stops waiting for candidates and never writes after their late result', async () => {
    const backend = pending<never[]>()
    vi.mocked(source.entries).mockReturnValue(backend.promise)
    const saved = vi.spyOn(db, 'createBriefing')
    const considered = vi.spyOn(db, 'recordBriefingConsidered')
    const controller = new AbortController()
    const result = observe(service.generate('morning', true, controller.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(source.entries).toHaveBeenCalledTimes(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toHaveBeenCalledWith({ error: expect.objectContaining({ category: 'cancelled' }) })
    backend.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).not.toHaveBeenCalled()
    expect(considered).not.toHaveBeenCalled()
  })
  it.each(['coverage', 'saving checked groups'] as const)('cancels pending %s without saving a late result', async stage => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('Synthetic editorial profile.')
    vi.mocked(runCodex).mockResolvedValueOnce({ writerIds: [], newsClusterIds: [], newsGroups: [], socialIds: [] })
      .mockResolvedValueOnce({ intro: '', news: [], worthNoticing: [], social: [] })
    vi.mocked(source.entries).mockResolvedValue([])
    const coverage = new TopicService(db, source)
    const backend = pending<[]>()
    vi.spyOn(coverage, 'clustersForEntries').mockImplementation(() => stage === 'coverage' ? backend.promise : Promise.resolve([]))
    vi.spyOn(coverage, 'rememberSemanticClusters').mockImplementation(async () => { await backend.promise })
    service = new BriefingService(config, db, source, undefined, coverage)
    const saved = vi.spyOn(db, 'createBriefing')
    const considered = vi.spyOn(db, 'recordBriefingConsidered')
    const result = observe(service.generate('morning', true))
    await vi.advanceTimersByTimeAsync(0)
    expect(stage === 'coverage' ? coverage.clustersForEntries : coverage.rememberSemanticClusters).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(result).toHaveBeenCalledWith({ error: expect.objectContaining({ category: 'timeout' }) })
    backend.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).not.toHaveBeenCalled()
    expect(considered).not.toHaveBeenCalled()
  })

  it('passes cancellation through standalone candidate reads', async () => {
    const backend = pending<[]>()
    source.briefingEntries = vi.fn(() => backend.promise)
    const controller = new AbortController()
    const result = observe(service.generate('morning', true, controller.signal))
    await vi.advanceTimersByTimeAsync(0)
    const signal = vi.mocked(source.navigation).mock.calls[0][0]!
    expect(source.briefingEntries).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal }))
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(true)
  })

})
