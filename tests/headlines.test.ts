import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db.js'
import { HeadlineService, headlineEligible, headlineFingerprint, validHeadlineProposal, type HeadlineModel } from '../src/server/headlines.js'
import type { Entry } from '../src/server/types.js'

const body = 'Samsung Notes supports the S Pen and formatted documents. I prefer it to Google Keep for my notes. '.repeat(8)
const original = 'This one app keeps me using Samsung phones'
const title = 'Samsung Notes keeps me using Samsung phones for its S Pen support'
const entry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'one', feedId: 'feed/ap', feedTitle: 'Android Police', feedUrl: 'https://www.androidpolice.com/feed/',
  url: 'https://www.androidpolice.com/samsung-notes/', title: original, contentHtml: `<p>${body}</p>`,
  author: 'Author', excerpt: '', timestamp: Math.floor(Date.now() / 1000), publishedAt: new Date().toISOString(),
  read: false, starred: true, readingMinutes: 2, thumbnailUrl: '', kind: 'article', ...overrides,
})
let db: PaperDatabase
let model: ReturnType<typeof vi.fn<HeadlineModel>>
let fetchArticle: ReturnType<typeof vi.fn<(url: string) => Promise<{ contentHtml: string }>>>
let service: HeadlineService
beforeEach(() => {
  db = new PaperDatabase(':memory:')
  db.upsertEntries([entry()])
  fetchArticle = vi.fn(async () => ({ contentHtml: `<p>${body}</p>` }))
  model = vi.fn(async stage => stage === 'write'
    ? { results: [{ id: 'one', action: 'rewrite', title, evidence: ['Samsung Notes supports the S Pen and formatted documents.'] }] }
    : { results: [{ id: 'one', approve: true }] })
  service = new HeadlineService(db, fetchArticle, model)
})
afterEach(() => { service.stop(); db.close(); vi.restoreAllMocks() })

