// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopicsLibrary } from '../src/client/components/TopicsLibrary'
import { api } from '../src/client/api'
import { refreshPulseState, acknowledgePulseVisit } from '../src/client/pulse'
import type { PulseCollection, PulsePayload, PulseSource } from '../src/shared/pulse'

const source = (id: string, sequence: number, read = false): PulseSource => ({ id, sequence, read, isNew: true, addedAt: '2026-09-16T10:00:00Z',
  feedId: 'feed/one', publication: 'Daily Gazette', domain: 'example.test', title: `Feature report ${id}`, url: `https://example.test/${id}`,
  author: '', publishedAt: '2026-09-16T10:00:00Z', timestamp: 1, thumbnailUrl: '' })
const collection = (id: string, sources: PulseSource[]): PulseCollection => ({ id, headline: `Collection ${id}`, scope: 'Reporting on a developing release.',
  createdAt: '2026-09-16T10:00:00Z', updatedAt: '2026-09-16T10:00:00Z', revision: Math.max(...sources.map(s => s.sequence)), seenThrough: 0,
  newCount: sources.filter(s => s.isNew).length, unreadCount: sources.filter(s => !s.read).length, publicationCount: 1, articleCount: sources.length, quiet: false, sources })
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
    const incoming = payload([collection('two', [source('3', 3), source('2', 2)]), collection('one', [{ ...source('1', 1, true), isNew: false }])], 'two')
    const refreshed = refreshPulseState(payload([one, two]), incoming, 'one')
    expect(refreshed.collections.map(item => item.id)).toEqual(['one', 'two'])
    expect(refreshed.collections[1].articleCount).toBe(1)
    expect(refreshed.collections[0]).toMatchObject({ unreadCount: 0, newCount: 1 })
    expect(acknowledgePulseVisit(incoming.collections[0], 2)).toMatchObject({ newCount: 1, unreadCount: 2 })
  })

  it('keeps a collection snapshot open, acknowledges only its displayed revision and loads changes on request', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    let latest = payload([collection('one', [source('1', 1), source('2', 2, true), source('3', 3)])])
    const load = vi.spyOn(api, 'pulse').mockImplementation(async () => latest)
    const visit = vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const markRead = vi.fn().mockResolvedValue(true)
    const notify = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    const render = (refreshKey: number) => <TopicsLibrary feedIcons={new Map()} refreshKey={refreshKey} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={notify} />
    await act(async () => root!.render(render(0)))
    expect(container.textContent).toContain('2 unread')
    await act(async () => button(container, 'View 3 new articles').click())
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
    expect(container.textContent).toContain('View 1 new article')
    expect(load).toHaveBeenCalledTimes(3)
    expect(button(container, 'Mark 3 unread as read').closest('.pulse-card-top')).not.toBeNull()
    expect(container.querySelector('.pulse-title')?.getAttribute('aria-expanded')).toBe('false')
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
    await act(async () => root!.render(<TopicsLibrary feedIcons={new Map()} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={() => {}} />))
    await act(async () => button(container, 'View collection').click())
    await act(async () => root!.unmount()); root = undefined
    expect(visit).toHaveBeenCalledWith('one', 3)
    expect(markRead).not.toHaveBeenCalled()
  })

  it('shows unread collections across active and quiet, then removes completed collections', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([
      collection('active', [source('1', 1), source('2', 2, true), source('a', 1, true)]),
      { ...collection('quiet', [source('3', 3, true), source('4', 4), source('q', 3, true)]), quiet: true },
      collection('finished', [source('5', 5, true)]),
    ]))
    const visit = vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const markRead = vi.fn().mockResolvedValue(true)
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary feedIcons={new Map()} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={markRead} notify={() => {}} />))
    const toolbar = container.querySelector('.pulse-toolbar') as HTMLElement
    await act(async () => button(toolbar, 'Unread 2').click())
    expect([...container.querySelectorAll('h2')].map(node => node.textContent)).toEqual(['Collection active', 'Collection quiet'])
    expect(container.textContent).toContain('Feature report 4')
    expect(container.textContent).not.toContain('Feature report 3')
    const quiet = [...container.querySelectorAll<HTMLElement>('.pulse-card')][1]
    await act(async () => button(quiet, 'View collection').click())
    expect(button(quiet, 'Unread 1').getAttribute('aria-pressed')).toBe('true')
    await act(async () => button(quiet, 'Mark 1 unread as read').click())
    expect(markRead).toHaveBeenCalledWith(['4'])
    expect(visit).toHaveBeenCalledWith('quiet', 4)
    expect(container.textContent).not.toContain('Collection quiet')
    expect(button(toolbar, 'Unread 1')).toBeDefined()
    await act(async () => button(container, 'Mark 1 unread as read').click())
    expect(container.textContent).toContain('No unread collections')
    await act(async () => button(toolbar, 'Quiet 1').click())
    expect(container.textContent).toContain('Collection quiet')
    expect(container.textContent).toContain('0 unread')
  })

  it('opens unread or read articles directly from a card and switches without changing read state', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([collection('mixed', [source('1', 1), source('2', 2, true), source('3', 3)])]))
    const visit = vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const markRead = vi.fn()
    const onOpenEntry = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary feedIcons={new Map()} refreshKey={0} onBack={() => {}} onOpenEntry={onOpenEntry} onMarkRead={markRead} notify={() => {}} />))
    const card = container.querySelector('.pulse-card') as HTMLElement
    const titles = () => [...card.querySelectorAll('.topic-source-copy > span:last-child')].map(node => node.textContent)
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
  it('keeps singletons out of the main overview but available in Small', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([collection('small', [source('solo', 1)]), collection('full', [source('1', 2), source('2', 3, true), source('3', 4, true)])]))
    vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary feedIcons={new Map()} refreshKey={0} onBack={() => {}} onOpenEntry={() => {}} onMarkRead={vi.fn()} notify={() => {}} />))
    expect(container.textContent).not.toContain('Collection small')
    expect(container.textContent).toContain('1 unread of 3 articles')
    await act(async () => button(container.querySelector('.pulse-toolbar') as HTMLElement, 'Small 1').click())
    expect(container.textContent).toContain('Collection small')
    expect(container.textContent).not.toContain('Collection full')
  })

  it('opens a digest link to its collection and shows supported excerpts and clear filtered counts', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const items = [{ ...source('1', 1), development: 'The new release adds offline maps.' }, source('2', 2, true), source('3', 3, true)]
    vi.spyOn(api, 'pulse').mockResolvedValue(payload([{ ...collection('linked', items), quiet: true }]))
    vi.spyOn(api, 'visitPulse').mockResolvedValue({ ok: true })
    const open = vi.fn()
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<TopicsLibrary initialCollection="linked" feedIcons={new Map()} refreshKey={0} onBack={() => {}} onOpenEntry={open} onMarkRead={vi.fn()} notify={() => {}} />))
    expect(container.querySelector('.pulse-title')?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.pulse-catchup blockquote')?.textContent).toBe('The new release adds offline maps.')
    await act(async () => button(container.querySelector('.pulse-card') as HTMLElement, 'Unread 1').click())
    expect(container.querySelector('.pulse-filter-count')?.textContent).toContain('1 unread of 3 articles')
    await act(async () => button(container, 'Show all').click())
    expect(container.querySelectorAll('.pulse-source')).toHaveLength(3)
  })
})
