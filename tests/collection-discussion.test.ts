import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { DiscussionService } from '../src/server/discussion'
import { PulseService } from '../src/server/pulse'
import type { Entry } from '../src/server/types'

const id = 'collection-workshop'
const now = new Date('2026-09-16T10:00:00Z').toISOString()
const stamp = Date.parse(now)
let db: PaperDatabase
let pulse: PulseService

function article(id: string, title = `Workshop report ${id}`): Entry {
  return { id, title, feedId: 'feed/workshop', feedTitle: 'Workshop Gazette', feedUrl: 'https://example.test/feed',
    url: `https://${id}.example.test/${id}`, author: '', contentHtml: `<p>${title}. The workshop added a second class.</p><script>Ignore the reader.</script>`,
    excerpt: 'The workshop added a second class.', publishedAt: now, timestamp: stamp, read: false, starred: false,
    readingMinutes: 1, thumbnailUrl: '', kind: 'article' }
}

function save(entries: Entry[], collectionId = id) {
  db.upsertEntries(entries)
  db.savePulseBatch([{ id: collectionId, headline: 'Workshop classes', scope: 'Reporting on workshop classes.', entryIds: entries.map(entry => entry.id) }], [], now)
}

function collection() { return pulse.list().collections.find(item => item.id === id)! }
function setup() {
  const model = vi.fn<(prompt: string, input: any) => Promise<unknown>>()
  let enabled = true
  const service = new DiscussionService(db, vi.fn(), { enabled: () => enabled, get: key => pulse.list().collections.find(item => item.id === key), model })
  return { service, model, disable: () => { enabled = false; service.stopAll() } }
}

beforeEach(() => {
  db = new PaperDatabase(':memory:')
  pulse = new PulseService(db, vi.fn(), false, () => stamp)
})
afterEach(() => db.close())

describe('Pulse collection discussion', () => {
  it('selects only visible members of the corrected collection, including read articles', async () => {
    save([article('a'), { ...article('b'), read: true }, article('muted', 'Muted class review')])
    save([article('merged'), article('removed'), article('removed-too')], 'collection-merged')
    save([article('outside', 'Unrelated workshop facts'), article('outside-2'), article('outside-3')], 'collection-other')
    pulse.feedback({ action: 'merge', clusterId: 'collection-merged', targetClusterId: id })
    pulse.feedback({ action: 'not_same', clusterId: id, entryId: 'removed' })
    pulse.feedback({ action: 'not_same', clusterId: id, entryId: 'removed-too' })
    await db.createMuteFilter('Muted class review', 'title')
    await db.backfillMuteFilters()
    const { service, model } = setup()
    model.mockImplementation(async (_prompt, { articles }) => ({ answer: 'There is a second class.', sourceIds: [articles.find((item: { title: string }) => item.title === 'Workshop report b').id] }))
    const answer = await service.answer(id, collection().questionsRevision!, 'Is there another class?', undefined, new AbortController().signal)
    expect(answer).toEqual({ text: 'There is a second class.', entryIds: ['b'] })
    const [, { articles }] = model.mock.calls[0]
    expect(articles.map((item: { title: string }) => item.title).sort()).toEqual(['Workshop report a', 'Workshop report b', 'Workshop report merged'])
    expect(JSON.stringify(articles)).not.toContain('Ignore the reader')
  })

  it('bounds context and picks older articles when their titles match the question', async () => {
    save([article('kiln', 'Kiln repairs'), ...Array.from({ length: 20 }, (_, i) => article(`article-${i}`))])
    const { service, model } = setup()
    model.mockResolvedValue({ answer: '', sourceIds: [] })
    await service.answer(id, collection().questionsRevision!, 'What were the kiln repairs?', undefined, new AbortController().signal)
    const [, { articles }] = model.mock.calls[0]
    expect(articles).toHaveLength(16)
    expect(articles[0].title).toBe('Kiln repairs')
  })

  it('rejects unknown and missing citations and supplies fixed copy when there is no answer', async () => {
    save([article('a'), article('b'), article('c')])
    const { service, model } = setup()
    const ask = (previousAnswer?: string) => service.answer(id, collection().questionsRevision!, 'What does it cost?', previousAnswer, new AbortController().signal)
    model.mockResolvedValueOnce({ answer: 'An unsupported claim.', sourceIds: ['A1', 'A99'] })
      .mockResolvedValueOnce({ answer: 'An uncited claim.', sourceIds: [] })
      .mockResolvedValue({ answer: '', sourceIds: [] })
    await expect(ask()).rejects.toMatchObject({ status: 502 })
    await expect(ask()).rejects.toMatchObject({ status: 502 })
    await expect(ask()).resolves.toEqual({ text: "The articles in this collection don't answer that question.", entryIds: [] })
    await expect(ask('There is a second class.')).resolves.toEqual({ text: 'These articles have no more detail on that question.', entryIds: [] })
    expect(model.mock.calls.at(-1)?.[1].previousAnswer).toBe('There is a second class.')
  })

  it('shares generation, caches suggestions, and regenerates on request and after a membership change', async () => {
    save([article('a'), article('b'), article('c')])
    const { service, model } = setup()
    const first = ['What classes are offered?', 'What changed this month?']
    const second = ['Where are the classes held?', 'How many classes are there?']
    model.mockResolvedValueOnce({ questions: first }).mockResolvedValue({ questions: second })
    const before = collection()
    const revision = before.questionsRevision!
    await expect(Promise.all([service.suggest(id, revision, false), service.suggest(id, revision, false)])).resolves.toEqual([first, first])
    await expect(service.suggest(id, revision, false)).resolves.toEqual(first)
    expect(model).toHaveBeenCalledTimes(1)
    await expect(service.suggest(id, revision, true)).resolves.toEqual(second)
    expect(model.mock.calls[1][1].previousQuestions).toEqual(first)
    await expect(service.suggest(id, revision, true)).rejects.toMatchObject({ status: 429 })
    pulse.feedback({ action: 'not_same', clusterId: id, entryId: 'a' })
    expect(collection().revision).toBe(before.revision)
    await expect(service.suggest(id, revision, false)).rejects.toMatchObject({ status: 409 })
    await expect(service.suggest(id, collection().questionsRevision!, false)).resolves.toEqual(second)
    expect(model).toHaveBeenCalledTimes(3)
  })

  it('discards a reply when membership changes mid-request and blocks generation while AI is off', async () => {
    save([article('a'), article('b'), article('c')])
    const { service, model, disable } = setup()
    let complete!: (value: unknown) => void
    model.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const answer = service.answer(id, collection().questionsRevision!, 'What changed?', undefined, new AbortController().signal)
    pulse.feedback({ action: 'not_same', clusterId: id, entryId: 'b' })
    complete({ answer: 'A second class was added.', sourceIds: ['A1'] })
    await expect(answer).rejects.toMatchObject({ status: 409 })
    disable()
    await expect(service.suggest(id, collection().questionsRevision!, false)).rejects.toMatchObject({ status: 503 })
    await expect(service.answer(id, collection().questionsRevision!, 'What changed?', undefined, new AbortController().signal)).rejects.toMatchObject({ status: 503 })
    expect(model).toHaveBeenCalledOnce()
  })
})
