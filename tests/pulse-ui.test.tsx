// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopicsLibrary } from '../src/client/components/TopicsLibrary'
import { api } from '../src/client/api'
import { refreshPulseState, acknowledgePulseVisit } from '../src/client/pulse'
import type { PulseCollection, PulsePayload, PulseSource } from '../src/shared/pulse'

const source = (id: string, sequence: number, read = false): PulseSource => ({ id, sequence, read, isNew: true, addedAt: '2026-09-16T10:00:00Z',
  feedId: 'feed/one', publication: 'Daily Gazette', domain: `paper-${sequence % 2}.test`, title: `Feature report ${id}`, url: `https://example.test/${id}`,
  author: '', publishedAt: '2026-09-16T10:00:00Z', timestamp: 1, thumbnailUrl: '' })
const collection = (id: string, sources: PulseSource[]): PulseCollection => ({ id, headline: `Collection ${id}`, scope: 'Reporting on a developing release.',
  createdAt: '2026-09-16T10:00:00Z', updatedAt: '2026-09-16T10:00:00Z', revision: Math.max(...sources.map(s => s.sequence)), seenThrough: 0,
  newCount: sources.filter(s => s.isNew).length, unreadCount: sources.filter(s => !s.read).length, publicationCount: new Set(sources.map(s => s.domain)).size, articleCount: sources.length,
  latestPublishedAt: sources[0].publishedAt, recentArticleCount: sources.length, recentPublicationCount: new Set(sources.map(s => s.domain)).size,
  active: true, archived: false, quiet: false, sources })
const payload = (collections: PulseCollection[], revision = 'one'): PulsePayload => ({ collections, revision, status: { enabled: true, running: false, lastCompletedAt: null, failed: false } })
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.restoreAllMocks(); document.body.innerHTML = '' })

