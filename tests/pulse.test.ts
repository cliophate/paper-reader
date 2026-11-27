import { navigationWithFeeds } from './fixtures/navigation.js'
import fs from 'node:fs'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { DATABASE_VERSION } from '../src/server/auth-schema'
import { STORY_CHOICES_VERSION } from '../src/server/pulse-schema.js'
import { PulseService as RealPulseService, type PulseModel, reviewPulseGroups, duplicatePulseArticle, pulseExtract, validatePulseGroups, validatePulseBatch, shortPulseReferences, comparePulseCollections } from '../src/server/pulse'
import { PULSE_CATCH_UP_PROMPT, validatePulseCatchUp } from '../src/server/pulse-catch-up'
import { TopicService } from '../src/server/topics'
import { PaperRepository } from '../src/server/repository'
import type { Entry } from '../src/server/types'

const acceptReview: PulseModel = async (_prompt, input) => ({ decisions: (input as { articles: Array<{ id: string }> }).articles.map(entry => ({ entryId: entry.id, relevant: true, duplicateOf: '', excerpt: '' })) })
class PulseService extends RealPulseService {
  constructor(db: PaperDatabase, model: PulseModel, enabled = true, now: () => number = Date.now, catchUpModel: PulseModel = async () => ({ collections: [] })) {
    super(db, model, enabled, now, acceptReview, catchUpModel)
  }
}

