// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/client/App'
import { api } from '../src/client/api'
import { offlineArticles } from '../src/client/offline'
import type { Entry, EntryPage, Feed } from '../src/client/types'

vi.mock('../src/client/api', () => ({ api: {
  recentReading: vi.fn(), navigation: vi.fn(), status: vi.fn(), entries: vi.fn(), entry: vi.fn(), editState: vi.fn(), markStreamRead: vi.fn(),
  markRelativeRead: vi.fn(), undo: vi.fn(),
  setStreamOrder: vi.fn(), removeFeed: vi.fn(), fullText: vi.fn(), previewRead: vi.fn(), confirmRead: vi.fn(),
} }))

vi.mock('../src/client/offline', () => ({ offlineArticles: vi.fn(), saveOffline: vi.fn(), removeOffline: vi.fn() }))

const post = (id: string): Entry => ({
  id, feedId: id, feedTitle: `Instagram ${id}`, feedUrl: 'https://example.com/feed',
  title: `Post ${id}`, author: 'Photographer', url: `https://example.com/${id}`,
  contentHtml: '<p>A photo and a video.</p><img src="/photo.jpg"><video controls src="/video.mp4"></video><a href="https://example.com">Last link</a>',
  excerpt: '', publishedAt: '2026-09-07T12:00:00Z', timestamp: 1, read: true, starred: false,
  readingMinutes: 1, thumbnailUrl: '', kind: 'instagram',
})
let root: Root
let container: HTMLDivElement
let initialPage: EntryPage

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width'), addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  // Simulate a browser that is not delivering animation frames. Navigation
  // must not wait for these to arrive, including when View Transitions exists.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: vi.fn(() => { throw new Error('Must not freeze the document') }) })
  HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top || 0 })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=a&pane=article&unread=0')
  initialPage = { items: [post('a'), post('b')], continuation: '' }
  vi.mocked(api.entries).mockImplementation(async target => target.id === 'instagram' ? initialPage : { items: [post('c')], continuation: '' })
  vi.mocked(api.navigation).mockResolvedValue({ unread: 0, starred: 0, uncategorized: [], folders: [
    { id: 'instagram', title: 'Instagram', unread: 0, feeds: [] },
    { id: 'tech', title: 'Tech', unread: 0, feeds: [] },
  ] })
  vi.mocked(api.status).mockResolvedValue({ readwiseConfigured: false, kirbyConfigured: false, briefingConfigured: false, sync: { lastCompletedAt: null } })
  vi.mocked(api.entry).mockResolvedValue({ entry: post('a') })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  await act(async () => { root.render(<App />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

async function edge(target = 'video', cancel = false, release = true) {
  const scroll = container.querySelector<HTMLElement>('.article-scroll')!
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 892 }, clientHeight: { configurable: true, value: 700 } })
  await act(async () => { scroll.scrollTop = 180; scroll.dispatchEvent(new Event('scroll', { bubbles: true })) })
  expect(container.querySelector('.article-edge-zone.next')?.textContent).toContain('Release to open')
  if (release) await act(async () => {
    scroll.querySelector(target)!.dispatchEvent(new Event(cancel ? 'touchcancel' : 'touchend', { bubbles: true }))
  })
}

