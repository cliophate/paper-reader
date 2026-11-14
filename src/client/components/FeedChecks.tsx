import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { FeedCheckResult, FeedChecksView, FeedCheckTarget } from '../../shared/feed-checks'
import { api } from '../api'

const FeedChecksContext = createContext<{
  view: FeedChecksView | null
  busy: boolean
  check: (target: FeedCheckTarget) => Promise<void>
  interval: (minutes: number | null, feedId?: string) => Promise<void>
} | null>(null)

const time = (value: number) => new Date(value).toLocaleString()
function errorSummary(error: string, status: number) {
  const messages: Record<string, string> = { policy: 'The network policy blocked this feed.', network: 'The network request failed.',
    timeout: 'The feed request timed out.', limit: 'The feed exceeded a request limit.', encoding: 'The feed uses an unsupported encoding.',
    redirect: 'The feed redirect failed.', aborted: 'The check was cancelled.', ingestion: 'Paper could not read the feed contents.' }
  return messages[error] || (status ? `The publisher returned HTTP ${status}.` : 'The feed request failed.')
}
function resultMessage(results: FeedCheckResult[]) {
  if (!results.length) return 'This folder has no feeds.'
  if (results.length === 1) {
    const result = results[0]
    if (result.status === 'retry-after') return `The publisher requested a wait until ${time(result.until!)}.`
    if (result.status === 'cooldown') return `This feed was checked recently. Try again after ${time(result.until!)}.`
    if (result.status === 'running') return 'This feed is already being checked.'
    if (result.status === 'queued') return 'Check queued. Articles appear after collection finishes.'
  }
  const labels: Record<FeedCheckResult['status'], string> = { queued: 'queued', running: 'already running', cooldown: 'waiting for cooldown', 'retry-after': 'waiting for the publisher', unavailable: 'unavailable', 'queue-full': 'queue full, try later' }
  return Object.entries(labels).flatMap(([status, label]) => {
    const count = results.filter(result => result.status === status).length
    return count ? [`${count} ${label}`] : []
  }).join('; ') + '.'
}

export function FeedChecks({ children }: { children: ReactNode }) {
  const [view, setView] = useState<FeedChecksView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState('')
  const [folderId, setFolderId] = useState('')
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try { const next = await api.feedChecks(); if (!disposed) { setView(next); setLoadError('') } }
      catch { if (!disposed) setLoadError('Could not load feed checks. Retrying in a few seconds.') }
      if (!disposed) timer = setTimeout(() => void load(), 5000)
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [])
  const run = async (action: (revision: { expectedRevision: number; expectedOrganizationRevision: number }) => Promise<{ snapshot: FeedChecksView; results?: FeedCheckResult[] }>) => {
    if (!view || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await action({ expectedRevision: view.revision, expectedOrganizationRevision: view.organizationRevision })
      setView(result.snapshot)
      setMessage(result.results ? resultMessage(result.results) : 'Check interval saved.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update feed checks.')
      try { setView(await api.feedChecks()) } catch { /* Keep the last snapshot until polling succeeds. */ }
    } finally { setBusy(false) }
  }
  const check = (target: FeedCheckTarget) => run(revision => api.checkFeeds({ ...revision, ...target }))
  const interval = (minutes: number | null, feedId?: string) => run(revision => api.setCheckInterval({ ...revision, feedId, intervalMinutes: minutes }))
  return <FeedChecksContext.Provider value={{ view, busy, check, interval }}>
    <details className="feed-check-controls">
      <summary>Feed checks and intervals</summary>
      {!view ? <p>Loading check settings...</p> : view.backend === 'freshrss' ? <p>FreshRSS manages feed checks and intervals. Refresh imports articles from FreshRSS.</p> : <>
        <p>Reload articles shows what Paper already has. Check now asks the publisher for updates. Feeds are polled, so new articles may take time to appear.</p>
        {!view.enabled && <p>Feed collection is disabled by the server.</p>}
        <IntervalInput key={`global-${view.revision}`} value={view.intervalMinutes} disabled={busy} onSave={minutes => interval(minutes)} />
        <label>Folder to check<select value={folderId} disabled={busy || !view.enabled} onChange={event => setFolderId(event.target.value)}><option value="">Uncategorized</option>{view.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.title}</option>)}</select></label>
        <button disabled={busy || !view.enabled} onClick={() => void check({ folderId: folderId || null })}>Check folder now</button>
        <p>Checks wait for the publisher's Retry-After and at least one minute between manual attempts. Failed feeds retry with a longer wait.</p>
      </>}
    </details>
    {(error || loadError) && <p role="alert" className="form-error feed-check-message">{error || loadError}</p>}
    {message && <p role="status" className="feed-check-message">{message}</p>}
    {children}
  </FeedChecksContext.Provider>
}

function IntervalInput({ value, disabled, onSave, feed = false }: { value: number | null; disabled: boolean; feed?: boolean; onSave: (minutes: number | null) => Promise<void> }) {
  const [minutes, setMinutes] = useState(value === null ? '' : String(value))
  return <form className="feed-check-interval" onSubmit={event => { event.preventDefault(); void onSave(minutes === '' ? null : Number(minutes)) }}>
    <label>{feed ? 'Feed interval in minutes' : 'Default interval in minutes'}<input type="number" min={5} max={1440} step={1} required={!feed} disabled={disabled} value={minutes} placeholder={feed ? 'Use default' : undefined} onChange={event => setMinutes(event.target.value)} /></label>
    <button disabled={disabled}>Save interval</button>
    <p>5 to 1440 minutes.{feed ? ' Leave empty to use the default.' : ' Applies after a successful check.'}</p>
  </form>
}

export function FeedCheckDetails({ feedId }: { feedId: string }) {
  const context = useContext(FeedChecksContext)
  if (!context || context.view?.backend !== 'standalone') return null
  const { view, busy, check, interval } = context
  const feed = view.feeds.find(feed => feed.feedId === feedId)
  if (!feed) return null
  return <section className="feed-check-details">
    <h4>Check schedule</h4>
    <dl>
      <dt>Last successful check</dt><dd>{feed.lastSuccessAt ? time(feed.lastSuccessAt) : 'Not checked successfully yet'}</dd>
      <dt>Next scheduled check</dt><dd>{feed.nextFetchAt ? time(feed.nextFetchAt) : 'Due now'}</dd>
      <dt>Check state</dt><dd>{feed.state === 'running' ? 'Checking upstream' : feed.state === 'queued' ? 'Queued' : 'Waiting for next check'}</dd>
      <dt>Consecutive failures</dt><dd>{feed.failures}</dd>
      {feed.lastError && <><dt>Last error</dt><dd>{errorSummary(feed.lastError, feed.lastStatus)}</dd></>}
      {feed.retryAfterUntil > Date.now() && <><dt>Publisher Retry-After until</dt><dd>{time(feed.retryAfterUntil)}</dd></>}
      {feed.cooldownUntil > Date.now() && <><dt>Manual cooldown until</dt><dd>{time(feed.cooldownUntil)}</dd></>}
    </dl>
    <button disabled={busy || !view.enabled || feed.state !== 'idle'} onClick={() => void check({ feedId })}>{feed.state === 'running' ? 'Checking...' : feed.state === 'queued' ? 'Check queued' : 'Check now'}</button>
    <IntervalInput key={`${feedId}-${view.revision}`} feed value={feed.intervalMinutes} disabled={busy} onSave={minutes => interval(minutes, feedId)} />
  </section>
}
