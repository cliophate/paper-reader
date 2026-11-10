// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedSettings } from '../src/client/components/FeedSettings'
import { SubscriptionTools } from '../src/client/components/SubscriptionTools'
import { subscriptionToolsApi as api } from '../src/client/subscriptionToolsApi'
import type { ImportPreview } from '../src/shared/subscription-tools'
vi.mock('../src/client/subscriptionToolsApi', () => ({ subscriptionToolsApi: { discover: vi.fn(), preview: vi.fn(), previewFeed: vi.fn(), apply: vi.fn(), export: vi.fn() } }))
let root: Root, container: HTMLDivElement, preview: ImportPreview
const changed = vi.fn(async () => {})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  preview = {
    token: 'synthetic-preview', multipleMemberships: false, folders: ['Reading'], warnings: ['FreshRSS applies one subscription at a time.'],
    rows: [{ key: '1', title: 'Example', url: 'https://example.test/rss', folders: ['News / World'], sourcePaths: [['News', 'World']], matches: [], suggestedId: null, repeatedUrl: false, folderConflict: false, identityConflict: false }],
  }
  vi.mocked(api.preview).mockResolvedValue(preview)
  vi.mocked(api.previewFeed).mockResolvedValue(preview)
  vi.mocked(api.apply).mockResolvedValue({ results: [{ key: '1', status: 'created', message: 'Subscription added.' }] })
  changed.mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.resetAllMocks() })
async function render(width = 1280) { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); await act(async () => root.render(<SubscriptionTools onChanged={changed} />)) }
const form = (name: string) => container.querySelector<HTMLFormElement>(`form[aria-label="${name}"]`)!
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
async function submit(name: string) { await act(async () => form(name).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function select(element: HTMLSelectElement, value: string) { await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) }) }
async function importPreview() {
  await enter(container.querySelector('textarea')!, '<opml><body/></opml>')
  await submit('Import OPML')
}