describe('mobile reader switching', () => {
  it.each(['j', 'k'])('keeps %s navigation working after marking an unread folder read', async key => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=a&pane=article&unread=1')
    initialPage.continuation = 'old-page'
    const folders = [
      { id: 'before', title: 'Before', unread: 1, feeds: [] },
      { id: 'instagram', title: 'Instagram', unread: 2, feeds: [] },
      { id: 'empty', title: 'Empty', unread: 0, feeds: [] },
      { id: 'tech', title: 'Tech', unread: 1, feeds: [] },
    ]
    vi.mocked(api.navigation).mockResolvedValue({ unread: 4, starred: 0, uncategorized: [], folders })
    vi.mocked(api.markStreamRead).mockImplementation(async () => {
      folders[1].unread = 0
      return { ok: true, count: 2 }
    })
    await mount()
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'A', shiftKey: true })) })
    expect(container.querySelectorAll('.story-row')).toHaveLength(0)
    expect(container.querySelector('.load-more-marker')?.textContent).toBe('End')
    vi.mocked(api.entries).mockClear()
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })) })
    expect(location.search).toContain(`id=${key === 'j' ? 'tech' : 'before'}`)
    expect(location.search).toContain('entry=c')
    expect(api.entries).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.entries).mock.calls[0][3]).toBe('')
  })

  it('reveals the end marker before J crosses into the next folder', async () => {
    await mount()
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear()
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'j' })) })
    const marker = container.querySelector('.load-more-marker')!
    expect(location.search).toContain('entry=b')
    expect(marker.textContent).toBe('End')
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(marker)
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'j' })) })
    expect(location.search).toContain('id=tech')
    expect(container.querySelector('.stream-title h1')?.textContent).toBe('Tech')
    expect(container.querySelector('.stream-boundary')?.textContent).toBe('Beginning')
  })

  it('reveals the beginning marker when K reaches the first article', async () => {
    history.replaceState(null, '', '/?kind=category&id=tech&title=Tech&entry=b&pane=article&unread=0')
    vi.mocked(api.entries).mockResolvedValue(initialPage)
    vi.mocked(api.entry).mockResolvedValue({ entry: post('b') })
    await mount()
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear()
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k' })) })
    expect(location.search).toContain('entry=a')
    const marker = container.querySelector('.stream-boundary')!
    expect(marker.textContent).toBe('Beginning')
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(marker)
  })

  it('does not call a page boundary the end of the stream', async () => {
    initialPage.continuation = 'next-page'
    await mount()
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear()
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'j' })) })
    expect(container.querySelector('.load-more-marker')?.textContent).not.toContain('End')
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(container.querySelectorAll('.story-row')[1])
  })

  it('saves the folder order and uses the reordered list for article navigation', async () => {
    initialPage.order = 'newest'
    await mount()
    vi.mocked(api.setStreamOrder).mockImplementation(async (_stream, order) => {
      initialPage = { items: [post('b'), post('a')], continuation: '', order }
      return { ok: true, order }
    })
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Article order"]')!
    expect(select.value).toBe('newest')
    await act(async () => { select.value = 'oldest'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(api.setStreamOrder).toHaveBeenCalledWith(expect.objectContaining({ kind: 'category', id: 'instagram' }), 'oldest')
    expect(select.value).toBe('oldest')
    expect([...container.querySelectorAll('.story-row h2')].map(n => n.textContent)).toEqual(['Post b', 'Post a'])
    await act(async () => { container.querySelectorAll<HTMLElement>('.story-row')[1].click() })
    // Previous now means the older article immediately before the open one.
    const scroll = container.querySelector<HTMLElement>('.article-scroll')!
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 892 }, clientHeight: { configurable: true, value: 700 } })
    await act(async () => { scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await act(async () => { scroll.querySelector('video')!.dispatchEvent(new Event('touchend', { bubbles: true })) })
    expect(location.search).toContain('entry=b')
    expect(api.editState).not.toHaveBeenCalled()
  })

  it('unsubscribes from an article source in a mixed folder after confirming, keeping the other feed and folder', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=3&pane=list&unread=0')
    initialPage = { items: ['1', '2', '3'].map(id => ({ ...post(id), feedId: id === '3' ? 'feed/keep' : 'feed/remove', feedTitle: id === '3' ? 'Keep this feed' : 'Unwanted feed' })), continuation: '' }
    vi.mocked(api.entry).mockResolvedValue({ entry: initialPage.items[2] })
    vi.mocked(api.removeFeed).mockResolvedValue({ ok: true })
    await mount()
    const rows = [...container.querySelectorAll('.story-row')]
    await act(async () => { rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 })) })
    const remove = container.querySelector<HTMLButtonElement>('.entry-unsubscribe')!
    expect(remove.textContent).toContain('Unsubscribe from feed')
    expect(remove.textContent).toContain('Unwanted feed')
    await act(async () => { remove.click() })
    expect(api.removeFeed).not.toHaveBeenCalled()
    expect(remove.textContent).toContain('Confirm unsubscribe')
    await act(async () => { remove.click() })
    expect(api.removeFeed).toHaveBeenCalledWith('feed/remove')
    expect([...container.querySelectorAll('.story-row h2')].map(node => node.textContent)).toEqual(['Post 3'])
    expect(location.search).toContain('id=instagram')
    expect(location.search).toContain('entry=3')
    expect(container.textContent).toContain('Unwanted feed unsubscribed')
    expect(api.editState).not.toHaveBeenCalled()
  })

  it('resets article unsubscribe confirmation when the context target changes and preserves items on failure', async () => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=1&pane=list&unread=0')
    initialPage = { items: ['1', '2'].map(id => ({ ...post(id), feedId: `feed/${id}`, feedTitle: `Feed ${id}` })), continuation: '' }
    vi.mocked(api.entry).mockResolvedValue({ entry: initialPage.items[0] })
    vi.mocked(api.removeFeed).mockRejectedValue(new Error('Could not unsubscribe'))
    await mount()
    const rows = [...container.querySelectorAll('.story-row')]
    await act(async () => { rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    await act(async () => { container.querySelector<HTMLButtonElement>('.entry-unsubscribe')!.click() })
    await act(async () => { rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    expect(container.querySelector('.entry-unsubscribe')!.textContent).toContain('Unsubscribe from feed')
    expect(container.querySelector('.entry-unsubscribe')!.textContent).toContain('Feed 2')
    await act(async () => { container.querySelector<HTMLButtonElement>('.entry-unsubscribe')!.click() })
    expect(api.removeFeed).not.toHaveBeenCalled()
    await act(async () => { container.querySelector<HTMLButtonElement>('.entry-unsubscribe')!.click() })
    expect(api.removeFeed).toHaveBeenCalledWith('feed/2')
    expect(container.querySelectorAll('.story-row')).toHaveLength(2)
    expect(container.textContent).toContain('Could not unsubscribe')
  })

  it('loads the saved server order and leaves it unchanged when saving fails', async () => {
    initialPage.order = 'oldest'
    await mount()
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Article order"]')!
    expect(select.value).toBe('oldest')
    vi.mocked(api.setStreamOrder).mockRejectedValue(new Error('Could not save order'))
    await act(async () => { select.value = 'newest'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(select.value).toBe('oldest')
    expect(container.textContent).toContain('Could not save order')
  })

  it.each(['above', 'below'] as const)('marks %s without unmounting the list, and preserves it on undo', async direction => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=3&pane=list&unread=1')
    initialPage = { items: ['1', '2', '3', '4', '5'].map(id => ({ ...post(id), read: id === '3' })), continuation: '' }
    const original = initialPage
    vi.mocked(api.entry).mockResolvedValue({ entry: initialPage.items[2] })
    await mount()
    vi.mocked(api.entry).mockClear()
    const list = container.querySelector<HTMLElement>('.story-list')!
    list.scrollTop = 200
    const rows = [...list.querySelectorAll('.story-row')]
    // Model a surviving visible row at a stable viewport position.
    rows.forEach(node => vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 110 } as DOMRect))
    let resolve!: (value: { ok: boolean; count: number; ids: string[]; undoToken: string }) => void
    vi.mocked(api.markRelativeRead).mockImplementation(() => new Promise(r => { resolve = r }))
    await act(async () => { rows[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    const button = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.includes(`Mark all ${direction}`))!
    await act(async () => { button.click() })
    expect(list.querySelectorAll('.story-row')).toHaveLength(5)
    expect(vi.mocked(api.entries)).toHaveBeenCalledTimes(1)
    initialPage = { items: original.items.filter(e => direction === 'above' ? ['4', '5'].includes(e.id) : ['1', '2'].includes(e.id)), continuation: '' }
    const survivor = direction === 'above' ? rows[3] : rows[0]
    await act(async () => { resolve({ ok: true, count: 2, ids: direction === 'above' ? ['1', '2'] : ['4', '5'], undoToken: 'undo-test' }) })
    expect(list.contains(survivor)).toBe(true)
    expect(list.querySelectorAll('.story-row')).toHaveLength(3)
    expect([...list.querySelectorAll('.story-row h2')].map(node => node.textContent)).toEqual(direction === 'above' ? ['Post 3', 'Post 4', 'Post 5'] : ['Post 1', 'Post 2', 'Post 3'])
    expect(api.entry).not.toHaveBeenCalled()
    expect(list.scrollTop).toBe(200)
    expect(api.markRelativeRead).toHaveBeenCalledWith(expect.objectContaining({ id: 'instagram' }), '3', direction, true, '', 'newest', { after: '', before: '' })
    initialPage = original
    vi.mocked(api.undo).mockResolvedValue({ ok: true, count: 2 })
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Undo')!.click() })
    expect(list.contains(survivor)).toBe(true)
    expect(list.querySelectorAll('.story-row')).toHaveLength(5)
    expect(list.scrollTop).toBe(200)
  })

  it('does not reload or move the list when nothing above needs marking', async () => {
    await mount()
    const list = container.querySelector<HTMLElement>('.story-list')!
    list.scrollTop = 140
    const row = list.querySelector('.story-row')!
    vi.mocked(api.markRelativeRead).mockResolvedValue({ ok: true, count: 0, ids: [] })
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.includes('Mark all above'))!.click() })
    expect(api.entries).toHaveBeenCalledTimes(1)
    expect(list.contains(row)).toBe(true)
    expect(list.scrollTop).toBe(140)
  })

  it('switches from a video or final link without using document transitions or waiting for frames', async () => {
    await mount()
    const video = container.querySelector('video')
    await edge('video', false, false)
    expect(container.querySelector('video')).toBe(video)
    await act(async () => { video!.dispatchEvent(new Event('touchend', { bubbles: true })) })
    expect(location.search).toContain('entry=b')
    expect(container.querySelector('.article-transition-next-in')).not.toBeNull()
    expect(document.startViewTransition).not.toHaveBeenCalled()
    await edge('a')
    expect(location.search).toContain('entry=c')
    expect(vi.mocked(api.entries).mock.calls.filter(([target]) => target.id === 'tech')).toHaveLength(1)
  })

  it('does not switch after touch cancellation', async () => {
    await mount()
    await edge('video', true)
    expect(location.search).toContain('entry=a')
  })

  it('updates edge progress without rerendering the main app or replacing media', async () => {
    await mount()
    await edge('video', false, false)
    const video = container.querySelector('video')
    const scroll = container.querySelector<HTMLElement>('.article-scroll')!
    // The scroll handler checks the mobile breakpoint once. App rendering
    // would make extra matchMedia calls for theme and layout state.
    vi.mocked(window.matchMedia).mockClear()
    for (let top = 120; top < 160; top += 5) {
      await act(async () => { scroll.scrollTop = top; scroll.dispatchEvent(new Event('scroll', { bubbles: true })) })
    }
    expect(window.matchMedia).toHaveBeenCalledTimes(8)
    expect(container.querySelector('video')).toBe(video)
  })

  it('times out a paginated load, ignores its late response, and can retry', async () => {
    initialPage = { items: [post('a')], continuation: 'page2' }
    await mount()
    let resolve!: (page: EntryPage) => void
    vi.mocked(api.entries).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await edge()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(container.textContent).toContain('too long')
    expect(container.querySelector('.article-navigation-status')).toBeNull()
    await act(async () => { resolve({ items: [post('late')], continuation: '' }) })
    expect(location.search).toContain('entry=a')
    expect(container.textContent).not.toContain('Post late')
    vi.mocked(api.entries).mockResolvedValueOnce({ items: [post('b')], continuation: '' })
    await edge()
    expect(location.search).toContain('entry=b')
  })

  it('also switches backwards without blocking on frames', async () => {
    await mount()
    await edge()
    const scroll = container.querySelector<HTMLElement>('.article-scroll')!
    await act(async () => { scroll.scrollTop = 20; scroll.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(container.querySelector('.article-edge-zone.previous')?.textContent).toContain('Release to open')
    await act(async () => { scroll.querySelector('img')!.dispatchEvent(new Event('touchend', { bubbles: true })) })
    expect(location.search).toContain('entry=a')
    expect(container.querySelector('.article-transition-previous-in')).not.toBeNull()
  })

  it('keeps the old post usable while loading and ignores a result after Back', async () => {
    initialPage = { items: [post('a')], continuation: '' }
    await mount()
    let resolve!: (page: EntryPage) => void
    vi.mocked(api.entries).mockImplementation(() => new Promise(done => { resolve = done }))
    await edge()
    expect(container.querySelector('.article-navigation-status')?.textContent).toContain('Loading')
    expect(container.querySelector('video')).not.toBeNull()
    expect(container.querySelector('.article-transition-next-in')).toBeNull()
    await act(async () => { (container.querySelector('[aria-label="Back to stories"]') as HTMLButtonElement).click() })
    await act(async () => { resolve({ items: [post('c')], continuation: '' }) })
    expect(location.search).not.toContain('entry=c')
    expect(container.querySelector('.article-navigation-status')).toBeNull()
  })

  it('recovers from a failed folder load and allows the next swipe', async () => {
    initialPage = { items: [post('a')], continuation: '' }
    await mount()
    vi.mocked(api.entries).mockRejectedValueOnce(new Error('Offline'))
    await edge()
    expect(container.textContent).toContain('Offline')
    expect(location.search).toContain('entry=a')
    expect(container.querySelector('.article-navigation-status')).toBeNull()
    await edge()
    expect(location.search).toContain('entry=c')
  })
})

const feed = (id: string, unread: number): Feed => ({
  id, title: id, unread, url: 'https://example.com/feed', siteUrl: 'https://example.com',
  iconUrl: '', categories: [], lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false,
})

async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => { (element as HTMLElement).click() })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('Starred read filter', () => {
  it.each([true, false])('replaces unread articles when opening Starred, mobile=%s', async mobile => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: mobile && query.includes('max-width'), addEventListener() {}, removeEventListener() {} })))
    history.replaceState(null, '', '/')
    const stars = [
      { ...post('read-star'), starred: true, read: true },
      { ...post('unread-star'), starred: true, read: false },
    ]
    vi.mocked(api.entries).mockImplementation(async target => ({
      items: target.kind === 'starred' ? stars : [{ ...post('unread-item'), read: false }], continuation: '',
    }))
    await mount()
    expect(container.querySelector('.story-row h2')?.textContent).toBe('Post unread-item')
    const star = [...container.querySelectorAll('.source-row')].find(row => row.querySelector('.source-label')?.textContent === 'Starred')!
    await click(star)
    expect(container.querySelector('.stream-title h1')?.textContent).toBe('Starred')
    expect(vi.mocked(api.entries).mock.lastCall?.[0].kind).toBe('starred')
    expect(vi.mocked(api.entries).mock.lastCall?.[1]).toBe(false)
    expect([...container.querySelectorAll('.story-row h2')].map(row => row.textContent)).toEqual(['Post read-star', 'Post unread-star'])
  })

  it('replaces the previous list when sync finishes during Starred loading', async () => {
    const events = new Map<string, EventListener>()
    vi.stubGlobal('EventSource', class {
      addEventListener(name: string, listener: EventListener) { events.set(name, listener) }
      removeEventListener() {}
      close() {}
    })
    history.replaceState(null, '', '/')
    const stars: EntryPage = { items: [
      { ...post('read-star'), starred: true, read: true },
      { ...post('unread-star'), starred: true, read: false },
    ], continuation: '' }
    let resolveStarred!: (page: EntryPage) => void
    let starredRequests = 0
    vi.mocked(api.entries).mockImplementation(async target => {
      if (target.kind !== 'starred') return { items: [{ ...post('unread-item'), read: false }], continuation: '' }
      if (++starredRequests === 1) return new Promise<EntryPage>(resolve => { resolveStarred = resolve })
      return stars
    })
    await mount()
    const star = [...container.querySelectorAll('.source-row')].find(row => row.querySelector('.source-label')?.textContent === 'Starred')!
    await click(star)
    await act(async () => { events.get('sync')!(new Event('sync')) })
    expect(container.querySelector('.stream-title h1')?.textContent).toBe('Starred')
    expect([...container.querySelectorAll('.story-row h2')].map(row => row.textContent)).toEqual(['Post read-star', 'Post unread-star'])
    await act(async () => { resolveStarred({ items: [{ ...post('stale-star'), starred: true }], continuation: '' }) })
    expect([...container.querySelectorAll('.story-row h2')].map(row => row.textContent)).toEqual(['Post read-star', 'Post unread-star'])
  })

  it.each([true, false])('shows read and unread stars and preserves the library filter, mobile=%s', async mobile => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: mobile && query.includes('max-width'), addEventListener() {}, removeEventListener() {} })))
    history.replaceState(null, '', '/?kind=starred&id=starred&title=Starred&pane=list&unread=1')
    vi.mocked(api.entries).mockResolvedValue({ items: [
      { ...post('read-star'), starred: true, read: true },
      { ...post('unread-star'), starred: true, read: false },
    ], continuation: '' })
    vi.mocked(api.markStreamRead).mockResolvedValue({ ok: true, count: 1 })
    await mount()
    expect(vi.mocked(api.entries).mock.lastCall?.[1]).toBe(false)
    expect(container.querySelectorAll('.story-row')).toHaveLength(2)
    expect(container.querySelector('.story-filter-label')?.textContent).toBe('All')
    expect(container.querySelector('.story-pane [aria-label="Article filter"]')).toBeNull()
    await click(container.querySelector('[aria-label="Mark stream read"]'))
    expect(container.querySelectorAll('.story-row')).toHaveLength(2)
    const all = [...container.querySelectorAll('.source-row')].find(row => row.querySelector('.source-label')?.textContent === 'All articles')!
    await click(all)
    expect(vi.mocked(api.entries).mock.lastCall?.[0].kind).toBe('all')
    expect(vi.mocked(api.entries).mock.lastCall?.[1]).toBe(true)
  })
})

