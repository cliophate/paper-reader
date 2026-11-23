import { useState } from 'react'
import type { BackendKind } from '../../shared/backend'

export async function sourceRequest(action: '' | '/test', body: unknown) {
  const response = await fetch('/api/settings/source' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => null)
  if (action === '' && response.status === 409 && result?.code === 'source-configured') return
  if (!response.ok || !result?.ok) throw new Error(result?.error || 'Could not check the connection.')
}

export function SourceSetup({ initial, onSaved }: { initial: 'freshrss' | 'miniflux'; onSaved: () => void }) {
  const [backend, setBackend] = useState<BackendKind>(initial)
  const [baseUrl, setBaseUrl] = useState(''), [username, setUsername] = useState(''), [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  async function submit(test: boolean) {
    setBusy(true); setError(''); setMessage('')
    try {
      await sourceRequest(test ? '/test' : '', { backend, baseUrl, ...(backend === 'freshrss' ? { username, apiPassword: secret } : { apiKey: secret }) })
      if (test) setMessage('Connection works.')
      else { setSecret(''); onSaved() }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not reach Paper.') }
    finally { setBusy(false) }
  }
  return <main className="login-page"><section className="login-card" aria-labelledby="source-title">
    <h1 id="source-title">Choose your feed source</h1>
    <form className="access-form" onChange={() => { setMessage(''); setError('') }} onSubmit={event => {
      event.preventDefault()
      void submit((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'test')
    }}>
      <label>Feed source<select disabled={busy} value={backend} onChange={event => {
        setBackend(event.target.value as BackendKind); setBaseUrl(''); setUsername(''); setSecret('')
      }}>
        <option value="freshrss">FreshRSS</option><option value="miniflux">Miniflux</option><option value="standalone">Standalone</option>
      </select></label>
      {backend === 'standalone' ? <p>Paper will fetch your feeds and store them here.</p> : <>
        <p>{backend === 'miniflux' ? 'Create an API key in Miniflux Settings > API Keys. Enter the server address without /v1.'
          : 'Enable the Google Reader API in FreshRSS and set an API password in your profile. Enter the server address without /api/greader.php.'}</p>
        <label>Server address<input type="url" required disabled={busy} maxLength={2048} autoComplete="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
        {backend === 'freshrss' && <label>Username<input required disabled={busy} autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>}
        <label>{backend === 'freshrss' ? 'API password' : 'API key'}<input required disabled={busy} type="password" autoComplete="off" maxLength={4096} value={secret} onChange={event => setSecret(event.target.value)} /></label>
      </>}
      {message && <p role="status">{message}</p>}{error && <p role="alert" className="form-error">{error}</p>}
      <button disabled={busy} type="submit">Continue</button>
      {backend !== 'standalone' && <button disabled={busy} type="submit" value="test">Test connection</button>}
    </form>
  </section></main>
}