describe('clear headlines', () => {
  it('does not start a review or decorate titles when disabled during a model request', async () => {
    model.mockImplementationOnce(async () => {
      service.setEnabled(false)
      return { results: [{ id: 'one', action: 'rewrite', title, evidence: ['Samsung Notes supports the S Pen'] }] }
    })
    await service.run()
    await service.run()
    expect(model).toHaveBeenCalledOnce()
    expect(service.status().enabled).toBe(false)
    expect(service.decorate(entry()).displayTitle).toBeUndefined()
    expect(db.getHeadline('one')).toBeNull()
  })
  it('only accepts articles from the two exact source hosts', () => {
    expect(headlineEligible(entry())).toBe(true)
    expect(headlineEligible(entry({ url: 'https://androidauthority.com/post', feedUrl: 'https://androidauthority.com/feed/' }))).toBe(true)
    for (const url of ['https://androidpolice.com.evil.test/post', 'https://evil.test/androidpolice.com', 'file:///androidpolice.com']) {
      expect(headlineEligible(entry({ url }))).toBe(false)
    }
    expect(headlineEligible(entry({ feedUrl: 'https://other.test/feed' }))).toBe(false)
    expect(headlineEligible(entry({ kind: 'youtube' }))).toBe(false)
  })

  it('requires grounded excerpts and rejects new financial claims or markup', () => {
    expect(validHeadlineProposal(original, body, title, ['Samsung Notes supports the S Pen'])).toBe(true)
    expect(validHeadlineProposal(original, body, title, ['This app supports every phone ever built'])).toBe(false)
    expect(validHeadlineProposal(original, body, 'Samsung saves $84.4 million with Notes', ['Samsung Notes supports the S Pen'])).toBe(false)
    expect(validHeadlineProposal(original, body, '<b>Samsung Notes</b>', ['Samsung Notes supports the S Pen'])).toBe(false)
    expect(validHeadlineProposal(original, body, title, [])).toBe(false)
  })

  it('requires a separate approval and leaves originals and read states untouched', async () => {
    await service.run()
    expect(model.mock.calls.map(call => call[0])).toEqual(['write', 'review'])
    expect((model.mock.calls[1][2] as Array<{ proposal: string }>)[0].proposal).toBe(title)
    expect(service.decorate(db.localEntry('one')!).displayTitle).toBe(title)
    expect(db.localEntry('one')).toMatchObject({ title: original, read: false, starred: true })
    expect(db.localEntry('one')!.displayTitle).toBeUndefined()
    await service.run()
    expect(model).toHaveBeenCalledTimes(2)
  })

  it('fails closed on reviewer rejection or a non-boolean approval', async () => {
    model.mockImplementation(async stage => stage === 'write'
      ? { results: [{ id: 'one', action: 'rewrite', title, evidence: ['Samsung Notes supports the S Pen'] }] }
      : { results: [{ id: 'one', approve: 'true' }] })
    await service.run()
    expect(service.decorate(entry()).displayTitle).toBeUndefined()
    expect(db.getHeadline('one')?.status).toBe('rejected')
  })

  it('does not repeat rejected or unchanged decisions', async () => {
    model.mockResolvedValue({ results: [{ id: 'one', action: 'keep', title: original, evidence: [] }] })
    await service.run(); await service.run()
    expect(model).toHaveBeenCalledTimes(1)
    expect(db.getHeadline('one')?.status).toBe('unchanged')
  })

  it('does not call models with short extraction or fetch failures', async () => {
    fetchArticle.mockResolvedValueOnce({ contentHtml: '<p>Subscribe to our newsletter.</p>' })
    await service.run()
    expect(model).not.toHaveBeenCalled()
    db.upsertEntries([entry({ title: 'Changed source title' })])
    fetchArticle.mockRejectedValueOnce(new Error('403'))
    await service.run()
    expect(db.getHeadline('one')?.status).toBe('error')
    await service.run()
    expect(fetchArticle).toHaveBeenCalledTimes(2)
  })

  it('invalidates the display title after source edits but not read-state changes', async () => {
    await service.run()
    const read = entry({ read: true })
    expect(headlineFingerprint(read)).toBe(headlineFingerprint(entry()))
    expect(service.decorate(read).displayTitle).toBe(title)
    const changed = entry({ title: 'New original title' })
    db.upsertEntries([changed])
    expect(service.decorate(changed).displayTitle).toBeUndefined()
  })

  it('invalidates cached headlines when the selected provider model changes', async () => {
    let version = 'openai:first-model'
    service = new HeadlineService(db, fetchArticle, model, true, () => version)
    await service.run()
    expect(service.decorate(entry()).displayTitle).toBe(title)
    version = 'openai:second-model'
    expect(service.decorate(entry()).displayTitle).toBeUndefined()
    await service.run()
    expect(model).toHaveBeenCalledTimes(4)
    expect(service.decorate(entry()).displayTitle).toBe(title)
  })

  it('discards a result when the source changes while it is being reviewed', async () => {
    model.mockImplementation(async stage => {
      if (stage === 'write') return { results: [{ id: 'one', action: 'rewrite', title, evidence: ['Samsung Notes supports the S Pen'] }] }
      db.upsertEntries([entry({ title: 'Updated article' })])
      return { results: [{ id: 'one', approve: true }] }
    })
    await service.run()
    expect(db.getHeadline('one')).toBeNull()
  })

  it('rejects mismatched IDs and backs off after model failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    model.mockResolvedValue({ results: [{ id: 'wrong', action: 'rewrite', title, evidence: [] }] })
    await service.run(); await service.run()
    expect(db.getHeadline('one')?.status).toBe('error')
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('does not run overlapping jobs or process disabled sources', async () => {
    let release!: () => void
    fetchArticle.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ contentHtml: `<p>${body}</p>` }) }))
    const first = service.run()
    await service.run()
    expect(fetchArticle).toHaveBeenCalledTimes(1)
    release(); await first
    const disabled = new HeadlineService(db, fetchArticle, model, false)
    await disabled.run()
    expect(disabled.decorate(entry()).displayTitle).toBeUndefined()
    expect(model).toHaveBeenCalledTimes(2)
  })
})
