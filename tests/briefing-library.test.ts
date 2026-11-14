import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingLibraryService } from '../src/server/briefing-library'
import { PaperDatabase, type BriefingRecord } from '../src/server/db'
import type { Entry } from '../src/server/types'

let directory: string, db: PaperDatabase
const article = (id: string): Entry => ({ id, title: `Synthetic story ${id}`, feedId: 'feed/one', feedTitle: 'Synthetic feed',
  feedUrl: 'https://example.test/feed', author: '', url: `https://example.test/${id}`, contentHtml: '<p>Synthetic report.</p>',
  excerpt: 'Synthetic report.', publishedAt: '2026-11-14T08:00:00Z', timestamp: 1, read: false, starred: false,
  readingMinutes: 1, thumbnailUrl: '', kind: 'article' })

function seed(missing = false) {
  db.upsertEntries(['one', 'two', 'background', 'unrelated'].map(article))
  const record: BriefingRecord = { id: 'briefing', kind: 'morning', subject: 'Synthetic briefing', html: '<p>Email briefing</p>', text: 'Email briefing',
    status: 'generated', windowStart: '2026-11-14T07:00:00Z', cutoff: '2026-11-14T08:00:00Z', createdAt: '2026-11-14T08:00:00Z',
    deliveredAt: null, acknowledgedAt: null, tokenHash: '0'.repeat(64),
    selection: { news: [{ headline: 'Synthetic development', summary: 'Two sources.', entryIds: ['one', 'two'], backgroundEntryIds: ['background'] }], worthNoticing: [], social: [] } }
  db.createBriefing(record, [{ id: 'one', section: 'news' }, { id: 'two', section: 'news' },
    { id: 'one', section: 'worth-noticing' }, ...(missing ? [{ id: 'missing', section: 'news' }] : [])])
  return record
}
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-briefing-library-')); db = new PaperDatabase(path.join(directory, 'paper.sqlite')) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('briefing acknowledgement', () => {
  it('waits for the source update, deduplicates requests, and leaves background and unrelated stories unread', async () => {
    const record = seed()
    let finish!: () => void
    const write = vi.fn((ids: string[]) => new Promise<void>(resolve => { finish = () => { db.editLocalEntryState(ids, 'read'); resolve() } }))
    const library = new BriefingLibraryService(db, write)
    expect(library.summary(record)).toMatchObject({ entryCount: 2, unreadCount: 2, missingCount: 0 })
    expect(library.detail(record).sources.map(source => source.id).sort()).toEqual(['background', 'one', 'two'])
    const first = library.markRead(record.id)
    expect(library.markRead(record.id)).toBe(first)
    expect(db.getBriefing(record.id)?.acknowledgedAt).toBeNull()
    finish()
    const result = await first
    expect(write).toHaveBeenCalledOnce()
    expect(new Set(result.sourceIds)).toEqual(new Set(['one', 'two']))
    expect(result.briefing).toMatchObject({ status: 'acknowledged', entryCount: 2, unreadCount: 0, missingCount: 0 })
    expect(result.briefing.acknowledgedAt).toBeTruthy()
    expect(db.localEntry('background')?.read).toBe(false)
    expect(db.localEntry('unrelated')?.read).toBe(false)
  })

  it('preserves unread state and the unacknowledged briefing when the reader rejects a write, then allows retry', async () => {
    const record = seed()
    const write = vi.fn<(ids: string[]) => Promise<void>>().mockRejectedValueOnce(new Error('Reader unavailable'))
      .mockImplementationOnce(async ids => { db.editLocalEntryState(ids, 'read') })
    const library = new BriefingLibraryService(db, write)
    await expect(library.markRead(record.id)).rejects.toThrow('Reader unavailable')
    expect(library.summary(db.getBriefing(record.id)!)).toMatchObject({ acknowledgedAt: null, unreadCount: 2 })
    expect((await library.markRead(record.id)).briefing.unreadCount).toBe(0)
  })

  it('uses current story state even after acknowledgement and reapplies read when a story becomes unread', async () => {
    const record = seed()
    const write = vi.fn(async (ids: string[]) => { db.editLocalEntryState(ids, 'read') })
    const library = new BriefingLibraryService(db, write)
    const first = await library.markRead(record.id)
    db.editLocalEntryState(['one'], 'unread')
    expect(library.summary(db.getBriefing(record.id)!)).toMatchObject({ status: 'acknowledged', unreadCount: 1 })
    const second = await library.markRead(record.id)
    expect(second.briefing.unreadCount).toBe(0)
    expect(second.briefing.acknowledgedAt).toBe(first.briefing.acknowledgedAt)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not acknowledge missing stories or a writer that did not update source state', async () => {
    const record = seed(true)
    const write = vi.fn(async () => {})
    const library = new BriefingLibraryService(db, write)
    expect(library.summary(record)).toMatchObject({ entryCount: 3, unreadCount: 2, missingCount: 1 })
    await expect(library.markRead(record.id)).rejects.toMatchObject({ status: 409 })
    expect(write).not.toHaveBeenCalled()
    await expect(library.markRead('missing-briefing')).rejects.toMatchObject({ status: 404 })
    expect(db.getBriefing(record.id)?.acknowledgedAt).toBeNull()
  })

  it('does not report success if source state changes before the write finishes', async () => {
    const record = seed()
    const library = new BriefingLibraryService(db, async () => {})
    await expect(library.markRead(record.id)).rejects.toMatchObject({ status: 409 })
    expect(db.getBriefing(record.id)?.acknowledgedAt).toBeNull()
  })
})
