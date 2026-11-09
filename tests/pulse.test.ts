import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { PulseService as RealPulseService, type PulseModel, reviewPulseGroups, duplicatePulseArticle, pulseExtract, validatePulseGroups, validatePulseBatch, shortPulseReferences } from '../src/server/pulse'
import { TopicService } from '../src/server/topics'
import { PaperRepository } from '../src/server/repository'
import type { Entry } from '../src/server/types'

const acceptReview: PulseModel = async (_prompt, input) => ({ decisions: (input as { articles: Array<{ id: string }> }).articles.map(entry => ({ entryId: entry.id, relevant: true, duplicateOf: '', excerpt: '' })) })
class PulseService extends RealPulseService {
  constructor(db: PaperDatabase, model: PulseModel, enabled = true, now: () => number = Date.now) {
    super(db, model, enabled, now, acceptReview)
  }
}

const DAY = 86_400_000
let now: number
let directory: string
let db: PaperDatabase
beforeEach(() => { now = Date.now(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-pulse-test-')); db = new PaperDatabase(path.join(directory, 'paper.sqlite')) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })
function article(id: string, title = `Orion 9 feature ${id} explained`, overrides: Partial<Entry> = {}): Entry {
  return { id, title, feedId: 'feed/one', feedTitle: 'One', feedUrl: 'https://one.test/feed', author: '', url: `https://one.test/${id}`,
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
  it('discovers collections from one publisher, retains identity, and never changes article read state', async () => {
    const first = [article('1'), article('2', undefined, { read: true }), article('3')]
    db.upsertEntries(first)
    const model = vi.fn().mockResolvedValueOnce(proposal(first))
    const service = new PulseService(db, model, true, () => now)
    await service.refresh()
    const original = service.list().collections[0]
    expect(original).toMatchObject({ headline: 'Orion 9', articleCount: 3, publicationCount: 1, unreadCount: 2, newCount: 3 })
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

  it('quiet collections retain all memberships and reactivate on a new addition', async () => {
    save([article('1'), article('2'), article('3')])
    now += 8 * DAY
    const late = article('4')
    db.upsertEntries([late])
    const model = vi.fn().mockResolvedValue(proposal([late], 'collection-one'))
    const service = new PulseService(db, model, true, () => now)
    expect(service.list().collections[0]).toMatchObject({ quiet: true, articleCount: 3 })
    await service.refresh()
    expect(model.mock.calls[0][1].collections[0].quiet).toBe(true)
    expect(service.list().collections[0]).toMatchObject({ quiet: false, articleCount: 4 })
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
      expect(service.list().collections).toHaveLength(1)
      expect(service.list().collections[0]).toMatchObject({ id: 'collection-c', articleCount: 9 })
    } finally { clock.useRealTimers() }
  })

  it('excludes muted articles from grouping and visible collections', async () => {
    const entries = [article('1'), article('2'), article('3')]
    save(entries)
    db.createMuteFilter('feature 1', 'title')
    const service = new PulseService(db, vi.fn(), true, () => now)
    expect(service.list().collections[0].sources.map(source => source.id)).not.toContain('1')
    db.upsertEntries([article('4', 'Excluded item for Orion 9')])
    db.createMuteFilter('Excluded item', 'title')
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
    let resolve!: (result: unknown) => void
    const service = new PulseService(db, () => new Promise(done => { resolve = done }), true, () => now)
    const running = service.refresh()
    service.feedback({ action: 'not_useful', clusterId: 'collection-one' })
    resolve(proposal([next], 'collection-one'))
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
    expect(validatePulseGroups(proposal(entries), entries.map(entry => ({ ...entry, url: 'https://one.test/same' })), [])).toEqual([])
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
  it('checks the minimum again when members were muted before saving and leaves survivors pending', () => {
    const entries = [article('1'), article('2'), article('3')]
    db.upsertEntries(entries)
    db.createMuteFilter('feature 2', 'title')
    db.createMuteFilter('feature 3', 'title')
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
    await expect(reviewPulseGroups(model, groups, entries, [])).rejects.toThrow('Unsupported')
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
