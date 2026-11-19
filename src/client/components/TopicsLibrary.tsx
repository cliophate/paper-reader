import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { acknowledgePulseVisit, refreshPulseState } from '../pulse'
import type { PulseCollection, PulsePayload, PulseSource } from '../../shared/pulse'
import { CollectionQuestions } from './CollectionQuestions'
import { Icon } from './Icon'
import { PulseCatchUp, PulseCollectionOptions } from './PulseCatchUp'

type ArticleFilter = 'new' | 'unread' | 'read' | 'all'
type CollectionFilter = 'unread' | 'active' | 'quiet' | 'small'
interface Visit { id: string; sequence: number }
// Remember the place when an article opens in Paper's reader, without persisting article content.
type PulseReturn = { id: string | null; filter: ArticleFilter; section: CollectionFilter; scroll: number }
function readPulseReturn(): PulseReturn | null {
  try {
    const value = JSON.parse(sessionStorage.getItem('paper-pulse-return') || 'null')
    return value && ['new', 'unread', 'read', 'all'].includes(value.filter) && ['unread', 'active', 'quiet', 'small'].includes(value.section) ? value : null
  } catch { return null }
}
let returnToPulse = readPulseReturn()
function rememberPulseReturn(value: PulseReturn | null) {
  returnToPulse = value
  try { if (value) sessionStorage.setItem('paper-pulse-return', JSON.stringify(value)); else sessionStorage.removeItem('paper-pulse-return') } catch { /* The current tab can still restore its place. */ }
}

interface TopicsLibraryProps {
  initialCollection?: string
  initialFilter?: 'new'
  discussionConfigured?: boolean
  onCollectionChange: (collection: PulseCollection | null) => void
  refreshKey: number
  onBack: () => void
  onOpenEntry: (id: string, context?: { id: string; title: string; ids: string[]; linkNumber?: number }) => void
  onMarkRead: (ids: string[], expectedRevisions?: Record<string, number>) => Promise<boolean>
  notify: (message: string, action?: { label: string; run: () => void }) => void
}

