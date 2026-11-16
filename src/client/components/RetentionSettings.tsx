import { useEffect, useId, useRef, useState } from 'react'
import { effectiveAutoRead } from '../../server/retention-policy'
import { api } from '../api'
import type { RetentionPolicy, RetentionPreview, RetentionView } from '../../shared/retention'

function Days({ label, help, value, onChange, suggested = 30, inherit = false }: {
  label: string; help: string; value: number | null | undefined; onChange(value: number | null | undefined): void; suggested?: number; inherit?: boolean
}) {
  const id = useId()
  return <div className="settings-list-row retention-row">
    <div><label htmlFor={id}>{label}</label><span id={`${id}-help`}>{help}</span></div>
    <span className="retention-days">
      <select id={id} aria-label={label} aria-describedby={`${id}-help`} value={value === undefined ? 'inherit' : value === null ? 'off' : 'days'}
        onChange={event => onChange(event.target.value === 'inherit' ? undefined : event.target.value === 'off' ? null : suggested)}>
        {inherit && <option value="inherit">Inherit</option>}
        <option value="off">{inherit ? 'Never' : 'Off'}</option><option value="days">After</option>
      </select>
      {typeof value === 'number' && <span className="retention-day-count">
        <input aria-label={`${label} days`} aria-describedby={`${id}-help`} type="number" min="1" max="36500" required value={value}
          onChange={event => onChange(event.target.valueAsNumber)} /><span>days</span>
      </span>}
    </span>
  </div>
}

