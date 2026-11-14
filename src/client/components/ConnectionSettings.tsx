import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import type { AiSettings, ConnectionsSettings, ConnectionsUpdate } from '../../shared/connections'

export function ConnectionSettings({ onChanged }: { onChanged: () => Promise<void> }) {
  const [settings, setSettings] = useState<ConnectionsSettings | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setError('')
    void api.connections().then(value => { if (current) setSettings(value) }).catch(() => { if (current) setError('Could not load connections. Check your connection to Paper.') })
    return () => { current = false }
  }, [attempt])

  async function save(patch: ConnectionsUpdate) {
    const next = await api.updateConnections(patch)
    setSettings(next)
    await onChanged().catch(() => { setError('Settings were saved. Refresh Paper to update connection status.') })
  }

  return <section className="connection-settings" aria-label="Connections">
    <h3>Connections</h3>
    <p className="settings-intro">Every connection is optional. These settings apply to your Paper server and all its devices.</p>
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    {!settings && !error && <p role="status">Loading connections...</p>}
    {settings && <>
      <AiConnection runtime={settings.aiRuntime} settings={settings.ai} openai={settings.openai} onSave={save} />
      <TokenConnection kind="readwise" settings={settings} onSave={save} />
      <TokenConnection kind="kirby" settings={settings} onSave={save} />
      <p className="connection-help">Tokens stay on the server and are never returned by Settings. Stored tokens are private files, without encryption at rest. Use HTTPS for remote access and protect Paper with your proxy login. Anyone with access to Paper can change these settings.</p>
    </>}
  </section>
}

function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="connection-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
}