describe('AI-edited headlines', () => {
  it('shows the display title while retaining the original in an accessible disclosure', async () => {
    initialPage = { items: [{ ...post('a'), kind: 'article', title: 'This mystery app changed everything', displayTitle: 'AntennaPod improved my podcast playback' }], continuation: '' }
    await mount()
    expect(container.querySelector('.story-row h2')?.textContent).toBe('AntennaPod improved my podcast playback')
    expect(container.querySelector('.story-row h2')?.getAttribute('title')).toContain('This mystery app changed everything')
    expect(container.querySelector('.article-header h1')?.textContent).toBe('AntennaPod improved my podcast playback')
    expect(container.querySelector('.original-headline summary')?.textContent).toContain('Original headline')
    expect(container.querySelector('.original-headline p')?.textContent).toBe('This mystery app changed everything')
  })
})

describe('Sources read filter', () => {
  it('puts the mobile toggle in the fixed Library header and filters folders, feeds, and Uncategorized together', async () => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&pane=sources&unread=1')
    vi.mocked(api.navigation).mockResolvedValue({ unread: 1, starred: 0, uncategorized: [feed('Unfiled read', 0)], folders: [
      { id: 'instagram', title: 'Instagram', unread: 1, feeds: [feed('Unread feed', 1), feed('Read feed', 0)] },
      { id: 'tech', title: 'Tech', unread: 0, feeds: [feed('Quiet feed', 0)] },
    ] })
    await mount()
    expect(container.querySelectorAll('[aria-label="Article filter"]')).toHaveLength(1)
    const heading = container.querySelector('.sidebar-heading')!
    expect(heading.children[0].textContent).toBe('Library')
    expect(heading.children[1].className).toBe('source-filter')
    expect(heading.children[2].getAttribute('aria-label')).toBe('Manage feeds')
    expect(container.querySelector('.source-nav .source-filter')).toBeNull()
    expect(container.querySelector('.source-filter [aria-pressed="true"]')?.textContent).toBe('Unread')
    expect(container.querySelector('.story-pane [aria-label="Article filter"]')).toBeNull()
    expect(container.querySelector('.story-filter-label')?.textContent).toBe('Unread')
    expect(container.querySelector('.source-nav')?.textContent).not.toContain('Tech')
    expect(container.querySelector('.source-nav')?.textContent).not.toContain('Uncategorized')
    await click(container.querySelector('.folder-expand'))
    expect(container.querySelector('.feed-list')?.textContent).toContain('Unread feed')
    expect(container.querySelector('.feed-list')?.textContent).not.toContain('Read feed')
    await click(container.querySelector('.source-filter button:last-child'))
    expect(container.querySelector('.source-nav')?.textContent).toContain('Tech')
    expect(container.querySelector('.source-nav')?.textContent).toContain('Uncategorized')
    expect(container.querySelector('.feed-list')?.textContent).toContain('Read feed')
    expect(container.querySelector('.story-filter-label')?.textContent).toBe('All')
    expect(vi.mocked(api.entries).mock.lastCall?.[1]).toBe(false)
    expect(container.querySelector('[data-mobile-pane]')?.getAttribute('data-mobile-pane')).toBe('sources')
    await click(container.querySelector('.source-filter button:first-child'))
    expect(vi.mocked(api.entries).mock.lastCall?.[1]).toBe(true)
    expect(container.querySelector('.source-nav')?.textContent).not.toContain('Tech')
  })

  it('offers Show all feeds when caught up without closing the last article', async () => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=a&pane=article&unread=1')
    initialPage = { items: [{ ...post('a'), read: false }], continuation: '' }
    vi.mocked(api.entry).mockResolvedValue({ entry: initialPage.items[0] })
    vi.mocked(api.navigation).mockResolvedValueOnce({ unread: 1, starred: 0, uncategorized: [], folders: [
      { id: 'instagram', title: 'Instagram', unread: 1, feeds: [feed('Last feed', 1)] },
    ] })
    vi.mocked(api.editState).mockResolvedValue({ ok: true })
    await mount()
    await click(container.querySelector('[aria-label="Mark read"]'))
    expect(location.search).toContain('entry=a')
    expect(location.search).toContain('pane=article')
    expect(container.querySelector('.article-document')).not.toBeNull()
    expect(container.querySelector('.source-nav .folder')).toBeNull()
    expect(container.querySelector('.sources-empty')?.textContent).toContain('All caught up')
    await click(container.querySelector('.mobile-tabs button:first-child'))
    await click(container.querySelector('.sources-empty button'))
    expect(container.querySelectorAll('.source-nav .folder')).toHaveLength(2)
    expect(container.querySelector('.sources-empty')).toBeNull()
    expect(container.querySelector('[data-mobile-pane]')?.getAttribute('data-mobile-pane')).toBe('sources')
  })

  it('leaves the desktop toggle in Stories', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
    await mount()
    expect(container.querySelector('.source-filter')).toBeNull()
    expect(container.querySelector('.story-filter-label')).toBeNull()
    expect(container.querySelector('.story-pane [aria-label="Article filter"]')).not.toBeNull()
    expect(container.querySelectorAll('.source-nav .folder')).toHaveLength(2)
    await click(container.querySelector('.story-pane [aria-label="Article filter"] button:first-child'))
    expect(container.querySelector('.source-nav .folder')).toBeNull()
    expect(container.querySelector('.sources-empty')).toBeNull()
  })
})


