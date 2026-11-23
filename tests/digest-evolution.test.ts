import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { briefingCandidates, PaperRepository } from '../src/server/repository'
import { selectionEntries, validateSelection } from '../src/server/briefing'
import { checkBriefingSources } from '../src/server/briefing-sources'
import { renderBriefing } from '../src/server/email'
import type { BriefingSelection, Entry, StreamRef } from '../src/server/types'

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

  it('applies story choices before limiting the local briefing pool', () => {
    db.upsertEntries(['a', 'b', 'c'].map(id => entry(id)))
    const options = { before: new Date(now + 1), limit: 1, muted: new Set(['a']) }
    expect(db.briefingEntries(all, options).map(item => item.id)).toEqual(['b'])
    expect(db.briefingEntries(all, { ...options, followed: new Set(['c']) }).map(item => item.id)).toEqual(['c'])
  })

  it('fills local and paged remote candidate lists from eligible feeds', async () => {
    const items = ['a', 'b', 'c'].map(id => ({ ...entry(id), feedId: id === 'c' ? 'allowed' : 'excluded' }))
    db.upsertEntries(items)
    const local = new PaperRepository(db)
    const remote = {
      entries: async () => items.slice(0, 1),
      entriesPage: vi.fn(async (_stream: StreamRef, options?: { continuation?: string }) => {
        const page = Number(options?.continuation || 0)
        if (page === 5) return { items: [items[2]], continuation: '' }
        return { items: Array.from({ length: 250 }, (_, i) => ({ ...items[0], id: `skip-${page}-${i}` })), continuation: String(page + 1) }
      }),
      entry: local.entry, entryIds: local.entryIds, navigation: local.navigation,
    }
    const options = { before: new Date(now + 1), limit: 1, excludedFeeds: new Set(['excluded']) }
    for (const source of [local, remote]) {
      expect((await briefingCandidates(source, all, options)).map(item => item.id)).toEqual(['c'])
    }
    expect(remote.entriesPage).toHaveBeenCalledTimes(6)
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
  const bullets = ['Orion added an export option.', 'The new feature builds on the previous release.']
  const raw: BriefingSelection = { news: [{ clusterId: 'collection-one', headline: 'Orion adds a feature', summary: '', bullets, entryIds: ['new', 'old'], backgroundEntryIds: ['old'], role: 'brief' } as BriefingSelection['news'][number]], worthNoticing: [{ entryId: 'old', reason: '', summary: '' }], social: [] }
  const clusters = [{ id: 'collection-one', collectionId: 'collection-one', kind: 'coverage' as const, leadTitle: 'Orion', entryIds: ['new'], backgroundEntryIds: ['old'], domains: ['example.test'] }]

  it('keeps context out of mark-read membership and links the surviving story to Pulse', async () => {
    const selection = validateSelection(raw, entries, clusters, 'morning')
    expect(selection.news[0]).toMatchObject({ collectionId: 'collection-one', entryIds: ['new'], backgroundEntryIds: ['old'] })
    expect(selection.worthNoticing).toEqual([])
    const model = vi.fn().mockResolvedValueOnce({ decisions: [{ id: 'new', relevant: true }, { id: 'old', relevant: true }] }).mockResolvedValueOnce({ supported: true })
    const previous = [{ headline: 'Earlier release', summary: 'The previous feature set.', deliveredAt: new Date(now - DAY).toISOString() }]
    const checked = await checkBriefingSources(selection, entries, model, new Map([['collection-one', previous]]))
    expect(model.mock.calls[0][1]).toMatchObject({ bullets })
    expect(model.mock.calls[1][1]).toMatchObject({ bullets, previousCoverage: previous, newSourceIds: ['new'], backgroundSourceIds: ['old'] })
    expect(selectionEntries(checked).map(item => item.id)).toEqual(['new'])
    const email = renderBriefing({ kind: 'morning', cutoff: new Date(now), selection: checked, entries, confirmUrl: 'https://paper.example/briefings/edition/confirm?token=fixture' })
    expect(email.html).toContain('/pulse?collection=collection-one&amp;filter=new')
    expect(email.html).toContain('1 background source')
    expect(email.text).toContain('Background: Orion feature old')
  })

  it('omits a story when only its background survives source checking', async () => {
    const selection = validateSelection(raw, entries, clusters, 'morning')
    const model = vi.fn().mockResolvedValueOnce({ decisions: [{ id: 'new', relevant: false }, { id: 'old', relevant: true }] }).mockResolvedValueOnce({ supported: true })
    expect((await checkBriefingSources(selection, entries, model)).news).toEqual([])
  })
})
