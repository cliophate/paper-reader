import { useEffect, useRef, useState } from 'react'
import { startRegistration, startAuthentication } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { authRequest, requireLogin, type AuthStatus } from '../auth'
import { clearOffline, setOfflineLocked } from '../offline'

interface Access {
  username: string; passwordEnabled: boolean
  passkeys: Array<{ id: string; name: string; created: number; used: number | null }>
  sessions: Array<{ id: string; created: number; seen: number; agent: string; current: boolean }>
  apps: Array<{ id: string; name: string; scope: string; created: number; used: number | null }>
}
const date = (value: number | null) => value ? new Date(value).toLocaleString() : 'Never'

export function OwnerForm({ setup, username = '', onSaved }: { setup: boolean; username?: string; onSaved: () => void }) {
  const [name, setName] = useState(username), [password, setPassword] = useState(''), [code, setCode] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <form className="access-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('')
    try { await authRequest(setup ? '/setup' : '/password', { username: name, password, ...(setup ? { code } : {}) }); setPassword(''); setCode(''); onSaved() }
    catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }}>
    {setup && <><p>Login is off. To enable it, use the setup code from Paper's startup log or run <code>npm run paper-auth -- setup-code</code> in the container. Codes expire after 15 minutes.</p><label>Setup code<input required autoComplete="off" value={code} onChange={event => setCode(event.target.value)} /></label></>}
    <label>Username<input required maxLength={80} autoComplete="username" value={name} onChange={event => setName(event.target.value)} /></label>
    <label>{setup ? 'Password' : 'New password'}<input required type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} /></label>
    <p>Use at least 12 characters.{!setup && ' Saving enables password login and signs out other sessions.'}</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    <button disabled={busy} type="submit">{busy ? 'Saving...' : setup ? 'Enable login' : 'Save credentials'}</button>
  </form>
}

export function LoginPage({ status, onSignedIn }: { status: AuthStatus; onSignedIn: () => void }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function login(passkey: boolean) {
    setBusy(true); setError('')
    try {
      if (passkey) {
        const options = await authRequest<PublicKeyCredentialRequestOptionsJSON>('/passkeys/options', {})
        const response = await startAuthentication({ optionsJSON: options })
        await authRequest('/passkeys/verify', response)
      } else await authRequest('/login', { username, password })
      setPassword(''); localStorage.removeItem('paper-login-required'); onSignedIn()
    } catch { setError('Could not sign in. Check your credentials or try again later. If you lost access, use the recovery command on the server.') }
    finally { setBusy(false) }
  }
  return <main className="login-page"><section className="login-card" aria-labelledby="login-title">
    <h1 id="login-title">Sign in to Paper</h1>
    {status.passwordEnabled && <form className="access-form" onSubmit={event => { event.preventDefault(); void login(false) }}>
      <label>Username<input autoFocus required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
    </form>}
    {status.passkeys && <button autoFocus={!status.passwordEnabled} disabled={busy} onClick={() => void login(true)}>Sign in with a passkey</button>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section></main>
}

export function AuthBoundary({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null), [error, setError] = useState('')
  const requestVersion = useRef(0)
  const load = async () => {
    const version = ++requestVersion.current
    try {
      const value = await authRequest<AuthStatus>('/status')
      if (version !== requestVersion.current) return
      setOfflineLocked(value.enabled && !value.authenticated)
      if (value.enabled && !value.authenticated) { await clearOffline(); localStorage.setItem('paper-login-required', 'true') }
      if (version !== requestVersion.current) return
      if (value.authenticated || !value.enabled) localStorage.removeItem('paper-login-required')
      localStorage.setItem('paper-login-enabled', String(value.enabled))
      setStatus(value); setError('')
    } catch {
      if (version !== requestVersion.current) return
      // Existing installations retain offline reading. Once login is enabled,
      // an unreachable server cannot prove that a saved session is still valid.
      if (localStorage.getItem('paper-login-enabled') !== 'true' && localStorage.getItem('paper-login-required') !== 'true') {
        setStatus({ enabled: false, authenticated: false, passwordEnabled: false, passkeys: false })
      } else { setStatus(null); setError('Connect to Paper to sign in.'); setOfflineLocked(true) }
    }
  }
  useEffect(() => {
    void load()
    const expired = () => { setStatus({ enabled: true, authenticated: false, passwordEnabled: true, passkeys: true }); void load() }
    const visible = () => { if (document.visibilityState === 'visible') void load() }
    window.addEventListener('paper-login-required', expired)
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 60_000)
    return () => { requestVersion.current++; window.removeEventListener('paper-login-required', expired); document.removeEventListener('visibilitychange', visible); clearInterval(timer) }
  }, [])
  if (!status) return <main className="login-page"><section className="login-card"><p role="status">{error || 'Opening Paper...'}</p>{error && <button onClick={() => void load()}>Try again</button>}</section></main>
  if (status.enabled && !status.authenticated) return <LoginPage status={status} onSignedIn={() => void load()} />
  return children
}

