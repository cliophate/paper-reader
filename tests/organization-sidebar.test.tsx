// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrganizationSidebar } from '../src/client/components/OrganizationSidebar'
import { api, ApiError } from '../src/client/api'
import { FRESHRSS_ORGANIZATION_CAPABILITIES, LOCAL_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
import type { OrganizationView } from '../src/shared/organization'
import type { Feed } from '../src/client/types'

vi.mock('../src/client/api', async original => ({ ...await original<typeof import('../src/client/api')>(), api: { organization: vi.fn(), organize: vi.fn() } }))
const feed = (id: string): Feed => ({ id, title: id, url: 'https://example.test/feed', siteUrl: '', iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false })
let root: Root, container: HTMLDivElement, snapshot: OrganizationView
let update: (next: OrganizationView) => void
const opened = vi.fn(), changed = vi.fn(), managed = vi.fn()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  snapshot = { backend: 'standalone', revision: 4, capabilities: LOCAL_ORGANIZATION_CAPABILITIES, navigation: { unread: 0, starred: 0, folders: [{ id: 'a', title: 'Essays', unread: 0, feeds: [feed('First'), feed('Second')] }, { id: 'b', title: 'Empty', unread: 0, feeds: [] }, { id: 'c', title: 'Other', unread: 0, feeds: [feed('First')] }], uncategorized: [feed('Unfiled')] } }
  vi.mocked(api.organize).mockImplementation(async ({ commands }) => ({ snapshot, results: commands.map((_, index) => ({ index, status: 'applied', changed: true })) }))
  vi.mocked(api.organization).mockImplementation(async () => snapshot)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.resetAllMocks() })
