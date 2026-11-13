import { describe, expect, it, vi } from 'vitest'
import { checkBriefingSources } from '../src/server/briefing-sources.js'
import { selectionEntries, validateSelection } from '../src/server/briefing.js'
import { renderBriefing } from '../src/server/email.js'
import type { BriefingSelection, Entry } from '../src/server/types.js'

const titles = [
  "What OpenAI's latest controversy tells us about the future of math",
  'GOG brings back big box PC games, one printable template at a time',
  'OpenAI researcher allegedly pressured mathematician to drop Anthropic co-author from math breakthrough paper',
  "After Decades Of Making Us Play As Men, GTA 6's Lucia Has A Lot To Prove",
  'OpenAI Just Claimed a Huge Math Discovery. Some Academics Are Crying Foul',
]
const entries = new Map(titles.map((title, index) => {
  const id = String(index)
  return [id, { id, title, url: `https://source${id}.example/story`, feedTitle: `Source ${id}`, contentHtml: `<p>${title}</p>`, thumbnailUrl: `https://source${id}.example/image.jpg` } as Entry]
}))
const selection: BriefingSelection = {
  intro: 'An opening about these stories.',
  news: [{ headline: 'OpenAI math claim sparks a dispute over credit', summary: 'Academics dispute the attribution of an OpenAI mathematics result.', entryIds: [...entries.keys()], role: 'lead', imageEntryId: '1' }],
  worthNoticing: [], social: [],
}
const decisions = { decisions: [...entries.keys()].map(id => ({ id, relevant: ['0', '2', '4'].includes(id) })) }

describe('briefing source checks', () => {
  it('propagates cancellation instead of saving a partially checked selection', async () => {
    const controller = new AbortController()
    const model = vi.fn(async () => { controller.abort(); throw new Error('cancelled') })
    await expect(checkBriefingSources(selection, entries, model, new Map(), controller.signal)).rejects.toThrow()
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('removes GOG and GTA from the maths story, rendered links, image and mark-read membership', async () => {
    const model = vi.fn().mockResolvedValueOnce(decisions).mockResolvedValueOnce({ supported: true })
    const checked = await checkBriefingSources(selection, entries, model)
    expect(checked.news[0].entryIds).toEqual(['0', '2', '4'])
    expect(checked.news[0].imageEntryId).toBe('')
    expect(checked.intro).toBe('')
    expect((model.mock.calls[1][1] as { sources: Array<{ id: string }> }).sources.map(s => s.id)).toEqual(['0', '2', '4'])
    expect(selectionEntries(checked).map(e => e.id)).toEqual(['0', '2', '4'])
    const email = renderBriefing({ kind: 'morning', cutoff: new Date(), selection: checked, entries, confirmUrl: 'https://paper.example/confirm' })
    for (const id of ['0', '2', '4']) expect(email.html).toContain(entries.get(id)!.url)
    for (const id of ['1', '3']) {
      expect(email.html).not.toContain(entries.get(id)!.url)
      expect(email.text).not.toContain(entries.get(id)!.url)
    }
    expect(selection.news[0].entryIds).toHaveLength(5)
  })

  it('drops claims unsupported after source removal, along with the opening', async () => {
    const model = vi.fn().mockResolvedValueOnce(decisions).mockResolvedValueOnce({ supported: false })
    const result = await checkBriefingSources(selection, entries, model)
    expect(result.news).toEqual([])
    expect(result.intro).toBe('')
    expect(selectionEntries(result)).toEqual([])
  })

  it.each([
    null,
    { decisions: [{ id: '0', relevant: true }] },
    { decisions: [...decisions.decisions.slice(0, 4), { id: 'unknown', relevant: true }] },
    { decisions: [...decisions.decisions.slice(0, 4), { id: '0', relevant: true }] },
    { decisions: decisions.decisions.map(d => ({ ...d, relevant: 'true' })) },
  ])('fails closed on invalid or incomplete source decisions: %j', async raw => {
    const model = vi.fn().mockResolvedValue(raw)
    expect((await checkBriefingSources(selection, entries, model)).news).toEqual([])
    expect(model).toHaveBeenCalledTimes(1)
  })

  it('does not accept truthy strings as factual approval', async () => {
    const model = vi.fn().mockResolvedValueOnce(decisions).mockResolvedValueOnce({ supported: 'true' })
    expect((await checkBriefingSources(selection, entries, model)).news).toEqual([])
  })

  it('omits unchecked news on outage without losing other sections', async () => {
    const candidate = { ...selection, social: [{ entryId: 'social', summary: 'A post', imageEntryId: '' }] }
    const result = await checkBriefingSources(candidate, entries, vi.fn().mockRejectedValue(new Error('offline')))
    expect(result.news).toEqual([])
    expect(result.social).toEqual(candidate.social)
  })

  it('keeps the opening and image when all sources pass', async () => {
    const model = vi.fn().mockResolvedValueOnce({ decisions: [...entries.keys()].map(id => ({ id, relevant: true })) }).mockResolvedValueOnce({ supported: true })
    expect(await checkBriefingSources(selection, entries, model)).toEqual(selection)
  })
})

describe('writer source selection', () => {
  const cluster = { id: 'cluster', kind: 'event' as const, entryIds: [...entries.keys()], domains: [], leadTitle: 'Maths' }
  it('keeps the explicitly chosen subset instead of expanding it back to the full cluster', () => {
    const raw = { ...selection, news: [{ ...selection.news[0], clusterId: 'cluster', entryIds: ['0', '2', '4', '0'] }] }
    expect(validateSelection(raw, entries, [cluster], 'morning').news[0].entryIds).toEqual(['0', '2', '4'])
  })
  it('rejects missing source choices and unknown clusters', () => {
    for (const item of [
      { ...selection.news[0], clusterId: 'cluster', entryIds: undefined },
      { ...selection.news[0], clusterId: 'invented' },
    ]) {
      expect(validateSelection({ ...selection, news: [item] } as unknown as BriefingSelection, entries, [cluster], 'morning').news).toEqual([])
    }
  })
})
