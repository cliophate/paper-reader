import { clearOffline, setOfflineLocked } from './offline'

export interface AuthStatus { enabled: boolean; authenticated: boolean; passwordEnabled: boolean; passkeys: boolean }
let installed = false
export function requireLogin() {
  setOfflineLocked(true)
  localStorage.setItem('paper-login-required', 'true')
  void clearOffline()
  window.dispatchEvent(new Event('paper-login-required'))
}
export function installAuthHandling() {
  if (installed) return
  installed = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.origin === location.origin && url.pathname.startsWith('/api/') && response.status === 401
      && !['/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/auth/passkeys/verify'].includes(url.pathname)) requireLogin()
    return response
  }
  window.addEventListener('storage', event => {
    if (event.key === 'paper-login-required' && event.newValue === 'true') {
      setOfflineLocked(true); void clearOffline(); window.dispatchEvent(new Event('paper-login-required'))
    }
  })
}
export async function authRequest<T = { ok: boolean }>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api/auth${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Could not complete the access request.')
  return value as T
}