export function RetentionSettings({ backend }: { backend: 'standalone' | 'freshrss' | 'miniflux' }) {
  const previewHintId = useId()
  const folderPicker = useRef<HTMLSelectElement>(null), feedPicker = useRef<HTMLSelectElement>(null)
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
  const selectedFeed = view?.feeds.find(item => item.id === feed)
  const effective = draft && selectedFeed ? effectiveAutoRead(draft, feed, selectedFeed.folderIds) : null
  const source = effective?.source === 'folder' ? `folder ${view?.folders.find(item => item.id === effective.folderId)?.title || effective.folderId}`
    : effective?.source === 'feed' ? "this feed's limit" : 'the default limit'
  const deleting = draft && (draft.readDays !== null || draft.unreadDays !== null)
  const needsPreview = Boolean(deleting && !preview)
  const overrides = draft && view ? [
    ...Object.entries(draft.folderDays).map(([id, days]) => ({ kind: 'folderDays' as const, id, days, title: view.folders.find(item => item.id === id)?.title || id })),
    ...Object.entries(draft.feedDays).map(([id, days]) => ({ kind: 'feedDays' as const, id, days, title: view.feeds.find(item => item.id === id)?.title || id })),
  ] : []
  return <section className="retention-settings" aria-label="Article cleanup">
    <h4>Article cleanup</h4>
    <p className="settings-intro">All limits start off.{backend === 'standalone' && ' Article age counts from when Paper first saved it.'}</p>
    {backend !== 'standalone' && <p className="settings-intro">{backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'} manages article history. Paper only removes saved full-text pages here.</p>}
    {draft && view && <form onSubmit={event => { event.preventDefault(); void perform(false) }}>
      <fieldset disabled={busy}>
        {backend === 'standalone' && <>
          <section className="retention-group" aria-label="Mark as read">
            <h5>Mark as read</h5>
            <Days label="Mark unread articles as read" help="Applies to all feeds unless you set a different limit below."
              value={draft.autoReadDays} onChange={value => change({ ...draft, autoReadDays: value ?? null })} />
            <section className="retention-overrides" aria-label="Mark as read overrides">
              <h6>Different limits for folders or feeds</h6>
              <p className="settings-intro">These only change when articles are marked read. A feed limit comes first. For feeds in several folders, Never wins, then the longest limit. Otherwise, Paper uses the default above. Inherit removes a limit.</p>
              {overrides.length > 0 && <ul className="retention-override-list" aria-label="Existing overrides">
                {overrides.map(item => <li className="settings-list-row" key={`${item.kind}-${item.id}`}>
                  <div><strong>{item.title}</strong><span>{item.kind === 'folderDays' ? 'Folder' : 'Feed'}, {item.days === null ? 'never' : `after ${item.days} days`}</span></div>
                  <span className="retention-override-actions">
                    <button type="button" aria-label={`Change ${item.kind === 'folderDays' ? 'folder' : 'feed'} limit for ${item.title}`}
                      onClick={() => { if (item.kind === 'folderDays') { setFolder(item.id); folderPicker.current?.focus() } else { setFeed(item.id); feedPicker.current?.focus() } }}>Change</button>
                    <button type="button" aria-label={`Remove ${item.kind === 'folderDays' ? 'folder' : 'feed'} limit for ${item.title}`}
                      onClick={() => override(item.kind, item.id, undefined)}>Remove</button>
                  </span>
                </li>)}
              </ul>}
              <div className="retention-override-picker">
                <label>Folder <select ref={folderPicker} aria-label="Override folder" value={folder} onChange={event => setFolder(event.target.value)}>
                  <option value="">Choose a folder</option>{view.folders.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select></label>
                {folder && <Days label="Folder limit" help={view.folders.find(item => item.id === folder)?.title || folder} inherit
                  value={Object.hasOwn(draft.folderDays, folder) ? draft.folderDays[folder] : undefined} onChange={value => override('folderDays', folder, value)} />}
                <label>Feed <select ref={feedPicker} aria-label="Override feed" value={feed} onChange={event => setFeed(event.target.value)}>
                  <option value="">Choose a feed</option>{view.feeds.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                </select></label>
                {feed && <Days label="Feed limit" help={selectedFeed?.title || feed} inherit
                  value={Object.hasOwn(draft.feedDays, feed) ? draft.feedDays[feed] : undefined} onChange={value => override('feedDays', feed, value)} />}
              </div>
              {effective && <p className="retention-effective" role="status">{selectedFeed?.title}: {effective.days === null ? 'never marked read automatically' : `marked read after ${effective.days} days`}, from {source}.</p>}
            </section>
          </section>
          <section className="retention-group" aria-label="Delete old articles">
            <h5>Delete old articles</h5>
            <Days label="Read articles" help="Delete old articles you have read." value={draft.readDays} suggested={60} onChange={value => change({ ...draft, readDays: value ?? null })} />
            <Days label="Unread articles" help="Delete old articles even if you have not read them." value={draft.unreadDays} suggested={180} onChange={value => change({ ...draft, unreadDays: value ?? null })} />
            <div className="retention-protections">
              <h6>Paper always keeps</h6>
              <ul>
                <li>Starred articles</li><li>Articles with discussions</li><li>Pulse collections</li>
                <li>Saved briefings and reports</li><li>Recent reading history</li><li>Articles still in their feed</li>
              </ul>
              <p>Paper makes a backup before it deletes anything for the first time.</p>
            </div>
          </section>
        </>}
        <section className="retention-group" aria-label="Full-text cache">
          <h5>Full-text cache</h5>
          <Days label="Remove saved full-text pages" help="Age counts from when Paper fetched the page. Articles and search results stay."
            value={draft.cacheDays} onChange={value => change({ ...draft, cacheDays: value ?? null })} />
        </section>
        <div className="retention-actions">
          {backend === 'standalone' && <button type="submit">Preview</button>}
          <button type="button" disabled={busy || needsPreview} aria-describedby={needsPreview ? previewHintId : undefined} onClick={() => void perform(true)}>Save</button>
          {needsPreview && <span id={previewHintId}>Preview first to see what would be deleted.</span>}
        </div>
      </fieldset>
      {preview && <div className="retention-preview" role="status">
        <p>This would mark <strong>{preview.marked}</strong> read and delete <strong>{preview.deleted}</strong> articles.</p>
        <p className="settings-intro">Counts can change if articles or their saved state change before cleanup.</p>
      </div>}
    </form>}
    {message && <p role="status">{message}</p>}
    {view?.error && <p role="alert">{view.error}</p>}
    <div className="retention-status">
      {backend === 'standalone' && <p>Article cleanup runs daily and after you save.</p>}
      <p>Cache cleanup runs every six hours and after you save.</p>
      {backend === 'standalone' && view?.lastRun && <p>Last run: {view.lastRun.finishedAt ? new Date(view.lastRun.finishedAt).toLocaleString() : 'in progress'}. Marked {view.lastRun.marked} read and deleted {view.lastRun.deleted} articles.</p>}
      {view?.cacheRun && <p>Last cache cleanup: {new Date(view.cacheRun.at).toLocaleString()}. Removed {view.cacheRun.deleted} pages.</p>}
    </div>
  </section>
}
