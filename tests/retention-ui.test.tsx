// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/client/api'
import { RetentionSettings } from '../src/client/components/RetentionSettings'
import type { RetentionView } from '../src/shared/retention'

vi.mock('../src/client/api', () => ({ api: { retention: vi.fn(), previewRetention: vi.fn(), saveRetention: vi.fn() } }))
let root: Root, container: HTMLDivElement, view: RetentionView
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  view = { backend: 'standalone', policy: { autoReadDays: null, folderDays: {}, feedDays: {}, readDays: null, unreadDays: null, cacheDays: null }, revision: 0,
    feeds: [{ id: 'feed', title: 'Feed', folderIds: ['folder'] }], folders: [{ id: 'folder', title: 'Folder' }], lastRun: null, cacheRun: null, error: '' }
  vi.mocked(api.retention).mockImplementation(async () => structuredClone(view))
  vi.mocked(api.previewRetention).mockResolvedValue({ marked: 5, deleted: 3, token: 'preview' })
  vi.mocked(api.saveRetention).mockImplementation(async policy => ({ ...view, policy, revision: 1 }))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })
const button = (label: string) => [...container.querySelectorAll('button')].find(button => button.textContent === label)!
async function select(label: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('hides article policies in FreshRSS mode and offers cache cleanup', async () => {
  view.backend = 'freshrss'
  await act(async () => root.render(<RetentionSettings backend="freshrss" />))
  expect(container.textContent).toContain('FreshRSS owns article history.')
  expect(container.textContent).not.toContain('Auto-mark-read')
  expect(container.textContent).not.toContain('Delete read articles')
  expect(container.textContent).not.toContain('Folder and feed overrides')
  expect(container.textContent).toContain('Clean full-text cache')
  await select('Clean full-text cache', 'days')
  await act(async () => button('Save retention policy').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, cacheDays: 30 }, 0, undefined)
})

it('requires a preview before enabling deletion and invalidates it when editing', async () => {
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  await select('Delete read articles', 'days')
  expect(button('Save retention policy').disabled).toBe(true)
  await act(async () => button('Preview policy').click())
  expect(container.textContent).toContain('This would mark 5 read and delete 3 articles.')
  expect(button('Save retention policy').disabled).toBe(false)
  await select('Auto-mark-read', 'days')
  expect(button('Save retention policy').disabled).toBe(true)
  await act(async () => button('Preview policy').click())
  await act(async () => button('Save retention policy').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, autoReadDays: 30, readDays: 60 }, 0, 'preview')
  expect(container.textContent).toContain('Policy saved.')
})

it('offers inherit and never overrides and polls the last run', async () => {
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  await select('Override folder', 'folder'); await select('Folder auto-read', 'days')
  await select('Override feed', 'feed'); await select('Feed auto-read', 'off')
  await act(async () => button('Save retention policy').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, folderDays: { folder: 30 }, feedDays: { feed: null } }, 0, undefined)
  view.lastRun = { id: 1, startedAt: 1, finishedAt: 2, cursor: 10, ceiling: 10, batches: 1, marked: 4, deleted: 2 }
  await act(async () => vi.advanceTimersByTime(3000))
  expect(container.textContent).toContain('Marked 4 read and deleted 2 articles.')
})


it('shows the effective feed policy and source while editing overrides', async () => {
  view.policy.autoReadDays = 10
  view.policy.folderDays = { folder: 20, second: null }
  view.folders.push({ id: 'second', title: 'Keep unread' })
  view.feeds[0].folderIds.push('second')
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  await select('Override feed', 'feed')
  expect(container.textContent).toContain('Effective auto-read: Never. Source: folder Keep unread.')
  await select('Feed auto-read', 'days')
  expect(container.textContent).toContain('Effective auto-read: after 30 days. Source: feed override.')
  await select('Feed auto-read', 'inherit')
  await select('Override folder', 'second'); await select('Folder auto-read', 'inherit')
  expect(container.textContent).toContain('Effective auto-read: after 20 days. Source: folder Folder.')
  await select('Override folder', 'folder'); await select('Folder auto-read', 'inherit')
  expect(container.textContent).toContain('Effective auto-read: after 10 days. Source: global limit.')
})