describe('reader workflow improvements', () => {
  it('searches the archive and previews the search scope without marking the old folder read', async () => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&pane=stories&unread=1&q=design')
    vi.mocked(api.entries).mockResolvedValue(initialPage)
    vi.mocked(api.previewRead).mockResolvedValue({ token: 'reviewed', count: 2 })
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(api.entries).toHaveBeenCalledWith(expect.objectContaining({ kind: 'all' }), false, 'design', '', undefined, { after: '', before: '' })
    await click(container.querySelector('[aria-label="Mark search results read"]'))
    expect(api.previewRead).toHaveBeenCalledWith(expect.objectContaining({ kind: 'all' }), 'design', '', '')
    expect(api.markStreamRead).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('2 unread articles')
  })

  it('switches full and feed content without reverting a star made while reading', async () => {
    initialPage = { items: [{ ...post('a'), kind: 'article', contentHtml: '<p>Original feed version.</p>' }], continuation: '' }
    vi.mocked(api.fullText).mockResolvedValue({ url: initialPage.items[0].url, title: 'Expanded', byline: '', contentHtml: '<p>Full article version.</p>', excerpt: 'Full', readingMinutes: 3, fetchedAt: '', cached: false })
    vi.mocked(api.editState).mockResolvedValue({ ok: true })
    await mount()
    await click(container.querySelector('[aria-label="Fetch full article"]'))
    expect(container.querySelector('.article-document')?.textContent).toContain('Full article version')
    await click(container.querySelector('[aria-label="Star article"]'))
    await click([...container.querySelectorAll('button')].find(button => button.textContent === 'Show feed version')!)
    expect(container.querySelector('.article-document')?.textContent).toContain('Original feed version')
    expect(container.querySelector('[aria-label="Fetch full article"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Remove star"]')).not.toBeNull()
    await click(container.querySelector('[aria-label="Fetch full article"]'))
    expect(container.querySelector('.article-document')?.textContent).toContain('Full article version')
    expect(container.querySelector('[aria-label="Remove star"]')).not.toBeNull()
    expect(api.fullText).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed automatic read action visible without retrying it every second', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    initialPage = { items: [{ ...post('a'), read: false }], continuation: '' }
    vi.mocked(api.editState).mockRejectedValue(new Error('FreshRSS is unavailable'))
    try {
      await mount()
      await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(api.editState).toHaveBeenCalledTimes(1)
      expect(container.querySelector('.article-error')?.textContent).toContain('FreshRSS is unavailable')
      expect(container.querySelector('.article-error')?.textContent).toContain('Retry change')
    } finally { focus.mockRestore(); visibility.mockRestore() }
  })
})


