import fs from 'node:fs/promises'
import { runCodex } from '../src/server/codex.js'
import { PulseService, storedPulseCollections } from '../src/server/pulse.js'
import { TopicService } from '../src/server/topics.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingService } from '../src/server/briefing.js'
import { PaperDatabase } from '../src/server/db.js'
import { switchingEntrySource } from '../src/server/repository.js'
import type { EntrySource, EntryOptions } from '../src/server/backend.js'
import type { Config } from '../src/server/config.js'
import type { Entry, NavigationPayload } from '../src/server/types.js'

vi.mock('../src/server/codex.js', () => ({ runCodex: vi.fn() }))

const config = { ai: { enabled: true, provider: 'codex', briefingsEnabled: true }, codex: { enabled: true, shortlistModel: 'fixture-shortlist', editorModel: 'fixture-editor', configDir: '/synthetic-profile' }, briefing: {}, publicUrl: 'http://fixture.test', timeZone: 'UTC' } as Config
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

  it.each([false, true])('includes 15-hour-old remote unread articles in a first morning briefing with story choices enabled or disabled (%s)', async enabled => {
    const now = new Date()
    const published = new Date(now.getTime() - 15 * 3_600_000)
    const articles: Entry[] = []
    const pulse = new PulseService(db, vi.fn(), false)
    for (const group of ['ordinary', 'muted', 'followed']) {
      const members = [1, 2, 3].map(n => ({
        id: group + n, title: group + ' footbridge report', feedId: 'feed/' + n, feedTitle: 'Synthetic publisher ' + n,
        feedUrl: `https://p${n}.test/rss`, url: `https://p${n}.test/${group}`, author: '',
        contentHtml: '<p>The bridge opens tomorrow.</p>', excerpt: 'The bridge opens tomorrow.', timestamp: published.getTime(),
        publishedAt: published.toISOString(), read: false, starred: false, readingMinutes: 1, thumbnailUrl: '', kind: 'article' as const,
      }))
      db.upsertEntries(members)
      const entryIds = members.map(entry => entry.id)
      db.savePulseBatch([{ id: group, headline: group, scope: 'Construction', entryIds }], entryIds, now.toISOString())
      articles.push(...members)
    }
    pulse.setChoice('muted', 'mute')
    pulse.setChoice('followed', 'follow')
    if (enabled) pulse.setBriefingChoices(true)
    db.setSyncValue('coverage_generated_at', now.toISOString())
    const coverage = new TopicService(db, source, () => storedPulseCollections(db).collections)
    const remoteEntries = (options?: EntryOptions) => articles.filter(item => !options?.after || item.timestamp > options.after.getTime())
    vi.mocked(source.entries).mockImplementation(async (_stream, options) => remoteEntries(options))
    source.entriesPage = async (_stream, options) => ({ items: remoteEntries(options), continuation: '' })
    service = new BriefingService(config, db, switchingEntrySource(() => false, source, source), undefined, coverage)
    vi.spyOn(fs, 'readFile').mockResolvedValue('Synthetic editorial profile.')
    vi.mocked(runCodex).mockResolvedValueOnce({ writerIds: [], newsClusterIds: ['ordinary', 'muted', 'followed'], newsGroups: [], socialIds: [] })
      .mockResolvedValueOnce({ news: [], social: [], worthNoticing: ['followed1', 'muted1'].map(entryId => ({ entryId, reason: 'Bridge update', summary: 'The bridge opens tomorrow.' })) })
    const result = await service.generate('morning', true)
    const input = vi.mocked(runCodex).mock.calls[0][3] as { newsClusters: { id: string; followed?: boolean }[] }
    expect(input.newsClusters.map(item => item.id)).toContain('ordinary')
    expect(input.newsClusters.some(item => item.id === 'muted')).toBe(!enabled)
    if (enabled) expect(input.newsClusters[0]).toMatchObject({ id: 'followed', followed: true })
    expect(result.selection.worthNoticing.map(item => item.entryId)).toEqual(enabled ? ['followed1'] : ['followed1', 'muted1'])
  })

  it('applies remote folder exclusions to scheduled briefs and keeps manual generation available', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('Synthetic editorial profile.')
    const sourceFeed = { id: 'folder-feed' } as NavigationPayload['uncategorized'][number]
    vi.mocked(source.navigation).mockResolvedValue({ ...navigation, folders: [{ id: 'private', title: 'Folder', feeds: [sourceFeed], unread: 0 }] })
    const article = (id: string, feedId: string) => ({ id, feedId, kind: 'article', url: 'https://fixture.test/' + id,
      title: id, contentHtml: '<p>' + id + '</p>', timestamp: Date.now(), feedUrl: '', thumbnailUrl: '' }) as Entry
    const items = [article('Synthetic private story', sourceFeed.id), article('Synthetic public story', 'other')]
    vi.mocked(source.entries).mockResolvedValue(items)
    source.entriesPage = async () => ({ items, continuation: '' })
    db.aiActivity.savePolicy({ ...db.aiActivity.policy(), folders: ['private'] })
    vi.mocked(runCodex).mockImplementation(async (_config, model) => model === 'fixture-shortlist'
      ? { writerIds: [], newsClusterIds: [], newsGroups: [], socialIds: [] } : { intro: '', news: [], worthNoticing: [], social: [] })
    await service.generateScheduled('morning', new AbortController().signal, () => {})
    const inputs = () => JSON.stringify(vi.mocked(runCodex).mock.calls.map(call => call[3]))
    expect(inputs()).not.toContain('Synthetic private story')
    expect(inputs()).toContain('Synthetic public story')
    expect(db.aiActivity.view().items.every(row => row.trigger === 'scheduled')).toBe(true)
    vi.mocked(runCodex).mockClear()
    db.aiActivity.savePolicy({ ...db.aiActivity.policy(), daily: 1 })
    await expect(service.generateScheduled('evening', new AbortController().signal, () => {})).rejects.toThrow('Daily background AI limit')
    expect(runCodex).not.toHaveBeenCalled()
    await service.generate('evening', true)
    expect(inputs()).toContain('Synthetic private story')
    vi.mocked(runCodex).mockClear()
    await expect(service.generate('evening', false, undefined, 'scheduled')).rejects.toThrow('Daily background AI limit')
    expect(runCodex).not.toHaveBeenCalled()
    expect(db.aiActivity.view('briefing', 'limited').items).toMatchObject([{ trigger: 'scheduled' }, { trigger: 'scheduled' }])
  })

  it('saves lead prose and short brief lines when the shortlist fails', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('Synthetic editorial profile.')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const articles = [
      ['Library opens a new reading room', 'The library opened 20 new study desks.'],
      ['Library opens its new reading room', 'Visitors can book a desk for two hours.'],
      ['City extends the riverside bicycle path', 'The path now reaches the ferry dock.'],
      ['City extends its riverside bicycle path', 'The extension adds two kilometres.'],
    ].map(([title, excerpt], index) => ({
      id: String(index), title, excerpt, kind: 'article', url: `https://source${index}.example/story`, contentHtml: `<p>${excerpt}</p>`, timestamp: Date.now(),
      feedTitle: `Synthetic publisher ${index + 1}`, thumbnailUrl: '',
    }) as Entry)
    vi.mocked(source.entries).mockResolvedValue(articles)
    vi.mocked(runCodex).mockRejectedValueOnce(new Error('Synthetic shortlist failure'))
      .mockRejectedValueOnce(new Error('Synthetic shortlist failure'))
      .mockResolvedValueOnce({ decisions: ['0', '1'].map(id => ({ id, relevant: true })) })
      .mockResolvedValueOnce({ supported: true })
      .mockResolvedValueOnce({ decisions: ['2', '3'].map(id => ({ id, relevant: true })) })
      .mockResolvedValueOnce({ supported: true })
    const { selection } = await service.generate('morning', true)
    expect(selection.news).toMatchObject([
      { role: 'lead', summary: 'The library opened 20 new study desks.' },
      { role: 'brief', summary: '', bullets: ['The path now reaches the ferry dock.', 'The extension adds two kilometres.'] },
    ])
  })

})
