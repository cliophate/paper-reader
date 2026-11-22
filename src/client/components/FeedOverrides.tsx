import { useEffect, useState } from 'react'
import type { FeedOverrideUpdate, FeedOverrideView } from '../../shared/feed-overrides'
import { api } from '../api'
import type { Feed } from '../types'

const empty: FeedOverrideUpdate = { userAgent: '', articleCookieOrigin: '', contentSelector: '', removeSelectors: [], lazyImages: false, stripTracking: false }

export function FeedOverrides({ feed, backend }: { feed: Feed; backend: 'standalone' | 'miniflux' | 'freshrss' }) {
  const [saved, setSaved] = useState<FeedOverrideView | null>(null)
  const [draft, setDraft] = useState(empty)
  const [entryId, setEntryId] = useState('')
  const [preview, setPreview] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  function load(view: FeedOverrideView) {
    const { userAgent, articleCookieOrigin, contentSelector, removeSelectors, lazyImages, stripTracking } = view
    setDraft({ userAgent, articleCookieOrigin, contentSelector, removeSelectors, lazyImages, stripTracking })
    setSaved(view)
    setEntryId(id => view.articles.some(article => article.id === id) ? id : view.articles[0]?.id || '')
  }
  useEffect(() => {
    let disposed = false
    api.feedOverrides(feed.id).then(view => { if (!disposed) load(view) })
      .catch(() => { if (!disposed) setError('Could not load feed overrides.') })
    return () => { disposed = true }
  }, [feed.id])
  function edit(patch: Partial<FeedOverrideUpdate>) {
    setDraft(current => ({ ...current, ...patch }))
    setPreview(''); setMessage(''); setError('')
  }
  async function run(action: 'preview' | 'save' | 'reset') {
    setBusy(true); setPreview(''); setMessage(''); setError('')
    const overrides = draft.cookie ? { ...draft, expectedCookieOrigin: origin } : draft
    try {
      if (action === 'preview') {
        const article = await api.previewFeedOverrides(feed.id, entryId, overrides)
        setPreview(article.contentHtml)
      } else {
        load(await api.saveFeedOverrides(feed.id, action === 'reset' ? { ...empty, cookie: null } : overrides))
        setMessage(action === 'reset' ? 'Overrides reset.' : 'Overrides saved.')
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not apply feed overrides.') }
    finally { setBusy(false) }
  }
  const active = saved && [saved.userAgent && 'user agent', saved.cookieSet && 'cookie', saved.contentSelector && 'content selector',
    saved.removeSelectors.length > 0 && 'element removal', saved.lazyImages && 'lazy images', saved.stripTracking && 'tracking links'].filter(Boolean).join(', ')
  const origin = URL.canParse(feed.url) ? new URL(feed.url).origin : ''
  return <details className="feed-repair feed-overrides">
    <summary>Fetch and extraction overrides{active && <small>{active}</small>}</summary>
    {error && <p role="alert" className="form-error">{error}</p>}
    {saved && <fieldset disabled={busy}>
      <p>{backend === 'standalone' ? 'Headers apply to feed checks and full articles. Rewrites also apply to new feed content.'
        : `${backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'} fetches this feed. These settings apply when Paper fetches a full article.`}</p>
      <label>User agent<input maxLength={512} value={draft.userAgent} onChange={event => edit({ userAgent: event.target.value })} /></label>
      <label>Cookie ({saved.cookieSet ? 'set' : 'not set'})<input type="password" autoComplete="new-password" maxLength={4096}
        value={draft.cookie || ''} placeholder={saved.cookieSet ? 'Leave blank to keep' : undefined}
        onChange={event => edit({ cookie: event.target.value || undefined })} /></label>
      {saved.cookieSet && <button type="button" onClick={() => edit({ cookie: draft.cookie === null ? undefined : null })}>{draft.cookie === null ? 'Keep saved cookie' : 'Clear cookie'}</button>}
      <p>{draft.cookie === null ? 'Saving will clear the cookie.' : `Feed cookie origin: ${draft.cookie ? origin : saved.cookieOrigin || origin}`}</p>
      {(draft.cookie || saved.cookieSet && draft.cookie !== null) && <label>Additional cookie origin for full articles, optional
        <input type="url" maxLength={512} placeholder="https://publisher.example" value={draft.articleCookieOrigin}
          onChange={event => edit({ articleCookieOrigin: event.target.value })} />
      </label>}
      <label>Full article content selector<input maxLength={256} value={draft.contentSelector} placeholder="article .body"
        onChange={event => edit({ contentSelector: event.target.value })} /></label>
      <label>Selectors to remove, one per line<textarea rows={3} value={draft.removeSelectors.join('\n')}
        onChange={event => edit({ removeSelectors: event.target.value.split('\n') })} /></label>
      <label><input type="checkbox" checked={draft.lazyImages} onChange={event => edit({ lazyImages: event.target.checked })} /> Prefer lazy-loaded images</label>
      <label><input type="checkbox" checked={draft.stripTracking} onChange={event => edit({ stripTracking: event.target.checked })} /> Strip tracking parameters from links</label>
      {saved.articles.length ? <><label>Recent article<select value={entryId} onChange={event => { setEntryId(event.target.value); setPreview('') }}>
        {saved.articles.map(article => <option key={article.id} value={article.id}>{article.title}</option>)}
      </select></label><button type="button" onClick={() => void run('preview')}>Preview article</button></> : <p>A preview is available once this feed has an article.</p>}
      {preview && <iframe title="Article preview" sandbox="" referrerPolicy="no-referrer" srcDoc={preview} />}
      <div className="feed-editor-actions"><button type="button" onClick={() => void run('save')}>Save overrides</button>
        {active && <button type="button" onClick={() => void run('reset')}>Reset overrides</button>}</div>
      {message && <p role="status">{message}</p>}
    </fieldset>}
  </details>
}
