import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { acknowledgePulseVisit, refreshPulseState } from '../pulse'
import type { PulseCollection, PulsePayload, PulseSource } from '../../shared/pulse'
import { Icon } from './Icon'

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
  onCollectionChange: (collection: PulseCollection | null) => void
  feedIcons: Map<string, string>
  refreshKey: number
  onBack: () => void
  onOpenEntry: (id: string, context?: { id: string; title: string; ids: string[]; linkNumber?: number }) => void
  onMarkRead: (ids: string[], expectedRevisions?: Record<string, number>) => Promise<boolean>
  notify: (message: string, action?: { label: string; run: () => void }) => void
}

export function TopicsLibrary({ initialCollection, onCollectionChange, feedIcons, refreshKey, onBack, onOpenEntry, onMarkRead, notify }: TopicsLibraryProps) {
  const directLink = initialCollection && initialCollection !== returnToPulse?.id ? initialCollection : undefined
  const [payload, setPayload] = useState<PulsePayload | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [hasUpdates, setHasUpdates] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(initialCollection || null)
  const [filter, setFilter] = useState<ArticleFilter>(directLink ? 'all' : returnToPulse?.filter || 'all')
  const [section, setSection] = useState<CollectionFilter>(returnToPulse?.section || 'active')
  const [mergeFrom, setMergeFrom] = useState<string | null>(null)
  const current = useRef<PulsePayload | null>(null)
  const open = useRef<string | null>(expanded)
  const visit = useRef<Visit | null>(null)
  const linked = useRef(directLink)
  const requestId = useRef(0)
  const scroll = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const restoreScroll = useRef(returnToPulse?.scroll || 0)
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
          const target = next.collections.find(collection => collection.id === linked.current)
          if (target) { setSection(target.articleCount < 3 ? 'small' : target.quiet ? 'quiet' : 'active'); setFilter('all') }
          else setError('This collection is no longer available. Browse the saved collections below.')
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
    linked.current = initialCollection
    open.current = initialCollection
    setExpanded(initialCollection)
    setFilter('all')
    void finishVisit().then(() => load(true))
  }, [initialCollection, finishVisit, load])
  useEffect(() => {
    mounted.current = true
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 30_000)
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
    if (section === 'unread' && expanded && payload && !payload.collections.some(collection => collection.id === expanded && collection.unreadCount > 0)) {
      void closeCollection()
    }
  }, [payload, section, expanded])
  const changeSection = async (next: CollectionFilter) => {
    await closeCollection()
    setSection(next)
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
    const ids = collection.sources.filter(source => sourceFilter === 'all' || (sourceFilter === 'new' ? source.isNew : sourceFilter === 'read' ? source.read : !source.read)).map(source => source.id)
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
  const smallCount = payload?.collections.filter(collection => collection.articleCount < 3).length || 0
  const unreadCount = payload?.collections.filter(collection => collection.articleCount >= 3 && collection.unreadCount > 0).length || 0
  const activeCount = payload?.collections.filter(collection => collection.articleCount >= 3 && !collection.quiet).length || 0
  const quietCount = payload?.collections.filter(collection => collection.articleCount >= 3 && collection.quiet).length || 0
  const merging = payload?.collections.find(collection => collection.id === mergeFrom)
  return <section className="topics-library panel">
    <header className="topics-header">
      <div className="topics-heading">
        <button className="topics-back mobile-back icon-button" onClick={() => { rememberPulseReturn(null); onBack() }} aria-label="Back to sources"><Icon name="back" /></button>
        <div><span>Across your feeds</span><h1>Pulse</h1></div>
      </div>
      <div className="topics-header-meta">
        <span>{activeCount} active {activeCount === 1 ? 'collection' : 'collections'}</span>
        <button className={`icon-button ${refreshing ? 'spinning' : ''}`} disabled={refreshing} onClick={() => void refresh()} aria-label="Reload articles" title="Reload articles from Paper or FreshRSS"><Icon name="refresh" /></button>
      </div>
    </header>
    <div className="topics-scroll" ref={scroll}>
      <div className="topics-column">
        <div className="topics-intro"><p>Stories that keep developing. Return to a collection to catch up on what arrived.</p></div>
        <div className="pulse-toolbar">
          <div className="pulse-tabs" aria-label="Collections">
            <button aria-pressed={section === 'unread'} onClick={() => void changeSection('unread')}>Unread <span>{unreadCount}</span></button>
            <button aria-pressed={section === 'active'} onClick={() => void changeSection('active')}>Active <span>{activeCount}</span></button>
            <button aria-pressed={section === 'quiet'} onClick={() => void changeSection('quiet')}>Quiet <span>{quietCount}</span></button>
            {smallCount > 0 && <button aria-pressed={section === 'small'} onClick={() => void changeSection('small')}>Small <span>{smallCount}</span></button>}
          </div>
          {payload?.status.running && <span className="pulse-status" role="status">Finding related articles…</span>}
        </div>
        {hasUpdates && <div className="pulse-updates" role="status"><span>New articles or collection changes are available.</span><button disabled={refreshing} onClick={() => void applyUpdates()}>Show updates</button></div>}
        {error && <div className="pulse-notice" role="alert">{error} <button onClick={() => void load()}>Try again</button></div>}
        {payload?.status.failed && <p className="pulse-notice" role="status">Grouping is delayed. Your saved collections are available; Paper will retry automatically.</p>}
        {payload && !payload.status.enabled && <p className="pulse-notice">Automatic grouping is paused. Saved collections are still available.</p>}
        <p className="pulse-quiet-note">{section === 'small' ? 'Collections with fewer than three visible articles. Merge related collections or keep them here until more reporting arrives.' : section === 'unread' ? 'Collections with unread articles, including quiet collections.' : section === 'active' ? 'Collections with articles added in the last seven days, whether read or unread.' : 'No additions in seven days. Unread articles stay here, and new coverage can bring a collection back.'}</p>
        {merging && <div className="topics-merge-notice"><span>Choose the collection that belongs with "{merging.headline}".</span><button onClick={() => setMergeFrom(null)}>Cancel</button></div>}
        {!payload && !error && <div className="topics-state"><h2>Loading Pulse</h2></div>}
        {payload && !collections.length && <div className="topics-state"><h2>{section === 'small' ? 'No small collections' : section === 'unread' ? 'No unread collections' : section === 'quiet' ? 'No quiet collections yet' : payload.status.running ? 'Finding the connections' : 'No active collections yet'}</h2><p>{section === 'small' ? 'Collections reduced by filters or corrections remain recoverable here.' : section === 'unread' ? 'You have read every article in your collections. Browse Active or Quiet to revisit them.' : section === 'quiet' ? 'Older collections will remain here for later reading.' : 'Collections appear when several articles follow the same developing subject.'}</p></div>}
        {collections.map(collection => <CollectionCard key={collection.id} collection={collection} feedIcons={feedIcons}
          unreadOnly={section === 'unread'}
          expanded={expanded === collection.id} filter={filter} onExpand={next => void showCollection(collection, next)} onCollapse={() => void closeCollection()}
          onOpenEntry={id => openArticle(id, collection)} onMarkRead={markRead} merging={Boolean(mergeFrom)} mergingThis={mergeFrom === collection.id}
          onMerge={() => mergeFrom && void saveFeedback('merge', mergeFrom, '', collection.id)} onStartMerge={() => setMergeFrom(collection.id)}
          onHide={() => void saveFeedback('not_useful', collection.id)} onRemove={id => void saveFeedback('not_same', collection.id, id)} />)}
      </div>
    </div>
  </section>
}

