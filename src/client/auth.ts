import { ApiError } from './api'
import { signOutKey, signOutPending } from './offlineAccess'
import { withReplayLock } from './offlineQueue'
import { clearOffline, setOfflineLocked } from './offline'

export interface AuthStatus { setup?: 'freshrss' | 'miniflux'; enabled: boolean; authenticated: boolean; passwordEnabled: boolean; passkeys: boolean }
let installed = false
export function requireLogin() {
  setOfflineLocked(true)
  localStorage.setItem('paper-login-required', 'true')
  void withReplayLock(clearOffline)
  window.dispatchEvent(new Event('paper-login-required'))
}
async function finishSignOut() {
  if (!signOutPending()) return
  await withReplayLock(async () => {
    if (!signOutPending()) return
    setOfflineLocked(true)
    await clearOffline()
    localStorage.setItem('paper-login-required', 'true')
    window.dispatchEvent(new Event('paper-login-required'))
    try { await authRequest('/logout', {}) }
    catch (error) {
      // A previous request can revoke the session before its response arrives.
      if (!(error instanceof ApiError && error.status === 401)) throw error
      if (error.code !== 'login-required' && (await authRequest<AuthStatus>('/status')).authenticated !== false) throw error
    }
    if (!signOutPending()) return
    localStorage.setItem(signOutKey, 'true')
    window.dispatchEvent(new Event('paper-login-required'))
  })
}

export function signOut() {
  localStorage.setItem(signOutKey, 'pending')
  setOfflineLocked(true)
  return finishSignOut()
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
    if (event.key === signOutKey && (event.newValue === 'pending' || event.newValue === 'true')) {
      setOfflineLocked(true)
      window.dispatchEvent(new Event('paper-login-required'))
    }
    if (event.key === 'paper-login-required' && event.newValue === 'true') {
      setOfflineLocked(true); void withReplayLock(clearOffline); window.dispatchEvent(new Event('paper-login-required'))
    }
  })
  const retrySignOut = () => { void finishSignOut().catch(() => { /* Retry while the sign-out flag is pending. */ }) }
  window.addEventListener('online', retrySignOut)
  window.setInterval(retrySignOut, 60_000)
  retrySignOut()
}
export async function authRequest<T = { ok: boolean }>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api/auth${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
  const value = await response.json()
  if (!response.ok) throw new ApiError(value.error || 'Could not complete the access request.', response.status, value.code)
  return value as T
}
