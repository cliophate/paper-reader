import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SavedView, ViewCount } from '../../shared/saved-views'
import { searchHint } from '../../server/search-query'
import { api, ApiError } from '../api'
import { emptyFilters, filtersQuery, queryFilters } from '../savedViews'
import type { NavigationPayload, StreamRef } from '../types'
import { Icon } from './Icon'
import { Modal } from './Modal'

function countLabel(value: ViewCount) { return String(value.count) + (value.capped ? '+' : '') }

export function SavedViews({ navigation, active, online, onOpen, onChanged, initialQuery, downloadAction }: {
  navigation: NavigationPayload | null; active: string; online: boolean; onOpen: (stream: StreamRef) => void
  downloadAction: (id: string) => React.ReactNode
  onChanged: () => Promise<unknown>; initialQuery: string
}) {
  const views = navigation?.savedViews
  const [editor, setEditor] = useState<SavedView | 'new' | null>(null)
  const [counts, setCounts] = useState<Record<string, ViewCount>>({})
  useEffect(() => {
    if (!views?.length || !online) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const updated = await api.viewCounts(controller.signal)
        if (!controller.signal.aborted) setCounts(current => ({ ...current, ...updated }))
      } catch { /* Keep the last counts until navigation refreshes. */ }
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [views, online])
  return <>
    <div className="saved-views-heading"><span>Saved views</span><button className="icon-button" aria-label="Create saved view" disabled={!online} onClick={() => setEditor('new')}><Icon name="plus" /></button></div>
    {views?.map(view => <div className="saved-view-row" key={view.id}>
      <button className={'source-row' + (active === view.id ? ' active' : '')} onClick={() => onOpen({ kind: 'view', id: view.id, title: view.title, viewQuery: view.query })}>
        <Icon name="bookmark" /><span className="source-label">{view.title}</span>
        <span className="source-count" title="Unread articles">{counts[view.id] && countLabel(counts[view.id])}</span>
      </button><button className="icon-button" aria-label={'Edit ' + view.title} disabled={!online} onClick={() => setEditor(view)}><Icon name="edit" /></button>
    </div>)}
    {editor && createPortal(<ViewEditor view={editor === 'new' ? undefined : editor} navigation={navigation} initialQuery={editor === 'new' ? initialQuery : editor.query}
      downloadAction={editor === 'new' ? null : downloadAction(editor.id)} onClose={() => setEditor(null)} onChanged={onChanged} />, document.body)}
  </>
}