function CollectionCard({ collection, feedIcons, expanded, filter, unreadOnly, onExpand, onCollapse, onOpenEntry, onMarkRead, merging, mergingThis, onMerge, onStartMerge, onHide, onRemove }: {
  collection: PulseCollection; feedIcons: Map<string, string>; expanded: boolean; filter: ArticleFilter; unreadOnly: boolean
  onExpand: (filter: ArticleFilter) => void; onCollapse: () => void; onOpenEntry: (id: string) => void
  onMarkRead: (ids: string[], expectedRevisions?: Record<string, number>) => Promise<boolean>; merging: boolean; mergingThis: boolean
  onMerge: () => void; onStartMerge: () => void; onHide: () => void; onRemove: (id: string) => void
}) {
  const [marking, setMarking] = useState(false)
  const sources = expanded
    ? collection.sources.filter(source => filter === 'all' || (filter === 'new' ? source.isNew : filter === 'read' ? source.read : !source.read))
    : collection.sources.filter(source => !unreadOnly || !source.read).slice(0, 3)
  const unreadIds = collection.sources.filter(source => !source.read).map(source => source.id)
  const markRead = async () => {
    if (marking || !unreadIds.length) return
    setMarking(true)
    try { await onMarkRead(unreadIds) } finally { setMarking(false) }
  }
  const listId = `pulse-${collection.id}`
  return <article className={`topic-card no-image pulse-card ${mergingThis ? 'merge-source' : ''}`}>
    <div className="topic-card-copy">
      <div className="pulse-card-top">
        {collection.newCount > 0 ? <button className="pulse-new" onClick={() => onExpand('new')}>{collection.seenThrough ? `${collection.newCount} new since your last visit` : 'New collection'}</button> : <span className="pulse-seen">{collection.unreadCount ? 'No new additions' : 'All read'}</span>}
        <div className="pulse-card-top-actions">
          <time dateTime={collection.updatedAt}>Updated {relativeTime(collection.updatedAt)}</time>
          <button className="pulse-mark-read" disabled={marking || !unreadIds.length} onClick={() => void markRead()}>{marking ? 'Marking read…' : `Mark ${unreadIds.length} unread as read`}</button>
        </div>
      </div>
      <h2><button className="pulse-title" aria-expanded={expanded} aria-controls={listId} onClick={() => expanded ? onCollapse() : onExpand(unreadOnly ? 'unread' : collection.newCount ? 'new' : 'all')}>{collection.headline}</button></h2>
      <p className="topic-summary">{collection.scope}</p>
      <div className="pulse-counts"><span>{collection.unreadCount} unread of {collection.articleCount} articles</span><span>{collection.publicationCount} {collection.publicationCount === 1 ? 'publication' : 'publications'}</span></div>
    </div>
    {expanded && collection.sources.some(source => source.isNew) && <div className="pulse-catchup">
      <h3>{collection.seenThrough ? 'Since your last visit' : 'Latest reporting'}</h3>
      <ul>{collection.sources.filter(source => source.isNew).slice(0, 3).map(source => <li key={source.id}>
        <button onClick={() => onOpenEntry(source.id)}>{source.title}</button>
        {source.development && <blockquote>{source.development}</blockquote>}
        <span>{source.publication}</span>
      </li>)}</ul>
      <p>Excerpts from the linked reporting. Open an article for its full context.</p>
    </div>}
    <div className="topic-sources" id={listId}>
      <p className="pulse-filter-count">{expanded ? `${sources.length} ${filter === 'all' ? 'of' : filter + ' of'} ${collection.articleCount} articles` : `${sources.length} shown of ${collection.articleCount} articles`}
        {(!expanded || filter !== 'all') && <button onClick={() => onExpand('all')}>Show all</button>}
      </p>
      <div className="pulse-tabs pulse-article-tabs" aria-label={`Articles in ${collection.headline}`}>
        <button aria-pressed={expanded && filter === 'unread'} onClick={() => onExpand('unread')}>Unread <span>{collection.unreadCount}</span></button>
        <button aria-pressed={expanded && filter === 'read'} onClick={() => onExpand('read')}>Read <span>{collection.articleCount - collection.unreadCount}</span></button>
        <button aria-pressed={expanded && filter === 'new'} onClick={() => onExpand('new')}>New <span>{collection.newCount}</span></button>
        <button aria-pressed={expanded && filter === 'all'} onClick={() => onExpand('all')}>All <span>{collection.articleCount}</span></button>
      </div>
      {!expanded && <h3>{unreadOnly ? 'Unread articles' : 'Latest additions'}</h3>}
      {!sources.length && <p className="pulse-empty">{filter === 'new' ? 'No new articles since your last visit.' : filter === 'read' ? 'You have not read any articles in this collection yet.' : 'You have read every article in this collection.'}</p>}
      <ol>{sources.map(source => <SourceRow key={source.id} source={source} iconUrl={feedIcons.get(source.feedId) || ''} showNew={expanded} onOpen={() => {
        // Opening from a preview is not a visit to the full collection.
        onOpenEntry(source.id)
      }} onRemove={expanded ? () => onRemove(source.id) : undefined} />)}</ol>
    </div>
    <div className="pulse-card-actions">
      <div>{expanded ? <button onClick={onCollapse}>Close collection</button> : <>
        {collection.newCount > 0 && <button className="primary" onClick={() => onExpand('new')}>View {collection.newCount} new {collection.newCount === 1 ? 'article' : 'articles'}</button>}
        <button onClick={() => onExpand(unreadOnly ? 'unread' : 'all')}>View collection</button>
      </>}</div>
    </div>
    {(expanded || merging) && <div className="topic-feedback-actions">
      {merging && !mergingThis ? <button className="primary" onClick={onMerge}>Merge into this collection</button> : <button disabled={mergingThis} onClick={onStartMerge}>{mergingThis ? 'Choose another collection' : 'Merge collection'}</button>}
      <button onClick={onHide}>Hide collection</button>
    </div>}
  </article>
}

