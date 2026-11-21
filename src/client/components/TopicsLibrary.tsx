import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ACTIVE_VISIBLE, NEW_MIN_ARTICLES, NEW_MIN_PUBLICATIONS } from '../../server/pulse-rules'
import { api } from '../api'
import { acknowledgePulseVisit, refreshPulseState } from '../pulse'
import type { PulseCollection, PulsePayload, PulseSource } from '../../shared/pulse'
import { CollectionQuestions } from './CollectionQuestions'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { PulseCatchUp, PulseCollectionOptions } from './PulseCatchUp'

type ArticleFilter = 'new' | 'unread' | 'read' | 'all'
type CollectionFilter = 'unread' | 'active' | 'quiet' | 'small' | 'archived'

function collectionSection(collection: PulseCollection): Exclude<CollectionFilter, 'unread'> {
  if (collection.archived) return 'archived'
  if (collection.articleCount < NEW_MIN_ARTICLES || collection.publicationCount < NEW_MIN_PUBLICATIONS) return 'small'
  return collection.active ? 'active' : 'quiet'
}

const descriptions: Record<CollectionFilter, string> = {
  active: 'At least two publications covered the story in the last 72 hours.',
  unread: 'Active and quiet collections with articles you have yet to read.',
  small: 'Collections with fewer than three articles or fewer than two publications.',
  quiet: 'These collections have coverage from the last seven days, with fewer than two publications covering the story in the last 72 hours.',
  archived: 'The newest article in each collection is more than seven days old.',
}