function ViewEditor({ view, initialQuery, navigation, onClose, onChanged, downloadAction }: {
  downloadAction: React.ReactNode
  view?: SavedView; initialQuery: string; navigation: NavigationPayload | null; onClose: () => void; onChanged: () => Promise<unknown>
}) {
  const [title, setTitle] = useState(view?.title || '')
  const [query, setQuery] = useState(initialQuery)
  const [filters, setFilters] = useState(() => queryFilters(initialQuery) || emptyFilters)
  const [raw, setRaw] = useState(() => !queryFilters(initialQuery))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState('')
  const text = raw ? query : filtersQuery(filters)
  const hint = searchHint(text)?.replace(' Searching as plain terms.', '')
  const feeds = new Map(navigation?.uncategorized.map(feed => [feed.id, feed]))
  for (const folder of navigation?.folders || []) for (const feed of folder.feeds) feeds.set(feed.id, feed)
  const views = navigation?.savedViews || []
  const orderRevision = views.map(item => item.id).join(',')
  const index = views.findIndex(item => item.id === view?.id)
  useEffect(() => {
    setPreview('')
    if (!text || hint) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const value = await api.viewCount(text, false, controller.signal)
        if (!controller.signal.aborted) setPreview(countLabel(value) + (value.count === 1 ? ' match' : ' matches'))
      } catch (error) {
        if (!controller.signal.aborted) setPreview(error instanceof Error ? error.message : 'Count unavailable.')
      }
    }, 260)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [text, hint])
  async function change(action: () => Promise<unknown>, close: boolean) {
    setBusy(true); setError('')
    try {
      await action()
      if (close) onClose()
      await onChanged()
    }
    catch (error) {
      setError(error instanceof Error ? error.message : 'Could not update the view.')
      if (error instanceof ApiError && error.status === 409) await onChanged()
    }
    finally { setBusy(false) }
  }
  const days = /^\d+d$/.test(filters.after)
  return <Modal title={view ? 'Edit saved view' : 'Create saved view'} onClose={onClose} busy={busy} className="view-editor">
    <form onSubmit={event => { event.preventDefault(); void change(() => api.saveView(title, text, view), true) }}>
      <fieldset disabled={busy}>
        <label>Name<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label>
        {!raw && <>
          <label>Feeds and folders<select multiple value={filters.sources} onChange={event => setFilters({ ...filters, sources: [...event.target.selectedOptions].map(option => option.value) })}>
            <optgroup label="Folders">{navigation?.folders.map(folder => <option key={folder.id} value={'folderid:' + folder.id}>{folder.title}</option>)}</optgroup>
            <optgroup label="Feeds">{[...feeds.values()].map(feed => <option key={feed.id} value={'feedid:' + feed.id}>{feed.title}</option>)}</optgroup>
          </select></label>
          <label>Keywords<input value={filters.keywords} onChange={event => setFilters({ ...filters, keywords: event.target.value })} /></label>
          <label>Author<input value={filters.author} onChange={event => setFilters({ ...filters, author: event.target.value })} /></label>
          <div className="view-filter-pair">
            <label>Published in the last<input aria-label="Number of days" type="number" min="1" placeholder="Days" value={days ? filters.after.slice(0, -1) : ''} onChange={event => setFilters({ ...filters, after: event.target.value ? event.target.value + 'd' : '' })} /></label>
            <label>Published since<input type="date" value={days ? '' : filters.after} onChange={event => setFilters({ ...filters, after: event.target.value })} /></label>
          </div>
          <label>Published before<input type="date" value={filters.before} onChange={event => setFilters({ ...filters, before: event.target.value })} /></label>
          <div className="view-filter-pair">{(['minminutes', 'maxminutes'] as const).map(key => <label key={key}>{key === 'minminutes' ? 'Minimum minutes' : 'Maximum minutes'}<input type="number" min="0" value={filters[key]} onChange={event => setFilters({ ...filters, [key]: event.target.value })} /></label>)}</div>
          <label>Read status<select value={filters.read} onChange={event => setFilters({ ...filters, read: event.target.value })}><option value="">Any</option><option value="unread">Unread</option><option value="read">Read</option></select></label>
          <label>Stars<select value={filters.stars} onChange={event => setFilters({ ...filters, stars: event.target.value })}><option value="">Any</option><option value="is:starred">Starred</option><option value="-is:starred">Unstarred</option></select></label>
        </>}
        <label>Search query<textarea value={text} onChange={event => { setQuery(event.target.value); setRaw(true) }} /></label>
        {raw && <button type="button" disabled={!queryFilters(query)} onClick={() => { setFilters(queryFilters(query)!); setRaw(false) }}>Edit with filters</button>}
        <output aria-live="polite">{hint || preview || (text ? 'Counting matches…' : 'Choose a filter or enter a query.')}</output>
        {error && <p role="alert">{error}</p>}
        <div className="view-editor-actions"><button disabled={!title.trim() || !text.trim() || Boolean(hint)}>Save view</button>
          {view && <>
            {downloadAction}
            <button type="button" disabled={index <= 0} onClick={() => void change(() => api.moveView(view.id, 'up', orderRevision), false)}>Move up</button>
            <button type="button" disabled={index < 0 || index === views.length - 1} onClick={() => void change(() => api.moveView(view.id, 'down', orderRevision), false)}>Move down</button>
            <button type="button" onClick={() => { if (window.confirm('Delete "' + view.title + '"?')) void change(() => api.deleteView(view), true) }}>Delete view</button>
          </>}
        </div>
        {view && <p>If you edit or delete this view, downloaded articles stay on this device until you remove them.</p>}
      </fieldset>
    </form>
  </Modal>
}
