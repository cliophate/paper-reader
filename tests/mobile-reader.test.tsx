import { FRESHRSS_ORGANIZATION_CAPABILITIES, LOCAL_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/client/App'
import { api, ApiError } from '../src/client/api'
import { offlineArticles } from '../src/client/offline'
import type { Entry, EntryPage, Feed } from '../src/client/types'

vi.mock('../src/client/api', async () => ({ ...await vi.importActual('../src/client/api'), api: {
  organization: vi.fn(), organize: vi.fn(), recentReading: vi.fn(), navigation: vi.fn(), status: vi.fn(), entries: vi.fn(), entry: vi.fn(), editState: vi.fn(), markStreamRead: vi.fn(),
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
  vi.mocked(api.organization).mockImplementation(async () => ({ backend: 'freshrss', capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES, revision: null, navigation: await api.navigation() }))
  vi.mocked(api.editState).mockResolvedValue({ ok: true })
  vi.mocked(api.status).mockResolvedValue({ backend: 'freshrss', backendInstance: 'freshrss:fixture', discussionConfigured: false, readwiseConfigured: false, kirbyConfigured: false, briefingConfigured: false, sync: { lastCompletedAt: null } })
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
  it.each([true, false])('counts loaded rows using the active unread filter, unread=%s', async unreadOnly => {
    history.replaceState(null, '', `/?kind=category&id=instagram&title=Instagram&pane=stories&unread=${unreadOnly ? '1' : '0'}`)
    initialPage.items = Array.from({ length: 9 }, (_, index) => ({ ...post(String(index)), read: index === 0 }))
    vi.mocked(api.navigation).mockResolvedValue({ unread: 8, starred: 0, uncategorized: [], folders: [
      { id: 'instagram', title: 'Instagram', unread: 8, feeds: [] },
    ] })
    await mount()
    expect(container.querySelectorAll('.story-row')).toHaveLength(9)
    expect(container.querySelector('.filter-row')?.textContent).toContain(unreadOnly ? '8 of 8 loaded' : '9 loaded')
  })

  it('hides the discussion action when discussion is not configured', async () => {
    await mount()
    expect(container.querySelector('button[aria-label="Discuss article"]')).toBeNull()
  })

  it('shows a distinct discussion icon when configured and disables the action offline', async () => {
    vi.mocked(api.status).mockResolvedValue({ ...(await api.status()), discussionConfigured: true })
    initialPage.items[0] = { ...post('a'), kind: 'article' }
    await mount()
    const discuss = container.querySelector<HTMLButtonElement>('button[aria-label="Discuss article"]')!
    expect(discuss.disabled).toBe(false)
    expect(discuss.title).toBe('Discuss article')
    expect(discuss.querySelector('svg')?.innerHTML).not.toBe(container.querySelector('button[aria-label="Fetch full article"] svg')?.innerHTML)
    const connection = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await act(async () => { window.dispatchEvent(new Event('offline')) })
    expect(discuss.disabled).toBe(true)
    connection.mockReturnValue(true)
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(discuss.disabled).toBe(false)
    connection.mockRestore()
  })

  it('exposes separate story open and options buttons without nested interactive controls', async () => {
    await mount()
    const interactive = 'button, a[href], input, select, textarea, [role="button"], [tabindex]'
    for (const row of container.querySelectorAll('.story-row')) {
      expect(row.matches(interactive)).toBe(false)
      for (const control of row.querySelectorAll(interactive)) expect(control.querySelector(interactive)).toBeNull()
      expect(row.querySelector('.story-open')?.getAttribute('aria-label')).toBe(row.querySelector('h2')?.textContent)
    }
    const row = container.querySelectorAll('.story-row')[1]
    const open = row.querySelector<HTMLButtonElement>('.story-open')!
    open.focus()
    expect(document.activeElement).toBe(open)
    await act(async () => { open.click() })
    expect(location.search).toContain('entry=b')
    const options = row.querySelector<HTMLButtonElement>('.row-options')!
    options.focus()
    await act(async () => { options.click() })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(location.search).toContain('entry=b')
  })

  it.each(['.story-open', '.row-options'])('leaves native Enter and Space activation on %s to the button', async selector => {
    await mount()
    const control = container.querySelectorAll('.story-row')[1].querySelector(selector)!
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      await act(async () => { control.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
      expect(location.search).toContain('entry=a')
    }
  })

  it('opens the touch context menu and suppresses the following story click', async () => {
    await mount()
    const open = container.querySelectorAll('.story-row')[1].querySelector<HTMLButtonElement>('.story-open')!
    const press = new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 40 })
    Object.defineProperty(press, 'pointerType', { value: 'touch' })
    await act(async () => { open.dispatchEvent(press); await vi.advanceTimersByTimeAsync(450) })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { open.dispatchEvent(new Event('pointerup', { bubbles: true })); open.click() })
    expect(location.search).toContain('entry=a')
    await act(async () => { open.click() })
    expect(location.search).toContain('entry=b')
  })

  it.each(['pointermove', 'pointercancel'])('cancels a touch context menu on %s', async type => {
    await mount()
    const open = container.querySelector<HTMLButtonElement>('.story-open')!
    const press = new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 })
    Object.defineProperty(press, 'pointerType', { value: 'touch' })
    await act(async () => {
      open.dispatchEvent(press)
      open.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 20, clientY: 0 }))
      await vi.advanceTimersByTimeAsync(450)
    })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it.each(['', 'not-a-date', '0', '1970-01-01T00:00:00.000Z', undefined])('opens an article with unavailable publication date %s without crashing', async publishedAt => {
    initialPage.items[0] = { ...post('a'), kind: 'article', publishedAt: publishedAt as string, timestamp: 0 }
    await mount()
    expect(container.querySelector('.article-kicker')?.textContent).toContain('Date unavailable')
    expect(container.querySelector('.story-list')?.textContent).toContain('Date unavailable')
    expect(container.textContent).not.toContain('NaNd')
  })

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

  it.each([false, true])('keeps a newer list and selection when bulk read finishes, including return=%s', async returnToFolder => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=a&pane=article&unread=1')
    initialPage.items = initialPage.items.map(entry => ({ ...entry, read: false, stateRevision: 1 }))
    let finish!: (result: { ok: boolean; count: number; undoToken: string }) => void
    vi.mocked(api.markStreamRead).mockReturnValue(new Promise(resolve => { finish = resolve }))
    vi.mocked(api.undo).mockResolvedValue({ ok: true, count: 2 })
    await mount()
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'A', shiftKey: true })) })
    const navigate = async (id: string, entry: string) => {
      await act(async () => {
        history.pushState(null, '', `/?kind=category&id=${id}&title=${id === 'tech' ? 'Tech' : 'Instagram'}&entry=${entry}&pane=article&unread=1`)
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    }
    await navigate('tech', 'c')
    if (returnToFolder) {
      initialPage.items.push({ ...post('new'), read: false, stateRevision: 1 })
      await navigate('instagram', 'new')
    }
    const rows = container.querySelectorAll('.story-row').length
    const selection = location.search
    await act(async () => { finish({ ok: true, count: 2, undoToken: 'synthetic-undo' }) })
    expect(container.querySelectorAll('.story-row')).toHaveLength(rows)
    expect(location.search).toBe(selection)
    expect(container.querySelector('.article-view')).not.toBeNull()
    vi.mocked(api.entries).mockClear()
    await act(async () => { container.querySelector<HTMLButtonElement>('.toast button')!.click() })
    expect(api.undo).toHaveBeenCalledWith('synthetic-undo')
    expect(api.entries).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.story-row')).toHaveLength(rows)
    expect(location.search).toBe(selection)
  })

  it('traverses feeds in sidebar order, skips empty feeds, and deduplicates memberships', async () => {
    history.replaceState(null, '', '/?kind=feed&id=first&entry=a&pane=article&unread=1')
    const feed = (id: string, unread = 1) => ({ id, title: id, unread, url: `https://example.com/${id}` })
    vi.mocked(api.navigation).mockResolvedValue({ unread: 3, starred: 0, uncategorized: [feed('last')], folders: [
      { id: 'one', title: 'One', unread: 2, feeds: [feed('first'), feed('empty', 0), feed('stale'), feed('next')] },
      { id: 'two', title: 'Two', unread: 1, feeds: [feed('first')] },
    ] })
    vi.mocked(api.entries).mockImplementation(async target => ({ items: target.id === 'stale' ? [] : [post(target.id === 'first' ? 'a' : target.id)], continuation: '' }))
    await mount()
    vi.mocked(api.entries).mockClear()
    const key = async (key: string) => { await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })) }) }
    await key('j')
    expect(location.search).toContain('id=next')
    expect(vi.mocked(api.entries).mock.calls.map(call => call[0].id)).toEqual(['stale', 'next'])
    await key('j')
    expect(location.search).toContain('id=last')
    await key('k')
    expect(location.search).toContain('id=next')
  })

  it('does not navigate articles from a select or editable descendant', async () => {
    await mount()
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Article order"]')!
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    editable.setAttribute('contenteditable', 'true')
    editable.innerHTML = '<span>Editing</span>'
    container.append(editable)
    await act(async () => {
      select.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'j' }))
      editable.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'j' }))
    })
    expect(location.search).toContain('entry=a')
    editable.remove()
  })

  it('ignores an obsolete source failure after a successful reload, but keeps a current failure visible', async () => {
    const sources: EventTarget[] = []
    vi.stubGlobal('EventSource', class extends EventTarget { constructor() { super(); sources.push(this) } close() {} })
    let failOld!: (error: Error) => void
    vi.mocked(api.organization).mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject }))
    await mount()
    const oldSignal = vi.mocked(api.organization).mock.calls[0][1]!
    await act(async () => { sources.at(-1)!.dispatchEvent(new Event('sync')) })
    expect(oldSignal.aborted).toBe(true)
    expect(container.textContent).toContain('Instagram')
    await act(async () => { failOld(new TypeError('NetworkError while attempting to fetch sources')) })
    expect(container.querySelector('.reader-status')?.textContent).not.toContain('NetworkError')
    vi.mocked(api.organization).mockRejectedValueOnce(new TypeError('Current source failure'))
    await act(async () => { sources.at(-1)!.dispatchEvent(new Event('sync')) })
    expect(container.querySelector('.reader-status')?.textContent).toContain('Current source failure')
    await act(async () => { sources.at(-1)!.dispatchEvent(new Event('sync')) })
    expect(container.querySelector('.reader-status')?.textContent).not.toContain('Current source failure')
  })

  it('aborts source requests when a reload leaves the page', async () => {
    let fail!: (error: Error) => void
    vi.mocked(api.organization).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    await mount()
    const signal = vi.mocked(api.organization).mock.calls[0][1]!
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'))
      fail(new TypeError('NetworkError while attempting to fetch sources'))
    })
    expect(signal.aborted).toBe(true)
    expect(container.querySelector('.reader-status')?.textContent).not.toContain('NetworkError')
    await act(async () => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })) })
    expect(api.organization).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Instagram')
  })

  it('keeps the programmatic reader focus target out of Tab order and leaves article controls tabbable', async () => {
    await mount()
    const article = container.querySelector<HTMLElement>('.article-view')!
    expect(article.tabIndex).toBe(-1)
    article.focus()
    expect(document.activeElement).toBe(article)
    expect(article.querySelector<HTMLAnchorElement>('a[href]')!.tabIndex).toBe(0)
    expect(article.querySelector<HTMLButtonElement>('button:not(:disabled)')!.tabIndex).toBe(0)
  })

  it('opens the existing discovery flow from the Feeds add menu and returns focus on close', async () => {
    await mount()
    const plus = container.querySelector<HTMLButtonElement>('[aria-label="Add feed or folder"]')!
    await act(async () => { plus.focus(); plus.click() })
    const add = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === 'Add feed')!
    await act(async () => add.click())
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Settings')
    expect(container.querySelector('[aria-label="Discover feeds"]')).not.toBeNull()
    expect(container.querySelectorAll('.subscription-tools')).toHaveLength(1)
    expect(container.querySelector('.feed-add-form')).toBeNull()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(plus)
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

  it('sends the displayed standalone revision and restores server state after a conflict', async () => {
    initialPage.items[0] = { ...post('a'), stateRevision: 4 }
    vi.mocked(api.entry).mockResolvedValue({ entry: initialPage.items[0] })
    vi.mocked(api.status).mockResolvedValue({ backend: 'standalone', backendInstance: 'standalone:fixture', discussionConfigured: false, readwiseConfigured: false, kirbyConfigured: false, briefingConfigured: false, sync: { lastCompletedAt: null } })
    vi.mocked(api.editState).mockRejectedValue(new ApiError('Article state changed', 409, 'state-conflict', undefined, { a: { read: true, starred: true, revision: 5 } }))
    await mount()
    const star = container.querySelector<HTMLButtonElement>('[aria-label="Star article"]')!
    await act(async () => { star.click() })
    expect(api.editState).toHaveBeenCalledWith(['a'], 'star', 'reader', { expectedRevisions: { a: 4 }, undo: true })
    expect(container.querySelector('[aria-label="Remove star"]')).not.toBeNull()
    expect(container.textContent).toContain('Article state changed')
    vi.mocked(api.editState).mockResolvedValue({ ok: true, revisions: { a: 6 }, undoToken: 'synthetic-undo' })
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Remove star"]')!.click() })
    expect(api.editState).toHaveBeenLastCalledWith(['a'], 'unstar', 'reader', { expectedRevisions: { a: 5 }, undo: true })
  })

  it('allows opaque standalone subscription IDs and disables historical unsubscribed sources', async () => {
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&pane=list&unread=0')
    initialPage = { items: [{ ...post('one'), feedId: 'paper:subscription:opaque' }, { ...post('two'), feedId: 'feed/historical' }], continuation: '' }
    const navigation = { unread: 0, starred: 0, folders: [], uncategorized: [{ id: 'paper:subscription:opaque', title: 'Standalone feed', url: 'https://example.test/feed', siteUrl: '', iconUrl: '', categories: [], unread: 0, broken: false, lastCheckedAt: null, lastErrorAt: null, lastPublishedAt: null }] }
    vi.mocked(api.navigation).mockResolvedValue(navigation)
    vi.mocked(api.organization).mockResolvedValue({ backend: 'standalone', capabilities: LOCAL_ORGANIZATION_CAPABILITIES, revision: 0, navigation })
    await mount()
    const rows = [...container.querySelectorAll('.story-row')]
    await act(async () => { rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    expect(container.querySelector<HTMLButtonElement>('.entry-unsubscribe')!.disabled).toBe(false)
    await act(async () => { rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    expect(container.querySelector<HTMLButtonElement>('.entry-unsubscribe')!.disabled).toBe(true)
  })

  it('unsubscribes from an article source in a mixed folder after confirming, keeping the other feed and folder', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
    history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=3&pane=list&unread=0')
    initialPage = { items: ['1', '2', '3'].map(id => ({ ...post(id), feedId: id === '3' ? 'feed/keep' : 'feed/remove', feedTitle: id === '3' ? 'Keep this feed' : 'Unwanted feed' })), continuation: '' }
    vi.mocked(api.entry).mockResolvedValue({ entry: initialPage.items[2] })
    vi.mocked(api.removeFeed).mockResolvedValue({ ok: true })
    vi.mocked(api.navigation).mockResolvedValue({ unread: 0, starred: 0, uncategorized: [], folders: [{ id: 'instagram', title: 'Instagram', unread: 0, feeds: initialPage.items.map(entry => ({ id: entry.feedId, title: entry.feedTitle, url: entry.feedUrl, siteUrl: '', iconUrl: '', categories: ['Instagram'], unread: 0, broken: false, lastCheckedAt: null, lastErrorAt: null, lastPublishedAt: null })) }] })
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
    vi.mocked(api.navigation).mockResolvedValue({ unread: 0, starred: 0, uncategorized: [], folders: [{ id: 'instagram', title: 'Instagram', unread: 0, feeds: initialPage.items.map(entry => ({ id: entry.feedId, title: entry.feedTitle, url: entry.feedUrl, siteUrl: '', iconUrl: '', categories: ['Instagram'], unread: 0, broken: false, lastCheckedAt: null, lastErrorAt: null, lastPublishedAt: null })) }] })
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
    expect(heading.children).toHaveLength(2)
    expect(container.querySelector('.organization-header [aria-label="Add feed or folder"]')).not.toBeNull()
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

describe('organization keeps the reading session', () => {
  it.each(['all', 'unread', 'later-page'])('retains the %s reading session while renaming its folder', async mode => {
    const { LOCAL_ORGANIZATION_CAPABILITIES } = await import('../src/server/organization')
    const navigation = { unread: 1, starred: 0, uncategorized: [], folders: [{ id: 'instagram', title: 'Instagram', unread: 1, feeds: [feed('a', 1)] }] }
    vi.mocked(api.organization).mockResolvedValue({ backend: 'standalone', revision: 1, capabilities: LOCAL_ORGANIZATION_CAPABILITIES, navigation })
    if (mode === 'unread') {
      history.replaceState(null, '', '/?kind=category&id=instagram&title=Instagram&entry=a&pane=article&unread=1')
      initialPage = { items: [{ ...post('b'), read: false }], continuation: '' }
    } else if (mode === 'later-page') {
      initialPage = { items: [post('a')], continuation: 'page2' }
    }
    await mount()
    if (mode === 'later-page') {
      vi.mocked(api.entries).mockResolvedValueOnce({ items: [post('b')], continuation: '' })
      await edge()
      vi.mocked(api.entry).mockResolvedValue({ entry: post('b') })
    }
    const video = container.querySelector('video')!
    expect(video).not.toBeNull()
    video.currentTime = 12
    const entryRequests = vi.mocked(api.entries).mock.calls.length
    const missingEntryRequests = vi.mocked(api.entry).mock.calls.length
    const rows = [...container.querySelectorAll('.story-row')]
    const historyLength = history.length
    const originalEntry = new URLSearchParams(location.search).get('entry')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit feeds"]')!.click())
    const options = container.querySelector<HTMLButtonElement>('button[aria-label="Options for Instagram"]')!
    await act(async () => { options.focus(); options.click() })
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Rename folder')!.click() })
    const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!
    await act(async () => {
      const input = form.querySelector('input')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Photos')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    vi.mocked(api.organize).mockResolvedValue({ results: [{ index: 0, status: 'applied', changed: true }], snapshot: { backend: 'standalone', revision: 2, capabilities: LOCAL_ORGANIZATION_CAPABILITIES, navigation: { ...navigation, folders: [{ ...navigation.folders[0], title: 'Photos' }] } } })
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(new URLSearchParams(location.search).get('entry')).toBe(originalEntry)
    expect(new URLSearchParams(location.search).get('title')).toBe('Photos')
    expect(history.length).toBe(historyLength)
    expect(container.querySelector('.social-author')?.textContent).toContain(`Instagram ${mode === 'later-page' ? 'b' : 'a'}`)
    expect(api.entries).toHaveBeenCalledTimes(entryRequests)
    expect(api.entry).toHaveBeenCalledTimes(missingEntryRequests)
    expect(container.querySelector('video')).toBe(video)
    expect(video.currentTime).toBe(12)
    expect([...container.querySelectorAll('.story-row')]).toEqual(rows)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Options for Photos')
  })
})