function SourceRow({ source, iconUrl, showNew, onOpen, onRemove }: { source: PulseSource; iconUrl: string; showNew: boolean; onOpen: () => void; onRemove?: () => void }) {
  return <li className={`pulse-source ${source.read ? 'is-read' : 'is-unread'}`}>
    <button onClick={onOpen}>
      <SourceMark title={source.publication} iconUrl={iconUrl} />
      <span className="topic-source-copy"><span><strong>{source.publication}</strong><time dateTime={source.publishedAt}>{relativeTime(source.publishedAt)}</time>{showNew && source.isNew && <span className="pulse-source-new">New</span>}<span className="pulse-read-label">{source.read ? 'Read' : 'Unread'}</span></span><span>{source.title}</span></span>
    </button>
    {onRemove && <button className="topic-source-remove" onClick={onRemove} aria-label={`Remove ${source.title} from collection`} title="Does not belong in this collection"><Icon name="close" /></button>}
    <a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open ${source.title} on ${source.domain}`} title="Open original"><Icon name="external" /></a>
  </li>
}
function SourceMark({ title, iconUrl }: { title: string; iconUrl: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [iconUrl])
  const showIcon = Boolean(iconUrl && !failed)
  return <span className={`topic-source-mark ${showIcon ? 'has-icon' : ''}`}>{showIcon ? <img src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : title.trim().charAt(0).toUpperCase() || 'P'}</span>
}
function relativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const minutes = Math.round((timestamp - Date.now()) / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}