const emptyHeadings: Record<CollectionFilter, string> = {
  active: 'No active collections yet', unread: 'No unread collections', small: 'No small collections',
  quiet: 'No quiet collections yet', archived: 'No archived collections',
}
interface Visit { id: string; sequence: number }
// Remember the place when an article opens in Paper's reader, without persisting article content.
type PulseReturn = { id: string | null; filter: ArticleFilter; section: CollectionFilter; scroll: number; allActive?: boolean }
function readPulseReturn(): PulseReturn | null {
  try {
    const value = JSON.parse(sessionStorage.getItem('paper-pulse-return') || 'null')
    return value && ['new', 'unread', 'read', 'all'].includes(value.filter) && ['unread', 'active', 'quiet', 'small', 'archived'].includes(value.section) ? value : null
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
  const [allActive, setAllActive] = useState(Boolean(!directLink && returnToPulse?.allActive))
  const [mergeFrom, setMergeFrom] = useState<string | null>(null)
  const [markPreview, setMarkPreview] = useState<{ ids: string[]; collectionCount: number } | null>(null)
  const [marking, setMarking] = useState<{ collectionId?: string } | null>(null)
  const current = useRef<PulsePayload | null>(null)
  const open = useRef<string | null>(expanded)
  const visit = useRef<Visit | null>(null)
  const linked = useRef(directLink)
  const requestId = useRef(0)
  const scroll = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const markFocus = useRef<{ button: HTMLButtonElement; title?: HTMLButtonElement | null } | null>(null)
  const mounted = useRef(true)
  const restoreScroll = useRef(directLink ? 0 : returnToPulse?.scroll || 0)
  const view = useRef({ expanded, filter, section, allActive })
  view.current = { expanded, filter, section, allActive }

  const install = useCallback((next: PulsePayload) => { current.current = next; setPayload(next) }, [])

  useLayoutEffect(() => {
    if (markPreview || !markFocus.current) return
    const { button, title } = markFocus.current
    if ((!button.isConnected || button.disabled) && (document.activeElement === document.body || document.activeElement === button)) {
      (title?.isConnected ? title : heading.current)?.focus()
      markFocus.current = null
    } else if (!marking) markFocus.current = null
  }, [markPreview, marking, payload])

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
        const restored = next.collections.find(collection => collection.id === open.current)
        if (restored) {
          const section = collectionSection(restored)
          const keepUnread = !linked.current && view.current.section === 'unread' && ['quiet', 'active'].includes(section) && restored.unreadCount > 0
          setSection(keepUnread ? 'unread' : section)
          if (section === 'active' && next.collections.filter(item => collectionSection(item) === 'active').indexOf(restored) >= ACTIVE_VISIBLE) setAllActive(true)
        }
        if (linked.current) {
          const { id, filter } = linked.current
          if (restored?.id === id) {
            setFilter(filter || 'all')
            requestAnimationFrame(() => {
              const card = document.getElementById(`pulse-${id}`)?.closest('article')
              const pane = scroll.current
              if (card && pane) pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top
            })
          } else setError('This collection is no longer available. Browse the saved collections below.')
          linked.current = undefined
        }
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
    restoreScroll.current = 0
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
    setAllActive(false)
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
      section: view.current.section, scroll: scroll.current?.scrollTop || 0, allActive: view.current.allActive })
    const sourceFilter = view.current.expanded === collection.id ? view.current.filter : view.current.section === 'unread' ? 'unread' : 'all'
    const ids = threadSources(collection, sourceFilter, id).map(source => source.id)
    onOpenEntry(id, { id: collection.id, title: collection.headline, ids, linkNumber: collection.linkNumber })
  }
  const markRead = async (ids: string[], collectionId?: string) => {
    if (marking) return
    const unread = new Map<string, number | undefined>()
    for (const collection of current.current?.collections || []) {
      for (const source of collection.sources) if (!source.read) unread.set(source.id, source.stateRevision)
    }
    const marked = new Set(ids.filter(id => unread.has(id)))
    if (!marked.size) return
    const requested = [...marked]
    const revisions = requested.every(id => unread.get(id) !== undefined) ? Object.fromEntries(requested.map(id => [id, unread.get(id)!])) : undefined
    setMarking({ collectionId })
    try {
      const saved = revisions ? await onMarkRead(requested, revisions) : await onMarkRead(requested)
      if (saved && mounted.current && current.current) {
        install({ ...current.current, collections: current.current.collections.map(collection => {
          const sources = collection.sources.map(source => marked.has(source.id) ? { ...source, read: true } : source)
          return { ...collection, sources, unreadCount: sources.filter(source => !source.read).length }
        }) })
      }
    } finally { setMarking(null) }
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

  const sections: Record<CollectionFilter, PulseCollection[]> = { active: [], quiet: [], archived: [], small: [], unread: [] }
  for (const collection of payload?.collections || []) {
    const home = collectionSection(collection)
    sections[home].push(collection)
    if ((home === 'active' || home === 'quiet') && collection.unreadCount > 0) sections.unread.push(collection)
  }
  const collections = sections[section]
  const visible = section === 'active' && !allActive ? collections.slice(0, ACTIVE_VISIBLE) : collections
  const unreadCollections = visible.filter(collection => collection.unreadCount > 0)
  const openMarkPreview = (button: HTMLButtonElement) => {
    if (marking) return
    const ids = [...new Set(unreadCollections.flatMap(collection => collection.sources.filter(source => !source.read).map(source => source.id)))]
    if (!ids.length) return
    button.focus()
    markFocus.current = { button }
    setMarkPreview({ ids, collectionCount: unreadCollections.length })
  }
  const lead = section === 'archived' ? undefined : [...visible].sort((a, b) => b.newCount - a.newCount || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))[0]
  const ordered = lead ? [lead, ...visible.filter(collection => collection !== lead)] : visible
  const merging = payload?.collections.find(collection => collection.id === mergeFrom)
  return <section className="topics-library panel">
    <div className="topics-scroll" ref={scroll}>
      <div className="topics-column">
        <header className="topics-header">
          <div className="topics-heading"><button className="topics-back mobile-back icon-button" onClick={() => { rememberPulseReturn(null); onBack() }} aria-label="Back to sources"><Icon name="back" /></button><h1 ref={heading} tabIndex={-1}>Pulse</h1></div>
          <div className="pulse-toolbar">
            <div className="pulse-tabs pulse-section-tabs" role="group" aria-label="Collections">
              <button aria-pressed={section === 'unread'} onClick={() => void changeSection('unread')}>Unread <span>{sections.unread.length}</span></button>
              <button aria-pressed={section === 'active'} onClick={() => void changeSection('active')}>Active <span>{sections.active.length}</span></button>
              <button aria-pressed={section === 'quiet'} onClick={() => void changeSection('quiet')}>Quiet <span>{sections.quiet.length}</span></button>
              {sections.small.length > 0 && <button aria-pressed={section === 'small'} onClick={() => void changeSection('small')}>Small <span>{sections.small.length}</span></button>}
            </div>
            {unreadCollections.length > 0 && <button type="button" className="pulse-mark-all" aria-disabled={Boolean(marking)} onClick={event => openMarkPreview(event.currentTarget)}>Mark all read</button>}
            <button className={`icon-button ${refreshing ? 'spinning' : ''}`} disabled={refreshing} onClick={() => void refresh()} aria-label="Reload articles"><Icon name="refresh" /></button>
          </div>
        </header>
        {payload?.status.running && <p className="pulse-status" role="status">Finding related articles…</p>}
        {hasUpdates && <div className="pulse-updates" role="status"><span>New articles or collection changes are available.</span><button disabled={refreshing} onClick={() => void applyUpdates()}>Show updates</button></div>}
        {error && <div className="pulse-notice" role="alert">{error} <button onClick={() => void load()}>Try again</button></div>}
        {payload?.status.failed && <p className="pulse-notice" role="status">Grouping is delayed. Your saved collections are available; Paper will retry automatically.</p>}
        {payload && !payload.status.enabled && <p className="pulse-notice">Automatic grouping is paused. Saved collections are still available.</p>}
        {section === 'archived' && <h2 id="pulse-archived-heading" tabIndex={-1}>Archived collections</h2>}
        {collections.length > 0 && <p className="visually-hidden">{descriptions[section]}</p>}
        {merging && <div className="topics-merge-notice"><span>Open the collection that belongs with "{merging.headline}", then choose Merge into this collection.</span><button onClick={() => setMergeFrom(null)}>Cancel</button></div>}
        {!payload && !error && <div className="topics-state"><h2>Loading Pulse</h2></div>}
        {payload && !collections.length && <div className="topics-state"><h2>{emptyHeadings[section]}</h2><p>{descriptions[section]}</p></div>}
        {ordered.map(collection => <CollectionCard key={collection.id} collection={collection}
          lead={collection === lead} now={now} unreadOnly={section === 'unread'} summariesEnabled={Boolean(payload?.status.enabled)} discussionConfigured={discussionConfigured}
          expanded={expanded === collection.id} filter={filter} onExpand={next => showCollection(collection, next)} onCollapse={() => void closeCollection()}
          onOpenEntry={id => openArticle(id, collection)} marking={marking?.collectionId === collection.id} markDisabled={Boolean(marking)}
          onMarkRead={(ids, button) => {
            if (marking) return
            if (document.activeElement === button || document.activeElement === document.body) {
              markFocus.current = { button, title: button.closest('article')?.querySelector<HTMLButtonElement>('.pulse-title') }
            }
            void markRead(ids, collection.id)
          }} merging={Boolean(mergeFrom)} mergingThis={mergeFrom === collection.id}
          onMerge={() => mergeFrom && void saveFeedback('merge', mergeFrom, '', collection.id)} onStartMerge={() => setMergeFrom(collection.id)}
          onHide={() => void saveFeedback('not_useful', collection.id)} onRemove={id => void saveFeedback('not_same', collection.id, id)} />)}
        {visible.length < collections.length && <button className="pulse-list-more" onClick={() => {
          const first = collections[visible.length].id
          setAllActive(true)
          requestAnimationFrame(() => scroll.current?.querySelector<HTMLButtonElement>(`.pulse-title[aria-controls="pulse-${CSS.escape(first)}"]`)?.focus())
        }}>Show {collections.length - visible.length} more active collections</button>}
        {section === 'quiet' && sections.archived.length > 0 && <button className="pulse-list-more" onClick={() => void changeSection('archived')
          .then(() => requestAnimationFrame(() => document.getElementById('pulse-archived-heading')?.focus()))}>{countLabel(sections.archived.length, 'archived collection')}</button>}
      </div>
    </div>
    {markPreview && <Modal title="Mark all read" className="pulse-mark-dialog" busy={Boolean(marking)} onClose={() => setMarkPreview(null)}>
      <p>Mark {countLabel(markPreview.ids.length, 'article')} in {countLabel(markPreview.collectionCount, 'collection')} as read?</p>
      <div className="pulse-mark-dialog-actions"><button type="button" disabled={Boolean(marking)} onClick={() => setMarkPreview(null)}>Cancel</button><button type="button" className="primary" disabled={Boolean(marking)} onClick={() => void markRead(markPreview.ids).finally(() => setMarkPreview(null))}>{marking ? 'Marking read…' : 'Mark all read'}</button></div>
    </Modal>}
  </section>
}