export function TopicsLibrary({ initialCollection, initialFilter, discussionConfigured, onCollectionChange, refreshKey, onBack, onOpenEntry, onMarkRead, notify }: TopicsLibraryProps) {
  const directLink = initialCollection && (initialFilter || initialCollection !== returnToPulse?.id) ? { id: initialCollection, filter: initialFilter } : undefined
  const [payload, setPayload] = useState<PulsePayload | null>(null)
  const [now, setNow] = useState(Date.now)
  const [refreshing, setRefreshing] = useState(false)
  const [hasUpdates, setHasUpdates] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(initialCollection || null)
  const [filter, setFilter] = useState<ArticleFilter>(directLink ? directLink.filter || 'all' : returnToPulse?.filter || 'all')
  const [section, setSection] = useState<CollectionFilter>(returnToPulse?.section || 'active')
  const [mergeFrom, setMergeFrom] = useState<string | null>(null)
  const current = useRef<PulsePayload | null>(null)
  const open = useRef<string | null>(expanded)
  const visit = useRef<Visit | null>(null)
  const linked = useRef(directLink)
  const requestId = useRef(0)
  const scroll = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const restoreScroll = useRef(initialFilter ? 0 : returnToPulse?.scroll || 0)
  const view = useRef({ expanded, filter, section })
  view.current = { expanded, filter, section }

  const install = useCallback((next: PulsePayload) => { current.current = next; setPayload(next) }, [])

  const finishVisit = useCallback(async () => {
    const leaving = visit.current
    if (!leaving) return
    visit.current = null
    try {
      await api.visitPulse(leaving.id, leaving.sequence)
      if (mounted.current && current.current) install({ ...current.current,
        collections: current.current.collections.map(collection => collection.id === leaving.id ? acknowledgePulseVisit(collection, leaving.sequence) : collection) })
    } catch (reason) {
      if (mounted.current) notify(reason instanceof Error ? reason.message : 'Could not save your collection visit')
    }
  }, [install, notify])

  const load = useCallback(async (replace = false) => {
    const id = ++requestId.current
    try {
      const next = await api.pulse()
      if (!mounted.current || id !== requestId.current) return
      setError('')
      if (!current.current || replace) {
        install(next)
        setHasUpdates(false)
        if (linked.current) {
          const { id, filter } = linked.current
          const target = next.collections.find(collection => collection.id === id)
          if (target) {
            setSection(target.articleCount < 3 ? 'small' : target.quiet ? 'quiet' : 'active')
            setFilter(filter || 'all')
            if (filter === 'new') requestAnimationFrame(() => document.getElementById(`pulse-${id}`)?.closest('article')?.scrollIntoView({ block: 'nearest' }))
          } else setError('This collection is no longer available. Browse the saved collections below.')
          linked.current = undefined
        }
        const restored = next.collections.find(collection => collection.id === open.current)
        if (restored && !visit.current) visit.current = { id: restored.id, sequence: restored.revision }
        if (restoreScroll.current) {
          const position = restoreScroll.current
          restoreScroll.current = 0
          requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = position })
        }
      } else {
        setHasUpdates(next.revision !== current.current.revision)
        install(refreshPulseState(current.current, next, open.current))
      }
    } catch (reason) {
      if (mounted.current && id === requestId.current) setError(reason instanceof Error ? reason.message : 'Paper could not load Pulse')
    }
  }, [install])

  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => {
    if (!initialCollection) {
      if (open.current) { void finishVisit(); open.current = null; setExpanded(null) }
      return
    }
    if (initialCollection === open.current) return
    linked.current = { id: initialCollection, filter: initialFilter }
    if (initialFilter) restoreScroll.current = 0
    open.current = initialCollection
    setExpanded(initialCollection)
    setFilter(initialFilter || 'all')
    void finishVisit().then(() => load(true))
  }, [initialCollection, initialFilter, finishVisit, load])
  useEffect(() => {
    mounted.current = true
    const timer = window.setInterval(() => { if (!document.hidden) { setNow(Date.now()); void load() } }, 30_000)
    const leavingPage = () => { void finishVisit() }
    window.addEventListener('pagehide', leavingPage)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      window.removeEventListener('pagehide', leavingPage)
      void finishVisit()
    }
  }, [load, finishVisit])

  const showCollection = async (collection: PulseCollection, nextFilter: ArticleFilter) => {
    if (open.current !== collection.id) {
      await finishVisit()
      visit.current = { id: collection.id, sequence: collection.revision }
    }
    open.current = collection.id
    setExpanded(collection.id)
    setFilter(nextFilter)
    onCollectionChange(collection)
  }
  const closeCollection = async () => {
    await finishVisit()
    open.current = null
    setExpanded(null)
    rememberPulseReturn(null)
    onCollectionChange(null)
  }
  useEffect(() => {
    if (!linked.current && section === 'unread' && expanded && payload && !payload.collections.some(collection => collection.id === expanded && collection.unreadCount > 0)) {
      void closeCollection()
    }
  }, [payload, section, expanded])
  const changeSection = async (next: CollectionFilter) => {
    await closeCollection()
    setSection(next)
    if (scroll.current) scroll.current.scrollTop = 0
  }
  const applyUpdates = async () => {
    setRefreshing(true)
    await closeCollection()
    await load(true)
    setRefreshing(false)
  }
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try { await api.reload(); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not refresh feeds') }
    finally { setRefreshing(false) }
  }
  const openArticle = (id: string, collection: PulseCollection) => {
    rememberPulseReturn({ id: collection.id, filter: view.current.filter === 'new' ? 'unread' : view.current.filter,
      section: view.current.section, scroll: scroll.current?.scrollTop || 0 })
    const sourceFilter = view.current.expanded === collection.id ? view.current.filter : view.current.section === 'unread' ? 'unread' : 'all'
    const ids = threadSources(collection, sourceFilter, id).map(source => source.id)
    onOpenEntry(id, { id: collection.id, title: collection.headline, ids, linkNumber: collection.linkNumber })
  }
  const markRead = async (ids: string[]) => {
    const displayed = new Map(current.current?.collections.flatMap(collection => collection.sources).map(source => [source.id, source.stateRevision]) || [])
    const revisions = ids.every(id => displayed.get(id) !== undefined) ? Object.fromEntries(ids.map(id => [id, displayed.get(id)!])) : undefined
    const saved = revisions ? await onMarkRead(ids, revisions) : await onMarkRead(ids)
    if (saved && current.current) {
      const marked = new Set(ids)
      install({ ...current.current, collections: current.current.collections.map(collection => {
        const sources = collection.sources.map(source => marked.has(source.id) ? { ...source, read: true } : source)
        return { ...collection, sources, unreadCount: sources.filter(source => !source.read).length }
      }) })
    }
    return saved
  }
  const saveFeedback = async (action: 'not_same' | 'not_useful' | 'merge', id: string, entryId = '', target = '') => {
    try {
      await closeCollection()
      const feedback = await api.pulseFeedback(action, id, entryId, target)
      setMergeFrom(null)
      await load(true)
      notify(action === 'not_same' ? 'Article removed from collection' : action === 'not_useful' ? 'Collection hidden' : 'Collections merged', {
        label: 'Undo', run: () => void api.removePulseFeedback(feedback.id).then(() => load(true)).catch(reason => setError(reason.message)),
      })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save correction') }
  }

  const collections = payload?.collections.filter(collection => section === 'small' ? collection.articleCount < 3
    : collection.articleCount >= 3 && (section === 'unread' ? collection.unreadCount > 0 : collection.quiet === (section === 'quiet'))) || []
  const lead = [...collections].sort((a, b) => b.newCount - a.newCount || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))[0]
  const ordered = lead ? [lead, ...collections.filter(collection => collection !== lead)] : []
  const smallCount = payload?.collections.filter(collection => collection.articleCount < 3).length || 0
  const unreadCount = payload?.collections.filter(collection => collection.articleCount >= 3 && collection.unreadCount > 0).length || 0
  const activeCount = payload?.collections.filter(collection => collection.articleCount >= 3 && !collection.quiet).length || 0
  const quietCount = payload?.collections.filter(collection => collection.articleCount >= 3 && collection.quiet).length || 0
  const merging = payload?.collections.find(collection => collection.id === mergeFrom)
  return <section className="topics-library panel">
    <div className="topics-scroll" ref={scroll}>
      <div className="topics-column">
        <header className="topics-header">
          <div className="topics-heading"><button className="topics-back mobile-back icon-button" onClick={() => { rememberPulseReturn(null); onBack() }} aria-label="Back to sources"><Icon name="back" /></button><h1>Pulse</h1></div>
          <div className="pulse-toolbar">
            <div className="pulse-tabs pulse-section-tabs" role="group" aria-label="Collections">
              <button aria-pressed={section === 'unread'} onClick={() => void changeSection('unread')}>Unread <span>{unreadCount}</span></button>
              <button aria-pressed={section === 'active'} onClick={() => void changeSection('active')}>Active <span>{activeCount}</span></button>
              <button aria-pressed={section === 'quiet'} onClick={() => void changeSection('quiet')}>Quiet <span>{quietCount}</span></button>
              {smallCount > 0 && <button aria-pressed={section === 'small'} onClick={() => void changeSection('small')}>Small <span>{smallCount}</span></button>}
            </div>
            <button className={`icon-button ${refreshing ? 'spinning' : ''}`} disabled={refreshing} onClick={() => void refresh()} aria-label="Reload articles"><Icon name="refresh" /></button>
          </div>
        </header>
        {payload?.status.running && <p className="pulse-status" role="status">Finding related articles…</p>}
        {hasUpdates && <div className="pulse-updates" role="status"><span>New articles or collection changes are available.</span><button disabled={refreshing} onClick={() => void applyUpdates()}>Show updates</button></div>}
        {error && <div className="pulse-notice" role="alert">{error} <button onClick={() => void load()}>Try again</button></div>}
        {payload?.status.failed && <p className="pulse-notice" role="status">Grouping is delayed. Your saved collections are available; Paper will retry automatically.</p>}
        {payload && !payload.status.enabled && <p className="pulse-notice">Automatic grouping is paused. Saved collections are still available.</p>}
        <p className="visually-hidden">{section === 'small' ? 'Collections with fewer than three visible articles. Merge related collections or keep them here until more reporting arrives.' : section === 'unread' ? 'Collections with unread articles, including quiet collections.' : section === 'active' ? 'Collections with articles added in the last seven days, whether read or unread.' : 'No additions in seven days. Unread articles stay here, and new coverage can bring a collection back.'}</p>
        {merging && <div className="topics-merge-notice"><span>Open the collection that belongs with "{merging.headline}", then choose Merge into this collection.</span><button onClick={() => setMergeFrom(null)}>Cancel</button></div>}
        {!payload && !error && <div className="topics-state"><h2>Loading Pulse</h2></div>}
        {payload && !collections.length && <div className="topics-state"><h2>{section === 'small' ? 'No small collections' : section === 'unread' ? 'No unread collections' : section === 'quiet' ? 'No quiet collections yet' : payload.status.running ? 'Finding the connections' : 'No active collections yet'}</h2><p>{section === 'small' ? 'Collections reduced by filters or corrections remain recoverable here.' : section === 'unread' ? 'You have read every article in your collections. Browse Active or Quiet to revisit them.' : section === 'quiet' ? 'Older collections will remain here for later reading.' : 'Collections appear when several articles follow the same developing subject.'}</p></div>}
        {ordered.map(collection => <CollectionCard key={collection.id} collection={collection}
          lead={collection === lead} now={now} unreadOnly={section === 'unread'} summariesEnabled={Boolean(payload?.status.enabled)} discussionConfigured={discussionConfigured}
          expanded={expanded === collection.id} filter={filter} onExpand={next => showCollection(collection, next)} onCollapse={() => void closeCollection()}
          onOpenEntry={id => openArticle(id, collection)} onMarkRead={markRead} merging={Boolean(mergeFrom)} mergingThis={mergeFrom === collection.id}
          onMerge={() => mergeFrom && void saveFeedback('merge', mergeFrom, '', collection.id)} onStartMerge={() => setMergeFrom(collection.id)}
          onHide={() => void saveFeedback('not_useful', collection.id)} onRemove={id => void saveFeedback('not_same', collection.id, id)} />)}
      </div>
    </div>
  </section>
}

