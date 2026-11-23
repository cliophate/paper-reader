import { useEffect, useState } from 'react'
import type { WebhookCreate, WebhookEvent, WebhookSettings, WebhookTarget } from '../../shared/webhooks'
import { api } from '../api'
import type { Feed, NavigationPayload } from '../types'

const labels = { new_entries: 'New articles', starred_entry: 'Starred article', save_entry: 'Manual send', test: 'Test', rule_entry: 'Rule notification' }
const kinds = { webhook: 'Signed webhook', ntfy: 'ntfy', apprise: 'Apprise API' }
const empty: WebhookCreate = { name: '', kind: 'webhook', events: ['save_entry'], url: '', credential: '', feedId: '', folderId: '' }

export function WebhookSettingsPanel({ navigation, feeds, onChanged }: {
  navigation: NavigationPayload | null; feeds: Feed[]; onChanged: () => Promise<void>
}) {
  const [view, setView] = useState<WebhookSettings | null>(null)
  const [form, setForm] = useState(empty)
  const [edit, setEdit] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    void api.webhooks().then(result => { if (active) setView(result) }).catch(() => { if (active) setError('Could not load delivery targets.') })
    return () => { active = false }
  }, [])

  async function run(action?: () => Promise<unknown>, notice = '') {
    setBusy(true); setError(''); setMessage('')
    try { await action?.(); setView(await api.webhooks()); setMessage(notice) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update delivery targets.') }
    finally { setBusy(false) }
  }
  async function save() {
    if (edit) await api.updateWebhook(edit, { name: form.name, events: form.events, feedId: form.feedId, folderId: form.folderId })
    else setSecret((await api.createWebhook(form)).secret ?? '')
    setEdit(''); setForm(empty)
    await onChanged()
  }
  function editTarget(target: WebhookTarget) {
    setSecret(''); setEdit(target.id); setForm({ ...empty, ...target })
  }
  const scope = form.feedId ? 'feed/' + form.feedId : form.folderId ? 'folder/' + form.folderId : ''
  return <section className="connection-settings webhook-settings" aria-label="Webhooks and push notifications">
    <h3>Webhooks and push notifications</h3>
    <p className="connection-help">Choose which articles Paper sends. Private servers need their exact origin in PAPER_TRUSTED_SAVE_ORIGINS.</p>
    <form className="connection-card" onSubmit={event => { event.preventDefault(); void run(save, 'Delivery target saved.') }}>
      <fieldset disabled={busy}>
        <label className="connection-field">Target name<input required maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        {!edit && <>
          <label className="connection-field">Service<select value={form.kind} onChange={event => setForm({ ...empty, name: form.name, kind: event.target.value as WebhookCreate['kind'] })}>
            {Object.entries(kinds).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}
          </select></label>
          <label className="connection-field">{form.kind === 'ntfy' ? 'Topic URL' : form.kind === 'apprise' ? 'Apprise notify URL' : 'Webhook URL'}
            <input type="url" autoComplete="off" required value={form.url} onChange={event => setForm({ ...form, url: event.target.value })} /></label>
          {form.kind !== 'webhook' && <label className="connection-field">{form.kind === 'ntfy' ? 'Access token (optional)' : 'Configuration key (optional)'}
            <input type="password" autoComplete="new-password" value={form.credential} onChange={event => setForm({ ...form, credential: event.target.value })} /></label>}
          {form.kind === 'apprise' && <p className="connection-help">Enter the URL ending in /notify. Paper appends the configuration key when supplied. Add ?tag=alerts to reach destinations tagged alerts. Without a tag, a saved configuration sends to untagged destinations.</p>}
        </>}
        {Object.entries(labels).filter(([key]) => key !== 'test' && key !== 'rule_entry' && (form.kind === 'webhook' || key !== 'new_entries')).map(([key, label]) => {
          const item = key as WebhookEvent
          return <label className="connection-toggle" key={key}><input type="checkbox" checked={form.events.includes(item)}
            onChange={event => setForm({ ...form, events: event.target.checked ? [...form.events, item] : form.events.filter(value => value !== item) })} />{label}</label>
        })}
        <label className="connection-field">Article scope<select aria-describedby="webhook-scope-help" value={scope} onChange={({ target: { value } }) => setForm({ ...form,
          feedId: value.startsWith('feed/') ? value.slice(5) : '', folderId: value.startsWith('folder/') ? value.slice(7) : '' })}>
          <option value="">All feeds</option>
          <optgroup label="Folders">{navigation?.folders.map(folder => <option key={folder.id} value={'folder/' + folder.id}>{folder.title}</option>)}</optgroup>
          <optgroup label="Feeds">{feeds.map(feed => <option key={feed.id} value={'feed/' + feed.id}>{feed.title}</option>)}</optgroup>
        </select></label>
        <p className="connection-help" id="webhook-scope-help">Webhooks use the folders Paper currently knows. With local reads on, a feed you move in FreshRSS or Miniflux keeps its old folder for webhooks until Paper's next sync.</p>
        <button type="submit" disabled={!form.events.length}>{edit ? 'Save changes' : 'Add target'}</button>
        {edit && <button type="button" onClick={() => { setEdit(''); setForm(empty) }}>Cancel</button>}
      </fieldset>
    </form>
    {secret && <div className="connection-card"><label className="connection-field">Copy this signing secret now<input readOnly value={secret} onFocus={event => event.target.select()} /></label>
      <button onClick={() => setSecret('')}>Hide secret</button></div>}
    {view?.targets.map(target => <section className="connection-card" key={target.id} aria-label={target.name}>
      <h4>{target.name}</h4><p>{kinds[target.kind]} · {target.events.map(event => labels[event]).join(', ')}</p>
      <button disabled={busy} onClick={() => editTarget(target)}>Edit</button>
      <button disabled={busy} onClick={() => void run(() => api.testWebhook(target.id), 'Test queued.')}>Send test</button>
      {target.kind === 'webhook' && <button disabled={busy} onClick={() => {
        if (window.confirm('Replace the signing secret? Update the receiver before the next delivery.'))
          void run(async () => setSecret((await api.rotateWebhook(target.id)).secret))
      }}>Regenerate secret</button>}
      <button disabled={busy} onClick={() => {
        if (window.confirm('Remove this target and its queued deliveries and history?')) void run(async () => {
          await api.removeWebhook(target.id); setSecret('')
          if (edit === target.id) { setEdit(''); setForm(empty) }
          await onChanged()
        })
      }}>Remove</button>
    </section>)}
    <section className="connection-card" aria-label="Webhook delivery log"><h4>Delivery log</h4>
      <button disabled={busy} onClick={() => void run()}>Refresh log</button>
      {view && !view.deliveries.length && <p>No deliveries yet.</p>}
      <ul>{view?.deliveries.map(job => <li key={job.id}>{job.target} · {job.event === 'overflow' ? 'Queue overflow' : labels[job.event]} · {job.state}
        <div>{new Date(job.created).toLocaleString()} · {job.attempts} {job.attempts === 1 ? 'attempt' : 'attempts'}{job.status !== null && ` · HTTP ${job.status}`}</div>
        {job.error && <div>{job.error}</div>}{job.nextRetry !== null && <div>Next retry {new Date(job.nextRetry).toLocaleString()}</div>}
        {(job.state === 'failed' || job.nextRetry !== null) && <button disabled={busy} onClick={() => void run(() => api.retryWebhook(job.id), 'Retry queued.')}>Retry now</button>}
      </li>)}</ul>
    </section>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