function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button ${label}`)
  return result
}

describe('Pulse visit and update interface', () => {
  it('preserves membership and order during background updates while refreshing read status', () => {
    const one = collection('one', [source('1', 1)])
    const two = collection('two', [source('2', 2)])
    const incoming = payload([collection('two', [source('3', 3), source('2', 2)]), collection('one', [{ ...source('1', 1, true), isNew: false, stateRevision: 3 }])], 'two')
    const refreshed = refreshPulseState(payload([one, two]), incoming, 'one')
    expect(refreshed.collections.map(item => item.id)).toEqual(['one', 'two'])
    expect(refreshed.collections[1].articleCount).toBe(1)
    expect(refreshed.collections[0]).toMatchObject({ unreadCount: 0, newCount: 1 })
    expect(refreshed.collections[0].sources[0].stateRevision).toBe(3)
    expect(acknowledgePulseVisit(incoming.collections[0], 2)).toMatchObject({ newCount: 1, unreadCount: 2 })
  })

  it('keeps a collection snapshot open, acknowledges only its displayed revision and loads changes on request', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    let latest = payload([collection('one', [{ ...source('1', 1), stateRevision: 4 }, source('2', 2, true), { ...source('3', 3), stateRevision: 6 }])])
    const load = vi.spyOn(api, 'pulse').mockImplementation(async () => latest)
    const visit = vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const markRead = vi.fn().mockResolvedValue(true)
    const notify = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    const render = (refreshKey: number) => <TopicsLibrary onCollectionChange={() => {}} refreshKey={refreshKey} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={notify} />
    await act(async () => root!.render(render(0)))
    expect(container.textContent).toContain('2 unread')
    await act(async () => button(container, 'Collection one').click())
    expect(visit).not.toHaveBeenCalled()
    expect(markRead).not.toHaveBeenCalled()
    latest = payload([collection('one', [source('4', 4), source('1', 1), source('2', 2, true), source('3', 3)])], 'two')
    await act(async () => root!.render(render(1)))
    expect(container.textContent).toContain('Show updates')
    expect(container.textContent).not.toContain('Feature report 4')
    await act(async () => button(container, 'Close collection').click())
    expect(visit).toHaveBeenCalledWith('one', 3)
    expect(markRead).not.toHaveBeenCalled()
    expect(container.textContent).toContain('2 unread')
    latest = payload([collection('one', [source('4', 4), ...latest.collections[0].sources.slice(1).map(s => ({ ...s, isNew: false }))])], 'two')
    await act(async () => button(container, 'Show updates').click())
    expect(container.textContent).toContain('Feature report 4')
    expect(container.querySelectorAll('.pulse-source.is-new')).toHaveLength(1)
    expect(load).toHaveBeenCalledTimes(3)
    expect(container.querySelector('.pulse-title')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => button(container, 'Collection one').click())
    await act(async () => button(container, 'Mark 3 unread as read').click())
    expect(markRead).toHaveBeenCalledWith(['4', '1', '3'])
    expect(container.textContent).toContain('0 unread')
  })

  it('acknowledges an expanded collection on leaving, without marking articles read', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([collection('one', [source('1', 1), source('2', 2), source('3', 3)])]))
    const visit = vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const markRead = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={() => {}} />))
    await act(async () => button(container, 'Collection one').click())
    await act(async () => root!.unmount()); root = undefined
    expect(visit).toHaveBeenCalledWith('one', 3)
    expect(markRead).not.toHaveBeenCalled()
  })

  it('shows unread collections across active and quiet, then removes completed collections', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([
      collection('active', [source('1', 1), source('2', 2, true), source('a', 1, true)]),
      { ...collection('quiet', [source('3', 3, true), { ...source('4', 4), stateRevision: 7 }, source('q', 3, true)]), active: false, quiet: true },
      collection('finished', [source('5', 5, true)]),
    ]))
    const visit = vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const markRead = vi.fn().mockResolvedValue(true)
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={() => {}} />))
    const toolbar = container.querySelector('.pulse-toolbar') as HTMLElement
    await act(async () => button(toolbar, 'Unread 2').click())
    expect([...container.querySelectorAll('h2')].map(node => node.textContent)).toEqual(['Collection active', 'Collection quiet'])
    expect(container.textContent).toContain('Feature report 4')
    expect(container.textContent).not.toContain('Feature report 3')
    const quiet = [...container.querySelectorAll<HTMLElement>('.pulse-card')][1]
    expect(quiet.querySelector('.pulse-earlier')?.textContent).toBe('View collection')
    await act(async () => button(quiet, 'Collection quiet').click())
    expect(button(quiet, 'Unread 1').getAttribute('aria-pressed')).toBe('true')
    await act(async () => button(quiet, 'Mark 1 unread as read').click())
    expect(markRead).toHaveBeenCalledWith(['4'], { '4': 7 })
    expect(visit).toHaveBeenCalledWith('quiet', 4)
    expect(container.textContent).not.toContain('Collection quiet')
    expect(button(toolbar, 'Unread 1')).toBeDefined()
    await act(async () => button(container, 'Collection active').click())
    await act(async () => button(container, 'Mark 1 unread as read').click())
    expect(container.textContent).toContain('No unread collections')
    await act(async () => button(toolbar, 'Quiet 1').click())
    expect(container.textContent).toContain('Collection quiet')
    expect(container.textContent).toContain('0 unread')
  })

  it('marks hidden rows from a collapsed collection and moves focus when it leaves Unread', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const lead = collection('lead', [source('1', 1), source('2', 2), source('3', 3), source('4', 4)])
    const items = [{ ...source('older', 1), stateRevision: 3 }, source('read', 2, true), { ...source('latest', 3), stateRevision: 8 }]
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([lead, collection('compact', items)]))
    const markRead = vi.fn().mockResolvedValue(true)
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={() => {}} />))
    await act(async () => button(container, 'Unread 2').click())
    const compact = [...container.querySelectorAll<HTMLElement>('.pulse-card')][1]
    const mark = button(compact, 'Mark read')
    expect(mark.getAttribute('aria-label')).toBe('Mark all 2 unread articles in Collection compact as read')
    expect(mark.previousElementSibling?.textContent).toBe('1 earlier article')
    expect(compact.querySelectorAll('.pulse-source')).toHaveLength(1)
    await act(async () => { mark.focus(); mark.click() })
    expect(markRead).toHaveBeenCalledExactlyOnceWith(['older', 'latest'], { older: 3, latest: 8 })
    expect(compact.isConnected).toBe(false)
    expect(document.activeElement).toBe(container.querySelector('h1'))
    expect(button(container, 'Unread 1')).toBeDefined()
  })

  it('confirms and deduplicates only unread articles in the active section', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const shared = { ...source('shared', 1), stateRevision: 2 }
    const second = { ...source('second', 2), stateRevision: 5 }
    const read = [source('a', 3, true), source('b', 4, true), source('c', 5, true)]
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([
      collection('one', [shared, ...read.slice(1)]), collection('two', [shared, second, read[0]]), collection('finished', read),
      { ...collection('quiet', [source('quiet', 2), ...read.slice(1)]), active: false, quiet: true }, collection('small', [source('small', 1)]),
    ]))
    const markRead = vi.fn().mockResolvedValue(true)
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={() => {}} />))
    const toolbar = container.querySelector<HTMLElement>('.pulse-toolbar')!
    const opener = button(toolbar, 'Mark all read')
    await act(async () => opener.click())
    const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog().textContent).toContain('Mark 2 articles in 2 collections as read?')
    expect(markRead).not.toHaveBeenCalled()
    await act(async () => button(dialog(), 'Cancel').click())
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(markRead).not.toHaveBeenCalled()
    await act(async () => opener.click())
    await act(async () => { const confirm = button(dialog(), 'Mark all read'); confirm.focus(); confirm.click() })
    expect(markRead).toHaveBeenCalledExactlyOnceWith(['shared', 'second'], { shared: 2, second: 5 })
    expect(dialog()).toBeNull()
    expect(opener.isConnected).toBe(false)
    expect(container.querySelector('.pulse-mark-read')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('h1'))
    await act(async () => button(toolbar, 'Quiet 1').click())
    expect(button(toolbar, 'Mark all read')).toBeDefined()
  })

  it('switches article filters in the expanded thread without changing read state', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([collection('mixed', [source('1', 1), source('2', 2, true), source('3', 3)])]))
    const visit = vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const markRead = vi.fn()
    const onOpenEntry = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={onOpenEntry} onMarkRead={markRead} notify={() => {}} />))
    const card = container.querySelector('.pulse-card') as HTMLElement
    await act(async () => button(card, 'Collection mixed').click())
    const titles = () => [...card.querySelectorAll('.pulse-story-title')].map(node => node.textContent)
    await act(async () => button(card, 'Read 1').click())
    expect(titles()).toEqual(['Feature report 2'])
    await act(async () => button(card, 'Unread 2').click())
    expect(titles()).toEqual(['Feature report 1', 'Feature report 3'])
    await act(async () => button(card, 'All 3').click())
    expect(titles()).toHaveLength(3)
    expect(visit).not.toHaveBeenCalled()
    expect(markRead).not.toHaveBeenCalled()
    expect(onOpenEntry).not.toHaveBeenCalled()
  })
})

describe('Pulse collection size and catch-up', () => {
  it('shows the thread excerpt and collection options when AI is disabled', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const item = collection('disabled', [{ ...source('1', 1), development: 'The trial adds a second route.' }, source('2', 2), source('3', 3)])
    const initial = payload([{ ...item, catchUp: { latest: [{ text: 'A second route has opened.', entryIds: ['1'] }], background: [] } }])
    vi.spyOn(api, 'pulse').mockResolvedValue({ ...initial, status: { ...initial.status, enabled: false } })
    vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} initialCollection="disabled" feedIcons={new Map()} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={vi.fn()} notify={() => {}} />))
    expect(container.querySelector('.pulse-summaries')).toBeNull()
    expect(container.querySelector('.pulse-thread q')?.textContent).toBe('The trial adds a second route.')
    const menu = container.querySelector<HTMLDetailsElement>('.pulse-article-tabs .pulse-collection-options')!
    expect(menu.querySelector('summary')?.getAttribute('aria-label')).toBe('Collection options')
    await act(async () => { menu.open = true; menu.dispatchEvent(new Event('toggle')) })
    expect(button(container, 'Merge collection').closest('.pulse-options-menu')).not.toBeNull()
    expect(button(container, 'Hide collection').closest('.pulse-options-menu')).not.toBeNull()
    expect(button(container, 'Remove article').closest('.pulse-options-menu')).not.toBeNull()
  })

  it('keeps singletons out of the main overview but available in Small', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([collection('small', [source('solo', 1)]), collection('full', [source('1', 2), source('2', 3, true), source('3', 4, true)])]))
    vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={vi.fn()} notify={() => {}} />))
    expect(container.textContent).not.toContain('Collection small')
    expect(container.querySelector('#pulse-full-count')?.textContent).toBe('3 articles, 1 unread')
    await act(async () => button(container.querySelector('.pulse-toolbar') as HTMLElement, 'Small 1').click())
    expect(container.textContent).toContain('Collection small')
    expect(container.textContent).not.toContain('Collection full')
    expect(container.querySelector('#pulse-small-count')?.textContent).toBe('1 article, 1 unread')
    expect(container.querySelector('.pulse-earlier')?.textContent).toBe('View collection')
  })

  it('shows the first 25 active collections and picks the lead from the visible cards', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const members = [source('one', 1), source('two', 2), source('three', 3)]
    const ranked = Array.from({ length: 27 }, (_, i) => collection(String(i).padStart(2, '0'), members))
    ranked[26] = collection('26', [...members, source('four', 4)])
    vi.spyOn(api, 'pulse').mockResolvedValue(payload(ranked))
    vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    const render = (initialCollection?: string) => act(async () => root!.render(<TopicsLibrary initialCollection={initialCollection}
      onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={vi.fn()} notify={() => {}} />))
    await render()
    expect(button(container, 'Active 27')).toBeDefined()
    expect([...container.querySelectorAll('.pulse-title')].map(node => node.textContent)).toEqual(ranked.slice(0, 25).map(item => item.headline))
    await act(async () => button(container, 'Mark all read').click())
    const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog().textContent).toContain('Mark 3 articles in 25 collections as read?')
    await act(async () => button(dialog(), 'Cancel').click())
    await act(async () => { button(container, 'Show 2 more active collections').click(); await new Promise(requestAnimationFrame) })
    expect(container.querySelectorAll('.pulse-card')).toHaveLength(27)
    expect(document.activeElement?.textContent).toBe('Collection 25')
    expect(container.querySelector('.pulse-lead .pulse-title')?.textContent).toBe('Collection 26')
    await act(async () => button(container, 'Unread 27').click())
    await act(async () => button(container, 'Active 27').click())
    expect(container.querySelectorAll('.pulse-card')).toHaveLength(25)
    await render('25')
    expect(button(container, 'Collection 25').getAttribute('aria-expanded')).toBe('true')
  })

  it('files a single-publication burst in Small and opens archived collections from Quiet or a link', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const burst = { ...collection('burst', [source('1', 1), source('3', 3), source('5', 5)]), active: false, quiet: true }
    const archived = { ...burst, id: 'archive', headline: 'Archived thread', archived: true, quiet: false }
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([burst, archived]))
    vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const container = document.createElement('div'); root = createRoot(container)
    const render = (initialCollection?: string) => act(async () => root!.render(<TopicsLibrary initialCollection={initialCollection}
      onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={vi.fn()} notify={() => {}} />))
    await render()
    for (const label of ['Active 0', 'Unread 0', 'Quiet 0', 'Small 1']) expect(button(container, label)).toBeDefined()
    await act(async () => button(container, 'Small 1').click())
    expect(container.querySelector('.pulse-title')?.textContent).toBe('Collection burst')
    await act(async () => button(container, 'Quiet 0').click())
    expect(container.querySelectorAll('.pulse-card')).toHaveLength(0)
    await act(async () => button(container, '1 archived collection').click())
    expect(button(container, 'Archived thread').getAttribute('aria-expanded')).toBe('false')
    await act(async () => button(container, 'Active 0').click())
    await render('archive')
    expect(button(container, 'Archived thread').getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.pulse-lead')).toBeNull()
  })

  it('updates thread times even while the background request is pending', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-16T10:20:00Z'))
      const item = collection('clock', [source('1', 1), source('2', 2), source('3', 3)])
      vi.spyOn(api, 'pulse').mockResolvedValueOnce(payload([item])).mockImplementation(() => new Promise(() => {}))
      const container = document.createElement('div'); root = createRoot(container)
      await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={vi.fn()} notify={() => {}} />))
      const time = container.querySelector('.pulse-story time')!
      expect(time.textContent).toBe('20 min')
      await act(async () => vi.advanceTimersByTime(60_000))
      expect(time.textContent).toBe('21 min')
    } finally { vi.useRealTimers() }
  })

  it('promotes one collection by new count, update time and ID, and tries the next thumbnail on error', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const sources = [source('1', 1), source('2', 2), source('3', 3)]
    const lead = collection('a', sources.map((item, index) => ({ ...item, thumbnailUrl: index ? `/${index}.jpg` : 'data:text/plain,invalid' })))
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([
      { ...collection('fewer', sources.map(item => ({ ...item, isNew: false }))), updatedAt: '2026-09-18T10:00:00Z' },
      { ...collection('older', sources), updatedAt: '2026-09-15T10:00:00Z' }, collection('b', sources), lead,
    ]))
    const container = document.createElement('div'); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={vi.fn()} notify={() => {}} />))
    expect([...container.querySelectorAll('.pulse-title')].map(item => item.textContent)).toEqual(['Collection a', 'Collection fewer', 'Collection older', 'Collection b'])
    expect(container.querySelectorAll('.pulse-lead')).toHaveLength(1)
    const image = () => container.querySelector<HTMLImageElement>('.pulse-lead-image')
    expect(image()?.src).toBe('https://example.test/1.jpg')
    await act(async () => { image()!.dispatchEvent(new Event('error')) })
    expect(image()?.src).toBe('https://example.test/2.jpg')
    Object.defineProperties(image()!, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } })
    await act(async () => { image()!.dispatchEvent(new Event('load')) })
    expect(image()).toBeNull()
    expect(container.querySelector('.pulse-lead h2')?.textContent).toBe('Collection a')
  })

  it('previews the newest three articles in the lead and one in each other collection', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const sources = [2, 1, 4, 3].map(day => ({ ...source(String(day), day, day === 3), publishedAt: `2026-09-0${day}T12:00:00Z`,
      isNew: day !== 3, development: `Excerpt ${day}` }))
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([collection('a', sources), collection('b', sources)]))
    const open = vi.fn()
    const container = document.createElement('div'); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} refreshKey={0} onBack={() => {}} onOpenEntry={open} onMarkRead={vi.fn()} notify={() => {}} />))
    const [lead, compact] = container.querySelectorAll('.pulse-card')
    expect(Array.from(lead.querySelectorAll('.pulse-story-title'), item => item.textContent)).toEqual(['Feature report 4', 'Feature report 3', 'Feature report 2'])
    expect(lead.querySelector('.pulse-earlier')?.textContent).toBe('1 earlier article')
    expect(compact.querySelectorAll('.pulse-source')).toHaveLength(1)
    expect(compact.querySelector('.pulse-earlier')?.textContent).toBe('3 earlier articles')
    expect(lead.querySelector('.is-new q')?.textContent).toBe('Excerpt 4')
    expect(lead.querySelector('.is-read q')).toBeNull()
    await act(async () => lead.querySelector<HTMLButtonElement>('.pulse-story')!.click())
    expect(open).toHaveBeenCalledWith('4', expect.objectContaining({ ids: ['4', '3', '2', '1'] }))
  })

  it('opens a digest link to its collection and shows supported excerpts and clear filtered counts', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const items = [{ ...source('1', 1), development: 'The new release adds offline maps.' }, source('2', 2, true), source('3', 3, true)]
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([{ ...collection('linked', items), active: false, quiet: true }]))
    vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const open = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary onCollectionChange={() => {}} initialCollection="linked" refreshKey={0} onBack={() => {}} onOpenEntry={open} onMarkRead={vi.fn()} notify={() => {}} />))
    expect(container.querySelector('.pulse-title')?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.pulse-story q')?.textContent).toBe('The new release adds offline maps.')
    await act(async () => button(container.querySelector('.pulse-card') as HTMLElement, 'Unread 1').click())
    expect(container.querySelector('.pulse-filter-count')?.textContent).toContain('1 unread of 3 articles')
    await act(async () => button(container, 'Show all').click())
    expect(container.querySelectorAll('.pulse-source')).toHaveLength(3)
  })
})