function CollectionCard({ collection, lead, now, expanded, filter, unreadOnly, summariesEnabled, discussionConfigured, onExpand, onCollapse, onOpenEntry, onMarkRead, merging, mergingThis, onMerge, onStartMerge, onHide, onRemove }: {
  collection: PulseCollection; lead: boolean; now: number; expanded: boolean; filter: ArticleFilter; unreadOnly: boolean; summariesEnabled: boolean; discussionConfigured?: boolean
  onExpand: (filter: ArticleFilter) => Promise<void>; onCollapse: () => void; onOpenEntry: (id: string) => void
  onMarkRead: (ids: string[], expectedRevisions?: Record<string, number>) => Promise<boolean>; merging: boolean; mergingThis: boolean
  onMerge: () => void; onStartMerge: () => void; onHide: () => void; onRemove: (id: string) => void
}) {
  const [marking, setMarking] = useState(false)
  const [failedImages, setFailedImages] = useState<string[]>([])
  const image = lead && collectionImage(collection.sources, failedImages)
  const rejectImage = () => { if (image) setFailedImages(failed => [...failed, image]) }
  const list = useRef<HTMLDivElement>(null)
  const filtered = threadSources(collection, expanded ? filter : unreadOnly ? 'unread' : 'all')
  const sources = expanded ? filtered : filtered.slice(0, lead ? 3 : 1)
  const earlier = filtered.length - sources.length
  const unreadIds = collection.sources.filter(source => !source.read).map(source => source.id)
  const markRead = async () => {
    if (marking || !unreadIds.length) return
    setMarking(true)
    try { await onMarkRead(unreadIds) } finally { setMarking(false) }
  }
  const listId = `pulse-${collection.id}`
  const catchUp = expanded && summariesEnabled ? collection.catchUp : undefined
  const newIds = new Set(catchUp ? collection.sources.filter(source => source.isNew).map(source => source.id) : [])
  const latest = catchUp?.latest.filter(line => line.entryIds.every(id => newIds.has(id))) || []
  const background = catchUp?.background || []
  const hasCatchUp = latest.length > 0 || background.length > 0
  const options = (label: string) => <PulseCollectionOptions label={label} name={`${listId}-options`} actions={() => <>
    {merging && !mergingThis ? <button type="button" className="primary" onClick={onMerge}>Merge into this collection</button>
      : <button type="button" disabled={mergingThis} onClick={onStartMerge}>Merge collection</button>}
    <button type="button" onClick={onHide}>Hide collection</button>
    <form onSubmit={event => {
      event.preventDefault()
      const id = new FormData(event.currentTarget).get('entryId')
      if (typeof id === 'string' && collection.sources.some(source => source.id === id)) onRemove(id)
    }}><label>Remove an article<select name="entryId" required defaultValue=""><option value="" disabled>Choose an article</option>{collection.sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label><button type="submit">Remove article</button></form>
  </>} />
  return <article className={`pulse-card ${lead ? 'pulse-lead' : ''}`}>
    <header className="pulse-card-header">
      <div><h2><button className="pulse-title" aria-expanded={expanded} aria-controls={listId} aria-describedby={`${listId}-count`} onClick={() => expanded ? onCollapse() : onExpand(unreadOnly ? 'unread' : 'all')}>{collection.headline}</button></h2>
        <p className="pulse-scope">{collection.scope}</p>
        <span className="visually-hidden" id={`${listId}-count`}>{collection.articleCount} {collection.articleCount === 1 ? 'article' : 'articles'}, {collection.unreadCount} unread</span>
      </div>
      {image && <img key={image} className="pulse-lead-image" src={image} alt="" referrerPolicy="no-referrer" onError={rejectImage} onLoad={event => {
        if (event.currentTarget.naturalWidth <= 1 || event.currentTarget.naturalHeight <= 1) rejectImage()
      }} />}
    </header>
    <div id={listId} ref={list} tabIndex={-1}>
      {expanded && <>
        {hasCatchUp && <PulseCatchUp collection={collection} latest={latest} background={background} options={options} onOpenEntry={onOpenEntry} />}
        <div className="pulse-tabs pulse-article-tabs" role="group" aria-label={`Articles in ${collection.headline}`}>
          <button aria-pressed={filter === 'unread'} onClick={() => onExpand('unread')}>Unread <span>{collection.unreadCount}</span></button>
          <button aria-pressed={filter === 'read'} onClick={() => onExpand('read')}>Read <span>{collection.articleCount - collection.unreadCount}</span></button>
          <button aria-pressed={filter === 'new'} onClick={() => onExpand('new')}>New <span>{collection.newCount}</span></button>
          <button aria-pressed={filter === 'all'} onClick={() => onExpand('all')}>All <span>{collection.articleCount}</span></button>
          {!hasCatchUp && options('Collection options')}
        </div>
        <p className="pulse-filter-count">{sources.length} {filter === 'all' ? 'of' : filter + ' of'} {collection.articleCount} articles · {collection.publicationCount} {collection.publicationCount === 1 ? 'publication' : 'publications'}
          {filter !== 'all' && <button onClick={() => onExpand('all')}>Show all</button>}
        </p>
      </>}
      {!sources.length && <p className="pulse-empty">{filter === 'new' ? 'No new articles since your last visit.' : filter === 'read' ? 'You have not read any articles in this collection yet.' : 'You have read every article in this collection.'}</p>}
      <ol className="pulse-thread">{sources.map(source => <SourceRow key={source.id} source={source} now={now} onOpen={() => onOpenEntry(source.id)} showOriginal={expanded} />)}</ol>
    </div>
    {!expanded && <a className="pulse-earlier" href={collection.linkNumber ? `/collection/${collection.linkNumber}` : `/?view=pulse&collection=${encodeURIComponent(collection.id)}`} aria-controls={listId} aria-describedby={`${listId}-count`} onClick={event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      void onExpand('all').then(() => requestAnimationFrame(() => { list.current?.focus(); list.current?.scrollIntoView({ block: 'start' }) }))
    }}>{earlier ? `${earlier} earlier ${earlier === 1 ? 'article' : 'articles'}` : 'View collection'}</a>}
    {expanded && discussionConfigured && collection.questionsRevision && <CollectionQuestions key={collection.questionsRevision} collection={collection} revision={collection.questionsRevision} onOpenEntry={onOpenEntry} />}
    {expanded && <div className="pulse-card-actions">
      <button disabled={marking || !unreadIds.length} onClick={() => void markRead()}>{marking ? 'Marking read…' : `Mark ${unreadIds.length} unread as read`}</button><button onClick={onCollapse}>Close collection</button>
    </div>}
  </article>
}

