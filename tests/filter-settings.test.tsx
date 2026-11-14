// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FiltersSettings } from '../src/client/components/SettingsPanels'
import { api } from '../src/client/api'
import type { MuteFilter } from '../src/client/types'

vi.mock('../src/client/api', () => ({ api: { filters: vi.fn(), previewFilter: vi.fn(), addFilter: vi.fn(), removeFilter: vi.fn() } }))
const pending: MuteFilter = { id: 'filter', phrase: 'kelvin', scope: 'title', feedId: '', feedTitle: '', matchCount: 0, matching: true, createdAt: '2026-01-01' }
const changed = vi.fn(async () => {})
const notify = vi.fn()
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.mocked(api.filters).mockImplementation(async () => [{ ...pending }])
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })
async function render() { await act(async () => root.render(<FiltersSettings feeds={[]} onChanged={changed} notify={notify} />)) }
async function advance(ms = 2000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

it('polls pending filters, refreshes on completion, and stops polling', async () => {
  await render()
  expect(container.textContent).toContain('Matching...')
  expect(container.textContent).not.toContain('0 hidden')
  await advance(1999)
  expect(api.filters).toHaveBeenCalledTimes(1)
  await advance(1)
  expect(api.filters).toHaveBeenCalledTimes(2)
  vi.mocked(api.filters).mockResolvedValue([{ ...pending, matching: false, matchCount: 12 }])
  await advance()
  expect(container.textContent).toContain('12 hidden')
  expect(changed).toHaveBeenCalledTimes(1)
  await advance(10_000)
  expect(api.filters).toHaveBeenCalledTimes(3)
})

it('retries a failed poll and cancels polling when the panel unmounts', async () => {
  await render()
  vi.mocked(api.filters).mockRejectedValueOnce(new Error('Temporary failure'))
  await advance()
  expect(container.textContent).toContain('Temporary failure')
  await advance()
  expect(api.filters).toHaveBeenCalledTimes(3)
  await act(async () => root.render(null))
  await advance(10_000)
  expect(api.filters).toHaveBeenCalledTimes(3)
})

it('reenables creation while matching and announces no final count', async () => {
  vi.mocked(api.filters).mockResolvedValue([])
  vi.mocked(api.previewFilter).mockResolvedValue({ count: 1, items: [], truncated: false })
  vi.mocked(api.addFilter).mockResolvedValue(pending)
  await render()
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'kelvin')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="button"]')!.click())
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(api.addFilter).toHaveBeenCalledWith('kelvin', 'title', '')
  expect(input.disabled).toBe(false)
  expect(container.textContent).toContain('Matching...')
  expect(notify).toHaveBeenCalledWith('Filter added. Matching existing articles...')
  await advance()
  expect(api.filters).toHaveBeenCalledTimes(2)
})

it('reports pending matching to its parent and clears it when matching ends', async () => {
  const matching = vi.fn()
  await act(async () => root.render(<FiltersSettings feeds={[]} onChanged={changed} notify={notify} onMatchingChange={matching} />))
  expect(matching).toHaveBeenLastCalledWith(true)
  vi.mocked(api.filters).mockResolvedValue([{ ...pending, matching: false, matchCount: 2 }])
  await advance()
  expect(matching).toHaveBeenLastCalledWith(false)
})