function countLabel(count: number, singular: string) { return `${count.toLocaleString()} ${singular}${count === 1 ? '' : 's'}` }

function CollectionCard({ collection, lead, now, expanded, filter, unreadOnly, summariesEnabled, discussionConfigured, onExpand, onCollapse, onOpenEntry, onMarkRead, marking, markDisabled, merging, mergingThis, onMerge, onStartMerge, onHide, onRemove }: {
  collection: PulseCollection; lead: boolean; now: number; expanded: boolean; filter: ArticleFilter; unreadOnly: boolean; summariesEnabled: boolean; discussionConfigured?: boolean
  onExpand: (filter: ArticleFilter) => Promise<void>; onCollapse: () => void; onOpenEntry: (id: string) => void
  onMarkRead: (ids: string[], button: HTMLButtonElement) => void; marking: boolean; markDisabled: boolean; merging: boolean; mergingThis: boolean
  onMerge: () => void; onStartMerge: () => void; onHide: () => void; onRemove: (id: string) => void
}) {
  const [failedImages, setFailedImages] = useState<string[]>([])
  const image = lead && collectionImage(collection.sources, failedImages)
  const rejectImage = () => { if (image) setFailedImages(failed => [...failed, image]) }
  const list = useRef<HTMLDivElement>(null)
  const filtered = threadSources(collection, expanded ? filter : unreadOnly ? 'unread' : 'all')
  const sources = expanded ? filtered : filtered.slice(0, lead ? 3 : 1)
  const earlier = filtered.length - sources.length
  const unreadIds = collection.sources.filter(source => !source.read).map(source => source.id)
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
    {!expanded && <div className="pulse-preview-actions">
      <a className="pulse-earlier" href={collection.linkNumber ? `/collection/${collection.linkNumber}` : `/?view=pulse&collection=${encodeURIComponent(collection.id)}`} aria-controls={listId} aria-describedby={`${listId}-count`} onClick={event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        void onExpand('all').then(() => requestAnimationFrame(() => { list.current?.focus(); list.current?.scrollIntoView?.({ block: 'start' }) }))
      }}>{earlier ? `${earlier} earlier ${earlier === 1 ? 'article' : 'articles'}` : 'View collection'}</a>
      {unreadIds.length > 0 && <button type="button" className="pulse-mark-read" aria-disabled={markDisabled} aria-label={`Mark all ${countLabel(unreadIds.length, 'unread article')} in ${collection.headline} as read`} onClick={event => onMarkRead(unreadIds, event.currentTarget)}>{marking ? 'Marking read…' : 'Mark read'}</button>}
    </div>}
    {expanded && discussionConfigured && collection.questionsRevision && <CollectionQuestions key={collection.questionsRevision} collection={collection} revision={collection.questionsRevision} onOpenEntry={onOpenEntry} />}
    {expanded && <div className="pulse-card-actions">
      <button disabled={!unreadIds.length} aria-disabled={markDisabled} onClick={event => onMarkRead(unreadIds, event.currentTarget)}>{marking ? 'Marking read…' : `Mark ${unreadIds.length} unread as read`}</button><button onClick={onCollapse}>Close collection</button>
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
