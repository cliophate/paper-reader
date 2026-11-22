import { AiActivity } from './AiActivity'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api'
import type { AiSettings, ConnectionsSettings, ConnectionsUpdate, DestinationSecret, DestinationSettings, DestinationUpdate } from '../../shared/connections'
import type { BriefingDeliverySettings, DeliveryHistoryItem, DeliveryState, SmtpFields } from '../../shared/briefing-delivery'

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
      <AiActivity />
      <BriefingEmail settings={settings.briefingDelivery} onSave={save} />
      <TokenConnection kind="readwise" settings={settings} onSave={save} />
      {settings.saveDestinations?.map(destination => <SaveConnection key={destination.id} settings={destination} onSave={save} />)}
      <TokenConnection kind="kirby" settings={settings} onSave={save} />
      <p className="connection-help">Tokens stay on the server and are never returned by Settings. Stored tokens are private files, without encryption at rest. Use HTTPS for remote access and protect Paper with your proxy login. Anyone with access to Paper can change these settings.</p>
    </>}
  </section>
}

function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="connection-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
}

function ConnectionForm({ title, children, onSave, footer, testing = false, saveLabel = `Save ${title}` }: {
  title: string; children: ReactNode; onSave: () => Promise<void>; footer?: ReactNode; testing?: boolean; saveLabel?: string
}) {
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
    <fieldset disabled={busy || testing}>{children}<button className="connection-save" type="submit">{busy ? 'Saving...' : saveLabel}</button></fieldset>
    {error && <p className="connection-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {footer}
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
      <Toggle label="Article discussions and collection questions" checked={ai.discussionEnabled} disabled={!provider} onChange={toggle('discussionEnabled')} />
      <Toggle label="Clearer headlines" checked={ai.headlinesEnabled} disabled={!provider} onChange={toggle('headlinesEnabled')} />
      <Toggle label="Pulse story grouping" checked={ai.collectionsEnabled} disabled={!provider} onChange={toggle('collectionsEnabled')} />
      <Toggle label="Briefing generation" checked={ai.briefingsEnabled} disabled={!provider} onChange={toggle('briefingsEnabled')} />
    </fieldset>
    {ai.provider === 'openai' && <fieldset disabled={testing}>
      <legend>OpenAI-compatible API</legend>
      <p className="connection-help">Enter a Chat Completions base URL, including /v1 if your server uses it. Paper sends requests directly from this server. No AI worker or CLI is needed. Choose models your provider supports.</p>
      <label className="connection-field">Base URL<input type="url" value={models.baseUrl} onChange={event => { setModels(previous => ({ ...previous, baseUrl: event.target.value })); setTestResult('') }} autoComplete="off" /></label>
      <label className="connection-field">API key<input type="password" value={token} onChange={event => { setToken(event.target.value); setRemoveToken(false); setTestResult('') }} placeholder={openai.tokenConfigured && !removeToken ? 'Key saved. Leave blank to keep it.' : 'Optional for servers without authentication'} autoComplete="new-password" spellCheck={false} maxLength={4096} /></label>
      {openai.tokenConfigured && !removeToken && <p className="connection-help">Key {openai.tokenSource === 'environment' ? 'provided by the server environment' : 'saved on the server'}. <button type="button" onClick={() => { setRemoveToken(true); setToken(''); setTestResult('') }}>Remove key</button></p>}
      {removeToken && <p className="connection-help">Saving removes the key and disables any environment key. <button type="button" onClick={() => { setRemoveToken(false); setTestResult('') }}>Keep key</button></p>}
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
      <p>Codex credentials remain in the CLI login store. API keys use the private connection settings file. Existing briefings and discussions remain saved when AI is off.</p>
    </details>
  </ConnectionForm>
}

const deliveryLabels: Record<DeliveryState, string> = {
  pending: 'Queued', generating: 'Generating', ready: 'Ready', sending: 'Sending', retrying: 'Waiting to retry',
  delivered: 'Delivered', failed: 'Failed', unconfirmed: 'Acceptance unconfirmed', skipped: 'Skipped', missed: 'Missed',
}

function DeliveryHistory({ timeZone }: { timeZone: string }) {
  const [history, setHistory] = useState<DeliveryHistoryItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    async function load() {
      try {
        const jobs = await api.briefingDeliveryHistory()
        if (current) { setHistory(jobs); setFailed(false) }
      } catch { if (current) setFailed(true) }
    }
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => { current = false; clearInterval(timer) }
  }, [])
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone })
  return <section className="delivery-history" aria-label="Delivery history">
    <h5>Delivery history</h5>
    {failed && <p className="connection-error" role="alert">Could not load delivery history. Check your connection to Paper.</p>}
    {!failed && !history && <p role="status">Loading delivery history...</p>}
    {!failed && history?.length === 0 && <p className="connection-help">No scheduled runs yet.</p>}
    {Boolean(history?.length) && <ul>{history?.map(job => <li key={job.id}>
      <div><strong>{job.kind === 'morning' ? 'Morning' : 'Evening'}</strong> <time dateTime={new Date(job.scheduledAt).toISOString()}>{format.format(job.scheduledAt)}</time></div>
      <span>{deliveryLabels[job.state]}</span>
      {job.lastError && <p>{job.lastError}</p>}
    </li>)}</ul>}
  </section>
}

