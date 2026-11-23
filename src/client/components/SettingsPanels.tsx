import type { WebhookTarget } from '../../shared/webhooks'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { ActivityRecord, ArticleReport, MuteFilter } from '../types'
import { Icon } from './Icon'

export function FiltersSettings({ onOpenEntry, onChanged, notify, onMatchingChange }: {
  onOpenEntry: (id: string) => void
  onChanged: () => Promise<unknown>
  notify: (message: string) => void
  onMatchingChange?: (matching: boolean) => void
}) {
  const [filters, setFilters] = useState<MuteFilter[]>([])
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewRule>> | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [actions, setActions] = useState<MuteFilter['actions']>(['hide'])
  const [applyExisting, setApplyExisting] = useState(false)
  const [targets, setTargets] = useState<WebhookTarget[]>([])
  const [targetId, setTargetId] = useState('')
  const [hidden, setHidden] = useState<({ id: string } & Awaited<ReturnType<typeof api.hiddenByRule>>) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    try { setFilters(await api.filters()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Paper could not load filters') }
  }
  useEffect(() => { void load() }, [])

  const matching = filters.some(filter => filter.matching)
  // The reader keeps watching after Settings closes, so it can refresh once matching ends.
  useEffect(() => { onMatchingChange?.(matching) }, [matching, onMatchingChange])

  useEffect(() => {
    if (!matching) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const next = await api.filters()
        if (cancelled) return
        setFilters(next)
        if (filters.some(filter => filter.matching && next.some(item => item.id === filter.id && !item.matching))) await onChanged()
      } catch (reason) {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : 'Paper could not load filters')
        setFilters(current => [...current])
      }
    }, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [filters, onChanged])

  useEffect(() => { setPreview(null) }, [phrase])
  const check = async () => {
    setBusy(true); setPreviewing(true); setError('')
    try { setPreview(await api.previewRule(phrase.trim())) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not preview filter') }
    finally { setBusy(false); setPreviewing(false) }
  }
  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!phrase.trim() || busy || !preview || !actions.length || (actions.includes('notify') && !targetId)) return
    setBusy(true); setError('')
    try {
      const filter = await api.addRule(phrase.trim(), actions, targetId, applyExisting)
      setPhrase(''); setApplyExisting(false)
      setFilters(current => [filter, ...current])
      await onChanged()
      notify(filter.matching ? 'Rule saved. Checking existing articles.' : 'Rule saved.')
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
      notify('Rule removed')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not remove the filter')
    } finally { setBusy(false) }
  }

  const toggle = async (action: MuteFilter['actions'][number], checked: boolean) => {
    setActions(current => checked ? [...current, action] : current.filter(item => item !== action))
    if (action === 'notify' && checked) {
      try { setTargets((await api.webhooks()).targets) }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load notification targets.') }
    }
  }
  const showHidden = async (id: string, after = '') => {
    setBusy(true); setError('')
    try {
      const page = await api.hiddenByRule(id, after)
      setHidden(previous => ({ ...page, id, items: after && previous?.id === id ? [...previous.items, ...page.items] : page.items }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load hidden articles.') }
    finally { setBusy(false) }
  }
  const undo = async (rule: MuteFilter) => {
    setBusy(true); setError('')
    try { await api.undo(rule.undoTokens); notify('Restored article state.') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not undo the state changes.') }
    finally { await load(); await onChanged(); setBusy(false) }
  }
  return <section className="settings-page filters-settings">
    <header><h3>Article rules</h3><p>Use a search query to act on incoming articles. Hide keeps articles in your archive. Mark read and Star change reading state. Rules never discard articles.</p></header>
    <form className="filter-form rule-form" onSubmit={add}>
      <label className="filter-phrase"><span>Search query</span><input disabled={busy} autoFocus placeholder={'title:"new episode" OR feed:podcast'} value={phrase} onChange={event => setPhrase(event.target.value)} /></label>
      <fieldset disabled={busy}><legend>Actions</legend>{ruleActions.map(([action, label]) =>
        <label key={action}><input type="checkbox" checked={actions.includes(action)} onChange={event => void toggle(action, event.target.checked)} />{label}</label>)}</fieldset>
      {actions.includes('notify') && <label><span>Notification target</span><select disabled={busy} value={targetId} onChange={event => setTargetId(event.target.value)}>
        <option value="">Choose a target</option>{targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
      </select><small>Add targets in Reading &amp; connections.</small></label>}
      <label className="rule-existing"><input type="checkbox" disabled={busy} checked={applyExisting} onChange={event => setApplyExisting(event.target.checked)} />Also apply to existing matches</label>
      <button type="button" disabled={busy || !phrase.trim()} onClick={() => void check()}>{previewing ? 'Checking...' : 'Preview matches'}</button>
      <button type="submit" disabled={busy || !preview || !actions.length || (actions.includes('notify') && !targetId)}>Save rule</button>
    </form>
    {preview && <div className="filter-preview" role="status"><p>{preview.count} matching {preview.count === 1 ? 'article' : 'articles'}.</p><ul>{preview.items.map(entry => <li key={entry.id}>{entry.title} <small>{entry.feedTitle}</small></li>)}</ul></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-list">
      {filters.map(filter => <article className="settings-list-row rule-row" key={filter.id}>
        <div><strong>{filter.phrase}</strong><span>{filter.scope === 'query' ? ruleActions.filter(([action]) => filter.actions.includes(action)).map(([action, label]) => action === 'notify' && filter.targetName ? `Notify ${filter.targetName}` : label).join(', ')
          : `Contains this phrase in ${scopeLabel(filter.scope)}${filter.feedTitle ? ' in ' + filter.feedTitle : ''}`}
          {filter.actions.includes('notify') && !filter.targetId && ' · Notification target removed'}
          {filter.matching && ' · Matching...'}</span></div>
        {filter.actions.includes('hide') && (!filter.matching || filter.matchCount > 0) && <button disabled={busy} onClick={() => void showHidden(filter.id)}>{filter.matchCount} hidden</button>}
        {!filter.matching && filter.undoTokens.length > 0 && <button disabled={busy} onClick={() => void undo(filter)}>Undo state changes</button>}
        <button onClick={() => void remove(filter)} disabled={busy} aria-label={`Remove rule ${filter.phrase}`}><Icon name="close" /> Remove</button>
        {hidden?.id === filter.id && <div className="hidden-articles"><strong>Hidden articles</strong>
          {hidden.items.map(item => <button key={item.id} onClick={() => onOpenEntry(item.id)}>{item.title}</button>)}
          {!hidden.items.length && <span>No hidden articles.</span>}
          {hidden.next && <button disabled={busy} onClick={() => void showHidden(filter.id, hidden.next)}>Show more</button>}
          <button onClick={() => setHidden(null)}>Close list</button></div>}
      </article>)}
      {!filters.length && <div className="settings-empty">No article rules yet.</div>}
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

const ruleActions = [['hide', 'Hide'], ['read', 'Mark read'], ['star', 'Star'], ['notify', 'Notify']] as const

function scopeLabel(scope: MuteFilter['scope']): string {
  if (scope === 'title') return 'the title'
  if (scope === 'content') return 'the article text'
  return 'the title, text, author or source'
}

function issueLabel(issue: ArticleReport['issue']): string {
  if (issue === 'content') return 'Content'
  if (issue === 'media') return 'Image or video'
  if (issue === 'metadata') return 'Metadata'
  if (issue === 'social') return 'Social post'
  return 'Other'
}

function activityDetail(event: ActivityRecord): string {
  if (event.origin === 'rule' && Array.isArray(event.details.articles)) {
    return `${event.details.reason} · Rule ${event.details.ruleId} · ${event.details.articles.map(number => '#' + number).join(', ')}`
  }
  if (event.kind !== 'sync') return event.origin
  const details = event.details
  const changes = Number(details.readToUnread || 0)
  const duration = Number(details.durationMs || 0)
  const parts = [event.origin]
  if (duration > 0) parts.push(`${Math.max(1, Math.round(duration / 1000))}s`)
  if (changes > 0) parts.push(`${changes} restored to unread by the backend`)
  return parts.join(' · ')
}

function formatActivityTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
