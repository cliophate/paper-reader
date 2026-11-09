import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { ActivityRecord, ArticleReport, Feed, MuteFilter } from '../types'
import { Icon } from './Icon'

export function FiltersSettings({ feeds, onChanged, notify }: {
  feeds: Feed[]
  onChanged: () => Promise<unknown>
  notify: (message: string) => void
}) {
  const [filters, setFilters] = useState<MuteFilter[]>([])
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewFilter>> | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [scope, setScope] = useState<MuteFilter['scope']>('title')
  const [feedId, setFeedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    try { setFilters(await api.filters()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Paper could not load filters') }
  }
  useEffect(() => { void load() }, [])

  useEffect(() => { setPreview(null) }, [phrase, scope, feedId])
  const check = async () => {
    setBusy(true); setPreviewing(true); setError('')
    try { setPreview(await api.previewFilter(phrase.trim(), scope, feedId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not preview filter') }
    finally { setBusy(false); setPreviewing(false) }
  }
  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    if (phrase.trim().length < 2 || busy || !preview) return
    setBusy(true); setError('')
    try {
      const filter = await api.addFilter(phrase.trim(), scope, feedId)
      setPhrase('')
      setFilters(current => [filter, ...current])
      await onChanged()
      notify(`${filter.matchCount} existing ${filter.matchCount === 1 ? 'article matches' : 'articles match'} this filter`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not add the filter')
    } finally { setBusy(false) }
  }

  const remove = async (filter: MuteFilter) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await api.removeFilter(filter.id)
      setFilters(current => current.filter(item => item.id !== filter.id))
      await onChanged()
      notify('Filter removed')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not remove the filter')
    } finally { setBusy(false) }
  }

  return <section className="settings-page filters-settings">
    <header><h3>Filters</h3><p>Hide recurring noise without deleting it or changing its FreshRSS read state. Removing a filter restores any matches that are still unread.</p></header>
    <form className="filter-form" onSubmit={add}>
      <label className="filter-phrase"><span>Phrase</span><input disabled={busy} autoFocus placeholder="New podcast episode" value={phrase} onChange={event => setPhrase(event.target.value)} /></label>
      <label><span>Look in</span><select disabled={busy} value={scope} onChange={event => setScope(event.target.value as MuteFilter['scope'])}><option value="title">Title</option><option value="content">Article text</option><option value="any">Title, article, author, or source</option></select></label>
      <label><span>Feed</span><select disabled={busy} value={feedId} onChange={event => setFeedId(event.target.value)}><option value="">Every feed</option>{feeds.map(feed => <option key={feed.id} value={feed.id}>{feed.title}</option>)}</select></label>
      <button type="button" disabled={busy || phrase.trim().length < 2} onClick={() => void check()}>{previewing ? "Checking..." : "Preview matches"}</button><button type="submit" disabled={busy || !preview}>Add filter</button>
    </form>
    {preview && <div className="filter-preview"><p>{preview.count} matching articles. Starred matches stay visible in Starred.</p><ul>{preview.items.map(entry => <li key={entry.id}>{entry.title} <small>{entry.feedTitle}</small></li>)}</ul></div>}
    {error && <p className="form-error">{error}</p>}
    <div className="settings-list">
      {filters.map(filter => <article className="settings-list-row" key={filter.id}>
        <div><strong>"{filter.phrase}"</strong><span>{scopeLabel(filter.scope)}{filter.feedTitle ? ` in ${filter.feedTitle}` : ' in every feed'} · {filter.matchCount} hidden</span></div>
        <button onClick={() => void remove(filter)} disabled={busy} aria-label={`Remove filter ${filter.phrase}`}><Icon name="close" /> Remove</button>
      </article>)}
      {!filters.length && <div className="settings-empty">No filters yet.</div>}
    </div>
  </section>
}

export function ActivitySettings() {
  const [events, setEvents] = useState<ActivityRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true); setError('')
    try { setEvents(await api.activity(150)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Paper could not load activity') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  return <section className="settings-page activity-settings">
    <header><div><h3>Activity</h3><p>Paper records synchronization and state changes for 30 days. This is where an unexpected unread count should explain itself.</p></div><button className="settings-refresh" onClick={() => void load()}><Icon name="refresh" /> Refresh</button></header>
    {error && <p className="form-error">{error}</p>}
    <div className="settings-list activity-list">
      {events.map(event => <article className="activity-row" key={event.id}>
        <span className={`activity-kind ${event.kind}`}>{event.kind}</span>
        <div><strong>{event.summary}</strong><span>{activityDetail(event)} · {formatActivityTime(event.occurredAt)}</span></div>
      </article>)}
      {!loading && !events.length && <div className="settings-empty">No activity has been recorded yet.</div>}
      {loading && <div className="settings-empty">Loading activity...</div>}
    </div>
  </section>
}

export function ReportsSettings({ onOpenEntry, notify }: {
  onOpenEntry: (id: string) => void
  notify: (message: string) => void
}) {
  const [reports, setReports] = useState<ArticleReport[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true); setError('')
    try { setReports(await api.reports()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Paper could not load reports') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const openCount = useMemo(() => reports.filter(report => report.status === 'open').length, [reports])
  const toggle = async (report: ArticleReport) => {
    const status = report.status === 'open' ? 'resolved' : 'open'
    setBusyId(report.id)
    try {
      await api.setReportStatus(report.id, status)
      setReports(current => current.map(item => item.id === report.id ? { ...item, status, resolvedAt: status === 'resolved' ? new Date().toISOString() : null } : item))
      notify(status === 'resolved' ? 'Report resolved' : 'Report reopened')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Paper could not update the report') }
    finally { setBusyId('') }
  }
  return <section className="settings-page reports-settings">
    <header><h3>Reports</h3><p>{openCount} open. Reports keep the article source and the rendering details that were present when you filed them.</p></header>
    {error && <p className="form-error">{error}</p>}
    <div className="settings-list reports-list">
      {reports.map(report => <article className={`report-row ${report.status}`} key={report.id}>
        <div className="report-copy"><span>{issueLabel(report.issue)} · {report.feedTitle}</span><strong>{report.entryTitle}</strong>{report.note && <p>{report.note}</p>}<time dateTime={report.createdAt}>{formatActivityTime(report.createdAt)}</time></div>
        <div className="report-actions"><button onClick={() => onOpenEntry(report.entryId)}>Open</button><button onClick={() => void toggle(report)} disabled={busyId === report.id}>{report.status === 'open' ? 'Resolve' : 'Reopen'}</button></div>
      </article>)}
      {!loading && !reports.length && <div className="settings-empty">No article problems reported.</div>}
      {loading && <div className="settings-empty">Loading reports...</div>}
    </div>
  </section>
}

function scopeLabel(scope: MuteFilter['scope']): string {
  if (scope === 'title') return 'Title'
  if (scope === 'content') return 'Article text'
  return 'Anywhere'
}

function issueLabel(issue: ArticleReport['issue']): string {
  if (issue === 'content') return 'Content'
  if (issue === 'media') return 'Image or video'
  if (issue === 'metadata') return 'Metadata'
  if (issue === 'social') return 'Social post'
  return 'Other'
}

function activityDetail(event: ActivityRecord): string {
  if (event.kind !== 'sync') return event.origin
  const details = event.details
  const changes = Number(details.readToUnread || 0)
  const duration = Number(details.durationMs || 0)
  const parts = [event.origin]
  if (duration > 0) parts.push(`${Math.max(1, Math.round(duration / 1000))}s`)
  if (changes > 0) parts.push(`${changes} restored to unread by FreshRSS`)
  return parts.join(' · ')
}

function formatActivityTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