function BriefingEmail({ settings, onSave }: { settings: BriefingDeliverySettings; onSave: (patch: ConnectionsUpdate) => Promise<void> }) {
  const [schedule, setSchedule] = useState(settings.schedule)
  const [fields, setFields] = useState<Omit<SmtpFields, 'port'>>(() => {
    const { port: _port, passwordConfigured: _configured, passwordSource: _source, ...smtp } = settings.smtp
    return smtp
  })
  const [port, setPort] = useState(String(settings.smtp.port))
  const [password, setPassword] = useState('')
  const [remove, setRemove] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ message: string; ok: boolean } | null>(null)
  const smtp = () => ({ ...fields, port: Number(port), ...(remove ? { password: null } : password ? { password } : {}) })
  const field = <K extends keyof typeof fields>(key: K, value: typeof fields[K]) => setFields(current => ({ ...current, [key]: value }))
  async function save() {
    await onSave({ smtp: smtp(), briefingSchedule: schedule })
    setPassword('')
    setRemove(false)
  }
  async function test() {
    setTesting(true)
    setTestResult(null)
    try { setTestResult({ ok: true, ...(await api.testSmtp(smtp())) }) }
    catch (error) { setTestResult({ ok: false, message: error instanceof Error ? error.message : 'Could not send the test email.' }) }
    finally { setTesting(false) }
  }
  return <ConnectionForm title="Briefing email" saveLabel="Save briefing email" onSave={save} testing={testing} footer={<DeliveryHistory timeZone={settings.timeZone} />}>
    <Toggle label="Send scheduled briefings" checked={schedule.enabled} onChange={enabled => setSchedule(current => ({ ...current, enabled }))} />
    <p className="connection-help">Disable your external briefing workflow before turning this on. Scheduled mail requires AI and briefing generation.</p>
    <fieldset className="delivery-fields">
      <legend>Schedule in {settings.timeZone}</legend>
      <div className="delivery-grid">
        {(['morning', 'evening'] as const).map(kind => <label className="connection-field" key={kind}>
          {kind === 'morning' ? 'Morning' : 'Evening'}<input type="time" required value={schedule[kind]} onChange={event => setSchedule(current => ({ ...current, [kind]: event.target.value }))} />
        </label>)}
      </div>
    </fieldset>
    <fieldset className="delivery-fields" onChange={() => setTestResult(null)}>
      <legend>SMTP connection</legend>
      <div className="delivery-grid">
        <label className="connection-field">SMTP host<input value={fields.host} onChange={event => field('host', event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <label className="connection-field">Port<input type="number" required min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
        <label className="connection-field">Security<select value={fields.security} onChange={event => field('security', event.target.value as SmtpFields['security'])}>
          <option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="none">None</option>
        </select></label>
        <label className="connection-field">Username<input value={fields.user} onChange={event => field('user', event.target.value)} autoComplete="off" spellCheck={false} /></label>
      </div>
      <label className="connection-field">Password<input type="password" value={password} onChange={event => { setPassword(event.target.value); setRemove(false) }} placeholder={settings.smtp.passwordConfigured && !remove ? 'Leave blank to keep current password' : ''} autoComplete="new-password" maxLength={4096} /></label>
      {settings.smtp.passwordConfigured && <p className="connection-help">
        {remove ? 'Saving removes the password and disables any environment password.' : settings.smtp.passwordSource === 'environment' ? 'Password provided by the server environment.' : 'Password saved on the server.'}{' '}
        <button type="button" onClick={() => { setRemove(!remove); setPassword(''); setTestResult(null) }}>{remove ? 'Keep password' : 'Remove password'}</button>
      </p>}
      <div className="delivery-grid">
        <label className="connection-field">Sender<input type="email" value={fields.from} onChange={event => field('from', event.target.value)} autoComplete="off" /></label>
        <label className="connection-field">Recipient<input type="email" value={fields.to} onChange={event => field('to', event.target.value)} autoComplete="off" /></label>
      </div>
      <p className="connection-help">Send a test to the recipient using these form values before saving.</p>
      <button type="button" onClick={() => void test()}>{testing ? 'Sending test...' : 'Send test email'}</button>
      {testResult && <p role={testResult.ok ? 'status' : 'alert'} className={testResult.ok ? undefined : 'connection-error'}>{testResult.message}</p>}
    </fieldset>
  </ConnectionForm>
}

const credentialLabels: Record<DestinationSecret, string> = {
  token: 'Access token', clientId: 'Client ID', clientSecret: 'Client secret', username: 'Username', password: 'Password',
}
const destinationHelp = {
  linkding: 'Copy the API token from your Linkding settings.',
  wallabag: 'Create a client under API clients management in Wallabag. Enter its ID and secret along with your Wallabag login.',
  readeck: 'Create an API token in your Readeck profile with permission to write bookmarks.',
  raindrop: 'Create an app under Integrations in your Raindrop.io settings and generate a test token for your account.',
  linkwarden: 'Create an access token in your Linkwarden settings.',
}

function SaveConnection({ settings, onSave }: { settings: DestinationSettings; onSave: (patch: ConnectionsUpdate) => Promise<void> }) {
  const { id, name } = settings
  const [enabled, setEnabled] = useState(settings.enabled)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [secrets, setSecrets] = useState<Partial<Record<DestinationSecret, string | null>>>({})
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const fields: DestinationSecret[] = id === 'wallabag' ? ['clientId', 'clientSecret', 'username', 'password'] : ['token']
  const patch = (): DestinationUpdate => ({ enabled, ...(id === 'raindrop' ? {} : { baseUrl }), ...secrets })
  async function test() {
    setTesting(true)
    setResult(null)
    try { await api.testSaveDestination(id, patch()); setResult({ ok: true, message: `Connected to ${name}.` }) }
    catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : `Could not connect to ${name}.` }) }
    finally { setTesting(false) }
  }
  return <ConnectionForm title={name} testing={testing} onSave={async () => { await onSave({ [id]: patch() }); setSecrets({}) }}>
    <Toggle label={`Enable ${name}`} checked={enabled} onChange={setEnabled} />
    <p className="connection-help">{destinationHelp[id]} Saving an article sends its URL, title and feed folders as tags.</p>
    <fieldset onChange={() => setResult(null)}>
      {id !== 'raindrop' && <>
        <label className="connection-field">Base URL<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} autoComplete="off" /></label>
        <p className="connection-help">Enter the server URL, including any installation path. Private servers need their origin in PAPER_TRUSTED_SAVE_ORIGINS.</p>
      </>}
      {fields.map(key => <label className="connection-field" key={key}>{credentialLabels[key]}
        <input type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} value={secrets[key] ?? ''}
          placeholder={settings.savedSecrets.includes(key) && secrets[key] !== null ? 'Saved. Leave blank to keep it.' : ''}
          onChange={event => setSecrets({ ...secrets, [key]: event.target.value })} />
      </label>)}
      {settings.savedSecrets.length > 0 && <button type="button" onClick={() => { setSecrets(Object.fromEntries(fields.map(key => [key, null]))); setResult(null) }}>Remove saved credentials</button>}
      {fields.some(key => secrets[key] === null) && <p className="connection-help">Save to remove these credentials. <button type="button" onClick={() => { setSecrets({}); setResult(null) }}>Keep credentials</button></p>}
      <button type="button" onClick={() => void test()}>{testing ? 'Testing...' : 'Test connection'}</button>
      {result && <p role={result.ok ? 'status' : 'alert'}>{result.message}</p>}
    </fieldset>
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
        <ol><li>Sign in to Readwise and open <a href="https://readwise.io/access_token" target="_blank" rel="noreferrer">your access token page</a>.</li><li>Copy the token, paste it above, and choose a destination.</li><li>Enable Readwise Reader and save. Use the bookmark button on an article to save its URL and title. If you enabled several services, choose Readwise Reader.</li></ol>
        <p>Paper does not import your Reader library or highlights. See the <a href="https://readwise.io/reader_api" target="_blank" rel="noreferrer">Reader API documentation</a>. Reader may use your default destination if the one you select is unavailable in your account.</p>
      </> : <>
        <ol><li>Install a compatible publishing endpoint on your Kirby site. Paper requires a custom endpoint; Kirby's standard API alone will not work.</li><li>Get the publishing URL and bearer token from that plugin's configuration. Paste them above. Use HTTPS unless you control the private network.</li><li>Enable Kirby notes and save. Select a passage in an article and choose Create note in Kirby.</li></ol>
        <p>Paper sends the selected quote, article title, and source URL to create a note draft. The endpoint must accept a multipart <code>payload</code> field containing JSON with <code>title</code>, <code>destination: "notes"</code>, and Markdown <code>text</code>, authenticated with your bearer token. It must return JSON with <code>ok: true</code> and a page <code>id</code> or <code>slug</code>. Configure the endpoint to create drafts.</p>
      </>}
    </details>
  </ConnectionForm>
}
