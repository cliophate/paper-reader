import { useEffect, useState } from 'react'
import { api } from '../api'
import type { RetentionPolicy, RetentionPreview, RetentionView } from '../../shared/retention'

function Days({ label, value, onChange, suggested = 30, inherit = false }: {
  label: string; value: number | null | undefined; onChange(value: number | null | undefined): void; suggested?: number; inherit?: boolean
}) {
  return <label className="retention-days"><span>{label}</span>
    <select aria-label={label} value={value === undefined ? 'inherit' : value === null ? 'off' : 'days'}
      onChange={event => onChange(event.target.value === 'inherit' ? undefined : event.target.value === 'off' ? null : suggested)}>
      {inherit && <option value="inherit">Inherit</option>}
      <option value="off">{inherit ? 'Never' : 'Off'}</option><option value="days">After days</option>
    </select>
    {typeof value === 'number' && <input aria-label={`${label} days`} type="number" min="1" max="36500" required value={value}
      onChange={event => onChange(event.target.valueAsNumber)} />}
  </label>
}

export function RetentionSettings({ backend }: { backend: 'standalone' | 'freshrss' }) {
  const [view, setView] = useState<RetentionView | null>(null)
  const [draft, setDraft] = useState<RetentionPolicy | null>(null)
  const [revision, setRevision] = useState(0)
  const [preview, setPreview] = useState<RetentionPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [folder, setFolder] = useState(''), [feed, setFeed] = useState('')
  useEffect(() => {
    let active = true
    void api.retention().then(value => { if (active) { setView(value); setDraft(value.policy); setRevision(value.revision) } }).catch(() => { if (active) setMessage('Could not load retention settings.') })
    const timer = setInterval(() => { void api.retention().then(value => { if (active) setView(value) }).catch(() => {}) }, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const change = (next: RetentionPolicy) => { setDraft(next); setPreview(null); setMessage('') }
  const override = (kind: 'folderDays' | 'feedDays', id: string, value: number | null | undefined) => {
    if (!draft) return
    const values = { ...draft[kind] }
    if (value === undefined) delete values[id]; else values[id] = value
    change({ ...draft, [kind]: values })
  }
  const perform = async (save: boolean) => {
    if (!draft) return
    setBusy(true); setMessage('')
    try {
      if (save) {
        const value = await api.saveRetention(draft, revision, preview?.token)
        setView(value); setDraft(value.policy); setRevision(value.revision); setPreview(null)
        setMessage('Policy saved. Cleanup will run in the background.')
      } else setPreview(await api.previewRetention(draft))
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not update retention.') }
    finally { setBusy(false) }
  }
  const deleting = draft && (draft.readDays !== null || draft.unreadDays !== null)
  return <section className="retention-settings" aria-label="Retention">
    <h4>Retention</h4>
    {backend === 'freshrss' && <p>FreshRSS owns article history. Paper only cleans its full-text cache here.</p>}
    {draft && view && <form onSubmit={event => { event.preventDefault(); void perform(false) }}>
      <fieldset disabled={busy}>
        {backend === 'standalone' && <>
          <p>Age starts when Paper first stores an article. All limits are off until you enable them.</p>
          <Days label="Auto-mark-read" value={draft.autoReadDays} onChange={value => change({ ...draft, autoReadDays: value ?? null })} />
          <details><summary>Folder and feed overrides</summary>
            <p>Feed overrides take priority over folder overrides, then the global limit. Never disables auto-read for that scope.</p>
            <label>Folder <select aria-label="Override folder" value={folder} onChange={event => setFolder(event.target.value)}>
              <option value="">Choose a folder</option>{view.folders.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select></label>
            {folder && <Days label="Folder auto-read" inherit value={Object.hasOwn(draft.folderDays, folder) ? draft.folderDays[folder] : undefined} onChange={value => override('folderDays', folder, value)} />}
            <label>Feed <select aria-label="Override feed" value={feed} onChange={event => setFeed(event.target.value)}>
              <option value="">Choose a feed</option>{view.feeds.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select></label>
            {feed && <Days label="Feed auto-read" inherit value={Object.hasOwn(draft.feedDays, feed) ? draft.feedDays[feed] : undefined} onChange={value => override('feedDays', feed, value)} />}
          </details>
          <Days label="Delete read articles" value={draft.readDays} suggested={60} onChange={value => change({ ...draft, readDays: value ?? null })} />
          <Days label="Delete unread articles" value={draft.unreadDays} suggested={180} onChange={value => change({ ...draft, unreadDays: value ?? null })} />
          <p>Stars, discussions, Pulse collections, saved briefings, reports and recent reading history stay. Articles still in the latest feed also stay. Paper backs up before its first deletion.</p>
        </>}
        <Days label="Clean full-text cache" value={draft.cacheDays} onChange={value => change({ ...draft, cacheDays: value ?? null })} />
        <p>Cache cleanup runs every six hours. Article cleanup runs daily and after policy changes.</p>
        {backend === 'standalone' && <button type="submit">Preview policy</button>}
        <button type="button" disabled={busy || Boolean(deleting && !preview)} onClick={() => void perform(true)}>Save retention policy</button>
      </fieldset>
      {preview && <p role="status">This would mark {preview.marked} read and delete {preview.deleted} articles. Counts can change if articles or their saved state change before cleanup.</p>}
    </form>}
    {message && <p role="status">{message}</p>}
    {view?.error && <p role="alert">{view.error}</p>}
    {view?.lastRun && <p>Last run: {view.lastRun.finishedAt ? new Date(view.lastRun.finishedAt).toLocaleString() : 'in progress'}. Marked {view.lastRun.marked} read and deleted {view.lastRun.deleted} articles.</p>}
    {view?.cacheRun && <p>Last cache cleanup: {new Date(view.cacheRun.at).toLocaleString()}. Removed {view.cacheRun.deleted} pages.</p>}
  </section>
}