describe('saved reading navigation', () => {
  it.each([['Continue reading', 'recent'], ['Offline articles', 'offline']])('opens %s from Sources and returns to the stream', async (label, mode) => {
    vi.mocked(api.recentReading).mockResolvedValue([post('saved')])
    vi.mocked(offlineArticles).mockResolvedValue([post('saved')])
    await mount()
    const button = [...container.querySelectorAll<HTMLButtonElement>('.source-nav button')].find(item => item.textContent === label)!
    await click(button)
    expect(container.querySelector('.stream-title h1')?.textContent).toBe(label)
    expect(container.querySelector('[data-mobile-pane]')?.getAttribute('data-mobile-pane')).toBe('stories')
    expect(container.querySelector('.article-document')).toBeNull()
    expect(container.querySelector('.story-row')?.textContent).toContain('Post saved')
    expect(new URLSearchParams(location.search).get('library')).toBe(mode)
    expect(mode === 'recent' ? api.recentReading : offlineArticles).toHaveBeenCalled()
    await click([...container.querySelectorAll<HTMLButtonElement>('.source-nav button')].find(item => item.textContent?.startsWith('All articles'))!)
    expect(container.querySelector('.stream-title h1')?.textContent).toBe('All articles')
    expect(new URLSearchParams(location.search).get('library')).not.toBe(mode)
  })
})