const DAY = 86_400_000
let now: number
let directory: string
let db: PaperDatabase
beforeEach(() => { now = Date.now(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-pulse-test-')); db = new PaperDatabase(path.join(directory, 'paper.sqlite')) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
function article(id: string, title = `Orion 9 feature ${id} explained`, overrides: Partial<Entry> = {}): Entry {
  const publisher = /[02468]$/.test(id) ? 'two' : 'one'
  return { id, title, feedId: `feed/${publisher}`, feedTitle: publisher, feedUrl: `https://${publisher}.test/feed`, author: '', url: `https://${publisher}.test/${id}`,
    contentHtml: `<p>${title}. The release introduces this change.</p>`, excerpt: title, publishedAt: new Date(now).toISOString(), timestamp: now,
    read: false, starred: false, readingMinutes: 2, thumbnailUrl: '', kind: 'article', ...overrides }
}
function proposal(entries: Entry[], collectionId = '', title = 'Orion 9') {
  return { groups: [{ collectionId, title, scope: 'Features and developments of the Orion 9 release.', members: entries.map(entry => ({ entryId: entry.id, evidence: entry.title })) }] }
}
function save(entries: Entry[], id = 'collection-one') {
  db.upsertEntries(entries)
  db.savePulseBatch([{ id, headline: 'Orion 9', scope: 'The Orion 9 release and its features.', entryIds: entries.map(entry => entry.id) }], entries.map(entry => entry.id), new Date(now).toISOString())
}

type CatchUpInput = { collections: Array<{ collectionId: string; articles: Array<{ id: string; title: string; isNew: boolean }> }> }
function catchUpResponse(input: CatchUpInput) {
  return { collections: input.collections.map(collection => ({
    collectionId: collection.collectionId,
    latest: collection.articles.filter(entry => entry.isNew).slice(0, 2).map(entry => ({ text: entry.title, entryIds: [entry.id] })),
    background: [{ text: 'The release follows a public trial.', entryIds: [collection.articles.at(-1)!.id] }],
  })) }
}

describe('cited Pulse catch-up', () => {
  it('omits excluded articles and mixed collections from grouping and catch-up input', async () => {
    save(['1', '2', '3'].map(id => article(id)))
    db.upsertEntries([article('4'), article('5')])
    db.aiActivity.savePolicy({ ...db.aiActivity.policy(), feeds: ['feed/two'] })
    const group = vi.fn(async () => ({ groups: [] }))
    const summary = vi.fn(async () => ({ collections: [] }))
    await new PulseService(db, group, true, () => now, summary).refresh()
    expect(group).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      articles: [expect.objectContaining({ title: article('5').title })], collections: [],
    }), expect.anything())
    expect(summary).not.toHaveBeenCalled()
  })

  it.each(['unrelated', 'muted'])('rebuilds provider descriptions after an excluded member is %s', async reason => {
    const entries = [article('1'), article('2'), article('3'), article('4', 'Private description', { feedId: 'excluded' })]
    db.upsertEntries(entries)
    db.savePulseBatch([{ id: 'story', entryIds: entries.map(entry => entry.id), headline: 'Private description',
      scope: 'Private scope copied from a former source.' }], entries.map(entry => entry.id), new Date(now).toISOString())
    if (reason === 'unrelated') db.createCoverageFeedback({ action: 'not_same', clusterId: 'story', entryId: '4' })
    else {
      await db.createMuteFilter('Private description', 'title')
      await db.backfillMuteFilters()
    }
    db.upsertEntries([article('5')])
    db.aiActivity.savePolicy({ ...db.aiActivity.policy(), feeds: ['excluded'] })
    const group = vi.fn(async (_prompt: string, _input: unknown) => ({ groups: [] }))
    const summary = vi.fn(async (_prompt: string, _input: unknown) => ({ collections: [] }))
    await new PulseService(db, group, true, () => now, summary).refresh()
    for (const calls of [group.mock.calls, summary.mock.calls]) {
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0][1])).not.toContain('Private')
    }
  })

  it('accepts a follow-up when an eligible title exceeds the limit and the model rebuilds the scope', async () => {
    const prefix = 'Orion release '.repeat(8).trimEnd()
    save(['1', '2', '3'].map(id => article(id, prefix + ' international coverage ' + id)))
    db.upsertEntries([article('5')])
    db.aiActivity.savePolicy({ ...db.aiActivity.policy(), feeds: ['excluded'] })
    const service = new PulseService(db, async (prompt, raw) => {
      const { collections: [collection], articles } = raw as { collections: { collectionId: string; title: string; scope: string }[]; articles: Entry[] }
      expect(collection.title).toBe(prefix)
      expect(collection.scope).toBe('')
      const group = proposal(articles.filter(item => item.title === article('5').title), collection.collectionId)
      if (!prompt.includes('If its scope is empty, write a new one-sentence scope')) group.groups[0].scope = collection.scope
      return group
    })
    await service.refresh()
    expect(service.list().status.failed).toBe(false)
    expect(service.list().collections[0].sources.map(source => source.id)).toContain('5')
  })

  it('refreshes a saved catch-up when its background exclusion set changes', async () => {
    save(['1', '2', '3'].map(id => article(id)))
    const summary = vi.fn(async (_prompt: string, input: unknown) => catchUpResponse(input as CatchUpInput))
    const service = new PulseService(db, vi.fn(), true, () => now, summary)
    await service.refresh()
    db.aiActivity.savePolicy({ ...db.aiActivity.policy(), feeds: ['another-feed'] })
    await service.refresh()
    await service.refresh()
    expect(summary).toHaveBeenCalledTimes(2)
  })

  it('skips grouping when one remaining request cannot cover membership review', async () => {
    db.upsertEntries([article('1')])
    db.aiActivity.savePolicy({ ...db.aiActivity.policy(), daily: 1 })
    const group = vi.fn(async () => ({ groups: [] }))
    await new PulseService(db, group).refresh()
    expect(group).not.toHaveBeenCalled()
    expect(db.aiActivity.view('grouping').items).toMatchObject([{ outcome: 'limited' }])
    expect(db.aiActivity.view().used).toEqual({})
  })

  it('drops the whole line when any citation is foreign, missing or invalid', () => {
    const articles = new Map([['a1', { id: 'new', isNew: true }], ['a2', { id: 'older', isNew: false }]])
    expect(validatePulseCatchUp({
      latest: [
        { text: 'Foreign source.', entryIds: ['a1', 'a3'] },
        { text: 'Missing citations.' },
        { text: 'No citations.', entryIds: [] },
        { text: 'Invalid ID.', entryIds: ['a1', 2] },
        { text: 'Old news.', entryIds: ['a2'] },
        { text: 'New routes opened.', entryIds: ['a1', 'a1'] },
      ],
      background: [
        { text: 'Unsupported context.', entryIds: ['a3'] },
        { text: 'The pilot began in May.', entryIds: ['a2'] },
      ],
    }, articles)).toEqual({
      latest: [{ text: 'New routes opened.', entryIds: ['new'] }],
      background: [{ text: 'The pilot began in May.', entryIds: ['older'] }],
    })
    expect(validatePulseCatchUp({ latest: [], background: [] }, articles)).toBeUndefined()
    expect(validatePulseCatchUp(null, articles)).toBeUndefined()
  })

  it('refreshes after additions, removals and merges, while visits and read state only change what is shown', async () => {
    save(['1', '2', '3'].map(id => article(id)))
    const model = vi.fn(async (_prompt: string, input: unknown) => catchUpResponse(input as CatchUpInput))
    const service = new PulseService(db, vi.fn(), true, () => now, model)
    const before = service.list().revision
    await service.refresh()
    const initial = service.list().collections[0]
    expect(initial.catchUp?.latest).toHaveLength(2)
    expect(initial.catchUp?.latest[0].entryIds).toEqual(['3'])
    expect(service.list().revision).not.toBe(before)
    expect(model.mock.calls[0][0]).toBe(PULSE_CATCH_UP_PROMPT)
    expect((model.mock.calls[0][1] as CatchUpInput).collections[0].articles[0]).toMatchObject({ id: 'a1', isNew: true })

    service.visit(initial.id, initial.revision)
    db.upsertEntries([article('3', undefined, { read: true })])
    await service.refresh()
    expect(model).toHaveBeenCalledOnce()
    expect(service.list().collections[0].catchUp).toEqual({ latest: [], background: initial.catchUp?.background })

    save([article('4')])
    await service.refresh()
    const updated = service.list().collections[0]
    expect(updated.catchUp?.latest.map(line => line.entryIds)).toEqual([['4']])
    expect((model.mock.calls[1][1] as CatchUpInput).collections[0].articles.map(entry => entry.isNew)).toEqual([true, false, false, false])
    const corrected = service.feedback({ action: 'not_same', clusterId: initial.id, entryId: '2' })
    await service.refresh()
    expect(service.list().collections[0].revision).toBe(updated.revision)
    expect(model).toHaveBeenCalledTimes(3)
    expect(service.removeFeedback(corrected.id)).toBe(true)
    await service.refresh()
    expect(model).toHaveBeenCalledTimes(4)

    save(['5', '6', '7'].map(id => article(id)), 'collection-two')
    await service.refresh()
    const target = service.list().collections.find(item => item.id === 'collection-two')!
    service.feedback({ action: 'merge', clusterId: initial.id, targetClusterId: target.id })
    await service.refresh()
    expect(model).toHaveBeenCalledTimes(6)
    expect(service.list().collections[0]).toMatchObject({ id: target.id, revision: target.revision, articleCount: 7 })
    expect((model.mock.calls[5][1] as CatchUpInput).collections[0].articles).toHaveLength(7)
  })

  it('summarizes only active collections with at least three articles', async () => {
    save(['1', '2', 'small-3'].map(id => article(id)), 'collection-small')
    db.createCoverageFeedback({ action: 'not_same', clusterId: 'collection-small', entryId: 'small-3' })
    const current = now
    now -= 4 * DAY
    save(['3', '4', '5'].map(id => article(id)), 'collection-quiet')
    now -= 30 * DAY
    save(['archived-1', 'archived-2', 'archived-3'].map(id => article(id)), 'collection-archived')
    now = current
    const model = vi.fn(async (_prompt: string, input: unknown) => catchUpResponse(input as CatchUpInput))
    const service = new PulseService(db, vi.fn(), true, () => now, model)
    await service.refresh()
    expect(model).not.toHaveBeenCalled()
    save([article('6')], 'collection-quiet')
    await service.refresh()
    expect(model).not.toHaveBeenCalled()
    save([article('7')], 'collection-quiet')
    await service.refresh()
    expect(model).toHaveBeenCalledOnce()
    expect((model.mock.calls[0][1] as CatchUpInput).collections).toHaveLength(1)
    expect(service.list().collections.find(item => item.id === 'collection-quiet')?.catchUp).toBeDefined()
  })

  it('keeps the last good summary across an empty reply, provider failure and restart', async () => {
    save(['1', '2', '3'].map(id => article(id)))
    const model = vi.fn(async (_prompt: string, input: unknown) => catchUpResponse(input as CatchUpInput))
    const service = new PulseService(db, vi.fn(), true, () => now, model)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await service.refresh()
      const saved = db.pulseCatchUps().get('collection-one')
      expect(saved?.summary.latest).toHaveLength(2)
      save([article('4')])
      model.mockResolvedValueOnce({ collections: [] })
      await service.refresh()
      expect(db.pulseCatchUps().get('collection-one')).toEqual(saved)
      expect(service.list().collections[0].catchUp).toEqual(saved?.summary)
      await service.refresh()
      expect(model).toHaveBeenCalledTimes(2)
      now += 16 * 60_000
      model.mockRejectedValueOnce(new Error('Fixture provider unavailable'))
      await service.refresh()
      expect(db.pulseCatchUps().get('collection-one')).toEqual(saved)
      service.feedback({ action: 'not_same', clusterId: 'collection-one', entryId: '3' })
      expect(service.list().collections[0].catchUp?.latest.map(line => line.entryIds)).toEqual([['2']])
      db.close()
      db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
      const reopened = new PulseService(db, vi.fn(), false, () => now, model)
      await reopened.refresh()
      expect(model).toHaveBeenCalledTimes(3)
      expect(reopened.list().collections[0].catchUp).toBeUndefined()
      expect(db.pulseCatchUps().get('collection-one')).toEqual(saved)
    } finally { warn.mockRestore() }
  })

  it('bounds each model request and keeps short article references unique across collections', async () => {
    for (const prefix of ['a', 'b', 'c', 'd', 'e']) save([1, 2, 3].map(id => article(prefix + id)), 'collection-' + prefix)
    const model = vi.fn(async (_prompt: string, input: unknown) => {
      const batch = input as CatchUpInput
      const reply = catchUpResponse(batch)
      if (batch.collections.length > 1) reply.collections[0].latest[0].entryIds.push(batch.collections[1].articles[0].id)
      return reply
    })
    const service = new PulseService(db, vi.fn(), true, () => now, model)
    await service.refresh()
    expect(model).toHaveBeenCalledOnce()
    expect((model.mock.calls[0][1] as CatchUpInput).collections).toHaveLength(4)
    expect(service.list().collections[0].catchUp?.latest).toHaveLength(1)
    await service.refresh()
    expect((model.mock.calls[1][1] as CatchUpInput).collections).toHaveLength(1)
    expect(db.pulseCatchUps().size).toBe(5)
  })

  it('discards a response when a correction lands before it can be saved', async () => {
    save(['1', '2', '3'].map(id => article(id)))
    let finish!: () => void
    let started!: () => void
    const requested = new Promise<void>(resolve => { started = resolve })
    const model = vi.fn((_prompt: string, input: unknown) => new Promise(resolve => {
      finish = () => resolve(catchUpResponse(input as CatchUpInput))
      started()
    }))
    const service = new PulseService(db, vi.fn(), true, () => now, model)
    const running = service.refresh()
    await requested
    expect(model).toHaveBeenCalledOnce()
    service.feedback({ action: 'not_same', clusterId: 'collection-one', entryId: '2' })
    finish()
    await running
    expect(db.pulseCatchUps().size).toBe(0)
  })

  it('migrates v18 without changing the collection membership or visits', () => {
    save(['1', '2', '3'].map(id => article(id)))
    db.visitPulseCollection('collection-one', 2)
    db.greaderDatabase.exec('DROP TABLE pulse_catch_ups; PRAGMA user_version = 18')
    db.close()
    const file = path.join(directory, 'paper.sqlite')
    db = new PaperDatabase(file)
    expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
    expect(fs.statSync(file + '.before-pulse-catch-ups-v19').mode & 0o777).toBe(0o600)
    expect(db.pulseCatchUps().size).toBe(0)
    const service = new PulseService(db, vi.fn(), true, () => now)
    expect(service.list().collections[0]).toMatchObject({ articleCount: 3, newCount: 1, seenThrough: 2 })
  })
})

