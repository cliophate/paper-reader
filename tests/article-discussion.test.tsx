// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArticleDiscussion } from '../src/client/components/ArticleDiscussion'
import type { Discussion } from '../src/shared/discussion'
import type { Entry } from '../src/client/types'

let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('article discussion interface', () => {
  it('opens without generating a reply, attaches selections, renders references safely and ignores stale HTTP responses', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const saved: Discussion = { entryId: 'one', revision: 1, source: { title: 'Article', author: 'Writer', url: 'https://example.com', kind: 'feed', warning: 'Feed text may be incomplete.', paragraphs: [{ id: 'P1', text: 'The chair has a low seat and no armrests.' }] }, messages: [] }
    let events: any
    vi.stubGlobal('EventSource', class { onmessage: any; onerror: any; onopen: any; constructor() { events = this } close() {} })
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/message')) {
        const message = JSON.parse(String(init?.body))
        expect(message.quote).toBe('The chair has a low seat and no armrests.')
        const current: Discussion = { ...saved, revision: 3, messages: [{ id: 'answer', role: 'assistant', text: 'Evidence [P1]. <script>alert(1)</script>', status: 'complete' }] }
        events.onmessage({ data: JSON.stringify(current) })
        return new Response(JSON.stringify({ ...saved, revision: 2, messages: [{ ...current.messages[0], text: '', status: 'running' }] }))
      }
      return new Response(JSON.stringify({ discussion: saved, enabled: true }))
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<ArticleDiscussion entry={{ id: 'one', title: 'Article' } as Entry} initialQuote="The chair has a low seat and no armrests." onClose={() => {}} />))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Explain?')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(container.textContent).toContain('Evidence [P1]')
    expect(container.textContent).not.toContain('Thinking...')
    expect(container.querySelector('script')).toBeNull()
    await act(async () => (container.querySelector('.discussion-citation') as HTMLButtonElement).click())
    expect(container.querySelector('.discussion-passage')?.textContent).toContain('The chair has a low seat')
  })
})