async function render(options: { online?: boolean; unreadOnly?: boolean } = {}) {
  function Host() {
    const [value, setValue] = useState(snapshot); update = setValue
    return <OrganizationSidebar snapshot={value} navigation={value.navigation} active={{ kind: 'feed', id: 'First', title: 'First' }} unreadOnly={options.unreadOnly ?? false} online={options.online ?? true} onSnapshot={next => { changed(next); setValue(next) }} onOpen={opened} onMarkFeed={vi.fn()} onMarkFolder={vi.fn()} onManage={managed} />
  }
  await act(async () => root.render(<Host />))
}
const button = (name: string, parent: ParentNode = document) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name || item.querySelector('.source-label')?.textContent === name || item.getAttribute('aria-label') === name)!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
async function click(name: string, parent: ParentNode = document) { const item = button(name, parent); expect(item, name).toBeTruthy(); await act(async () => { item.focus(); item.click() }) }
async function key(element: Element, key: string, shiftKey = false) { await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })) }) }
async function enter(value: string) { await act(async () => { const input = dialog().querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function select(value: string) { await act(async () => { const input = dialog().querySelector('select')!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function submit() { await act(async () => { dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
async function drag(element: Element, event: string) { await act(async () => { const dispatched = new Event(event, { bubbles: true, cancelable: true }); Object.defineProperty(dispatched, 'dataTransfer', { value: { setData: vi.fn() } }); element.dispatchEvent(dispatched) }) }

describe('sidebar organization interactions', () => {
  it('supports keyboard context menus, arrow navigation, Escape and focus restoration', async () => {
    await render(); await click('Expand Essays')
    const row = button('First'); row.focus()
    await key(row, 'F10', true)
    expect(document.activeElement?.textContent).toBe('Open feed')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Rename feed')
    await key(document.activeElement!, 'End')
    expect(document.activeElement?.textContent).toBe('Unsubscribe')
    await key(document.activeElement!, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('renames in place, keeps selection, and returns focus to the same row options', async () => {
    await render(); await click('Expand Essays'); await click('Options for First'); await click('Rename feed')
    expect(document.activeElement).toBe(dialog().querySelector('input'))
    await enter('Renamed')
    snapshot = structuredClone(snapshot); snapshot.navigation.folders[0].feeds[0].title = 'Renamed'; snapshot.revision++
    await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'rename-feed', feedId: 'First', title: 'Renamed' }] })
    expect(document.querySelector('.feed-row.active .source-label')?.textContent).toBe('Renamed')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Options for Renamed')
    expect(opened).not.toHaveBeenCalled()
  })

  it('uses the revision when editing began even if navigation updates while the form is open', async () => {
    await render(); await click('Options for Essays'); await click('Rename folder')
    await act(async () => update({ ...snapshot, revision: 7 }))
    await enter('New name'); await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'rename-folder', folderId: 'a', title: 'New name' }] })
  })

  it('shows empty folders while organizing unread feeds and creates a folder without navigation', async () => {
    await render({ unreadOnly: true })
    expect(button('Options for Empty')).toBeUndefined()
    await click('Organize feeds'); await click('Expand Empty')
    expect(container.textContent).toContain('No feeds')
    await click('New folder'); await enter('Quiet'); await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'create-folder', title: 'Quiet' }] })
    expect(opened).not.toHaveBeenCalled()
  })

  it('explains removal and merge semantics and requires explicit confirmation', async () => {
    await render(); await click('Options for Essays'); await click('Remove folder')
    expect(dialog().textContent).toContain('Feeds with no other folders move to Uncategorized')
    expect(dialog().textContent).toContain('Article history, stars and reading positions stay saved')
    expect(api.organize).not.toHaveBeenCalled()
    await click('Cancel'); await click('Options for Essays'); await click('Merge folder')
    expect(dialog().textContent).toContain('duplicate memberships appear once')
    await select('c'); await click('Confirm merge')
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'merge-folders', sourceId: 'a', destinationId: 'c' }] })
  })

  it('has mobile menu buttons, a trapped dialog and a confirmed unsubscribe with fallback focus', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    await render(); await click('Expand Essays'); await click('Options for First'); await click('Unsubscribe')
    expect(api.organize).not.toHaveBeenCalled()
    await key(button('Cancel', dialog()), 'Tab', true)
    expect(document.activeElement?.textContent).toBe('Confirm unsubscribe')
    await key(document.activeElement!, 'Tab')
    expect(document.activeElement?.textContent).toBe('Cancel')
    snapshot = structuredClone(snapshot); snapshot.navigation.folders.forEach(folder => { folder.feeds = folder.feeds.filter(feed => feed.id !== 'First') })
    await click('Confirm unsubscribe')
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'unsubscribe', feedId: 'First' }] })
    expect(document.activeElement?.textContent).toBe('Organize feeds')
  })

  it('preserves source membership in moves and explains moving a multi-folder feed to Uncategorized', async () => {
    await render(); await click('Expand Essays'); await click('Options for First'); await click('Move feed')
    expect(dialog().textContent).toContain('Other folders keep this feed')
    expect(dialog().textContent).toContain('only when no memberships remain')
    await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: null }] })
    await click('Uncategorized'); await click('Options for Unfiled'); await click('Move feed'); await select('b'); await submit()
    expect(api.organize).toHaveBeenLastCalledWith({ expectedRevision: 4, commands: [{ type: 'move-feed', feedId: 'Unfiled', fromFolderId: null, toFolderId: 'b' }] })
  })

  it('keeps only failed bulk selections and identifies the failed feeds without replaying successes', async () => {
    await render(); await click('Organize feeds'); await click('Expand Essays')
    for (const input of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => input.click())
    await click('Move selected'); await select('b')
    vi.mocked(api.organize).mockResolvedValueOnce({ snapshot, results: [{ index: 0, status: 'applied', changed: true }, { index: 1, status: 'failed', code: 'not-found', message: 'The source changed.' }] })
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1 of 2 changes confirmed. Second: The source changed.')
    expect(container.textContent).toContain('1 selected')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('Move selected'); await select('b'); await submit()
    expect(vi.mocked(api.organize).mock.calls[1][0].commands).toEqual([{ type: 'move-feed', feedId: 'Second', fromFolderId: 'a', toFolderId: 'b' }])
  })

  it('deduplicates a multi-folder feed in bulk unsubscribe and confirms the names', async () => {
    await render(); await click('Organize feeds'); await click('Expand Essays'); await click('Expand Other')
    for (const input of container.querySelectorAll<HTMLInputElement>('input[aria-label^="Select First"]')) await act(async () => input.click())
    await click('Unsubscribe selected')
    expect(dialog().textContent).toContain('Unsubscribe from 1 feed?')
    expect(api.organize).not.toHaveBeenCalled()
    await click('Confirm unsubscribe')
    expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'unsubscribe', feedId: 'First' }])
  })

  it('blocks stale writes until reload and never retries automatically', async () => {
    await render(); await click('Options for Essays'); await click('Rename folder'); await enter('New')
    vi.mocked(api.organize).mockRejectedValueOnce(new ApiError('Conflict', 409, 'conflict', 5))
    await submit()
    expect(dialog().textContent).toContain('No changes from this request were applied')
    expect(button('Save', dialog()).disabled).toBe(true)
    expect(api.organization).not.toHaveBeenCalled()
    snapshot = { ...snapshot, revision: 5 }
    await click('Reload organization', dialog())
    expect(api.organization).toHaveBeenCalledWith(true)
    expect(api.organize).toHaveBeenCalledTimes(1)
    await submit()
    expect(vi.mocked(api.organize).mock.calls[1][0].expectedRevision).toBe(5)
  })

  it('retains acknowledged outcomes on refresh failure and requires reload before further writes', async () => {
    await render(); await click('Options for Essays'); await click('Rename folder'); await enter('Changed')
    vi.mocked(api.organize).mockResolvedValueOnce({ snapshot: null, results: [{ index: 0, status: 'applied', changed: true }], refreshError: 'Navigation could not reload.' })
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1 of 1 changes confirmed. Navigation could not reload.')
    expect(button('New folder').disabled).toBe(true)
    expect(api.organize).toHaveBeenCalledTimes(1)
  })

  it('limits FreshRSS menus and drag targets to supported operations and disables offline writes', async () => {
    snapshot = { ...snapshot, backend: 'freshrss', revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES }
    await render({ online: false }); await click('Organize feeds'); await click('Options for Essays')
    expect(button('New folder')).toBeUndefined(); expect(button('Rename folder')).toBeUndefined(); expect(button('Move down')).toBeUndefined()
    await key(document.activeElement!, 'Escape'); await click('Expand Essays'); await click('Options for First')
    expect(button('Rename feed').disabled).toBe(true); expect(button('Move feed').disabled).toBe(true)
    expect(container.querySelector('[draggable="true"]')).toBeNull()
    expect(container.textContent).toContain('Bulk changes can partly succeed')
  })

  it('shows visible drop targets and persists feed and folder order through commands', async () => {
    await render(); await click('Expand Essays')
    await drag(button('Second'), 'dragstart')
    const before = [...container.querySelectorAll<HTMLElement>('.organization-drop')].find(item => item.textContent === 'Place before First')!
    await drag(before, 'dragover'); expect(before.classList.contains('over')).toBe(true)
    await drag(before, 'drop')
    expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'order-feeds', folderId: 'a', feedIds: ['Second', 'First'] }])
    expect(container.querySelector('.organization-drop')).toBeNull()
    await drag(button('Empty'), 'dragstart')
    await drag([...container.querySelectorAll<HTMLElement>('.organization-drop')].find(item => item.textContent === 'Place before Essays')!, 'drop')
    expect(vi.mocked(api.organize).mock.calls[1][0].commands).toEqual([{ type: 'move-folder', folderId: 'b', beforeId: 'a' }])
  })

  it('offers keyboard ordering equivalent to drag/drop and folder drop moves under FreshRSS', async () => {
    await render(); await click('Expand Essays'); await click('Options for Second'); await click('Move up')
    expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'order-feeds', folderId: 'a', feedIds: ['Second', 'First'] }])
    await act(async () => update({ ...snapshot, backend: 'freshrss', revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES }))
    await drag(button('First'), 'dragstart')
    expect(container.textContent).not.toContain('Place before')
    await drag([...container.querySelectorAll<HTMLElement>('.organization-drop')].find(item => item.textContent === 'Move to Empty')!, 'drop')
    expect(vi.mocked(api.organize).mock.calls[1][0]).toEqual({ expectedRevision: null, commands: [{ type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: 'b' }] })
  })
})
