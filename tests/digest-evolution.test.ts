import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { selectionEntries, validateSelection } from '../src/server/briefing'
import { checkBriefingSources } from '../src/server/briefing-sources'
import { renderBriefing } from '../src/server/email'
import type { BriefingSelection, Entry } from '../src/server/types'

const now = Date.parse('2026-09-23T18:00:00Z')
const DAY = 86_400_000
const all = { kind: 'all' as const, id: 'all', title: 'All articles' }
const entry = (id: string, timestamp = now - DAY): Entry => ({ id, title: `Orion feature ${id}`, url: `https://example.test/${id}`, feedId: 'feed/1', feedTitle: 'Example', feedUrl: 'https://example.test/rss', author: '', contentHtml: `<p>Orion feature ${id} is available.</p>`, excerpt: 'Orion development', publishedAt: new Date(timestamp).toISOString(), timestamp, read: false, starred: false, readingMinutes: 1, thumbnailUrl: '', kind: 'article' })
let directory: string, db: PaperDatabase
beforeEach(() => { vi.useFakeTimers().setSystemTime(now); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-')); db = new PaperDatabase(path.join(directory, 'test.sqlite')) })
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); vi.useRealTimers() })

describe('digest candidate eligibility', () => {
  it('includes late arrivals and retains unselected articles without refreshing their arrival on resync', () => {
    const late = entry('late', now - 30 * DAY)
    db.upsertEntries([late, entry('normal')])
    expect(db.briefingEntries(all, { before: new Date(now + 1), unreadOnly: true }).map(item => item.id).sort()).toEqual(['late', 'normal'])
    vi.setSystemTime(now + DAY)
    db.upsertEntries([late])
    expect(db.briefingEntries(all, { before: new Date(now + 2 * DAY), unreadOnly: true })).toHaveLength(2)
    expect(db.briefingEntries(all, { before: new Date(now + 8 * DAY), unreadOnly: true })).toHaveLength(0)
  })

  it('rotates past considered candidates and respects mute, read and delivered state', async () => {
    db.upsertEntries([entry('a'), entry('b'), entry('muted'), { ...entry('read'), read: true }])
    const creating = db.createMuteFilter('feature muted', 'title')
    await vi.runAllTimersAsync()
    await creating
    const first = db.briefingEntries(all, { before: new Date(now + 1), unreadOnly: true, limit: 1 })
    db.recordBriefingConsidered(first.map(item => item.id), now)
    const second = db.briefingEntries(all, { before: new Date(now + 1), unreadOnly: true, limit: 1 })
    expect(second[0].id).not.toBe(first[0].id)
    db.createBriefing({ id: 'edition', kind: 'morning', windowStart: new Date(now - DAY).toISOString(), cutoff: new Date(now).toISOString(), subject: 'Fixture', html: '', text: '', status: 'delivered', tokenHash: '', selection: { news: [], worthNoticing: [], social: [] }, createdAt: new Date(now).toISOString(), deliveredAt: new Date(now).toISOString(), acknowledgedAt: null }, [{ id: second[0].id, section: 'news' }])
    expect(db.briefingEntries(all, { before: new Date(now + 1), unreadOnly: true }).map(item => item.id)).toEqual([first[0].id])
  })
})

describe('continuing digest stories', () => {
  const entries = new Map([entry('new'), entry('old')].map(item => [item.id, item]))
  const raw: BriefingSelection = { news: [{ clusterId: 'collection-one', headline: 'Orion adds a feature', summary: 'The new feature builds on the previous release.', entryIds: ['new', 'old'], backgroundEntryIds: ['old'], role: 'brief' } as BriefingSelection['news'][number]], worthNoticing: [{ entryId: 'old', reason: '', summary: '' }], social: [] }
  const clusters = [{ id: 'collection-one', collectionId: 'collection-one', kind: 'coverage' as const, leadTitle: 'Orion', entryIds: ['new'], backgroundEntryIds: ['old'], domains: ['example.test'] }]

  it('keeps context out of mark-read membership and links the surviving story to Pulse', async () => {
    const selection = validateSelection(raw, entries, clusters, 'morning')
    expect(selection.news[0]).toMatchObject({ collectionId: 'collection-one', entryIds: ['new'], backgroundEntryIds: ['old'] })
    expect(selection.worthNoticing).toEqual([])
    const model = vi.fn().mockResolvedValueOnce({ decisions: [{ id: 'new', relevant: true }, { id: 'old', relevant: true }] }).mockResolvedValueOnce({ supported: true })
    const previous = [{ headline: 'Earlier release', summary: 'The previous feature set.', deliveredAt: new Date(now - DAY).toISOString() }]
    const checked = await checkBriefingSources(selection, entries, model, new Map([['collection-one', previous]]))
    expect(model.mock.calls[1][1]).toMatchObject({ previousCoverage: previous, newSourceIds: ['new'], backgroundSourceIds: ['old'] })
    expect(selectionEntries(checked).map(item => item.id)).toEqual(['new'])
    const email = renderBriefing({ kind: 'morning', cutoff: new Date(now), selection: checked, entries, confirmUrl: 'https://paper.example/briefings/edition/confirm?token=fixture' })
    expect(email.html).toContain('view=pulse&amp;collection=collection-one')
    expect(email.html).toContain('Background, kept separate')
    expect(email.text).toContain('Background: Orion feature old')
  })

  it('omits a story when only its background survives source checking', async () => {
    const selection = validateSelection(raw, entries, clusters, 'morning')
    const model = vi.fn().mockResolvedValueOnce({ decisions: [{ id: 'new', relevant: false }, { id: 'old', relevant: true }] }).mockResolvedValueOnce({ supported: true })
    expect((await checkBriefingSources(selection, entries, model)).news).toEqual([])
  })
})