function ConnectionForm({ title, children, onSave }: { title: string; children: ReactNode; onSave: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try { await onSave(); setMessage(`${title} settings saved.`) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save settings.') }
    finally { setBusy(false) }
  }
  return <form className="connection-card" aria-label={title} onSubmit={event => void submit(event)} onChange={() => setMessage('')}>
    <h4>{title}</h4>
    <fieldset disabled={busy}>{children}<button className="connection-save" type="submit">{busy ? 'Saving...' : `Save ${title}`}</button></fieldset>
    {error && <p className="connection-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </form>
}

function AiConnection({ settings, openai, runtime, onSave }: { settings: AiSettings; openai: ConnectionsSettings['openai']; runtime?: ConnectionsSettings['aiRuntime']; onSave: (patch: ConnectionsUpdate) => Promise<void> }) {
  const [ai, setAi] = useState(settings)
  const toggle = (key: keyof AiSettings) => (value: boolean) => setAi(previous => ({ ...previous, [key]: value }))
  const [models, setModels] = useState(() => {
    const { tokenConfigured: _configured, tokenSource: _source, ...fields } = openai
    return fields
  })
  const [token, setToken] = useState('')
  const [removeToken, setRemoveToken] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')
  const provider = ai.provider !== 'none'
  const apiSettings = () => ({ ...models, ...(removeToken ? { token: null } : token.trim() ? { token: token.trim() } : {}) })
  async function save() {
    await onSave({ ai, ...(ai.provider === 'openai' ? { openai: apiSettings() } : {}) })
    setToken(''); setRemoveToken(false)
  }
  async function test() {
    setTesting(true); setTestResult('')
    try { setTestResult((await api.testAiConnection(apiSettings())).message) }
    catch (error) { setTestResult(error instanceof Error ? error.message : 'Could not test the connection.') }
    finally { setTesting(false) }
  }
  return <ConnectionForm title="AI features" onSave={save}>
    {runtime && <p role="status" className="connection-help">{runtime.message}</p>}
    <Toggle label="Enable AI features" checked={ai.enabled} onChange={toggle('enabled')} />
    <p className="connection-help">AI sends article text to your chosen provider. Pulse grouping and headline cleanup can run in the background after a sync and may incur charges. Turning AI off stops new requests. Requests already running may finish.</p>
    <fieldset disabled={!ai.enabled}>
      <legend>Providers</legend>
      <label className="connection-field">AI provider<select value={ai.provider} onChange={event => { setAi(previous => ({ ...previous, provider: event.target.value as AiSettings['provider'] })); setTestResult('') }}>
        <option value="none">None</option><option value="codex">Codex worker</option><option value="openai">OpenAI-compatible API</option>
      </select></label>
      {!provider && <p className="connection-help">Select a provider to run AI features.</p>}
    </fieldset>
    <fieldset disabled={!ai.enabled}>
      <legend>Features</legend>
      <Toggle label="Article discussions" checked={ai.discussionEnabled} disabled={!provider} onChange={toggle('discussionEnabled')} />
      <Toggle label="Clearer headlines" checked={ai.headlinesEnabled} disabled={!provider} onChange={toggle('headlinesEnabled')} />
      <Toggle label="Pulse story grouping" checked={ai.collectionsEnabled} disabled={!provider} onChange={toggle('collectionsEnabled')} />
      <Toggle label="Briefing generation" checked={ai.briefingsEnabled} disabled={!provider} onChange={toggle('briefingsEnabled')} />
    </fieldset>
    {ai.provider === 'openai' && <fieldset disabled={testing}>
      <legend>OpenAI-compatible API</legend>
      <p className="connection-help">Enter a Chat Completions base URL, including /v1 if your server uses it. Paper sends requests directly from this server. No AI worker or CLI is needed. Choose models your provider supports.</p>
      <label className="connection-field">Base URL<input type="url" value={models.baseUrl} onChange={event => { setModels(previous => ({ ...previous, baseUrl: event.target.value })); setTestResult('') }} autoComplete="off" /></label>
      <label className="connection-field">API key<input type="password" value={token} onChange={event => { setToken(event.target.value); setRemoveToken(false); setTestResult('') }} placeholder={openai.tokenConfigured && !removeToken ? 'Key saved. Leave blank to keep it.' : 'Optional for servers without authentication'} autoComplete="new-password" spellCheck={false} maxLength={4096} /></label>
      {openai.tokenConfigured && !removeToken && <p className="connection-help">Key {openai.tokenSource === 'environment' ? 'provided by the server environment' : 'saved on the server'}. <button type="button" onClick={() => { setRemoveToken(true); setToken('') }}>Remove key</button></p>}
      {removeToken && <p className="connection-help">Saving removes the key and disables any environment key. <button type="button" onClick={() => setRemoveToken(false)}>Keep key</button></p>}
      {([['discussionModel', 'Discussion model'], ['headlinesModel', 'Headlines model'], ['groupingModel', 'Grouping model'], ['shortlistModel', 'Briefing shortlist model'], ['editorModel', 'Briefing editor model']] as const).map(([key, label]) => <label className="connection-field" key={key}>{label}<input value={models[key]} onChange={event => { setModels(previous => ({ ...previous, [key]: event.target.value })); setTestResult('') }} maxLength={200} autoComplete="off" /></label>)}
      <p className="connection-help">Public HTTPS works by default. For localhost, LAN or Docker hosts, the administrator must add the exact origin, including scheme and port, to PAPER_TRUSTED_AI_ORIGINS in the server environment. This cannot be changed in Settings. Localhost refers to Paper's container when using Docker.</p>
      <p className="connection-help">Test connection sends one tiny request using this form without saving or enabling AI. It uses the discussion model. It may incur a charge. Keys stay on the server and never reach the Codex worker. See docs/ai-providers.md for setup examples.</p>
      <button type="button" disabled={testing} onClick={() => void test()}>{testing ? 'Testing...' : 'Test connection'}</button>
      {testResult && <p role="status">{testResult}</p>}
    </fieldset>}
    <details className="connection-setup"><summary>How to set up the Codex worker</summary>
      <p>Paper runs the Codex CLI in a separate AI worker. The worker connects through a private Unix socket and has no Paper network access, data or service tokens. For Docker, run these commands from your Paper checkout:</p>
      <pre><code>{`mkdir -p ai-auth/codex\nchmod 700 ai-auth/codex\ndocker compose -f compose.yaml -f compose.ai.yaml build paper paper-ai\ndocker compose -f compose.yaml -f compose.ai.yaml run --rm --no-deps paper-ai codex login --device-auth\ndocker compose -f compose.yaml -f compose.ai.yaml up -d paper paper-ai`}</code></pre>
      <p>Complete the login link and one-time code in your own browser. Device login may need enabling in your ChatGPT security or workspace settings. See <a href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noreferrer">Codex authentication</a>.</p>
      <p>New installs generate the worker secret during setup. Existing installs must follow the AI upgrade steps in <code>docs/integrations.md</code> to add it, remove the old auth mounts and shared worker network from Paper, and configure the socket volume. Both containers must use the same UID and GID. The Codex option requires the worker. Native development can use <code>PAPER_AI_LOCAL=unsafe</code> only with synthetic feeds. This lets model processes read Paper data and secrets.</p>
      <p>Codex model names come from your server's <code>.env</code>. Set <code>PAPER_DISCUSSION_MODEL</code> for discussions, <code>PAPER_COLLECTION_MODEL</code> for Pulse, and <code>PAPER_HEADLINE_WRITER_MODEL</code> / <code>PAPER_HEADLINE_REVIEWER_MODEL</code> for headlines. Briefings use <code>CODEX_SHORTLIST_MODEL</code> / <code>CODEX_EDITOR_MODEL</code>. Choose models your provider account can access, then restart Paper after changing the environment.</p>
      <p>Codex credentials remain in the CLI login store. API keys use the private connection settings file. Existing briefings and discussions remain saved when AI is off. Briefing schedules require separate automation.</p>
    </details>
  </ConnectionForm>
}

function TokenConnection({ kind, settings, onSave }: { kind: 'readwise' | 'kirby'; settings: ConnectionsSettings; onSave: (patch: ConnectionsUpdate) => Promise<void> }) {
  const current = settings[kind]
  const [enabled, setEnabled] = useState(current.enabled)
  const [token, setToken] = useState('')
  const [removeToken, setRemoveToken] = useState(false)
  const [location, setLocation] = useState(settings.readwise.location)
  const [publishUrl, setPublishUrl] = useState(settings.kirby.publishUrl)
  const title = kind === 'readwise' ? 'Readwise Reader' : 'Kirby notes'
  const hasToken = !removeToken && (Boolean(token.trim()) || current.tokenConfigured)
  async function save() {
    const credentials = removeToken ? { token: null } : token.trim() ? { token: token.trim() } : {}
    await onSave(kind === 'readwise' ? { readwise: { enabled, location, ...credentials } } : { kirby: { enabled, publishUrl, ...credentials } })
    setToken(''); setRemoveToken(false)
  }
  return <ConnectionForm title={title} onSave={save}>
    <Toggle label={`Enable ${title}`} checked={enabled} onChange={setEnabled} />
    <p className="connection-help">{!enabled ? 'Off. Saved credentials are kept for later.' : !hasToken ? 'Add a token to finish setup.' : kind === 'kirby' && !publishUrl.trim() ? 'Add your publishing endpoint to finish setup.' : 'Enabled. Credentials have not been verified with the service.'}</p>
    {kind === 'kirby' && <label className="connection-field">Publishing endpoint<input type="url" value={publishUrl} onChange={event => setPublishUrl(event.target.value)} placeholder="https://example.com/your-publishing-endpoint" autoComplete="off" /></label>}
    <label className="connection-field">{kind === 'readwise' ? 'Readwise access token' : 'Publishing token'}<input type="password" value={token} onChange={event => { setToken(event.target.value); setRemoveToken(false) }} placeholder={current.tokenConfigured && !removeToken ? 'Token saved. Leave blank to keep it.' : 'Paste your token'} autoComplete="new-password" spellCheck={false} maxLength={4096} /></label>
    {current.tokenConfigured && !removeToken && <p className="connection-help">Token {current.tokenSource === 'environment' ? 'provided by the server environment' : 'saved on the server'}. <button type="button" onClick={() => { setRemoveToken(true); setToken('') }}>Remove token</button></p>}
    {removeToken && <p className="connection-help">The token will be removed when you save. Environment tokens will also stay disabled. <button type="button" onClick={() => setRemoveToken(false)}>Keep token</button></p>}
    {kind === 'readwise' && <label className="connection-field">Save articles to<select value={location} onChange={event => setLocation(event.target.value)}><option value="new">Inbox</option><option value="later">Later</option><option value="archive">Archive</option><option value="feed">Feed</option></select></label>}
    <details className="connection-setup"><summary>How to set up {title}</summary>
      {kind === 'readwise' ? <>
        <ol><li>Sign in to Readwise and open <a href="https://readwise.io/access_token" target="_blank" rel="noreferrer">your access token page</a>.</li><li>Copy the token, paste it above, and choose a destination.</li><li>Enable Readwise Reader and save. Use the Readwise button on an article to save its URL and title.</li></ol>
        <p>Paper does not import your Reader library or highlights. See the <a href="https://readwise.io/reader_api" target="_blank" rel="noreferrer">Reader API documentation</a>. Reader may use your default destination if the one you select is unavailable in your account.</p>
      </> : <>
        <ol><li>Install a compatible publishing endpoint on your Kirby site. Paper requires a custom endpoint; Kirby's standard API alone will not work.</li><li>Get the publishing URL and bearer token from that plugin's configuration. Paste them above. Use HTTPS unless you control the private network.</li><li>Enable Kirby notes and save. Select a passage in an article and choose Create note in Kirby.</li></ol>
        <p>Paper sends the selected quote, article title, and source URL to create a note draft. The endpoint must accept a multipart <code>payload</code> field containing JSON with <code>title</code>, <code>destination: "notes"</code>, and Markdown <code>text</code>, authenticated with your bearer token. It must return JSON with <code>ok: true</code> and a page <code>id</code> or <code>slug</code>. Configure the endpoint to create drafts.</p>
      </>}
    </details>
  </ConnectionForm>
}
