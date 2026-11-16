// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrganizationSidebar } from '../src/client/components/OrganizationSidebar'
import { api, ApiError } from '../src/client/api'
import { FRESHRSS_ORGANIZATION_CAPABILITIES, LOCAL_ORGANIZATION_CAPABILITIES, MINIFLUX_ORGANIZATION_CAPABILITIES } from '../src/server/organization'
import type { OrganizationView } from '../src/shared/organization'
import type { Feed } from '../src/client/types'

vi.mock('../src/client/api', async original => ({ ...await original<typeof import('../src/client/api')>(), api: { organization: vi.fn(), organize: vi.fn() } }))
const feed = (id: string): Feed => ({ id, title: id, url: 'https://example.test/feed', siteUrl: '', iconUrl: '', categories: [], unread: 0, lastPublishedAt: null, lastCheckedAt: null, lastErrorAt: null, broken: false })
let root: Root, container: HTMLDivElement, snapshot: OrganizationView
let update: (next: OrganizationView) => void
const opened = vi.fn(), changed = vi.fn(), managed = vi.fn(), addFeed = vi.fn()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  snapshot = { backend: 'standalone', revision: 4, capabilities: LOCAL_ORGANIZATION_CAPABILITIES, navigation: { unread: 0, starred: 0, folders: [{ id: 'a', title: 'Essays', unread: 0, feeds: [feed('First'), feed('Second')] }, { id: 'b', title: 'Empty', unread: 0, feeds: [] }, { id: 'c', title: 'Other', unread: 0, feeds: [feed('First')] }], uncategorized: [feed('Unfiled')] } }
  vi.mocked(api.organize).mockImplementation(async ({ commands }) => ({ snapshot, results: commands.map((_, index) => ({ index, status: 'applied', changed: true })) }))
  vi.mocked(api.organization).mockImplementation(async () => snapshot)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.resetAllMocks(); vi.unstubAllGlobals() })
