// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSettings } from '../src/client/components/ConnectionSettings'
import { api } from '../src/client/api'
import type { ConnectionsSettings } from '../src/shared/connections'

vi.mock('../src/client/api', () => ({ api: { connections: vi.fn(), updateConnections: vi.fn() } }))
let root: Root
let container: HTMLDivElement
let settings: ConnectionsSettings
const changed = vi.fn(async () => {})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  settings = {
    ai: { enabled: false, codexEnabled: true, discussionEnabled: true, briefingsEnabled: true, headlinesEnabled: true, collectionsEnabled: true },
    readwise: { enabled: true, location: 'later', tokenConfigured: true, tokenSource: 'environment' },
    kirby: { enabled: false, publishUrl: '', tokenConfigured: false, tokenSource: null },
  }
  vi.mocked(api.connections).mockResolvedValue(settings)
  vi.mocked(api.updateConnections).mockImplementation(async patch => {
    if (patch.readwise) settings = { ...settings, readwise: { ...settings.readwise, ...patch.readwise, tokenConfigured: patch.readwise.token === null ? false : true, tokenSource: patch.readwise.token === null ? null : 'settings' } }
    return settings
  })
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.resetAllMocks() })
const form = (name: string) => container.querySelector<HTMLFormElement>(`form[aria-label="${name}"]`)!
async function render() { await act(async () => root.render(<ConnectionSettings onChanged={changed} />)) }
async function submit(element: HTMLFormElement) { await act(async () => { element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('connection settings forms', () => {
  it('shows setup instructions and keeps existing tokens out of password fields', async () => {
    await render()
    expect(container.textContent).toContain('Every connection is optional')
    expect(container.textContent).toContain('Kirby\'s standard API alone will not work')
    expect(container.textContent).toContain('codex login --device-auth')
    expect(container.querySelector('a[href="https://readwise.io/access_token"]')).not.toBeNull()
    const input = form('Readwise Reader').querySelector<HTMLInputElement>('input[type="password"]')!
    expect(input.value).toBe('')
    expect(input.autocomplete).toBe('new-password')
    expect(form('Readwise Reader').textContent).toContain('provided by the server environment')
    await submit(form('Readwise Reader'))
    expect(api.updateConnections).toHaveBeenCalledWith({ readwise: { enabled: true, location: 'later' } })
    expect(changed).toHaveBeenCalledOnce()
  })

  it('shows worker availability and keeps deployment details out of saved settings', async () => {
    settings.aiRuntime = { available: false, message: 'AI is unavailable. Configure and start the isolated AI worker.' }
    await render()
    expect(form('AI features').textContent).toContain(settings.aiRuntime.message)
    expect(form('AI features').textContent).toContain('--no-deps paper-ai codex login')
    await submit(form('AI features'))
    expect(api.updateConnections).toHaveBeenCalledWith({ ai: settings.ai })
  })

  it('saves a replacement token and clears it from the form after saving', async () => {
    await render()
    const input = form('Readwise Reader').querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(input, 'synthetic-ui-token')
    await submit(form('Readwise Reader'))
    expect(api.updateConnections).toHaveBeenCalledWith({ readwise: { enabled: true, location: 'later', token: 'synthetic-ui-token' } })
    expect(input.value).toBe('')
    expect(form('Readwise Reader').textContent).toContain('settings saved')
  })

  it('stages token removal until Save and explicitly clears environment fallback', async () => {
    await render()
    const remove = [...form('Readwise Reader').querySelectorAll('button')].find(button => button.textContent === 'Remove token')!
    await act(async () => remove.click())
    expect(api.updateConnections).not.toHaveBeenCalled()
    expect(form('Readwise Reader').textContent).toContain('Environment tokens will also stay disabled')
    await submit(form('Readwise Reader'))
    expect(api.updateConnections).toHaveBeenCalledWith({ readwise: { enabled: true, location: 'later', token: null } })
    expect(form('Readwise Reader').textContent).toContain('Add a token to finish setup')
  })

  it('allows the AI master switch and individual features to be saved without changing tokens', async () => {
    await render()
    const ai = form('AI features')
    const toggle = (label: string) => [...ai.querySelectorAll('label')].find(item => item.textContent === label)!.querySelector<HTMLInputElement>('input')!
    expect(toggle('Article discussions').matches(':disabled')).toBe(true)
    await act(async () => toggle('Enable AI features').click())
    expect(toggle('Article discussions').matches(':disabled')).toBe(false)
    await act(async () => toggle('Clearer headlines').click())
    await submit(ai)
    expect(api.updateConnections).toHaveBeenCalledWith({ ai: { ...settings.ai, enabled: true, headlinesEnabled: false } })
  })

  it('reports save failures without clearing unsaved input or reporting success', async () => {
    await render()
    vi.mocked(api.updateConnections).mockRejectedValue(new Error('Could not save connection settings.'))
    const input = form('Readwise Reader').querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(input, 'synthetic-unsaved-token')
    await submit(form('Readwise Reader'))
    expect(input.value).toBe('synthetic-unsaved-token')
    expect(form('Readwise Reader').querySelector('[role="alert"]')?.textContent).toContain('Could not save')
    expect(form('Readwise Reader').querySelector('[role="status"]')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('shows a retry after a load failure', async () => {
    vi.mocked(api.connections).mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.querySelector('form')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(form('AI features')).not.toBeNull()
  })
})