describe('subscription settings', () => {
  it('offers a visible transfer view separately from the full-height manager', async () => {
    await act(async () => root.render(<FeedSettings onChanged={changed}><div>Existing manager</div></FeedSettings>))
    expect(container.textContent).toContain('Existing manager')
    await act(async () => button('Discover and transfer').click())
    expect(form('Import OPML')).not.toBeNull()
    expect(container.querySelector('.feed-settings-transfer')).not.toBeNull()
    await act(async () => button('Manage feeds').click())
    expect(form('Import OPML')).toBeNull()
  })
  it.each([1280, 390])('uses labelled native controls and review forms at viewport width %i', async width => {
    await render(width)
    expect(form('Discover feeds').querySelector('input')?.closest('label')?.textContent).toContain('Website or feed URL')
    expect(form('Discover feeds').querySelector('button')?.type).toBe('submit')
    await importPreview()
    expect(form('Confirm subscription import').textContent).toContain('News / World')
    expect(form('Confirm subscription import').textContent).toContain('Duplicate policy')
    expect(container.querySelector('[role="grid"]')).toBeNull()
    const controls = [...form('Confirm subscription import').querySelectorAll('input,select,textarea')]
    expect(controls.every(element => Boolean(element.closest('label')))).toBe(true)
    expect(controls.every(element => element.getAttribute('tabindex') !== '-1')).toBe(true)
    const apply = button('Apply reviewed import'); apply.focus(); expect(document.activeElement).toBe(apply)
    // The native form submission path is shared by Enter and the submit button.
    await submit('Confirm subscription import')
    expect(api.apply).toHaveBeenCalledWith('synthetic-preview', [{ key: '1', action: 'create', folders: ['News / World'] }])
    expect(changed).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('created. Subscription added.')
  })

  it('requires a choice among multiple discovered candidates before previewing', async () => {
    vi.mocked(api.discover).mockResolvedValue({ responseUrl: 'https://example.test/', candidates: [{ url: 'https://example.test/rss', title: 'News', format: 'rss' }, { url: 'https://example.test/replies', title: 'Replies', format: 'atom' }] })
    await render()
    await enter(form('Discover feeds').querySelector('input')!, 'https://example.test/')
    await submit('Discover feeds')
    expect(button('Preview selected feed').disabled).toBe(true)
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios[0].name).toBe(radios[1].name)
    await act(async () => radios[1].click())
    await act(async () => button('Preview selected feed').click())
    expect(api.previewFeed).toHaveBeenCalledWith('https://example.test/replies', 'Replies')
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('defaults ambiguous URL matches to skip and requires explicit reuse and folder choice', async () => {
    preview.rows[0] = { ...preview.rows[0], repeatedUrl: true, folderConflict: true, matches: [{ id: 'existing', title: 'Existing', url: 'https://example.test/rss', folders: ['Reading'] }] }
    await render(); await importPreview()
    const action = form('Confirm subscription import').querySelector<HTMLSelectElement>('select')!
    expect(action.value).toBe('skip')
    expect(button('Apply reviewed import').disabled).toBe(true)
    expect(container.textContent).toContain('Folder collision')
    await select(action, 'reuse:existing')
    const folder = form('Confirm subscription import').querySelectorAll<HTMLSelectElement>('select')[1]
    expect(folder.value).toBe('keep')
    await select(folder, 'folder:Reading')
    await submit('Confirm subscription import')
    expect(api.apply).toHaveBeenCalledWith('synthetic-preview', [{ key: '1', action: 'reuse', existingId: 'existing', folders: ['Reading'] }])
  })

  it('keeps literal sentinel-like folder names selectable', async () => {
    preview.folders = ['__keep', 'keep', 'none']
    await render(); await importPreview()
    const folder = form('Confirm subscription import').querySelectorAll<HTMLSelectElement>('select')[1]
    await select(folder, 'folder:__keep')
    await submit('Confirm subscription import')
    expect(api.apply).toHaveBeenCalledWith('synthetic-preview', [{ key: '1', action: 'create', folders: ['__keep'] }])
  })

  it.each(['existing', 'source'])('keeps typing a folder name that extends the %s name', async source => {
    if (source === 'existing') preview.folders = ['News']
    else preview.rows[0].folders = ['News']
    await render(); await importPreview()
    const input = form('Confirm subscription import').querySelector<HTMLInputElement>('input[type="text"]')!
    const name = 'News 2'
    for (const [index, character] of [...name].entries()) {
      await enter(input, input.value + character)
      expect(input.value).toBe(name.slice(0, index + 1))
    }
    await submit('Confirm subscription import')
    expect(api.apply).toHaveBeenCalledWith('synthetic-preview', [{ key: '1', action: 'create', folders: [name] }])
  })

  it('clears the custom draft when choosing another destination or making a new preview', async () => {
    await render(); await importPreview()
    const input = form('Confirm subscription import').querySelector<HTMLInputElement>('input[type="text"]')!
    await enter(input, 'Custom folder')
    await select(form('Confirm subscription import').querySelectorAll<HTMLSelectElement>('select')[1], 'folder:Reading')
    expect(input.value).toBe('')
    await submit('Confirm subscription import')
    expect(api.apply).toHaveBeenLastCalledWith('synthetic-preview', [{ key: '1', action: 'create', folders: ['Reading'] }])
    await importPreview()
    await enter(form('Confirm subscription import').querySelector<HTMLInputElement>('input[type="text"]')!, 'Another draft')
    await importPreview()
    expect(form('Confirm subscription import').querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('')
  })

  it('keeps per-item outcomes after navigation refresh fails, and refresh does not replay writes', async () => {
    changed.mockRejectedValueOnce(new Error('offline'))
    vi.mocked(api.apply).mockResolvedValue({ results: [{ key: '1', status: 'failed', message: 'May have been partly applied. Preview again.' }] })
    await render(); await importPreview(); await submit('Confirm subscription import')
    expect(container.textContent).toContain('failed. May have been partly applied')
    expect(container.textContent).toContain('Their results still apply')
    expect(form('Confirm subscription import')).toBeNull()
    await act(async () => button('Refresh navigation').click())
    expect(api.apply).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('discards consumed previews when the response is lost and reports uncertain remote results', async () => {
    vi.mocked(api.apply).mockRejectedValue(new Error('Response lost.'))
    await render(); await importPreview(); await submit('Confirm subscription import')
    expect(form('Confirm subscription import')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Some items may have changed')
    expect(changed).toHaveBeenCalledOnce()
  })

  it('rejects oversized files before upload and reports export omissions before downloading', async () => {
    vi.mocked(api.export).mockResolvedValue({ xml: '<opml/>', omitted: 2 })
    await render()
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [{ size: 1024 * 1024 + 1 }] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(api.preview).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('1 MiB')
    await act(async () => button('Prepare OPML export').click())
    expect(container.textContent).toContain('2 outlines were omitted')
    expect(button('Download OPML')).not.toBeUndefined()
  })
})