async function render(options: { online?: boolean; unreadOnly?: boolean } = {}) {
  function Host() {
    const [value, setValue] = useState(snapshot); update = setValue
    return <OrganizationSidebar snapshot={value} navigation={value.navigation} active={{ kind: 'feed', id: 'First', title: 'First' }} unreadOnly={options.unreadOnly ?? false} online={options.online ?? true} onSnapshot={next => { changed(next); setValue(next) }} onOpen={opened} onMarkFeed={vi.fn()} onMarkFolder={vi.fn()} onManage={managed} onAddFeed={addFeed} />
  }
  await act(async () => root.render(<Host />))
}
const button = (name: string, parent: ParentNode = document) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name || item.querySelector('.source-label')?.textContent === name || item.getAttribute('aria-label') === name)!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
async function click(name: string, parent: ParentNode = document) { const item = button(name, parent); expect(item, name).toBeTruthy(); await act(async () => { item.focus(); item.click() }) }
async function editFeeds() { await click('Edit feeds') }
async function key(element: Element, key: string, shiftKey = false) { await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })) }) }
async function enter(value: string) { await act(async () => { const input = dialog().querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function select(value: string) { await act(async () => { const input = dialog().querySelector('select')!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function submit() { await act(async () => { dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
async function pointer(element: Element, type: string, x = 0, y = 0) {
  await act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    element.dispatchEvent(event)
  })
}
async function dragTo(handle: Element, row: Element) {
  HTMLElement.prototype.setPointerCapture = vi.fn()
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => row) })
  await pointer(handle, 'pointerdown')
  await pointer(handle, 'pointermove', 20, 0)
}

describe('sidebar organization interactions', () => {
  it('hides broken feeds with zero unread in unread-only mode and labels them otherwise', async () => {
    snapshot.navigation.folders[0].feeds[0].broken = true
    snapshot.navigation.uncategorized[0].broken = true
    await render({ unreadOnly: true })
    expect(button('Essays')).toBeUndefined()
    expect(button('Uncategorized')).toBeUndefined()
    await act(async () => root.unmount())
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await render()
    await click('Expand Essays')
    await click('Uncategorized')
    expect(button('First').textContent).toContain('Update failed')
    expect(button('Unfiled').textContent).toContain('Update failed')
    await editFeeds()
    expect(button('First').textContent).toContain('Update failed')
  })

  it('totals Uncategorized unread counts and hides the count when all its feeds are read', async () => {
    snapshot.navigation.uncategorized = [{ ...feed('Unfiled'), unread: 2 }, { ...feed('Another'), unread: 3 }]
    await render()
    expect(button('Uncategorized').querySelector('.source-count')?.textContent).toBe('5')
    await editFeeds()
    expect(button('Uncategorized').querySelector('.source-count')?.textContent).toBe('5')
    await act(async () => update({ ...snapshot, navigation: { ...snapshot.navigation, uncategorized: snapshot.navigation.uncategorized.map(item => ({ ...item, unread: 0 })) } }))
    expect(button('Uncategorized').querySelector('.source-count')).toBeNull()
  })

  it('gives feed titles room in edit mode and restores icons and counts when done', async () => {
    snapshot.navigation.folders[0].feeds[0].unread = 3
    await render(); await click('Expand Essays')
    expect(button('First').querySelector('.feed-mark')).not.toBeNull()
    expect(button('First').querySelector('.source-count')?.textContent).toBe('3')
    await editFeeds()
    expect(button('First').querySelector('.feed-mark, .source-count')).toBeNull()
    expect(button('First').querySelector('.source-label')?.textContent).toBe('First')
    expect(button('Move First')).toBeTruthy()
    expect(button('Options for First')).toBeTruthy()
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
    await click('Done')
    expect(button('First').querySelector('.feed-mark')).not.toBeNull()
    expect(button('First').querySelector('.source-count')?.textContent).toBe('3')
  })

  it('requires a real Miniflux destination category and sends its stable ID with no revision', async () => {
    snapshot = { ...snapshot, backend: 'miniflux', revision: null, capabilities: MINIFLUX_ORGANIZATION_CAPABILITIES,
      navigation: { ...snapshot.navigation, uncategorized: [] } }
    await render(); await editFeeds()
    expect(container.textContent).toContain('Miniflux supports feed edits')
    expect(button('Uncategorized')).toBeUndefined()
    await click('Expand Essays'); await click('Options for First'); await click('Move feed')
    const options = [...dialog().querySelectorAll('option')]
    expect(options.map(option => option.value)).toEqual(['a', 'b', 'c'])
    expect(options.some(option => option.value === '')).toBe(false)
    await select('b'); await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: null, commands: [{ type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: 'b' }] })
  })
  it('keeps the Feeds heading and add menu visible in edit mode, with contextual selection and focus restoration', async () => {
    snapshot.navigation.folders[0].unread = 3
    snapshot.navigation.folders[0].feeds[0].unread = 3
    await render()
    expect(button('Essays').querySelector('.source-count')?.textContent).toBe('3')
    expect(container.querySelector('.organization-header h2')?.textContent).toBe('Feeds')
    expect(button('Organize feeds')).toBeUndefined()
    expect(button('New folder')).toBeUndefined()
    await click('Add feed or folder')
    expect(document.activeElement?.textContent).toBe('Add feed')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('New folder')
    await key(document.activeElement!, 'Escape')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Add feed or folder')
    await click('Add feed or folder'); await click('Add feed')
    expect(addFeed).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await editFeeds()
    expect(button('Essays').querySelector('.source-count')?.textContent).toBe('3')
    expect(button('Options for Essays')).toBeTruthy()
    expect(button('Move Essays')).toBeTruthy()
    expect(container.querySelector('.organization-header h2')?.textContent).toBe('Feeds')
    expect(document.activeElement?.textContent).toBe('Done')
    expect(button('Add feed or folder').disabled).toBe(false)
    expect(container.textContent).not.toContain('0 selected')
    await click('Expand Essays')
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(container.querySelector('.organization-header h2')?.textContent).toBe('Feeds')
    expect(container.querySelector('.organization-bulk')?.textContent).toContain('1 selected')
    expect(button('Move selected')).toBeTruthy()
    await click('Done')
    expect(container.querySelector('input[type="checkbox"], .organization-handle, .row-options')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit feeds')
  })

  it('Done closes stale menus and clears selection before a new edit session', async () => {
    await render(); await editFeeds(); await click('Expand Essays')
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await click('Add feed or folder')
    expect(button('New folder')).toBeTruthy()
    await click('Done')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit feeds')
    await editFeeds()
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
    expect(container.querySelector('.organization-bulk')).toBeNull()
    await click('Options for Essays'); await click('Done')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit feeds')
    expect(api.organize).not.toHaveBeenCalled()
  })

  it('Done cancels keyboard placement without saving or leaving a stale grip', async () => {
    await render(); await editFeeds()
    const grip = button('Move Empty')
    await key(grip, ' '); await key(grip, 'ArrowUp')
    expect(container.querySelector('[data-drop-edge]')).not.toBeNull()
    await click('Done')
    expect(container.querySelector('[data-drop-edge], .organization-handle')).toBeNull()
    await key(grip, 'Enter')
    expect(api.organize).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit feeds')
  })

  it('offers Add feed without New folder for FreshRSS and disables adding offline', async () => {
    snapshot = { ...snapshot, backend: 'freshrss', revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES }
    await render(); await click('Add feed or folder')
    expect(button('Add feed')).toBeTruthy()
    expect(button('New folder')).toBeUndefined()
    await key(document.activeElement!, 'Escape')
    await render({ online: false })
    expect(button('Add feed or folder').disabled).toBe(true)
  })

  it('supports keyboard context menus, arrow navigation, Escape and focus restoration', async () => {
    await render(); await click('Expand Essays')
    expect(container.querySelector('.organization-handle, .row-options, input[type="checkbox"]')).toBeNull()
    const row = button('First'); row.focus()
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    expect(button('Rename feed')).toBeTruthy()
    expect(button('Done')).toBeUndefined()
    await key(document.activeElement!, 'Escape')
    expect(document.activeElement).toBe(row)
    await key(row, 'F10', true)
    expect(document.activeElement?.textContent).toBe('Open feed')
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('Rename feed')
    await key(document.activeElement!, 'End')
    expect(document.activeElement?.textContent).toBe('Unsubscribe')
    await key(document.activeElement!, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(row)
    expect(button('Edit feeds')).toBeTruthy()
    expect(container.querySelector('.organization-handle, .row-options')).toBeNull()
    expect(api.organize).not.toHaveBeenCalled()
  })

  it('renames in place, keeps selection, and returns focus to the same row options', async () => {
    await render(); await editFeeds(); await click('Expand Essays'); await click('Options for First'); await click('Rename feed')
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
    await render(); await editFeeds(); await click('Options for Essays'); await click('Rename folder')
    await act(async () => update({ ...snapshot, revision: 7 }))
    await enter('New name'); await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'rename-folder', folderId: 'a', title: 'New name' }] })
  })

  it('shows empty folders while organizing unread feeds and creates a folder without navigation', async () => {
    await render({ unreadOnly: true })
    expect(button('Options for Empty')).toBeUndefined()
    await editFeeds(); await click('Expand Empty')
    expect(container.textContent).toContain('No feeds')
    await click('Done'); await click('Add feed or folder'); await click('New folder'); await enter('Quiet'); await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'create-folder', title: 'Quiet' }] })
    expect(opened).not.toHaveBeenCalled()
  })

  it('explains removal and merge semantics and requires explicit confirmation', async () => {
    await render(); await editFeeds(); await click('Options for Essays'); await click('Remove folder')
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
    await render(); await editFeeds(); await click('Expand Essays'); await click('Options for First'); await click('Unsubscribe')
    expect(api.organize).not.toHaveBeenCalled()
    await key(button('Cancel', dialog()), 'Tab', true)
    expect(document.activeElement?.textContent).toBe('Confirm unsubscribe')
    await key(document.activeElement!, 'Tab')
    expect(document.activeElement?.textContent).toBe('Cancel')
    snapshot = structuredClone(snapshot); snapshot.navigation.folders.forEach(folder => { folder.feeds = folder.feeds.filter(feed => feed.id !== 'First') })
    await click('Confirm unsubscribe')
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'unsubscribe', feedId: 'First' }] })
    expect(document.activeElement?.textContent).toBe('Done')
  })

  it('preserves source membership in moves and explains moving a multi-folder feed to Uncategorized', async () => {
    await render(); await editFeeds(); await click('Expand Essays'); await click('Options for First'); await click('Move feed')
    expect(dialog().textContent).toContain('Other folders keep this feed')
    expect(dialog().textContent).toContain('only when no memberships remain')
    await submit()
    expect(api.organize).toHaveBeenCalledWith({ expectedRevision: 4, commands: [{ type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: null }] })
    await click('Uncategorized'); await click('Options for Unfiled'); await click('Move feed'); await select('b'); await submit()
    expect(api.organize).toHaveBeenLastCalledWith({ expectedRevision: 4, commands: [{ type: 'move-feed', feedId: 'Unfiled', fromFolderId: null, toFolderId: 'b' }] })
  })

  it('keeps only failed bulk selections and identifies the failed feeds without replaying successes', async () => {
    await render(); await editFeeds(); await click('Expand Essays')
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
    await render(); await editFeeds(); await click('Expand Essays'); await click('Expand Other')
    for (const input of container.querySelectorAll<HTMLInputElement>('input[aria-label^="Select First"]')) await act(async () => input.click())
    await click('Unsubscribe selected')
    expect(dialog().textContent).toContain('Unsubscribe from 1 feed?')
    expect(api.organize).not.toHaveBeenCalled()
    await click('Confirm unsubscribe')
    expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'unsubscribe', feedId: 'First' }])
  })

  it('blocks stale writes until reload and never retries automatically', async () => {
    await render(); await editFeeds(); await click('Options for Essays'); await click('Rename folder'); await enter('New')
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
    await render(); await editFeeds(); await click('Options for Essays'); await click('Rename folder'); await enter('Changed')
    vi.mocked(api.organize).mockResolvedValueOnce({ snapshot: null, results: [{ index: 0, status: 'applied', changed: true }], refreshError: 'Navigation could not reload.' })
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1 of 1 changes confirmed. Navigation could not reload.')
    expect(button('Add feed or folder').disabled).toBe(true)
    expect(api.organize).toHaveBeenCalledTimes(1)
  })

  it('limits FreshRSS menus and drag targets to supported operations and disables offline writes', async () => {
    snapshot = { ...snapshot, backend: 'freshrss', revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES }
    await render({ online: false }); await editFeeds(); await click('Options for Essays')
    expect(button('New folder')).toBeUndefined(); expect(button('Rename folder')).toBeUndefined(); expect(button('Move down')).toBeUndefined()
    await key(document.activeElement!, 'Escape'); await click('Expand Essays'); await click('Options for First')
    expect(button('Rename feed').disabled).toBe(true); expect(button('Move feed').disabled).toBe(true)
    expect(container.querySelector('[draggable="true"]')).toBeNull()
    expect(container.textContent).toContain('Bulk changes can partly succeed')
  })

  it('preserves FreshRSS named Uncategorized without adding a duplicate empty group', async () => {
    snapshot = { ...snapshot, backend: 'freshrss', revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES }
    snapshot.navigation.uncategorized = []
    snapshot.navigation.folders[0].title = 'Uncategorized'
    await render(); await editFeeds()
    expect([...container.querySelectorAll('.folder-row .source-label')].filter(item => item.textContent === 'Uncategorized')).toHaveLength(1)
    await click('Expand Uncategorized'); await click('Options for First'); await click('Move feed')
    expect(dialog().textContent).toContain('FreshRSS returns feeds without a chosen folder to its default category')
    expect([...dialog().querySelectorAll('option')].map(item => item.textContent)).toEqual(['Default folder', 'Uncategorized', 'Empty', 'Other'])
  })

  it('drags only from a grip, shows an insertion line, and saves feed order', async () => {
    await render(); await editFeeds(); await click('Expand Essays')
    const grip = button('Move Second')
    await dragTo(grip, button('First'))
    expect(container.querySelector('[data-drop-edge="before"]')?.textContent).toContain('First')
    expect(container.querySelector('.organization-drop')).toBeNull()
    expect(document.querySelector('.organization-drag-preview > span')?.textContent).toBe('Second')
    await pointer(grip, 'pointerup', 20, 0)
    expect(vi.mocked(api.organize).mock.calls[0][0]).toEqual({ expectedRevision: 4, commands: [{ type: 'order-feeds', folderId: 'a', feedIds: ['Second', 'First'] }] })
    expect(container.querySelector('[data-drop-edge]')).toBeNull()
    expect(opened).not.toHaveBeenCalled()
    expect(button('First').draggable).toBe(false)
    await click('First')
    expect(opened).toHaveBeenCalledWith({ kind: 'feed', id: 'First', title: 'First' })
  })

  it('supports keyboard grip ordering, Escape cancellation, and the captured revision', async () => {
    await render(); await editFeeds()
    const grip = button('Move Empty')
    grip.focus()
    await key(grip, ' '); await key(grip, 'ArrowUp')
    expect(container.querySelector('[data-drop-edge="before"]')?.textContent).toContain('Essays')
    await act(async () => update({ ...snapshot, revision: 8 }))
    await key(grip, 'Enter')
    expect(vi.mocked(api.organize).mock.calls[0][0]).toEqual({ expectedRevision: 4, commands: [{ type: 'move-folder', folderId: 'b', beforeId: 'a' }] })
    expect(document.activeElement).toBe(grip)
    await key(grip, ' '); await key(grip, 'ArrowDown'); await key(grip, 'Escape')
    expect(api.organize).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-drop-edge]')).toBeNull()
  })

  it('moves only the dragged membership, including to Uncategorized, and cancels pointer gestures', async () => {
    await render(); await editFeeds(); await click('Expand Essays')
    const grip = button('Move First')
    await dragTo(grip, button('Empty'))
    expect(container.querySelector('[data-drop-edge="inside"]')?.textContent).toContain('Empty')
    await pointer(grip, 'pointercancel')
    expect(api.organize).not.toHaveBeenCalled()
    await dragTo(grip, button('Other')); await pointer(grip, 'pointerup')
    expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: 'c' }])
    await dragTo(grip, button('Uncategorized')); await pointer(grip, 'pointerup')
    expect(vi.mocked(api.organize).mock.calls[1][0].commands).toEqual([{ type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: null }])
  })

  it.each([false, true])('atomically moves and orders at the destination, existing membership=%s', async alreadyMember => {
    snapshot.navigation.folders[2].feeds = [...(alreadyMember ? [feed('First')] : []), feed('Third'), feed('Fourth')]
    await render(); await editFeeds(); await click('Expand Essays'); await click('Expand Other')
    const grip = button('Move First')
    await dragTo(grip, button('Fourth'))
    expect(container.querySelector('[data-drop-edge="before"]')?.textContent).toContain('Fourth')
    await act(async () => update({ ...snapshot, revision: 9 }))
    await pointer(grip, 'pointerup')
    expect(vi.mocked(api.organize).mock.calls[0][0]).toEqual({ expectedRevision: 4, commands: [
      { type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: 'c' },
      { type: 'order-feeds', folderId: 'c', feedIds: ['Third', 'First', 'Fourth'] },
    ] })
  })

  it('removes only the source membership when a multiply-filed feed is dropped onto an Uncategorized row', async () => {
    await render(); await editFeeds(); await click('Expand Essays'); await click('Uncategorized')
    const grip = button('Move First')
    await dragTo(grip, button('Unfiled'))
    expect(container.querySelector('[data-drop-edge="inside"]')?.textContent).toContain('Unfiled')
    expect(container.querySelector('[data-drop-edge="before"]')).toBeNull()
    expect(document.querySelector('.organization-drag-preview')?.textContent).toContain('Remove from Essays; keep other folders')
    await pointer(grip, 'pointerup')
    expect(vi.mocked(api.organize).mock.calls[0][0]).toEqual({ expectedRevision: 4, commands: [
      { type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: null },
    ] })
  })

  it('puts an after-folder line below its expanded children', async () => {
    await render(); await editFeeds(); await click('Expand Other')
    const grip = button('Move Essays')
    await dragTo(grip, button('Other'))
    await pointer(grip, 'pointermove', 20, 20)
    const subtree = button('Other').closest('.folder')!
    expect(subtree.hasAttribute('data-folder-drop-after')).toBe(true)
    expect(subtree.querySelector('.feed-list')).not.toBeNull()
    expect(button('Other').closest('[data-organization-row]')!.hasAttribute('data-drop-edge')).toBe(false)
    await pointer(grip, 'pointerup')
    expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'move-folder', folderId: 'a', beforeId: null }])
  })

  it.each(['drop', 'Escape', 'lostcapture', 'Done', 'unmount'])('scrolls with a stationary pointer and stops on %s', async ending => {
    const frames = new Map<number, FrameRequestCallback>()
    let serial = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    container.classList.add('source-nav')
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100 } as DOMRect)
    await render(); await editFeeds(); await click('Expand Essays')
    const grip = button('Move Second')
    await dragTo(grip, button('First'))
    await pointer(grip, 'pointermove', 20, 99)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => button('Empty')) })
    const frame = async () => { const [id, callback] = [...frames][0]; frames.delete(id); await act(async () => callback(0)) }
    await frame(); await frame()
    expect(container.scrollTop).toBeGreaterThan(16)
    expect(container.querySelector('[data-drop-edge="inside"]')?.textContent).toContain('Empty')
    if (ending === 'drop') {
      await pointer(grip, 'pointerup')
      expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'move-feed', feedId: 'Second', fromFolderId: 'a', toFolderId: 'b' }])
    } else if (ending === 'Escape') await key(grip, 'Escape')
    else if (ending === 'lostcapture') await pointer(grip, 'lostpointercapture')
    else if (ending === 'Done') {
      await click('Done')
      expect(container.querySelector('[data-drop-edge]')).toBeNull()
      expect(container.querySelector('[data-organization-handle]')).toBeNull()
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Edit feeds')
      await pointer(grip, 'pointerup')
    }
    else await act(async () => root.unmount())
    expect(frames.size).toBe(0)
    if (ending !== 'drop') expect(api.organize).not.toHaveBeenCalled()
  })

  it('keeps menu ordering and gates FreshRSS drag operations', async () => {
    await render(); await editFeeds(); await click('Expand Essays'); await click('Options for Second'); await click('Move up')
    expect(vi.mocked(api.organize).mock.calls[0][0].commands).toEqual([{ type: 'order-feeds', folderId: 'a', feedIds: ['Second', 'First'] }])
    await act(async () => update({ ...snapshot, backend: 'freshrss', revision: null, capabilities: FRESHRSS_ORGANIZATION_CAPABILITIES }))
    expect(button('Move Essays')).toBeUndefined()
    const grip = button('Move First')
    await key(grip, 'Enter')
    expect(button('Move feed')).toBeTruthy()
    await key(document.activeElement!, 'Escape')
    await dragTo(grip, button('Second'))
    expect(container.querySelector('[data-drop-edge]')).toBeNull()
    await pointer(grip, 'pointercancel')
    await dragTo(grip, button('Empty')); await pointer(grip, 'pointerup')
    expect(vi.mocked(api.organize).mock.calls[1][0]).toEqual({ expectedRevision: null, commands: [{ type: 'move-feed', feedId: 'First', fromFolderId: 'a', toFolderId: 'b' }] })
  })
})