export function AccessSettings() {
  const [access, setAccess] = useState<Access | null>(null), [enabled, setEnabled] = useState<boolean | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [keyName, setKeyName] = useState(''), [appName, setAppName] = useState(''), [appPassword, setAppPassword] = useState('')
  const load = async () => { const status = await authRequest<AuthStatus>('/status'); setEnabled(status.enabled); if (status.enabled) setAccess(await authRequest<Access>('/access')) }
  useEffect(() => { void load().catch(reason => setError((reason as Error).message)) }, [])
  const run = async (work: () => Promise<unknown>, success = 'Saved.') => {
    setBusy(true); setError(''); setMessage('')
    try { await work(); await load(); setMessage(success) } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  return <section className="settings-page access-settings">
    <header><h3>Access</h3><p>One owner for this Paper library. An authenticated proxy can stay in front of Paper.</p></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p>With login on, Paper needs a connection to open. Saved offline articles cannot be opened while signed out.</p>
    <p role="status">{message}</p>
    {enabled === false && <OwnerForm setup onSaved={() => { localStorage.setItem('paper-login-enabled', 'true'); location.assign('/') }} />}
    {access && <>
      <h4>Owner credentials</h4><OwnerForm setup={false} username={access.username} onSaved={() => void load()} />
      <label className="access-toggle"><input type="checkbox" checked={access.passwordEnabled} disabled={busy || (!access.passkeys.length && access.passwordEnabled)} onChange={event => void run(() => authRequest('/password/enabled', { enabled: event.target.checked }))} /> Allow password login</label>
      <h4>Passkeys</h4>
      <form className="access-form" onSubmit={event => { event.preventDefault(); void run(async () => {
        const options = await authRequest<PublicKeyCredentialCreationOptionsJSON>('/passkeys/register/options', {})
        const response = await startRegistration({ optionsJSON: options })
        await authRequest('/passkeys/register/verify', { response, name: keyName }); setKeyName('')
      }, 'Passkey added.') }}>
        <label>Passkey name<input required maxLength={80} value={keyName} onChange={event => setKeyName(event.target.value)} placeholder="Phone" /></label>
        <button disabled={busy}>Add passkey</button>
      </form>
      <div className="settings-list">{access.passkeys.map(key => <article className="settings-list-row" key={key.id}><div><strong>{key.name}</strong><span>Added {date(key.created)} · Last used {date(key.used)}</span></div><button disabled={busy || (!access.passwordEnabled && access.passkeys.length === 1)} aria-label={`Remove passkey ${key.name}`} onClick={() => { if (confirm(`Remove passkey ${key.name}?`)) void run(() => authRequest(`/passkeys/${encodeURIComponent(key.id)}`, undefined, 'DELETE')) }}>Remove</button></article>)}</div>
      <h4>Sessions</h4><div className="access-actions"><button disabled={busy} onClick={() => void run(() => authRequest('/sessions/sign-out-others', {}), 'Other sessions signed out.')}>Sign out other sessions</button><button disabled={busy} onClick={() => void run(async () => { await authRequest('/logout', {}); requireLogin() })}>Sign out</button></div>
      <div className="settings-list">{access.sessions.map(session => <article className="settings-list-row" key={session.id}><div><strong>{session.current ? 'This session' : 'Other session'}</strong><span>{session.agent || 'Unknown browser'}</span><span>Created {date(session.created)} · Last seen {date(session.seen)}</span></div></article>)}</div>
      <h4>App passwords</h4><p>Use a separate password for each reader app. Reader sync is reserved for the future Google Reader API. It does not grant access to Settings or an owner session.</p>
      <form className="access-form" onSubmit={event => { event.preventDefault(); void run(async () => { const result = await authRequest<{ password: string }>('/apps', { name: appName, scope: 'reader-sync' }); setAppPassword(result.password); setAppName('') }, 'App password created.') }}>
        <label>App name<input required maxLength={80} value={appName} onChange={event => setAppName(event.target.value)} placeholder="Phone reader" /></label>
        <label>Scope<select disabled><option>reader-sync</option></select></label><button disabled={busy}>Create app password</button>
      </form>
      {appPassword && <div className="access-secret"><label>Copy this password now. Paper will not show it again.<input readOnly autoFocus value={appPassword} onFocus={event => event.target.select()} /></label><div className="access-actions"><button onClick={() => void navigator.clipboard.writeText(appPassword).then(() => setMessage('Copied.'), () => setError('Select and copy the password above.'))}>Copy password</button><button onClick={() => setAppPassword('')}>Done</button></div></div>}
      <div className="settings-list">{access.apps.map(app => <article className="settings-list-row" key={app.id}><div><strong>{app.name}</strong><span>{app.scope} · Created {date(app.created)} · Last used {date(app.used)}</span></div><button disabled={busy} aria-label={`Revoke app password ${app.name}`} onClick={() => { if (confirm(`Revoke app password ${app.name}?`)) void run(() => authRequest(`/apps/${app.id}`, undefined, 'DELETE')) }}>Revoke</button></article>)}</div>
      <button disabled={busy || !access.apps.length} onClick={() => { if (confirm('Revoke every app password?')) void run(async () => { await authRequest('/apps', undefined, 'DELETE'); setAppPassword('') }) }}>Revoke all app passwords</button>
    </>}
  </section>
}
