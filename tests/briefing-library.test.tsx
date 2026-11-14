// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingLibrary } from '../src/client/components/BriefingLibrary'
import { api } from '../src/client/api'
import type { BriefingDetail, BriefingReadResult } from '../src/shared/briefings'

vi.mock('../src/client/api', () => ({ api: { briefings: vi.fn(), briefing: vi.fn(), briefingFeedback: vi.fn(), markBriefingRead: vi.fn() } }))
let root: Root, container: HTMLDivElement, detail: BriefingDetail
const changed = vi.fn(), open = vi.fn()
const readResult = (): BriefingReadResult => ({ sourceIds: ['one', 'two'], briefing: { ...detail, status: 'acknowledged', acknowledgedAt: '2026-11-14T09:00:00Z', unreadCount: 0,
  sources: detail.sources.map(source => ({ ...source, read: true })) } })
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  detail = { id: 'briefing', kind: 'morning', subject: 'Paper morning | Synthetic library story', status: 'generated',
    windowStart: '2026-11-14T07:00:00Z', cutoff: '2026-11-14T08:00:00Z', createdAt: '2026-11-14T08:00:00Z',
    deliveredAt: null, acknowledgedAt: null, feedback: null, entryCount: 2, unreadCount: 2, missingCount: 0,
    sourceIds: ['one', 'two'], selection: { news: [{ headline: 'Synthetic library story', summary: 'The library opened a reading room.', entryIds: ['one', 'two'] }], worthNoticing: [], social: [] },
    sources: ['one', 'two'].map(id => ({ id, title: `Synthetic story ${id}`, url: `https://example.test/${id}`, feedTitle: 'Synthetic feed', author: '', read: false, kind: 'article', thumbnailUrl: '', text: '' })),
    html: '<script>throw new Error("Email HTML must not run")</script><iframe src="https://example.test"></iframe>', text: 'Email version' }
  vi.mocked(api.briefings).mockResolvedValue([detail])
  vi.mocked(api.briefing).mockResolvedValue(detail)
  vi.mocked(api.markBriefingRead).mockImplementation(async () => readResult())
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals() })
const button = (name: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!
const render = async (refreshKey = 0) => { await act(async () => root.render(<BriefingLibrary onBack={() => {}} onOpenEntry={open} onMarkedRead={changed} refreshKey={refreshKey} />)) }
const click = async (element: HTMLElement) => { await act(async () => element.click()) }

describe('briefing web flow', () => {
  it('confirms in a modal, keeps the page in place, and updates briefing and individual source badges after success', async () => {
    let finish!: (result: BriefingReadResult) => void
    vi.mocked(api.markBriefingRead).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await render()
    expect(container.querySelector('iframe,script')).toBeNull()
    expect(container.querySelectorAll('[data-read="false"]')).toHaveLength(2)
    await click(button('Mark briefing read'))
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('2 unread source stories')
    expect(dialog.textContent).toContain('Synthetic story one')
    expect(api.markBriefingRead).not.toHaveBeenCalled()
    await click(button('Mark briefing and stories read', dialog))
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(button('Marking read...', dialog).disabled).toBe(true)
    expect(changed).not.toHaveBeenCalled()
    await act(async () => finish(readResult()))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('.briefing-read-bar')?.textContent).toContain('All 2 source stories are read.')
    expect(button('Briefing read').disabled).toBe(true)
    expect(container.querySelectorAll('[data-read="true"]')).toHaveLength(2)
    expect(changed).toHaveBeenCalledWith(['one', 'two'])
    expect(api.markBriefingRead).toHaveBeenCalledWith('briefing')
  })

  it('cancels without writes and leaves an error in the modal when the reader fails', async () => {
    await render()
    await click(button('Mark briefing read'))
    await click(button('Cancel'))
    expect(api.markBriefingRead).not.toHaveBeenCalled()
    vi.mocked(api.markBriefingRead).mockRejectedValueOnce(new Error('Miniflux is unavailable'))
    await click(button('Mark briefing read'))
    await click(button('Mark briefing and stories read'))
    expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Miniflux is unavailable')
    expect(container.querySelectorAll('[data-read="false"]')).toHaveLength(2)
    expect(changed).not.toHaveBeenCalled()
    await click(button('Mark briefing and stories read'))
    expect(button('Briefing read').disabled).toBe(true)
  })

  it('refreshes acknowledgement and article state from the email flow without changing the selected briefing', async () => {
    await render()
    const result = readResult()
    vi.mocked(api.briefings).mockResolvedValue([result.briefing])
    vi.mocked(api.briefing).mockResolvedValue(result.briefing)
    await render(1)
    expect(button('Briefing read').disabled).toBe(true)
    expect(container.querySelectorAll('[data-read="true"]')).toHaveLength(2)
    expect(container.querySelector('.briefing-list .active')?.textContent).toContain('Read')
    expect(api.markBriefingRead).not.toHaveBeenCalled()
  })

  it('opens source stories in the reader and treats model text as text', async () => {
    detail.selection.intro = '<img src=x onerror=alert(1)>'
    await render()
    expect(container.querySelector('.briefing-intro')?.textContent).toBe(detail.selection.intro)
    expect(container.querySelector('.briefing-intro img')).toBeNull()
    await click(button('Synthetic story one'))
    expect(open).toHaveBeenCalledWith('one')
  })

  it('does not let an earlier background fetch overwrite a successful read confirmation', async () => {
    await render()
    let finishList!: (items: BriefingDetail[]) => void
    let finishDetail!: (item: BriefingDetail) => void
    vi.mocked(api.briefings).mockImplementationOnce(() => new Promise(resolve => { finishList = resolve }))
    vi.mocked(api.briefing).mockImplementationOnce(() => new Promise(resolve => { finishDetail = resolve }))
    await render(1)
    await click(button('Mark briefing read'))
    await click(button('Mark briefing and stories read'))
    await act(async () => { finishList([detail]); finishDetail(detail) })
    expect(button('Briefing read').disabled).toBe(true)
    expect(container.querySelectorAll('[data-read="true"]')).toHaveLength(2)
    expect(container.querySelector('.briefing-list .active .briefing-status')?.textContent).toBe('Read')
  })
})
