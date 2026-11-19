import { useEffect, useRef, useState } from 'react'
import type { BriefingDetail, BriefingSource, BriefingSummary } from '../../shared/briefings'
import { api } from '../api'
import { Icon } from './Icon'
import { Modal } from './Modal'

export function BriefingLibrary({ onBack, onOpenEntry, onMarkedRead, refreshKey }: {
  onBack: () => void; onOpenEntry: (id: string) => void; onMarkedRead: (ids: string[]) => void; refreshKey: number
}) {
  const [briefings, setBriefings] = useState<BriefingSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<BriefingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [feedbackPending, setFeedbackPending] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [readPending, setReadPending] = useState(false)
  const [readError, setReadError] = useState('')
  const mutation = useRef(0)

  useEffect(() => {
    let cancelled = false
    const generation = mutation.current
    setError('')
    api.briefings().then(items => {
      if (cancelled || generation !== mutation.current) return
      setBriefings(items)
      setSelectedId(current => items.some(item => item.id === current) ? current
        : !window.matchMedia('(max-width: 1040px)').matches ? items[0]?.id || '' : '')
    }).catch(reason => { if (!cancelled) setError(reason.message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [retry, refreshKey])

  useEffect(() => {
    if (!selectedId) { setDetail(null); return }
    let cancelled = false
    const generation = mutation.current
    setDetail(current => current?.id === selectedId ? current : null)
    setDetailLoading(true)
    api.briefing(selectedId).then(item => {
      if (!cancelled && generation === mutation.current) setDetail(item)
    }).catch(reason => { if (!cancelled && generation === mutation.current) setError(reason.message) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedId, retry, refreshKey])

  const sendFeedback = async (feedback: 'useful' | 'too_broad' | 'missed') => {
    if (!detail || feedbackPending) return
    const id = detail.id
    setFeedbackPending(true)
    try {
      await api.briefingFeedback(id, feedback)
      setDetail(current => current?.id === id ? { ...current, feedback } : current)
      setBriefings(current => current.map(item => item.id === id ? { ...item, feedback } : item))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save feedback') }
    finally { setFeedbackPending(false) }
  }

  const markRead = async () => {
    if (!detail || readPending) return
    const id = detail.id
    mutation.current++
    setReadPending(true); setReadError('')
    try {
      const result = await api.markBriefingRead(id)
      mutation.current++
      setDetail(current => current?.id === id ? result.briefing : current)
      setBriefings(current => current.map(item => item.id === id ? result.briefing : item))
      setConfirming(false)
      onMarkedRead(result.sourceIds)
    } catch (reason) { setReadError(reason instanceof Error ? reason.message : 'Could not mark this briefing read. Please try again.') }
    finally { setReadPending(false) }
  }

  const complete = Boolean(detail?.acknowledgedAt && !detail.unreadCount)
  return <section className={`briefing-library panel ${selectedId ? 'has-selection' : ''}`}>
    <div className="briefing-list">
      <header><button className="briefing-library-back mobile-back icon-button" onClick={onBack} aria-label="Back to sources"><Icon name="back" /></button><h1>Briefings</h1><span>{briefings.length}</span></header>
      {error && <p className="form-error" role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      {loading && <p className="briefing-empty">Loading briefings</p>}
      {!error && !loading && !briefings.length && <div className="briefing-empty"><h2>No briefings yet</h2><p>The morning and evening editions will appear here after they are generated.</p></div>}
      {briefings.map(item => <button key={item.id} className={selectedId === item.id ? 'active' : ''} disabled={readPending} onClick={() => { setSelectedId(item.id); setReadError('') }}>
        <span className="briefing-kind">{item.kind}</span><strong>{briefingTitle(item.subject)}</strong>
        <span className="briefing-delivery">{deliveryStatus(item)}</span>
        <span className={`briefing-status ${item.acknowledgedAt && !item.unreadCount ? 'is-read' : ''}`}>{briefingStatus(item)}</span>
        <time>{formatDate(item.createdAt)}</time>
      </button>)}
    </div>
    <div className="briefing-preview">
      {detailLoading && !detail ? <p role="status">Loading briefing...</p> : detail ? <>
        <div className="briefing-preview-bar">
          <button className="briefing-back icon-button" disabled={readPending} onClick={() => setSelectedId('')} aria-label="Back to briefings"><Icon name="back" /></button>
          <div className="briefing-preview-title"><strong>{briefingTitle(detail.subject)}</strong><span>{deliveryStatus(detail)} · {detail.entryCount} source {detail.entryCount === 1 ? 'story' : 'stories'} · {briefingStatus(detail)}</span></div>
          <div className="briefing-feedback" aria-label="Briefing feedback"><span>Was this useful?</span><button className={detail.feedback === 'useful' ? 'active' : ''} disabled={feedbackPending} onClick={() => void sendFeedback('useful')}>Yes</button><button className={detail.feedback === 'too_broad' ? 'active' : ''} disabled={feedbackPending} onClick={() => void sendFeedback('too_broad')}>Too much</button><button className={detail.feedback === 'missed' ? 'active' : ''} disabled={feedbackPending} onClick={() => void sendFeedback('missed')}>Missed</button></div>
        </div>
        <div className="briefing-content-scroll"><BriefingContent detail={detail} onOpenEntry={onOpenEntry} /></div>
        <div className="briefing-read-bar">
          <p role="status">{complete ? 'Briefing marked read. ' : ''}{sourceReadStatus(detail)}</p>
          <button className="briefing-read-button" disabled={readPending || complete} onClick={() => { setReadError(''); setConfirming(true) }}><Icon name={complete ? 'check' : 'archive'} />{complete ? 'Briefing read' : 'Mark briefing read'}</button>
        </div>
      </> : <div className="briefing-empty"><h2>Select a briefing</h2><p>Your briefing and its source stories will appear here.</p></div>}
    </div>
    {confirming && detail && <Modal title="Mark briefing read?" className="briefing-read-dialog" busy={readPending} onClose={() => setConfirming(false)}>
      <p>{detail.unreadCount ? `${detail.unreadCount} unread source ${detail.unreadCount === 1 ? 'story will' : 'stories will'} be marked read.` : 'The available source stories are already read. Confirm to mark the briefing read too.'}</p>
      <p className="muted">This applies to the stories represented in this briefing.</p>
      <ul className="briefing-confirm-sources">{detail.sources.filter(source => representedIds(detail).has(source.id)).map(source => <li key={source.id}><span>{source.title}</span><span>{source.read ? 'Read' : 'Unread'}</span></li>)}</ul>
      {detail.missingCount > 0 && <p className="muted">{detail.missingCount} source {detail.missingCount === 1 ? 'story is' : 'stories are'} no longer available. Paper will mark the remaining stories and this briefing read.</p>}
      {readError && <p className="form-error" role="alert">{readError}</p>}
      <div className="briefing-dialog-actions"><button disabled={readPending} onClick={() => setConfirming(false)}>Cancel</button><button className="briefing-read-button" disabled={readPending} onClick={() => void markRead()}>{readPending ? 'Marking read...' : 'Mark briefing and stories read'}</button></div>
    </Modal>}
  </section>
}

function representedIds(detail: BriefingDetail) {
  return new Set(detail.sourceIds)
}

function BriefingContent({ detail, onOpenEntry }: { detail: BriefingDetail; onOpenEntry: (id: string) => void }) {
  const sources = new Map(detail.sources.map(source => [source.id, source]))
  const news = [...detail.selection.news].sort((a, b) => Number(b.role === 'lead') - Number(a.role === 'lead'))
  const empty = !news.length && !detail.selection.worthNoticing.length && !detail.selection.social.length
  return <article className="briefing-document" aria-label="Briefing content">
    <header><p className="briefing-edition">Paper · {detail.kind} edition</p><h1>{detail.kind === 'morning' ? 'Your morning briefing' : 'Your evening briefing'}</h1><time>{formatDate(detail.createdAt)}</time></header>
    {empty && <p>Nothing cleared the bar for this briefing.</p>}
    {detail.selection.intro && <p className="briefing-intro">{detail.selection.intro}</p>}
    {news.map((item, index) => {
      const bullets = item.role === 'lead' ? [] : item.bullets || []
      const lead = item.role === 'lead' || (index === 0 && !bullets.length)
      const url = !bullets.length && imageUrl(sources.get(item.imageEntryId || '')?.thumbnailUrl)
      const image = url && <img key={url} className="briefing-story-image" src={url} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true }} />
      const cited = new Set(item.entryIds)
      const background = new Set((item.backgroundEntryIds || []).filter(id => !cited.has(id)))
      const sourceId = `briefing-news-${index + 1}-sources`
      const sourceLabel = `Based on ${cited.size} ${cited.size === 1 ? 'source' : 'sources'}`
      return <section className={`briefing-story ${lead ? 'is-lead' : ''}`} key={index}>
        {lead && image}
        <h2>{item.headline}</h2>
        {!lead && image}
        {bullets.length ? <ul className="briefing-bullets">{bullets.map((line, index) => <li key={index}>{line}</li>)}</ul> : <p>{item.summary}</p>}
        <p className="briefing-source-count">{cited.size ? <a href={`#${sourceId}`}>{sourceLabel}</a> : sourceLabel}</p>
        <SourceStories id={sourceId} ids={item.entryIds} sources={sources} onOpenEntry={onOpenEntry} />
        {background.size > 0 && <>
          <p className="briefing-source-count"><a href={`#${sourceId}-background`}>{background.size} background {background.size === 1 ? 'source' : 'sources'}</a></p>
          <SourceStories id={`${sourceId}-background`} ids={[...background]} sources={sources} onOpenEntry={onOpenEntry} />
        </>}
        {item.collectionId && <p className="briefing-pulse-link"><a href={`/pulse?collection=${encodeURIComponent(item.collectionId)}&filter=new`}>Follow this story in Pulse</a></p>}
      </section>
    })}
    {detail.selection.worthNoticing.length > 0 && <section className="briefing-section"><h2>Worth noticing</h2>{detail.selection.worthNoticing.map(item => <div className="briefing-story" key={item.entryId}><SourceStories ids={[item.entryId]} sources={sources} onOpenEntry={onOpenEntry} /><p>{item.summary || item.reason}</p></div>)}</section>}
    {detail.selection.social.length > 0 && <section className="briefing-section"><h2>Seen in the feeds</h2>{detail.selection.social.map(item => {
      const source = sources.get(item.entryId)
      const original = source && ['x', 'threads', 'bluesky', 'mastodon'].includes(source.kind) && source.text.length <= 700 ? source.text : ''
      return <div className="briefing-story" key={item.entryId}>{source?.author && <h3>{source.author}</h3>}<p>{original || item.summary || source?.text}</p><SourceStories ids={[item.entryId]} sources={sources} onOpenEntry={onOpenEntry} /></div>
    })}</section>}
  </article>
}

function SourceStories({ id, ids, sources, onOpenEntry }: { id?: string; ids: string[]; sources: Map<string, BriefingSource>; onOpenEntry: (id: string) => void }) {
  return <ul id={id} tabIndex={id ? -1 : undefined} className="briefing-source-stories">{[...new Set(ids)].map(id => {
    const source = sources.get(id)
    return <li key={id} data-entry-id={id} data-read={source?.read}>
      {source ? <><div><button onClick={() => onOpenEntry(id)}>{source.title}</button><span>{source.feedTitle}</span></div><span className={`briefing-source-state ${source.read ? 'is-read' : ''}`}>{source.read ? 'Read' : 'Unread'}</span></>
        : <span>Source story is no longer available.</span>}
    </li>
  })}</ul>
}

function briefingTitle(subject: string) {
  return subject.replace(/^(?:Paper (?:morning|evening)(?: briefing)?|(?:Morning|Evening) Paper Briefing) \| /i, '')
}

function briefingStatus(item: BriefingSummary) {
  if (item.unreadCount) return `${item.unreadCount} unread`
  return item.acknowledgedAt ? 'Read' : 'Source stories read'
}

function deliveryStatus(item: BriefingSummary) {
  return item.deliveredAt || item.status === 'delivered' ? 'Delivered' : 'Generated'
}

function sourceReadStatus(item: BriefingSummary) {
  if (item.missingCount) return `${item.entryCount - item.unreadCount - item.missingCount} read · ${item.unreadCount} unread · ${item.missingCount} unavailable`
  if (item.unreadCount) return `${item.unreadCount} of ${item.entryCount} source stories unread`
  return item.entryCount ? `All ${item.entryCount} source ${item.entryCount === 1 ? 'story is' : 'stories are'} read.` : 'No source stories in this briefing.'
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short' }).format(date) : 'Date unavailable'
}

function imageUrl(value?: string) {
  try { const url = new URL(value || '', window.location.origin); return value && ['http:', 'https:'].includes(url.protocol) ? url.href : undefined }
  catch { return undefined }
}
