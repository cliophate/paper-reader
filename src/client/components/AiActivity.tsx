import { useEffect, useState, type FormEvent } from 'react'
import type { ActivityFeature, AiActivityView, AiPolicy, ModelPrice } from '../../shared/ai-activity'
import { api } from '../api'
import type { NavigationPayload } from '../types'

export function AiActivity() {
  const [open, setOpen] = useState(false)
  return <details className="connection-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>AI activity and controls</summary>
    {open && <ActivityPanel />}
  </details>
}

function ActivityPanel() {
  const [view, setView] = useState<AiActivityView>()
  const [feature, setFeature] = useState('')
  const [outcome, setOutcome] = useState('')
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setError('')
    void api.aiActivity(feature, outcome).then(result => { if (current) setView(result) })
      .catch(() => { if (current) setError('Could not load AI activity.') })
    return () => { current = false }
  }, [feature, outcome, revision])
  const refresh = () => setRevision(value => value + 1)
  return <>
    <button type="button" onClick={refresh}>Refresh activity</button>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p role="status">Loading AI activity...</p>}
    {view && <>
      <Controls view={view} onSave={refresh} />
      <details className="connection-setup"><summary>What each feature sends</summary>
        <dl>{Object.entries(view.features).map(([key, info]) => <div key={key}><dt>{info.label}</dt><dd>{info.sends}</dd></div>)}</dl>
      </details>
      <h5>Recent requests</h5>
      <p className="connection-help">Activity keeps up to 2,000 requests for 30 days. It stores request details and reported token counts. Article text, prompts and credentials stay out of the log.</p>
      <div className="delivery-grid">
        <label className="connection-field">Feature<select value={feature} onChange={e => setFeature(e.target.value)}>
          <option value="">All features</option>
          {Object.entries(view.features).map(([key, info]) => <option key={key} value={key}>{info.label}</option>)}
        </select></label>
        <label className="connection-field">Outcome<select value={outcome} onChange={e => setOutcome(e.target.value)}>
          <option value="">All outcomes</option>
          {['running', 'ok', 'error', 'cancelled', 'limited', 'busy', 'interrupted'].map(key => <option key={key}>{key}</option>)}
        </select></label>
      </div>
      {!view.items.length && <p>No matching requests.</p>}
      <ul className="ai-request-list">{view.items.map(item => <li key={item.id}>
        <strong>{view.features[item.feature].label}</strong> · {item.outcome} · {item.trigger}
        {item.reason && <div>{item.reason}</div>}
        <div><time dateTime={new Date(item.started).toISOString()}>{new Date(item.started).toLocaleString()}</time> · {item.duration} ms</div>
        <div>{item.provider === 'none' ? 'No provider request' : item.provider === 'codex' ? 'Codex' : 'OpenAI-compatible API'} · {item.model}</div>
        <div>{[item.inputTokens !== null && `${item.inputTokens} input tokens`, item.outputTokens !== null && `${item.outputTokens} output tokens`,
          item.totalTokens !== null && `${item.totalTokens} total tokens`].filter(Boolean).join(' · ')}</div>
        <div>{item.provider === 'codex' ? 'Subscription billing unavailable' : item.estimatedUsd === null ? 'Cost unavailable'
          : `Estimated cost ${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }).format(item.estimatedUsd)}`}</div>
      </li>)}</ul>
    </>}
  </>
}

function Limit({ label, value, change }: { label: string; value?: number | null; change: (value: number | null) => void }) {
  return <label className="connection-field">{label}<input type="number" min={0} step={1} placeholder="Unlimited"
    value={value ?? ''} onChange={e => change(e.target.value === '' ? null : e.target.valueAsNumber)} /></label>
}

