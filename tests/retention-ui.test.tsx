// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/client/api'
import { BackendSettings } from '../src/client/components/BackendSettings'
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

it.each(['freshrss', 'miniflux'] as const)('only offers cache cleanup in %s mode', async backend => {
  view.backend = backend
  await act(async () => root.render(<RetentionSettings backend={backend} />))
  expect(container.textContent).toContain(`${backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'} manages article history.`)
  expect(container.querySelectorAll('.retention-group')).toHaveLength(1)
  expect(button('Preview')).toBeUndefined()
  expect(container.textContent).not.toContain('Article cleanup runs daily')
  expect(container.textContent).not.toContain('Mark unread articles as read')
  expect(container.textContent).not.toContain('Read articles')
  expect(container.textContent).not.toContain('Different limits for folders or feeds')
  expect(container.textContent).toContain('Remove saved full-text pages')
  await select('Remove saved full-text pages', 'days')
  await act(async () => button('Save').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, cacheDays: 30 }, 0, undefined)
})

it('requires a preview before enabling deletion and invalidates it when editing', async () => {
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  await select('Read articles', 'days')
  expect(button('Save').disabled).toBe(true)
  expect(document.getElementById(button('Save').getAttribute('aria-describedby')!)?.textContent).toBe('Preview first to see what would be deleted.')
  await act(async () => button('Preview').click())
  expect(container.textContent).toContain('This would mark 5 read and delete 3 articles.')
  expect(button('Save').disabled).toBe(false)
  expect(container.textContent).not.toContain('Preview first')
  expect([...container.querySelectorAll('.retention-preview strong')].map(node => node.textContent)).toEqual(['5', '3'])
  await select('Mark unread articles as read', 'days')
  expect(button('Save').disabled).toBe(true)
  expect(document.getElementById(button('Save').getAttribute('aria-describedby')!)?.textContent).toBe('Preview first to see what would be deleted.')
  await act(async () => button('Preview').click())
  await act(async () => button('Save').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, autoReadDays: 30, readDays: 60 }, 0, 'preview')
  expect(container.textContent).toContain('Policy saved.')
})

it('offers inherit and never overrides and polls the last run', async () => {
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  await select('Override folder', 'folder'); await select('Folder limit', 'days')
  await select('Override feed', 'feed'); await select('Feed limit', 'off')
  await act(async () => button('Save').click())
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
  expect(container.textContent).toContain('Feed: never marked read automatically, from folder Keep unread.')
  await select('Feed limit', 'days')
  expect(container.textContent).toContain("Feed: marked read after 30 days, from this feed's limit.")
  await select('Feed limit', 'inherit')
  await select('Override folder', 'second'); await select('Folder limit', 'inherit')
  expect(container.textContent).toContain('Feed: marked read after 20 days, from folder Folder.')
  await select('Override folder', 'folder'); await select('Folder limit', 'inherit')
  expect(container.textContent).toContain('Feed: marked read after 10 days, from the default limit.')
})

it('groups cleanup controls and keeps overrides inside mark as read', async () => {
  await act(async () => root.render(<BackendSettings backend="standalone" />))
  expect([...container.querySelectorAll('.retention-group h5')].map(node => node.textContent)).toEqual(['Mark as read', 'Delete old articles', 'Full-text cache'])
  expect(container.querySelector('[aria-label="Mark as read"] [aria-label="Mark as read overrides"]')).not.toBeNull()
  expect(container.querySelector('.backend-backups')?.textContent).toContain('Stop Paper and all briefing commands')
  expect(container.querySelector('.backend-backups')?.textContent).toContain('generated secrets and connection settings')
  expect(container.querySelectorAll('.retention-protections li')).toHaveLength(6)
  expect(container.textContent).toContain('Paper makes a backup before it deletes anything for the first time.')
  expect(container.querySelector('.retention-status')?.textContent).toContain('Article cleanup runs daily and after you save.')
  expect(button('Save').disabled).toBe(false)
  expect(container.textContent).not.toContain('Preview first')
})

it('lists existing limits, changes one and removes both kinds by inheriting', async () => {
  view.policy.folderDays = { folder: null }
  view.policy.feedDays = { feed: 7 }
  view.policy.autoReadDays = 20
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  const rows = () => [...container.querySelectorAll('.retention-override-list li')]
  expect(rows()).toHaveLength(2)
  expect(rows()[0].textContent).toContain('FolderFolder, never')
  expect(rows()[1].textContent).toContain('FeedFeed, after 7 days')
  const click = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
  await click('Change folder limit for Folder')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Override folder')
  await select('Folder limit', 'days')
  expect(rows()[0].textContent).toContain('after 30 days')
  await click('Change feed limit for Feed')
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Override feed"]')?.value).toBe('feed')
  await click('Remove feed limit for Feed')
  expect(rows()).toHaveLength(1)
  expect(container.textContent).toContain('Feed: marked read after 30 days, from folder Folder.')
  await click('Remove folder limit for Folder')
  expect(rows()).toHaveLength(0)
  expect(container.textContent).toContain('Feed: marked read after 20 days, from the default limit.')
  await act(async () => button('Save').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, folderDays: {}, feedDays: {} }, 0, undefined)
})

it('keeps the days suffix beside the input and saves custom day counts', async () => {
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  await select('Remove saved full-text pages', 'days')
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Remove saved full-text pages days"]')!
  expect(input.parentElement?.textContent).toBe('days')
  expect(input.min).toBe('1'); expect(input.max).toBe('36500')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '45')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Save').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, cacheDays: 45 }, 0, undefined)
  await select('Remove saved full-text pages', 'off')
  expect(container.querySelector('input')).toBeNull()
  await act(async () => button('Save').click())
  expect(api.saveRetention).toHaveBeenLastCalledWith(view.policy, 1, undefined)
})

it('requires a fresh preview with saved deletion limits and after removing an override', async () => {
  view.policy.readDays = 60
  view.policy.folderDays = { folder: 20 }
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  expect(button('Save').disabled).toBe(true)
  await act(async () => button('Preview').click())
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove folder limit for Folder"]')!.click())
  expect(button('Save').disabled).toBe(true)
  expect(container.querySelector('.retention-preview')).toBeNull()
  await select('Read articles', 'off')
  expect(button('Save').disabled).toBe(false)
  expect(container.textContent).not.toContain('Preview first')
})

it('polls status every three seconds without replacing unsaved limits', async () => {
  await act(async () => root.render(<RetentionSettings backend="standalone" />))
  await select('Unread articles', 'days')
  view.cacheRun = { at: 1000, deleted: 12 }
  view.error = 'Cleanup will retry.'
  await act(async () => vi.advanceTimersByTime(2999))
  expect(api.retention).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTime(1))
  expect(api.retention).toHaveBeenCalledTimes(2)
  expect(container.querySelector('.retention-status')?.textContent).toContain('Removed 12 pages.')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Cleanup will retry.')
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Unread articles days"]')?.value).toBe('180')
  await act(async () => button('Preview').click())
  await act(async () => button('Save').click())
  expect(api.saveRetention).toHaveBeenCalledWith({ ...view.policy, unreadDays: 180 }, 0, 'preview')
})
