// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/client/api'
import { ReadingPreferencesProvider } from '../src/client/components/ReadingPreferences'
import { FeedRepair } from '../src/client/components/FeedRepair'
import { FeedChecks, FeedCheckDetails } from '../src/client/components/FeedChecks'
import type { FeedChecksView } from '../src/shared/feed-checks'

vi.mock('../src/client/api', () => ({ api: { readingPreferences: vi.fn(async () => ({ revision: 0, generation: 0, values: {} })), feedChecks: vi.fn(), repairFeed: vi.fn(), checkFeeds: vi.fn(), setCheckInterval: vi.fn() } }))
let root: Root, container: HTMLDivElement, view: FeedChecksView
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  view = { backend: 'standalone', enabled: true, revision: 3, organizationRevision: 7, intervalMinutes: 15,
    folders: [{ id: 'folder-1', title: 'Synthetic folder' }],
    feeds: [{ feedId: 'feed-1', lastSuccessAt: 10000, nextFetchAt: Date.now() + 900000, failures: 2, lastError: 'http-503', lastStatus: 503,
      retryAfterUntil: Date.now() + 3600000, cooldownUntil: 0, intervalMinutes: null, state: 'idle' }] }
  vi.mocked(api.feedChecks).mockImplementation(async () => structuredClone(view))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })
async function render() { await act(async () => root.render(<FeedChecks><FeedCheckDetails feedId="feed-1" /></FeedChecks>)) }
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!
async function click(name: string) { await act(async () => button(name).click()) }

it('shows success, schedule and failure details and reports Retry-After without hiding the result', async () => {
  vi.mocked(api.checkFeeds).mockResolvedValue({ snapshot: view, results: [{ feedId: 'feed-1', status: 'retry-after', until: view.feeds[0].retryAfterUntil }] })
  await render()
  expect(container.textContent).toContain('Last successful check')
  expect(container.textContent).toContain('Next scheduled check')
  expect(container.textContent).toContain('Consecutive failures2')
  expect(container.textContent).toContain('HTTP 503')
  expect(container.textContent).toContain('Publisher Retry-After until')
  await click('Check now')
  expect(api.checkFeeds).toHaveBeenCalledWith({ expectedRevision: 3, expectedOrganizationRevision: 7, feedId: 'feed-1' })
  const message = container.querySelector('[role="status"]')!
  expect(message.textContent).toContain('publisher requested a wait')
  expect(message.closest('details')).toBeNull()
})

it('disables repeated checks while pending or queued, then polls completion', async () => {
  let finish!: (result: Awaited<ReturnType<typeof api.checkFeeds>>) => void
  vi.mocked(api.checkFeeds).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render()
  await click('Check now')
  expect(button('Check now').disabled).toBe(true)
  view.feeds[0].state = 'queued'
  await act(async () => finish({ snapshot: structuredClone(view), results: [{ feedId: 'feed-1', status: 'queued' }] }))
  expect(button('Check queued').disabled).toBe(true)
  view.feeds[0].state = 'running'
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(button('Checking...').disabled).toBe(true)
  view.feeds[0].state = 'idle'; view.feeds[0].failures = 0; view.feeds[0].lastError = ''
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(button('Check now').disabled).toBe(false)
  expect(container.textContent).not.toContain('HTTP 503')
})

it('checks folders and saves a blank per-feed override with revision guards', async () => {
  vi.mocked(api.checkFeeds).mockResolvedValue({ snapshot: view, results: [{ feedId: 'feed-1', status: 'cooldown', until: Date.now() + 60000 }] })
  vi.mocked(api.setCheckInterval).mockResolvedValue({ snapshot: { ...view, revision: 4 } })
  await render()
  await act(async () => {
    const select = container.querySelector('select')!; select.value = 'folder-1'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click('Check folder now')
  expect(api.checkFeeds).toHaveBeenCalledWith({ expectedRevision: 3, expectedOrganizationRevision: 7, folderId: 'folder-1' })
  expect(container.querySelector('[role="status"]')!.textContent).toContain('checked recently')
  const form = container.querySelector('.feed-check-details form')!
  const input = form.querySelector('input')!
  expect(input.min).toBe('5'); expect(input.max).toBe('1440'); expect(input.value).toBe('')
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(api.setCheckInterval).toHaveBeenCalledWith({ expectedRevision: 3, expectedOrganizationRevision: 7, feedId: 'feed-1', intervalMinutes: null })
  expect(container.textContent).toContain('Check interval saved.')
})

it('reloads a stale revision after an error and shows the error', async () => {
  vi.mocked(api.checkFeeds).mockRejectedValue(new Error('Subscriptions changed. Reload.'))
  await render()
  view.revision = 8
  await click('Check now')
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Subscriptions changed')
  vi.mocked(api.checkFeeds).mockResolvedValue({ snapshot: view, results: [] })
  await click('Check now')
  expect(api.checkFeeds).toHaveBeenLastCalledWith({ expectedRevision: 8, expectedOrganizationRevision: 7, feedId: 'feed-1' })
})

it.each(['freshrss', 'miniflux'] as const)('hides standalone controls for %s with an explanation', async backend => {
  view.backend = backend; view.enabled = false; view.feeds = []
  await render()
  expect(container.textContent).toContain(`${backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'} manages feed checks and intervals`)
  expect(container.querySelector('input')).toBeNull()
  expect(button('Check folder now')).toBeUndefined()
  expect(button('Check now')).toBeUndefined()
})

it('explains disabled collection and prevents manual checks', async () => {
  view.enabled = false
  await render()
  expect(container.textContent).toContain('Feed collection is disabled by the server')
  expect(button('Check now').disabled).toBe(true)
  expect(button('Check folder now').disabled).toBe(true)
})

it('offers one-click repair for the suggested address and only displays a temporary redirect', async () => {
  const original = 'https://example.test/old'
  const next = 'https://example.test/new'
  const feed = { id: 'feed-1', title: 'Synthetic', url: original, siteUrl: '', iconUrl: '', categories: [], unread: 0,
    lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false }
  const changed = vi.fn(async () => {})
  const temporary = { redirects: [{ status: 307, url: next }], declaredUrl: '', suggestedUrl: '' }
  await act(async () => root.render(<ReadingPreferencesProvider><FeedRepair feed={feed} move={temporary} onChanged={changed} /></ReadingPreferencesProvider>))
  expect(container.textContent).toContain('Temporary redirect (HTTP 307)')
  expect(button('Use new address')).toBeUndefined()
  const declared = { redirects: [], declaredUrl: next, suggestedUrl: next, repairRef: 'fixture-reference' }
  await act(async () => root.render(<ReadingPreferencesProvider><FeedRepair feed={feed} move={declared} onChanged={changed} /></ReadingPreferencesProvider>))
  expect(api.repairFeed).not.toHaveBeenCalled()
  await click('Use new address')
  expect(api.repairFeed).toHaveBeenCalledExactlyOnceWith('feed-1', { repairRef: declared.repairRef }, original)
  expect(changed).toHaveBeenCalledOnce()
})