function collectionImage(sources: PulseSource[], failed: string[]) {
  for (const source of sources) {
    if (!source.thumbnailUrl.trim()) continue
    try {
      const url = new URL(source.thumbnailUrl, source.url)
      if (['http:', 'https:'].includes(url.protocol) && !failed.includes(url.href)) return url.href
    } catch { /* Try the next article's thumbnail. */ }
  }
}

function threadSources(collection: PulseCollection, filter: ArticleFilter, includeId?: string) {
  return collection.sources.filter(source => source.id === includeId || filter === 'all' || (filter === 'new' ? source.isNew : filter === 'read' ? source.read : !source.read))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
}

function SourceRow({ source, now, onOpen, showOriginal }: { source: PulseSource; now: number; onOpen: () => void; showOriginal: boolean }) {
  return <li className={`pulse-source ${source.isNew ? 'is-new' : ''} ${source.read ? 'is-read' : ''}`}>
    <button className="pulse-story" onClick={onOpen}>
      <time dateTime={source.publishedAt} title={new Date(source.publishedAt).toLocaleString()}>{relativeTime(source.publishedAt, now)}</time>
      <span className="pulse-dot" aria-hidden="true" />
      <span className="pulse-story-copy"><span className="pulse-publication">{source.publication}</span><span className="visually-hidden">{source.isNew && 'New. '}{source.read ? 'Read. ' : 'Unread. '}</span><span className="pulse-story-title">{source.title}</span>
        {source.isNew && source.development && <q>{source.development}</q>}
      </span>
    </button>
    {showOriginal && <div className="pulse-source-actions"><a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open ${source.title} on ${source.domain}`} title="Open original"><Icon name="external" /></a></div>}
  </li>
}

function relativeTime(value: string, now: number): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const minutes = Math.floor((now - timestamp) / 60_000)
  if (minutes < 0 || minutes >= 7 * 1440) return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(timestamp).getFullYear() !== new Date(now).getFullYear() && { year: 'numeric' }) })
  if (!minutes) return 'Now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`
  return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'short' })
}