describe('continuing Pulse collections', () => {
  it('stops before review and further batches when disabled during grouping', async () => {
    const entries = [article('one')]
    db.upsertEntries(entries)
    const review = vi.fn(acceptReview)
    const model: PulseModel = vi.fn(async (_prompt, input) => {
      service.setEnabled(false)
      return proposal((input as { articles: Entry[] }).articles)
    })
    const service = new RealPulseService(db, model, true, () => now, review)
    await service.refresh()
    await service.refresh()
    expect(model).toHaveBeenCalledOnce()
    expect(review).not.toHaveBeenCalled()
    expect(service.list()).toMatchObject({ collections: [], status: { enabled: false, failed: false } })
  })
  it('discovers collections across publishers, retains identity, and never changes article read state', async () => {
    const first = [article('1'), article('2', undefined, { read: true }), article('3')]
    db.upsertEntries(first)
    const model = vi.fn().mockResolvedValueOnce(proposal(first))
    const service = new PulseService(db, model, true, () => now)
    await service.refresh()
    const original = service.list().collections[0]
    expect(original).toMatchObject({ headline: 'Orion 9', articleCount: 3, publicationCount: 2, unreadCount: 2, newCount: 3 })
    service.visit(original.id, original.revision)
    const late = article('4', 'Orion 9 offline maps explained', { timestamp: now - DAY, publishedAt: new Date(now - DAY).toISOString() })
    now += 1000
    db.upsertEntries([late])
    model.mockResolvedValueOnce(proposal([late], original.id))
    await service.refresh()
    const updated = service.list().collections[0]
    expect(updated).toMatchObject({ id: original.id, headline: original.headline, articleCount: 4, unreadCount: 3, newCount: 1 })
    expect(updated.sources[0].id).toBe('4')
    service.visit(original.id, original.revision)
    expect(service.list().collections[0].newCount).toBe(1)
    expect(db.localEntry('2')?.read).toBe(true)
    expect(db.localEntry('1')?.read).toBe(false)
    await service.refresh()
    expect(model).toHaveBeenCalledTimes(2)
    db.close()
    db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    expect(new PulseService(db, model).list().collections[0]).toMatchObject({ id: original.id, newCount: 1, unreadCount: 3 })
  })

  it('quiet collections retain all memberships and reactivate when two publications return', async () => {
    save([article('1'), article('2'), article('3')])
    now += 4 * DAY
    const late = [article('4'), article('5')]
    db.upsertEntries(late)
    const model = vi.fn().mockResolvedValue(proposal(late, 'collection-one'))
    const service = new PulseService(db, model, true, () => now)
    expect(service.list().collections[0]).toMatchObject({ quiet: true, articleCount: 3 })
    await service.refresh()
    expect(model.mock.calls[0][1].collections[0].quiet).toBe(true)
    expect(service.list().collections[0]).toMatchObject({ quiet: false, active: true, articleCount: 5 })
  })

  it('ages from active to quiet to archived at publication boundaries and changes the payload revision', () => {
    save(['1', '2', '3'].map(id => article(id)))
    const service = new PulseService(db, vi.fn(), false, () => now)
    const published = now
    now += 3 * DAY
    const active = service.list()
    expect(active.collections[0]).toMatchObject({ active: true, quiet: false, archived: false, recentArticleCount: 3, recentPublicationCount: 2 })
    now++
    const quiet = service.list()
    expect(quiet.collections[0]).toMatchObject({ active: false, quiet: true, archived: false, recentArticleCount: 0 })
    expect(quiet.revision).not.toBe(active.revision)
    now = published + 7 * DAY
    expect(service.list().collections[0].quiet).toBe(true)
    now++
    const archived = service.list()
    expect(archived.collections[0]).toMatchObject({ active: false, quiet: false, archived: true })
    expect(archived.revision).not.toBe(quiet.revision)
  })

  it('counts articles up to one minute ahead of the clock', () => {
    save([article('1'), article('2', undefined, { timestamp: now + 60_000 }), article('3', undefined, { timestamp: now + 60_001 })])
    expect(new PulseService(db, vi.fn(), false, () => now).list().collections[0]).toMatchObject({
      recentArticleCount: 2, recentPublicationCount: 2, active: true, latestPublishedAt: new Date(now + 60_001).toISOString(),
    })
  })

  it('keeps a backfilled collection archived and offers it to the model for follow-up reporting', async () => {
    now -= 31 * DAY
    const old = now
    save(['1', '2', '3'].map(id => article(id)))
    now += 31 * DAY
    const late = article('4', undefined, { timestamp: old, publishedAt: new Date(old).toISOString() })
    db.upsertEntries([late])
    const model = vi.fn().mockResolvedValue(proposal([late], 'collection-one'))
    const service = new PulseService(db, model, true, () => now)
    await service.refresh()
    expect(model.mock.calls[0][1].collections[0].archived).toBe(true)
    expect(service.list().collections[0]).toMatchObject({ articleCount: 4, archived: true, active: false,
      recentArticleCount: 0, latestPublishedAt: new Date(old).toISOString(), updatedAt: new Date(now).toISOString() })
  })

  it('counts distinct publication domains in a recent burst', () => {
    save(['1', '2', '3'].map(id => article(id)))
    now += 4 * DAY
    save([article('5'), article('7'), article('9')])
    const service = new PulseService(db, vi.fn(), false, () => now)
    expect(service.list().collections[0]).toMatchObject({ recentArticleCount: 3, recentPublicationCount: 1, quiet: true, active: false })
  })

  it('ranks by activity, recent publications, recent articles, unread, newest publication, then ID', () => {
    save(['1', '2', '3'].map(id => article(id)))
    const [base] = new PulseService(db, vi.fn(), false, () => now).list().collections
    const tied = { ...base, latestPublishedAt: new Date(now - DAY).toISOString() }
    const ranked = [
      { ...base, id: 'publications', recentPublicationCount: 3 },
      { ...base, id: 'articles', recentArticleCount: 4 },
      { ...base, id: 'unread', unreadCount: 4 },
      { ...base, id: 'newer' },
      { ...tied, id: 'a' }, { ...tied, id: 'b' },
      { ...base, id: 'inactive', active: false, recentArticleCount: 20 },
    ]
    expect([...ranked].reverse().sort(comparePulseCollections).map(c => c.id)).toEqual(ranked.map(c => c.id))
  })

  it('reconsiders previously ungrouped articles when related new reporting arrives', async () => {
    const first = article('1')
    db.upsertEntries([first])
    const model = vi.fn().mockResolvedValueOnce({ groups: [] })
    const service = new PulseService(db, model, true, () => now)
    await service.refresh()
    const next = [article('2'), article('3')]
    db.upsertEntries(next)
    model.mockResolvedValueOnce(proposal([first, ...next]))
    await service.refresh()
    expect(model.mock.calls[1][1].articles.map((entry: Entry) => entry.title)).toContain(first.title)
    expect(service.list().collections[0].articleCount).toBe(3)
  })

  it('keeps corrections through additions, merge, undo, hiding, and restart', () => {
    save([article('1'), article('2'), article('3')])
    save([article('4'), article('5'), article('6')], 'collection-two')
    const service = new PulseService(db, vi.fn(), false, () => now)
    const removed = service.feedback({ action: 'not_same', clusterId: 'collection-one', entryId: '1' })
    const merge = service.feedback({ action: 'merge', clusterId: 'collection-one', targetClusterId: 'collection-two' })
    let merged = service.list().collections[0]
    expect(merged).toMatchObject({ id: 'collection-two', articleCount: 5 })
    service.visit(merged.id, merged.revision)
    expect(service.list().collections[0].newCount).toBe(0)
    now += 1000
    save([article('7')], 'collection-two')
    merged = service.list().collections[0]
    expect(merged).toMatchObject({ articleCount: 6, newCount: 1 })
    expect(service.removeFeedback(merge.id)).toBe(true)
    expect(service.list().collections).toHaveLength(2)
    expect(service.list().collections.find(collection => collection.id === 'collection-one')?.newCount).toBe(0)
    service.removeFeedback(removed.id)
    expect(service.list().collections.find(collection => collection.id === 'collection-one')?.articleCount).toBe(3)
    service.feedback({ action: 'not_useful', clusterId: 'collection-two' })
    save([article('8')], 'collection-two')
    expect(service.list().collections.map(collection => collection.id)).toEqual(['collection-one'])
    db.close(); db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    expect(new PulseService(db, vi.fn(), false, () => now).list().collections.map(collection => collection.id)).toEqual(['collection-one'])
  })

  it('applies chained merges in creation order even within the same millisecond', () => {
    save([article('1'), article('2'), article('3')], 'collection-a')
    save([article('4'), article('5'), article('6')], 'collection-b')
    save([article('7'), article('8'), article('9')], 'collection-c')
    const service = new PulseService(db, vi.fn(), false, () => now)
    const clock = vi.useFakeTimers().setSystemTime(now)
    try {
      service.feedback({ action: 'merge', clusterId: 'collection-a', targetClusterId: 'collection-b' })
      service.feedback({ action: 'merge', clusterId: 'collection-b', targetClusterId: 'collection-c' })
      const merged = service.list()
      expect(merged.collections).toHaveLength(1)
      expect(merged.collections[0]).toMatchObject({ id: 'collection-c', articleCount: 9 })
      expect(merged.collectionAliases).toEqual(expect.arrayContaining(['collection-a', 'collection-b'].map(id =>
        ({ id, linkNumber: db.linkNumber('collection', id), targetId: 'collection-c' }))))
      service.feedback({ action: 'not_useful', clusterId: 'collection-c' })
      expect(service.list().collectionAliases).toBeUndefined()
    } finally { clock.useRealTimers() }
  })

  it('excludes muted articles from grouping and visible collections', async () => {
    const entries = [article('1'), article('2'), article('3')]
    save(entries)
    await db.createMuteFilter('feature 1', 'title')
    await db.backfillMuteFilters()
    const service = new PulseService(db, vi.fn(), true, () => now)
    expect(service.list().collections[0].sources.map(source => source.id)).not.toContain('1')
    db.upsertEntries([article('4', 'Excluded item for Orion 9')])
    await db.createMuteFilter('Excluded item', 'title')
    await db.backfillMuteFilters()
    await service.refresh()
    expect(db.pulseCandidates(now - DAY, now + DAY, false, 100)).toEqual([])
  })

  it('retries failed batches without losing queued articles or replacing saved collections', async () => {
    save([article('1'), article('2'), article('3')])
    const next = article('4')
    db.upsertEntries([next])
    const model = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(proposal([next], 'collection-one'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new PulseService(db, model, true, () => now)
    await service.refresh()
    expect(service.list().status.failed).toBe(true)
    expect(service.list().collections[0].articleCount).toBe(3)
    await service.refresh()
    expect(model).toHaveBeenCalledTimes(1)
    now += 16 * 60_000
    await service.refresh()
    expect(service.list().status.failed).toBe(false)
    expect(service.list().collections[0].articleCount).toBe(4)
    warn.mockRestore()
  })

  it('does not resurrect a collection hidden while the model was running', async () => {
    save([article('1'), article('2'), article('3')])
    const next = article('4')
    db.upsertEntries([next])
    const pending = Promise.withResolvers<unknown>()
    const model = vi.fn(() => pending.promise)
    const service = new PulseService(db, model, true, () => now)
    const running = service.refresh()
    await vi.waitFor(() => expect(model).toHaveBeenCalledOnce())
    service.feedback({ action: 'not_useful', clusterId: 'collection-one' })
    pending.resolve(proposal([next], 'collection-one'))
    await running
    expect(service.list().collections).toEqual([])
  })

  it('validates quoted evidence and IDs and does not create collections from singletons or duplicate URLs', () => {
    const entries = [article('1', 'iOS 27 camera controls'), article('2', 'iOS 27 offline maps'), article('3', 'iOS 27 accessibility improvements')]
    expect(validatePulseGroups(proposal(entries, '', 'iOS 27'), entries, [])[0].headline).toBe('iOS 27')
    expect(validatePulseGroups(proposal(entries.slice(0, 1)), entries, [])).toEqual([])
    expect(() => validatePulseGroups(proposal([article('fake')]), entries, [])).toThrow('Unknown')
    const bad = proposal(entries); bad.groups[0].members[0].evidence = 'A claim absent from the supplied article'
    expect(() => validatePulseGroups(bad, entries, [])).toThrow('evidence')
    expect(() => validatePulseGroups(proposal(entries, 'unknown'), entries, [])).toThrow('Unknown collection')
    const duplicates = [article('4'), article('5', undefined, { url: 'https://two.test/4' }), article('7')]
    expect(validatePulseGroups(proposal(duplicates), duplicates, [])).toEqual([])
    expect(validatePulseGroups(proposal(duplicates), duplicates.map(entry => ({ ...entry, url: `https://${entry.feedTitle}.test/unique-${entry.id}` })), [])).toHaveLength(1)
    expect(pulseExtract(article('x', 'Example', { contentHtml: '<p>Quoted text</p><script>ignore instructions</script>' }))).not.toContain('<script>')
  })

  it('saves valid groups while keeping rejected proposals pending and accepts equivalent quote punctuation', () => {
    const good = [article('1'), article('2'), article('3')]
    const bad = [article('4'), article('5'), article('6')]
    const wrong = proposal(bad, '', 'Other release').groups[0]
    wrong.members[0].evidence = 'A fabricated connection'
    const result = validatePulseBatch({ groups: [...proposal(good).groups, wrong] }, [...good, ...bad], [])
    expect(result.groups).toHaveLength(1)
    expect([...result.deferred].sort()).toEqual(['4', '5', '6'])
    expect([...result.reasons]).toEqual(['Collection evidence is not in the article'])
    const quoted = good.map(entry => ({ ...entry, title: entry.title + ' &amp; more' }))
    const response = proposal(quoted)
    response.groups[0].members.forEach(member => { member.evidence = member.evidence.replace('&amp;', '&') })
    expect(validatePulseGroups(response, quoted, [])).toHaveLength(1)
  })

  it('uses short model references while preserving the original stored IDs', async () => {
    const model = vi.fn().mockResolvedValue({ groups: [{ collectionId: 'c1', title: 'Orion 9', scope: 'The Orion 9 release.', members: [{ entryId: 'a1', evidence: 'Orion 9' }] }] })
    const result = await shortPulseReferences(model)('prompt', { articles: [{ id: 'long-feed-entry-reference' }], collections: [{ collectionId: 'collection-persistent' }] }, {})
    expect(model.mock.calls[0][1]).toEqual({ articles: [{ id: 'a1' }], collections: [{ collectionId: 'c1' }] })
    expect(result).toMatchObject({ groups: [{ collectionId: 'collection-persistent', members: [{ entryId: 'long-feed-entry-reference' }] }] })
  })

  it('rejects only the unsupported member when enough evidence remains to create a group', () => {
    const entries = [article('1'), article('2'), article('3'), article('4')]
    const response = proposal(entries)
    response.groups[0].members[3].evidence = 'A fabricated connection'
    const result = validatePulseBatch(response, entries, [])
    expect(result.groups[0].entryIds).toEqual(['1', '2', '3'])
    expect([...result.deferred]).toEqual(['4'])
  })

  it('passes corrected collections to future briefings and leaves read eligibility to the briefing', async () => {
    const entries = [article('1'), article('2', undefined, { url: 'https://two.test/2' }), article('3', undefined, { url: 'https://three.test/3', read: true })]
    save(entries)
    const pulse = new PulseService(db, vi.fn(), false, () => now)
    const topics = new TopicService(db, new PaperRepository(db), () => pulse.list().collections)
    const groups = await topics.clustersForEntries(entries.slice(0, 2))
    expect(groups[0]).toMatchObject({ id: 'collection-one', kind: 'coverage', articleCount: 2 })
    expect(groups[0].sources.map(source => source.id).sort()).toEqual(['1', '2'])
    pulse.feedback({ action: 'not_same', clusterId: 'collection-one', entryId: '2' })
    expect((await topics.clustersForEntries(entries.slice(0, 2))).some(group => group.id === 'collection-one')).toBe(false)
  })
})

describe('Pulse membership quality', () => {
  it('scans new proposals from one publication or spanning more than seven days without retrying them', async () => {
    const one = ['1', '3', '5'].map(id => article(id))
    const week = [article('6', undefined, { timestamp: now - 7 * DAY }), article('7'), article('8')]
    expect(validatePulseGroups(proposal(week), week, [])).toHaveLength(1)
    week[0].timestamp--
    const entries = [...one, ...week]
    const proposals = { groups: [...proposal(one).groups, ...proposal(week, '', 'Another release').groups] }
    const checked = validatePulseBatch(proposals, entries, [])
    expect(checked.groups).toEqual([])
    expect(checked.deferred).toEqual(new Set())
    expect(checked.reasons).toEqual(new Set())
    db.upsertEntries(entries)
    const service = new PulseService(db, vi.fn().mockResolvedValue(proposals), true, () => now)
    await service.refresh()
    expect(service.list().collections).toEqual([])
    expect(service.list().status.failed).toBe(false)
    expect(db.pulseCandidates(now - 8 * DAY, now, false, 10)).toEqual([])
  })

  it('does not keep a single-publication proposal pending because of a repeated member ID', () => {
    const entries = ['1', '3', '5'].map(id => article(id))
    const response = proposal(entries)
    response.groups[0].members.push({ entryId: '1', evidence: entries[0].title })
    const checked = validatePulseBatch(response, entries, [])
    expect(checked.groups).toEqual([])
    expect(checked.deferred).toEqual(new Set())
  })

  it('treats mobile and AMP hosts as the same publication', () => {
    const entries = [article('1'), article('3', undefined, { url: 'https://m.one.test/3' }), article('5', undefined, { url: 'https://amp.one.test/5' })]
    expect(validatePulseGroups(proposal(entries), entries, [])).toEqual([])
  })

  it('ignores undated articles for activity and the seven-day span', () => {
    const old = now - 45 * DAY
    save([article('1', undefined, { timestamp: old }), article('2', undefined, { timestamp: old }), article('3', undefined, { timestamp: old })])
    const undated = [article('4', 'Orion 9 feature 4 explained', { publishedAt: '' }), article('5', 'Orion 9 feature 5 explained', { publishedAt: '' })]
    db.upsertEntries(undated)
    db.savePulseBatch([{ id: 'collection-one', headline: 'Orion 9', scope: 'The Orion 9 release and its features.', entryIds: ['4', '5'] }], ['4', '5'], new Date(now).toISOString())
    const service = new PulseService(db, vi.fn(), false, () => now)
    expect(service.list().collections[0]).toMatchObject({ articleCount: 5, active: false, archived: true })
    const fresh = [article('6', undefined, { timestamp: old, publishedAt: '' }), article('7'), article('8')]
    expect(validatePulseGroups(proposal(fresh), fresh, [])).toHaveLength(1)
  })

  it('uses the article domain first and falls back to the feed domain', () => {
    const entries = [article('1'), article('3', undefined, { url: 'https://www.one.test/3' }),
      article('5', undefined, { url: '', feedUrl: 'https://two.test/feed' })]
    expect(validatePulseGroups(proposal(entries), entries, [])).toHaveLength(1)
    entries[2].url = 'https://one.test/5'
    expect(validatePulseGroups(proposal(entries), entries, [])).toEqual([])
  })

  it('scans survivors when review removes the second publication', async () => {
    const entries = ['1', '3', '5', '2'].map(id => article(id))
    db.upsertEntries(entries)
    const review = vi.fn(async () => ({ decisions: entries.map((_, i) => ({
      entryId: `a${i + 1}`, relevant: i < 3, duplicateOf: '', excerpt: '',
    })) }))
    const service = new RealPulseService(db, vi.fn().mockResolvedValue(proposal(entries)), true, () => now, review)
    await service.refresh()
    expect(db.pulseCollections()).toEqual([])
    expect(service.list().status.failed).toBe(false)
    expect(db.pulseCandidates(now - DAY, now, false, 10)).toEqual([])
  })

  it('leaves survivors pending when a concurrent mute removes the second publication', async () => {
    const entries = ['1', '3', '5', '2'].map(id => article(id))
    db.upsertEntries(entries)
    await db.createMuteFilter('feature 2', 'title')
    await db.backfillMuteFilters()
    const ids = entries.map(entry => entry.id)
    db.savePulseBatch([{ id: 'new', headline: 'Orion 9', scope: 'The Orion 9 release.', entryIds: ids }], ids, new Date(now).toISOString())
    expect(db.pulseCollections()).toEqual([])
    expect(db.pulseCandidates(now - DAY, now, false, 10).map(entry => entry.id).sort()).toEqual(['1', '3', '5'])
  })

  it('checks the minimum again when members were muted before saving and leaves survivors pending', async () => {
    const entries = [article('1'), article('2'), article('3')]
    db.upsertEntries(entries)
    await db.createMuteFilter('feature 2', 'title')
    await db.backfillMuteFilters()
    await db.createMuteFilter('feature 3', 'title')
    await db.backfillMuteFilters()
    db.savePulseBatch([{ id: 'too-small', headline: 'Orion 9', scope: 'The Orion 9 release.', entryIds: ['1', '2', '3'] }], ['1', '2', '3'], new Date(now).toISOString())
    expect(db.pulseCollections()).toEqual([])
    expect(db.pulseCandidates(now - DAY, now + DAY, false, 10).map(entry => entry.id)).toEqual(['1'])
  })

  it('finds related older candidates instead of filling context with the newest unrelated articles', () => {
    const related = article('older', 'Orion 9 camera controls', { timestamp: now - 12 * DAY })
    const unrelated = Array.from({ length: 100 }, (_, i) => article(`noise-${i}`, `Marine archaeology expedition ${i}`, { timestamp: now - DAY }))
    db.upsertEntries([related, ...unrelated])
    db.savePulseBatch([], [related, ...unrelated].map(entry => entry.id), new Date(now).toISOString())
    expect(db.pulseRelatedCandidates([article('fresh', 'Orion 9 camera update')], now).map(entry => entry.id)).toContain('older')
  })

  it('reviews relevance and duplicate reporting, preserving only supported catch-up excerpts', async () => {
    const entries = [article('1'), article('2'), article('3'), article('4')]
    const groups = validatePulseGroups(proposal(entries), entries, [])
    const model = vi.fn().mockResolvedValue({ decisions: entries.map((entry, i) => ({ entryId: `a${i + 1}`, relevant: true, duplicateOf: i === 3 ? 'a1' : '', excerpt: entry.title })) })
    const result = await reviewPulseGroups(model, groups, entries, [])
    expect(result[0].entryIds).toEqual(['1', '2', '3'])
    expect(result[0].developments?.['1']).toBe(entries[0].title)
    model.mockResolvedValue({ decisions: entries.map((_, i) => ({ entryId: `a${i + 1}`, relevant: true, duplicateOf: '', excerpt: 'A made up factual development' })) })
    const withoutExcerpts = await reviewPulseGroups(model, groups, entries, [])
    expect(withoutExcerpts[0].entryIds).toEqual(['1', '2', '3', '4'])
    expect(Object.values(withoutExcerpts[0].developments!)).toEqual(['', '', '', ''])
  })

  it.each(['invented', 'short', 'long'])('drops a %s excerpt without losing supported excerpts or memberships', async invalid => {
    const body = 'A source passage with a detailed explanation of the camera change. '.repeat(8).trim()
    const entries = [article('1', undefined, { contentHtml: `<p>${body}</p>` }), article('2'), article('3')]
    const groups = validatePulseGroups(proposal(entries), entries, [])
    const excerpt = invalid === 'invented' ? 'An unsupported factual claim' : invalid === 'short' ? 'source' : body
    const model = vi.fn().mockResolvedValue({ decisions: entries.map((entry, i) => ({ entryId: `a${i + 1}`, relevant: true, duplicateOf: '', excerpt: i === 0 ? excerpt : entry.title })) })
    const result = await reviewPulseGroups(model, groups, entries, [])
    expect(result[0].entryIds).toEqual(['1', '2', '3'])
    expect(result[0].developments).toEqual({ '1': '', '2': entries[1].title, '3': entries[2].title })
    model.mockResolvedValue({ decisions: entries.map((_, i) => ({ entryId: i === 0 ? 'unknown' : `a${i + 1}`, relevant: true, duplicateOf: '', excerpt: '' })) })
    await expect(reviewPulseGroups(model, groups, entries, [])).rejects.toThrow('Invalid membership review')
  })

  it('recognizes syndicated text across different headlines and URLs', () => {
    const body = '<p>' + 'A detailed original report with useful specific observations. '.repeat(12) + '</p>'
    expect(duplicatePulseArticle(article('1', 'First headline', { contentHtml: body }), article('2', 'Second headline', { contentHtml: body }))).toBe(true)
    expect(duplicatePulseArticle(article('1', 'First headline'), article('2', 'A different development'))).toBe(false)
  })

  it('keeps the batch pending when the membership reviewer fails', async () => {
    const entries = [article('1'), article('2'), article('3')]
    db.upsertEntries(entries)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new RealPulseService(db, vi.fn().mockResolvedValue(proposal(entries)), true, () => now, vi.fn().mockRejectedValue(new Error('unavailable')))
    await service.refresh()
    expect(service.list().collections).toEqual([])
    expect(service.list().status.failed).toBe(true)
    expect(db.pulseCandidates(now - DAY, now + DAY, false, 10)).toHaveLength(3)
    warning.mockRestore()
  })

  it('lets one new article update an established Pulse and keeps older articles separate', async () => {
    const entries = [article('1'), article('2'), article('3')]
    save(entries)
    const pulse = new PulseService(db, vi.fn(), false, () => now)
    const topics = new TopicService(db, new PaperRepository(db), () => pulse.list().collections)
    const groups = await topics.clustersForEntries([entries[2]])
    expect(groups[0]).toMatchObject({ collectionId: 'collection-one', articleCount: 1, publicationCount: 1 })
    expect(groups[0].sources.map(source => source.id)).toEqual(['3'])
    expect(groups[0].backgroundSources?.map(source => source.id).sort()).toEqual(['1', '2'])
  })
})

describe('manual story choices', () => {
  it('restores v26 visits from the pre-v27 backup', () => {
    save(['1', '2', '3'].map(id => article(id)))
    db.visitPulseCollection('collection-one', 1)
    db.greaderDatabase.exec('DROP TABLE pulse_story_choices; DROP TABLE pulse_merge_choices; PRAGMA user_version = 26')
    db.close()
    const file = path.join(directory, 'paper.sqlite')
    db = new PaperDatabase(file)
    const backup = `${file}.before-story-choices-v${STORY_CHOICES_VERSION}`
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
    expect(new PulseService(db, vi.fn(), false).list()).toMatchObject({
      collections: [{ newCount: 2, followed: false }], storyChoices: [], useStoryChoicesInBriefings: false,
    })
    db.visitPulseCollection('collection-one', 3)
    db.close()
    fs.copyFileSync(backup, file)
    const restored = new DatabaseSync(file, { readOnly: true })
    try {
      expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(26)
      expect(restored.prepare('SELECT seen_through FROM pulse_visits WHERE collection_id = ?').get('collection-one')?.seen_through).toBe(1)
    } finally { restored.close(); db = new PaperDatabase(file) }
  })

  it.each([21, 22])('preserves choices and restores missing feed migrations from Pulse preview v%i', version => {
    save(['1', '2', '3'].map(id => article(id)))
    db.setStoryChoice('collection-one', { kind: 'follow' })
    if (version === 21) db.greaderDatabase.exec('ALTER TABLE pulse_story_choices DROP COLUMN orphaned_since; ALTER TABLE feed_fetch_state DROP COLUMN redirects_json')
    db.greaderDatabase.exec(`DROP TABLE feed_overrides; PRAGMA user_version = ${version}`)
    db.close()
    db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    expect(db.greaderDatabase.prepare("SELECT name FROM sqlite_schema WHERE name = 'feed_overrides'").get()).toBeDefined()
    expect(db.greaderDatabase.prepare("SELECT name FROM pragma_table_info('feed_fetch_state') WHERE name = 'redirects_json'").get()).toBeDefined()
    expect(new PulseService(db, vi.fn(), false).list().collections[0].followed).toBe(true)
    expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
  })

  it('keeps visits and feed state through a mute, a snooze, new arrivals and expiry with grouping paused', () => {
    db.replaceNavigation(navigationWithFeeds('feed/one', 'feed/two'))
    save(['1', '2', '3'].map(id => article(id)))
    const pulse = new PulseService(db, vi.fn(), false, () => now)
    pulse.visit('collection-one', 2)
    pulse.setChoice('collection-one', 'mute')
    const muted = pulse.list()
    expect(muted.collections).toEqual([])
    expect(muted.storyChoices).toMatchObject([{ id: 'collection-one', choice: { kind: 'mute' } }])
    save([article('4')])
    expect(pulse.list().revision).toBe(muted.revision)
    expect(db.localEntriesPage({ kind: 'all', id: 'all', title: 'All' }, { unreadOnly: true }).items).toHaveLength(4)
    expect(() => pulse.setChoice('collection-one', 'snooze', now)).toThrow('future')
    pulse.setChoice('collection-one', 'snooze', now + DAY)
    db.close(); db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    const restarted = new PulseService(db, vi.fn(), false, () => now)
    expect(restarted.list().collections).toEqual([])
    now += DAY
    expect(restarted.list().storyChoices).toEqual([])
    expect(restarted.list().collections[0]).toMatchObject({ articleCount: 4, unreadCount: 4, newCount: 2 })
    restarted.setChoice('collection-one', 'follow')
    now += 8 * DAY
    expect(restarted.list().collections[0]).toMatchObject({ followed: true, active: false })
    restarted.setChoice('collection-one', 'clear')
    expect(restarted.list().collections[0]).toMatchObject({ followed: false, archived: true })
  })

  it('matches fresh coverage to an empty muted story and omits empty choices from Settings', async () => {
    save(['1', '2', '3'].map(id => article(id)))
    const model: PulseModel = async (_prompt, input) => {
      const { collections, articles } = input as { collections: Array<{ title: string; scope: string; recentTitles: string[] }>; articles: Entry[] }
      expect(collections).toMatchObject([{ title: 'Orion 9', scope: 'The Orion 9 release and its features.', recentTitles: [] }])
      const matching = proposal(articles)
      matching.groups[0].scope = ' THE ORION 9 RELEASE and its features. '
      return matching
    }
    const pulse = new PulseService(db, model, true, () => now)
    pulse.setChoice('collection-one', 'mute')
    for (const entryId of ['1', '2', '3']) pulse.feedback({ action: 'not_same', clusterId: 'collection-one', entryId })
    expect(pulse.list().storyChoices).toEqual([])
    db.upsertEntries([article('4')])
    await pulse.refresh()
    expect(db.pulseCollectionIds()).toEqual(['collection-one'])
    expect(pulse.list()).toMatchObject({ collections: [], storyChoices: [{ id: 'collection-one', choice: { kind: 'mute' } }] })
  })

  it.each(['', 'c1'])('keeps a mute orphaned when the proposed scope changes (collection ID "%s")', async collectionId => {
    save(['1', '2', '3'].map(id => article(id)))
    const scope = 'Recovery of the Orion 9 landing capsule.'
    const model: PulseModel = async (_prompt, input) => {
      const group = proposal((input as { articles: Entry[] }).articles, collectionId, ' ORION 9 ')
      group.groups[0].scope = scope
      return group
    }
    const pulse = new PulseService(db, model, true, () => now)
    pulse.setChoice('collection-one', 'mute')
    for (const entryId of ['1', '2', '3']) pulse.feedback({ action: 'not_same', clusterId: 'collection-one', entryId })
    db.upsertEntries(['4', '5', '6'].map(id => article(id)))
    await pulse.refresh()
    expect(pulse.list()).toMatchObject({ collections: [{ scope, articleCount: 3 }], storyChoices: [] })
    expect(pulse.list().collections[0].id).not.toBe('collection-one')
    expect(db.storyChoices(now)).toMatchObject([{ id: 'collection-one', choice: { kind: 'mute' } }])
  })

  it('prunes choices after 30 days empty, including while grouping is paused', () => {
    for (const id of ['empty', 'revived', 'visible']) save(['1', '2', '3'].map(n => article(id + n)), id)
    const pulse = new PulseService(db, vi.fn(), false, () => now)
    for (const id of ['empty', 'revived', 'visible']) pulse.setChoice(id, 'mute')
    for (const id of ['empty', 'revived']) {
      for (const n of ['1', '2', '3']) pulse.feedback({ action: 'not_same', clusterId: id, entryId: id + n })
    }
    const sweep = () => { pulse.start(); pulse.stop() }
    sweep()
    now += 30 * DAY - 1
    save([article('4')], 'revived')
    sweep()
    expect(db.storyChoices(now).map(choice => choice.id)).toEqual(['empty', 'revived', 'visible'])
    pulse.feedback({ action: 'not_same', clusterId: 'revived', entryId: '4' })
    now++
    sweep()
    expect(db.storyChoices(now).map(choice => choice.id)).toEqual(['revived', 'visible'])
    expect(db.pulseCollectionIds()).toContain('empty')
    now += 30 * DAY
    sweep()
    expect(db.storyChoices(now).map(choice => choice.id)).toEqual(['visible'])
  })

  it.each(['feedback', 'list'])('counts downtime from the first empty %s observation', observation => {
    save(['1', '2', '3'].map(id => article(id)))
    const pulse = new PulseService(db, vi.fn(), false, () => now)
    pulse.setChoice('collection-one', 'mute')
    now += DAY
    if (observation === 'feedback') {
      for (const entryId of ['1', '2', '3']) pulse.feedback({ action: 'not_same', clusterId: 'collection-one', entryId })
    } else {
      db.greaderDatabase.prepare('DELETE FROM pulse_memberships WHERE collection_id = ?').run('collection-one')
      expect(pulse.list().storyChoices).toEqual([])
    }
    db.close()
    now += 30 * DAY - 1
    db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    const restarted = new PulseService(db, vi.fn(), false, () => now)
    restarted.start()
    restarted.stop()
    expect(db.storyChoices(now)).toHaveLength(1)
    now++
    restarted.start()
    restarted.stop()
    expect(db.storyChoices(now)).toEqual([])
  })

  it('restores only the absorbed choice when chained merges are undone out of order', () => {
    for (const key of ['a', 'b', 'c']) save(['1', '2', '3'].map(id => article(key + id)), key)
    const pulse = new PulseService(db, vi.fn(), false, () => now)
    pulse.setChoice('a', 'mute')
    const first = pulse.feedback({ action: 'merge', clusterId: 'a', targetClusterId: 'b' })
    expect(pulse.list().storyChoices).toMatchObject([{ id: 'b', choice: { kind: 'mute' } }])
    pulse.setChoice('b', 'follow')
    const second = pulse.feedback({ action: 'merge', clusterId: 'b', targetClusterId: 'c' })
    pulse.setChoice('c', 'snooze', now + DAY)
    pulse.removeFeedback(first.id)
    expect(pulse.list().storyChoices).toMatchObject([{ id: 'a', choice: { kind: 'mute' } }, { id: 'c', choice: { kind: 'snooze' } }])
    pulse.removeFeedback(second.id)
    expect(pulse.list().storyChoices).toEqual([
      { id: 'a', headline: 'Orion 9', choice: { kind: 'mute' } },
      { id: 'b', headline: 'Orion 9', choice: { kind: 'follow' } },
      { id: 'c', headline: 'Orion 9', choice: { kind: 'snooze', until: now + DAY } },
    ])
  })
})

it('defers busy or locked cleanup until the next Pulse tick and propagates other errors', () => {
  vi.useFakeTimers()
  const service = new PulseService(db, vi.fn(), false)
  const check = vi.spyOn(db, 'storyChoicesToCheck')
  check.mockImplementationOnce(() => { throw Object.assign(new Error('busy'), { errcode: 261 }) })
    .mockImplementationOnce(() => { throw Object.assign(new Error('locked'), { errcode: 6 }) })
  try {
    service.start()
    vi.advanceTimersByTime(2 * 5 * 60_000)
    expect(check).toHaveBeenCalledTimes(3)
    check.mockImplementationOnce(() => { throw new Error('cleanup failed') })
    expect(() => vi.advanceTimersByTime(5 * 60_000)).toThrow('cleanup failed')
  } finally { service.stop(); vi.useRealTimers() }
})