function Controls({ view, onSave }: { view: AiActivityView; onSave: () => void }) {
  const [policy, setPolicy] = useState<AiPolicy>(view.policy)
  const [navigation, setNavigation] = useState<NavigationPayload>()
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let current = true
    void api.navigation().then(result => { if (current) setNavigation(result) }).catch(() => {})
    return () => { current = false }
  }, [])
  const patch = (fields: Partial<AiPolicy>) => setPolicy(current => ({ ...current, ...fields }))
  const total = Object.values(view.used).reduce((sum, n) => sum + n, 0)
  const background = (Object.keys(view.features) as ActivityFeature[]).filter(key => view.features[key].background)
  const usage = (used: number, cap: number | null | undefined) => cap == null ? `${used} today`
    : `${used} of ${cap} today${used >= cap ? ', limit reached' : ''}`
  const feeds = new Map(navigation?.uncategorized.map(feed => [feed.id, feed.title]))
  for (const folder of navigation?.folders || []) for (const feed of folder.feeds) feeds.set(feed.id, feed.title)
  const folders = new Map(navigation?.folders.map(folder => [folder.id, folder.title]))
  const staleFolders = navigation ? policy.folders.filter(id => !folders.has(id)) : []
  const editPrice = (index: number, fields: Partial<ModelPrice>) =>
    patch({ prices: policy.prices.map((price, i) => i === index ? { ...price, ...fields } : price) })
  async function save(next: AiPolicy) {
    setSaving(true)
    try {
      await api.saveAiPolicy(next)
      setMessage('AI controls saved.')
      onSave()
      return true
    }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save AI controls.') }
    finally { setSaving(false) }
  }
  return <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save(policy) }} onChange={() => setMessage('')}>
    <h5>Daily background limits</h5>
    <p className="connection-help">Limits reset at midnight in {view.timeZone}. Paper counts each background request just before sending it, even if cancellation stops it from being sent. Manual requests can still run. Leave a limit blank for unlimited requests or enter zero to pause.</p>
    <fieldset disabled={saving}>
      <Limit label={`All background requests (${usage(total, view.policy.daily)})`} value={policy.daily} change={daily => patch({ daily })} />
      <details className="connection-setup"><summary>Limits by feature</summary>
        {background.map(key => <Limit key={key} label={`${view.features[key].label} (${usage(view.used[key] || 0, view.policy.featureLimits[key])})`}
          value={policy.featureLimits[key]} change={value => {
            const featureLimits = { ...policy.featureLimits }
            if (value === null) delete featureLimits[key]
            else featureLimits[key] = value
            patch({ featureLimits })
          }} />)}
      </details>
      <details className="connection-setup"><summary>Exclude feeds and folders</summary>
        <p>Exclusions apply only to background work. New suggestions, collection answers, article discussions and manual briefings can use excluded sources. Exclusions affect future provider requests, so previously saved catch-ups stay visible.</p>
        {!navigation && <p>Feed and folder choices are unavailable until navigation loads.</p>}
        {(['folders', 'feeds'] as const).map(key => {
          const choices = key === 'folders' ? folders : feeds
          for (const id of policy[key]) if (!choices.has(id)) choices.set(id, key === 'folders' ? policy.folderNames?.[id] ?? id : id)
          return <label key={key} className="connection-field">{key === 'feeds' ? 'Excluded feeds' : 'Excluded folders'}
            <select multiple value={policy[key]} disabled={!navigation} onChange={e => {
              const selected = Array.from(e.target.selectedOptions)
              patch({ [key]: selected.map(o => o.value), ...(key === 'folders' ? { folderNames: Object.fromEntries(selected.map(o => [o.value, o.text])) } : {}) })
            }}>
              {[...choices].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select></label>
        })}
        {staleFolders.map(id => <p key={id} role="alert">Excluded folder not found: {policy.folderNames?.[id] ?? id}. Background AI is paused.{' '}
          <button type="button" onClick={async () => {
            if (await save({ ...view.policy, folders: view.policy.folders.filter(folder => folder !== id) })) {
              setPolicy(current => ({ ...current, folders: current.folders.filter(folder => folder !== id) }))
            }
          }}>Remove exclusion</button>
        </p>)}
      </details>
      <details className="connection-setup"><summary>Model prices</summary>
        <p>Enter API prices in USD per million tokens. Paper estimates costs for future requests when the provider reports both token counts. Codex subscription billing is unavailable.</p>
        {policy.prices.map((price, i) => <fieldset key={i}>
          <label className="connection-field">Model name<input required maxLength={200} value={price.model} onChange={e => editPrice(i, { model: e.target.value })} /></label>
          {(['input', 'output'] as const).map(key => <label key={key} className="connection-field">{key === 'input' ? 'Input price' : 'Output price'}
            <input type="number" required min={0} step="any" value={Number.isFinite(price[key]) ? price[key] : ''} onChange={e => editPrice(i, { [key]: e.target.valueAsNumber })} /></label>)}
          <button type="button" onClick={() => patch({ prices: policy.prices.filter((_, j) => j !== i) })}>Remove model price</button>
        </fieldset>)}
        <button type="button" onClick={() => patch({ prices: [...policy.prices, { model: '', input: NaN, output: NaN }] })}>Add model price</button>
      </details>
      <button type="submit" className="connection-save">Save AI controls</button>
    </fieldset>
    {message && <p role="status">{message}</p>}
  </form>
}
