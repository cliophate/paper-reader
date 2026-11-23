import { queueArticleEdit, replayArticleEdits } from './offlineQueue'
import { searchCopies } from './offlineSearch'
import { OfflineDownloads, useOfflineDownload } from './components/OfflineDownloads'
import { EnclosurePlayers } from './components/EnclosurePlayers'
import { MAX_DISPLAYED_SEARCH_IDS, searchHint as getSearchHint } from '../server/search-query'
import { ArticleNotes, Highlights, useAnnotations, usePassageRanges } from './components/Annotations'
import { anchorPassage, passageText } from './passage'
import { AccessSettings } from './components/AccessSettings'
import { SavedViews } from './components/SavedViews'
import { currentSearchQuery, savedViewQuery } from './savedViews'
import { OrganizationSidebar } from './components/OrganizationSidebar'
import { FeedMark } from './components/FeedMark'
import type { SaveDestination } from '../shared/connections'
import type { OrganizationView } from '../shared/organization'
import { forwardRef, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createArticleBoundaryStore, type ArticleBoundaryStore } from './articleBoundaryStore'
import { createArticleNavigation } from './articleNavigation'
import { api, ApiError, playback } from './api'
import { useDialogFocus, useMenuFocus } from './dialogFocus'
import { rememberPosition, useReadingProgress } from './readingProgress'
import { prepareArticleMedia } from './articleMedia'
import { clearOffline, downloadPages, inOfflineStream, offlineArticles, offlineNavigation, patchOffline, removeOffline } from './offline'
import { FeedOverrides } from './components/FeedOverrides'
import type { FullTextMode } from '../server/reading-preference-values'
import { PreferenceNotice, ReadingPreferencesProvider, ReadingSettings, useReadingPreferences } from './components/ReadingPreferences'
import { FeedRepair } from './components/FeedRepair'
import { ArticleDiscussion } from './components/ArticleDiscussion'
import { BackendSettings } from './components/BackendSettings'
import { WebhookSettingsPanel } from './components/WebhookSettingsPanel'
import { ConnectionSettings } from './components/ConnectionSettings'
import { FeedSettings } from './components/FeedSettings'
import { isDarkTheme, toggledTheme } from './appearance'
import { articleImageSource, removeBrokenArticleImage, shouldShowArticleLeadImage } from './articleImages'
import { Icon } from './components/Icon'
import { ActivitySettings, FiltersSettings, ReportsSettings } from './components/SettingsPanels'
import { TopicsLibrary } from './components/TopicsLibrary'
import { BriefingLibrary } from './components/BriefingLibrary'
import { Modal } from './components/Modal'
import { StaleThresholds } from './components/StaleThresholds'
import { useFeedChecksView } from './components/FeedChecks'
import type { FeedMaintenance } from '../shared/feed-checks'
import { duplicateFeedGroups, feedMatchesAge, type FeedFilter } from './feedFilters'
import { recordFullTextSuccess } from './fullTextPreferences'
import { movementDirection } from './keyboard'
import { readReaderLocation, readerLocationUrl, resolveReaderLocation, type ReaderLinks, type MobilePane, type ReaderLocation } from './location'
import { articleEdgeState, swipeDirection, type GesturePoint } from './mobileGestures'
import { initialReaderChromeScrollState, readerChromeCanAutoHide, updateReaderChromeScroll } from './readerChrome'
import { authorLine, resistedPullDistance, shouldAutoMarkRead, shouldAutomaticallyFetchFullArticle, shouldFetchFullArticle, shouldReleaseToRefresh } from './reading'
import { formatXPostHtml } from './socialHtml'
import type { ArticleReport, Entry, Feed, Folder, NavigationPayload, StreamRef, XThreadPost } from './types'

type ReaderDestination = SaveDestination | { id: 'readwise'; name: string }
type ReaderFont = 'literata' | 'source'
type ReaderSize = 'small' | 'medium' | 'large'
type ReaderSpacing = 'compact' | 'comfortable' | 'spacious'
type ReaderWidth = 'narrow' | 'standard' | 'wide'
type ArticleBoundaryDirection = 'previous' | 'next'

const ARTICLE_BOUNDARY_DISTANCE = 56
const ARTICLE_BOUNDARY_ZONE_SIZE = 96

const allStream: StreamRef = { kind: 'all', id: 'all', title: 'All articles' }
function articleContent(entry: Entry): Partial<Entry> { return { contentHtml: entry.contentHtml, excerpt: entry.excerpt, readingMinutes: entry.readingMinutes, author: entry.author, fullText: Boolean(entry.fullText) } }

type PulseContext = { id: string; title: string; ids: string[] }
function savedPulseContext(id?: string): PulseContext | null {
  try { const value = JSON.parse(sessionStorage.getItem(`paper-collection:${id}`) || 'null'); return value?.id === id && Array.isArray(value.ids) ? value : null } catch { return null }
}

const starredStream: StreamRef = { kind: 'starred', id: 'starred', title: 'Starred' }

interface OverlayState {
  command: boolean
  help: false | 'shortcuts' | 'search'
  settings: boolean
  appearance: boolean
}

type SettingsSection = 'access' | 'backend' | 'feeds' | 'filters' | 'reports' | 'activity' | 'connections'

const closedOverlays: OverlayState = { command: false, help: false, settings: false, appearance: false }

interface ToastState {
  message: string
  actionLabel?: string
  action?: () => void
}

interface EntryContextState {
  entry: Entry
  left: number
  top: number
}

interface SelectionContextState {
  entryId: string
  save?: () => void
  quote: string
  left: number
  top: number
}

export default function App() {
  return <ReadingPreferencesProvider><Reader /></ReadingPreferencesProvider>
}

function Reader() {
  const [initialLocation] = useState(() => readReaderLocation())
  const [pendingLocation, setPendingLocation] = useState<ReaderLocation | null>(initialLocation)
  const resolvingLocation = useRef(true)
  const routeEntries = useRef(new Map<string, Entry>())
  const routeCollections = useRef<NonNullable<ReaderLinks['collections']>>([])
  const [view, setView] = useState(initialLocation.view)
  const [organization, setOrganization] = useState<OrganizationView | null>(null)
  const [navigation, setNavigation] = useState<NavigationPayload | null>(null)
  const [stream, setStream] = useState<StreamRef>(initialLocation.stream)
  const [entries, setEntries] = useState<Entry[]>([])
  for (const entry of entries) routeEntries.current.set(entry.id, entry)
  const readerLinks = useRef<ReaderLinks>({})
  readerLinks.current = { navigation, entries: [...routeEntries.current.values()], collections: routeCollections.current }
  const [selectedId, setSelectedId] = useState(initialLocation.selectedId)
  const [unreadOnly, setUnreadOnly] = useState(initialLocation.unreadOnly)
  const [query, setQuery] = useState(initialLocation.query)
  const searchHint = useMemo(() => getSearchHint(query), [query])
  const [selectedSearchStream, setSearchStream] = useState<StreamRef>(initialLocation.searchStream || allStream)
  const viewQuery = stream.kind === 'view' ? savedViewQuery(navigation?.savedViews || [], stream.id) : undefined
  const [searchUnread, setSearchUnread] = useState(initialLocation.searchUnread || false)
  const [after, setAfter] = useState(initialLocation.after || '')
  const [before, setBefore] = useState(initialLocation.before || '')
  const dates = useMemo(() => ({ after, before: before && Number.isFinite(Date.parse(before)) ? new Date(Date.parse(before) + 86400000).toISOString() : '' }), [after, before])
  const [libraryMode, setLibraryMode] = useState<'stream' | 'recent' | 'offline'>(initialLocation.library || 'stream')
  const searchStream = stream.kind === 'view' && libraryMode === 'stream' ? stream : selectedSearchStream
  const [linkedCollection, setLinkedCollection] = useState(initialLocation.view === 'pulse' && !initialLocation.collectionFilter ? initialLocation.collection : undefined)
  const [collectionFilter, setCollectionFilter] = useState<ReaderLocation['collectionFilter']>()
  const [pulseContext, setPulseContext] = useState<PulseContext | null>(() => savedPulseContext(initialLocation.collection))
  const [listError, setListError] = useState('')
  const [actionError, setActionError] = useState<{ id: string; message: string; operation: 'read' | 'unread' | 'star' | 'unstar' } | null>(null)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [syncError, setSyncError] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const [statusError, setStatusError] = useState('')
  const navigationRequest = useRef<AbortController | null>(null)
  const statusRequest = useRef<AbortController | null>(null)
  const preferences = useReadingPreferences()
  const { store: readingPreferences } = preferences
  const preferencesReady = preferences.state.hasSnapshot || !!preferences.state.legacy
  const autoRead = preferencesReady && preferences.value('markRead') === 'automatic'
  const feedVersions = useRef(new Map<string, Entry>())
  const fullVersions = useRef(new Map<string, Entry>())
  const [saveBusy, setSaveBusy] = useState(false)
  const [chooseSaveFor, setChooseSaveFor] = useState<Entry | null>(null)
  const [bulkPreview, setBulkPreview] = useState<{ token: string; count: number; label: string } | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const download = useOfflineDownload(navigation)
  const [picks, setPicks] = useState<Map<string, Entry> | null>(null)
  useEffect(() => setPicks(null), [stream.id, query, libraryMode])

  const [loading, setLoading] = useState(true)
  const [entryOrder, setEntryOrder] = useState<'newest' | 'oldest'>('newest')
  const [savingOrder, setSavingOrder] = useState(false)
  const entryOrderRef = useRef(entryOrder)
  entryOrderRef.current = entryOrder
  const [loadingMore, setLoadingMore] = useState(false)
  const [continuation, setContinuation] = useState('')
  const [previousContinuation, setPreviousContinuation] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [topicsRefreshKey, setTopicsRefreshKey] = useState(0)
  const [fetchingFullTextId, setFetchingFullTextId] = useState('')
  const [fullTextError, setFullTextError] = useState<{ id: string; message: string } | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [mobilePane, setMobilePane] = useState<MobilePane>(initialLocation.mobilePane)
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia('(max-width: 1040px)').matches)
  const [overlays, setOverlays] = useState<OverlayState>(closedOverlays)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('feeds')
  const [settingsFeedId, setSettingsFeedId] = useState('')
  const [settingsFeedView, setSettingsFeedView] = useState<'manage' | 'discover'>('manage')
  const [entryContext, setEntryContext] = useState<EntryContextState | null>(null)
  const [selectionContext, setSelectionContext] = useState<SelectionContextState | null>(null)
  useEffect(() => setSelectionContext(null), [online, view, selectedId])
  const [discussionTarget, setDiscussionTarget] = useState<{ entry: Entry; quote: string } | null>(null)
  useEffect(() => {
    if (discussionTarget && (discussionTarget.entry.id !== selectedId || view !== 'reader')) setDiscussionTarget(null)
  }, [selectedId, view, discussionTarget])
  const [reportEntry, setReportEntry] = useState<Entry | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('paper-theme') || 'system')
  const readerFont = preferences.value('font') as ReaderFont
  const [readerSize, setReaderSize] = useState<ReaderSize>(() => storedChoice('paper-reader-size', ['small', 'medium', 'large'], 'medium'))
  const readerSpacing = preferences.value('spacing') as ReaderSpacing
  const readerWidth = preferences.value('width') as ReaderWidth
  const [pullDistance, setPullDistance] = useState(0)
  const [sourcePullDistance, setSourcePullDistance] = useState(0)
  const [readerChromeHidden, setReaderChromeHidden] = useState(false)
  const [articleBoundaryStore] = useState(createArticleBoundaryStore)
  const [articleNavigation] = useState(createArticleNavigation)
  const [articleNavigationBusy, setArticleNavigationBusy] = useState(false)
  const [status, setStatus] = useState({ backend: 'freshrss' as 'freshrss' | 'standalone' | 'miniflux', discussionConfigured: false, readwiseConfigured: false, manualWebhooks: [] as Array<{ feedId: string; folderId: string }>, saveDestinations: [] as SaveDestination[], kirbyConfigured: false, briefingConfigured: false })
  const listRef = useRef<HTMLDivElement>(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const pendingListScroll = useRef<{ top: number; anchors: Array<{ node: HTMLElement; top: number }> } | null>(null)
  const sourceListRef = useRef<HTMLElement>(null)
  const storyRowRefs = useRef(new Map<string, HTMLElement>())
  const articleRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const streamStartRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const requestSerial = useRef(0)
  const loadedEntriesScope = useRef('')
  const pullStartY = useRef(0)
  const pullStartX = useRef(0)
  const pullEligible = useRef(false)
  const sourcePullStartY = useRef(0)
  const sourcePullEligible = useRef(false)
  const automaticFullTextAttempts = useRef(new Set<string>())
  const manuallyUnreadId = useRef('')
  const readerChromeScroll = useRef(initialReaderChromeScrollState())
  const storyGestureStart = useRef<(GesturePoint & { atTop: boolean; atBottom: boolean }) | null>(null)
  const storyGestureLast = useRef<GesturePoint | null>(null)
  const articleBoundaryGesture = useRef<{ direction: ArticleBoundaryDirection | null; travel: number; ready: boolean }>({ direction: null, travel: 0, ready: false })
  const articleBoundaryHaptic = useRef(false)
  const preparedStreamLoad = useRef<StreamRef | null>(null)
  const readerChromeTap = useRef<(GesturePoint & { pointerId: number }) | null>(null)

  const listedEntry = entries.find(entry => entry.id === selectedId) || null
  const refreshOffline = libraryMode === 'offline' && online
  const [offlineMedia, setOfflineMedia] = useState<(Pick<Entry, 'id' | 'enclosures'> & { useCached?: boolean }) | null>(null)
  const selected = useMemo(() => listedEntry && refreshOffline && offlineMedia?.id === listedEntry.id && !offlineMedia.useCached
    ? { ...listedEntry, enclosures: offlineMedia.enclosures }
    : listedEntry, [listedEntry, refreshOffline, offlineMedia])
  const fullMode = selected ? preferences.value(`fullText:${selected.feedId}`) as FullTextMode : 'auto'
  const learnedFullText = !!selected && preferences.value(`learned:${selected.feedId}`) === 'on'
  const readerGeneration = useRef(0)
  useLayoutEffect(() => { readerGeneration.current += 1 }, [view, stream.kind, stream.id, viewQuery, unreadOnly, query, libraryMode, searchStream.kind, searchStream.id, searchUnread, after, before, pulseContext?.id])
  const currentReader = useRef({ stream, selected, previousContinuation, entries, libraryMode })
  currentReader.current = { stream, selected, previousContinuation, entries, libraryMode }
  const selectedIndex = selected ? entries.findIndex(entry => entry.id === selected.id) : -1
  const adjacentSources = stream.kind === 'category' ? navigation?.folders || [] : stream.kind === 'feed' ? navigationFeeds(navigation) : []
  const currentFolderIndex = adjacentSources.findIndex(source => source.id === stream.id)
  const folderNavigation = libraryMode === 'stream' && !query && !pulseContext && currentFolderIndex >= 0
  const previousFolder = folderNavigation ? adjacentSources.slice(0, currentFolderIndex).reverse().find(folder => !unreadOnly || folder.unread > 0) : undefined
  const nextFolder = folderNavigation ? adjacentSources.slice(currentFolderIndex + 1).find(folder => !unreadOnly || folder.unread > 0) : undefined
  const previousFolderAvailable = Boolean(previousFolder)
  const nextFolderAvailable = Boolean(nextFolder)
  const atStreamEnd = selectedIndex >= 0 && selectedIndex === entries.length - 1 && !continuation
  const atStreamStart = selectedIndex === 0 && !previousContinuation
  const previousArticleAvailable = pulseContext && selected ? pulseContext.ids.indexOf(selected.id) > 0 : selectedIndex > 0 || Boolean(previousContinuation) || previousFolderAvailable
  const nextArticleAvailable = pulseContext && selected ? pulseContext.ids.indexOf(selected.id) < pulseContext.ids.length - 1 : (selectedIndex >= 0 && selectedIndex < entries.length - 1) || Boolean(continuation) || nextFolderAvailable
  const previousArticleTitle = pulseContext ? 'Previous article in collection' : selectedIndex > 0 ? entries[selectedIndex - 1].title : previousContinuation ? 'Previous article' : 'Beginning'
  const nextArticleTitle = pulseContext ? 'Next article in collection' : selectedIndex >= 0 && selectedIndex < entries.length - 1 ? entries[selectedIndex + 1].title : continuation ? 'Next article' : 'End'
  const starredView = !query && stream.kind === 'starred'
  const streamUnreadOnly = query ? searchUnread : unreadOnly && !starredView
  const unreadStreamTotal = !query && streamUnreadOnly ? streamUnreadCount(navigation, stream) : null
  const visibleStreamTotal = libraryMode === 'stream' ? unreadStreamTotal : null
  const feedIcons = useMemo(() => {
    const icons = new Map<string, string>()
    for (const folder of navigation?.folders || []) {
      for (const feed of folder.feeds) icons.set(feed.id, feed.iconUrl)
    }
    for (const feed of navigation?.uncategorized || []) icons.set(feed.id, feed.iconUrl)
    return icons
  }, [navigation])
  const visibleFolders = useMemo(() => (navigation?.folders || [])
    .filter(folder => !unreadOnly || folder.unread > 0)
    .map(folder => ({ ...folder, feeds: unreadOnly ? folder.feeds.filter(feed => feed.unread > 0) : folder.feeds })), [navigation, unreadOnly])
  const visibleUncategorized = useMemo(() => (navigation?.uncategorized || [])
    .filter(feed => !unreadOnly || feed.unread > 0), [navigation, unreadOnly])
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const darkThemeActive = isDarkTheme(theme, systemDark)

  const notify = useCallback((message: string, action?: { label: string; run: () => void }) => {
    window.clearTimeout(toastTimer.current)
    setToast({ message, actionLabel: action?.label, action: action?.run })
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 8000 : 2600)
  }, [])

  const copyArticleUrl = useCallback(async (entry: Entry) => {
    try {
      await navigator.clipboard.writeText(entry.url)
      notify('Article URL copied')
    } catch {
      notify('Could not copy the article URL. Use Copy link address on Original.')
    }
  }, [notify])

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  const loadStatus = useCallback(async () => {
    statusRequest.current?.abort()
    const controller = new AbortController()
    statusRequest.current = controller
    try {
      const next = await api.status(controller.signal)
      if (controller.signal.aborted) return
      setStatusError('')
      setStatus(next); if (!next.discussionConfigured) setDiscussionTarget(null); setLastSync(next.sync?.lastCompletedAt || null); setSyncError(next.sync?.lastError || '')
    } catch (error) {
      if (controller.signal.aborted) return
      setStatusError(error instanceof Error ? error.message : 'Could not fetch status')
      throw error
    }
  }, [])

  const applyOrganizationSnapshot = useCallback((snapshot: OrganizationView) => {
    setOrganization(snapshot)
    setNavigation(snapshot.navigation)
    // Keep the selected article and history entry when labels or memberships change.
    setStream(current => {
      if (current.kind === 'view') {
        const view = snapshot.navigation.savedViews?.find(view => view.id === current.id)
        return view && (view.title !== current.title || view.query !== current.viewQuery) ? { ...current, title: view.title, viewQuery: view.query } : current
      }
      const title = current.kind === 'category' ? snapshot.navigation.folders.find(folder => folder.id === current.id)?.title
        : current.kind === 'feed' ? uniqueFeeds(snapshot.navigation).find(feed => feed.id === current.id)?.title : undefined
      return title && title !== current.title ? { ...current, title } : current
    })
  }, [])
  const loadNavigation = useCallback(async () => {
    navigationRequest.current?.abort()
    const controller = new AbortController()
    navigationRequest.current = controller
    try {
      const snapshot = await api.organization(false, controller.signal)
      if (controller.signal.aborted) return
      applyOrganizationSnapshot(snapshot)
      setNavigationError('')
      return snapshot.navigation
    } catch (error) {
      if (controller.signal.aborted) return
      setNavigationError(error instanceof Error ? error.message : 'Could not fetch sources')
      throw error
    }
  }, [applyOrganizationSnapshot])

  const loadEntries = useCallback(async (target = currentReader.current.stream, select: 'keep' | 'first' | 'last' = 'keep', background: boolean | 'replace-in-place' = false) => {
    const serial = ++requestSerial.current
    const source = query ? searchStream : target
    const scope = JSON.stringify([libraryMode, source.kind, source.kind === 'view' ? [source.id, viewQuery] : source.id, query ? searchUnread : unreadOnly && target.kind !== 'starred', query, query ? dates : {}])
    setLoadingMore(false)
    if (!background) setLoading(true)
    try {
      setListError('')
      if (libraryMode !== 'stream' || !navigator.onLine) {
        let items = navigator.onLine && libraryMode === 'recent' ? await api.recentReading() : await offlineArticles()
        if (libraryMode === 'offline' || !navigator.onLine) {
          if (libraryMode === 'stream') items = source.kind === 'view' && viewQuery ? searchCopies(items, viewQuery) : items.filter(entry => inOfflineStream(entry, source))
          if (query) items = searchCopies(items, query)
          if (libraryMode === 'stream' && (query ? searchUnread : unreadOnly && source.kind !== 'starred')) items = items.filter(entry => !entry.read || entry.id === selectedIdRef.current)
          if (libraryMode === 'stream' && query && dates.after) items = items.filter(entry => entry.timestamp >= Date.parse(dates.after))
          if (libraryMode === 'stream' && query && dates.before) items = items.filter(entry => entry.timestamp < Date.parse(dates.before))
        }
        if (serial !== requestSerial.current) return
        setEntries(items); setContinuation(''); setPreviousContinuation(''); return
      }
      // Refresh a tail-loaded stream from the same end, so the first page
      // cannot introduce a gap ahead of the article being read.
      const current = currentReader.current
      const keepWindow = background === 'replace-in-place' || (!background && select === 'keep' && loadedEntriesScope.current === scope)
      const reverse = Boolean((background || keepWindow) && !query && current.previousContinuation && current.stream.kind === target.kind && current.stream.id === target.id)
      const result = await api.entries(query ? searchStream : target, query ? searchUnread : unreadOnly && target.kind !== 'starred', query, '', undefined, query ? dates : {}, reverse)
      // A bulk action must not collapse a paginated list back to page one.
      const loadedCount = current.entries.length
      const seenPages = new Set<string>()
      let cursor = reverse ? result.previousContinuation : result.continuation
      while (keepWindow && cursor && result.items.length < loadedCount) {
        if (serial !== requestSerial.current || seenPages.has(cursor)) break
        seenPages.add(cursor)
        const page = await api.entries(query ? searchStream : target, query ? searchUnread : unreadOnly && target.kind !== 'starred', query, cursor, undefined, query ? dates : {}, reverse)
        if (reverse) result.items.unshift(...page.items)
        else result.items.push(...page.items)
        result.continuation = page.continuation
        result.previousContinuation = page.previousContinuation
        cursor = reverse ? page.previousContinuation : page.continuation
      }
      if (serial !== requestSerial.current) return
      const scopeChanged = loadedEntriesScope.current !== scope
      loadedEntriesScope.current = scope
      const orderChanged = Boolean(result.order && result.order !== entryOrderRef.current)
      setEntryOrder(result.order || 'newest')
      if (keepWindow && listRef.current) {
        const list = listRef.current
        const top = list.getBoundingClientRect().top
        pendingListScroll.current = { top: list.scrollTop, anchors: [...list.querySelectorAll<HTMLElement>('.story-row')]
          .filter(node => node.getBoundingClientRect().bottom > top)
          .map(node => ({ node, top: node.getBoundingClientRect().top })) }
      }
      setEntries(current => {
        if (scopeChanged) return result.items
        if (keepWindow && !orderChanged) {
          const next = result.items.map(item => item.id === selectedIdRef.current && current.find(old => old.id === item.id)?.fullText ? { ...item, ...articleContent(current.find(old => old.id === item.id)!) } : item)
          const selectedIndex = current.findIndex(item => item.id === selectedIdRef.current)
          const selectedEntry = current[selectedIndex]
          if (selectedEntry && !next.some(item => item.id === selectedEntry.id)) {
            // Keep an open read article in its existing relative position. The
            // missing-entry effect would otherwise fetch and prepend it.
            const nextSurvivor = current.slice(selectedIndex + 1).find(item => next.some(incoming => incoming.id === item.id))
            const index = nextSurvivor ? next.findIndex(item => item.id === nextSurvivor.id) : next.length
            next.splice(index, 0, selectedEntry)
          }
          return next
        }
        if (background !== true || orderChanged) return result.items
        const incoming = new Map(result.items.map(item => [item.id, item]))
        const known = new Set(current.map(item => item.id))
        const arrived = result.items.filter(item => !known.has(item.id))
        const retained = current.map(item => { const fresh = incoming.get(item.id); return fresh && item.fullText ? { ...fresh, contentHtml: item.contentHtml, excerpt: item.excerpt, readingMinutes: item.readingMinutes, fullText: true } : fresh || item })
        const merged = [...arrived, ...retained]
        return query ? merged : merged.sort((a, b) => (result.order === 'oldest' ? 1 : -1) * (a.timestamp - b.timestamp || (a.crawledAt || 0) - (b.crawledAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
      })
      setContinuation(result.continuation)
      setPreviousContinuation(result.previousContinuation || '')
      setSelectedId(current => {
        if (select === 'first') return result.items[0]?.id || ''
        if (select === 'last') return result.items.at(-1)?.id || ''
        return current
      })
    } catch (error) {
      if (serial === requestSerial.current) setListError(error instanceof Error ? error.message : 'Paper could not load this stream')
    } finally {
      if (serial === requestSerial.current) setLoading(false)
    }
  }, [stream.kind, stream.id, viewQuery, unreadOnly, query, notify, searchStream, searchUnread, dates, libraryMode])

  const changeEntryOrder = async (order: 'newest' | 'oldest') => {
    if (savingOrder || order === entryOrder) return
    setSavingOrder(true)
    const serial = requestSerial.current
    try {
      await api.setStreamOrder(stream, order)
      if (serial === requestSerial.current) {
        setEntryOrder(order)
        // Start at the new end of the stream rather than pinning an article
        // from a distant page ahead of the newly ordered results.
        setSelectedId('')
        setMobilePane('stories')
        pushLocation({ selectedId: '', mobilePane: 'stories' })
        // A new order starts from its first page, even after entering this stream backward.
        currentReader.current = { ...currentReader.current, previousContinuation: '' }
        setPreviousContinuation('')
        await loadEntries(stream)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not save the article order')
    } finally { setSavingOrder(false) }
  }

  useLayoutEffect(() => {
    const snapshot = pendingListScroll.current
    pendingListScroll.current = null
    const list = listRef.current
    if (!snapshot || !list) return
    const anchor = snapshot.anchors.find(item => list.contains(item.node))
    if (anchor) list.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
    else list.scrollTop = snapshot.top
  }, [entries])

  const reloadFilteredLibrary = useCallback(async () => {
    const result = await loadNavigation()
    await loadEntries(stream, 'keep')
    setTopicsRefreshKey(current => current + 1)
    return result
  }, [loadEntries, loadNavigation, stream])

  // Filter settings poll while open. Once closed, finish watching a pending
  // filter here so its matches leave the list and unread counts.
  const [filtersMatching, setFiltersMatching] = useState(false)
  useEffect(() => {
    if (!filtersMatching || overlays.settings) return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const filters = await api.filters()
        if (cancelled || filters.some(filter => filter.matching)) return
        setFiltersMatching(false)
        await reloadFilteredLibrary()
      } catch { /* Try again on the next tick. */ }
    }, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [filtersMatching, overlays.settings, reloadFilteredLibrary])

  const loadMore = useCallback(async (): Promise<Entry[]> => {
    if (!navigator.onLine || !continuation || loadingMore) return []
    const serial = requestSerial.current
    setLoadingMore(true)
    try {
      const result = await api.entries(query ? searchStream : stream, streamUnreadOnly, query, continuation, undefined, query ? dates : {})
      if (serial !== requestSerial.current) return []
      const knownBeforeRequest = new Set(entries.map(entry => entry.id))
      const added = result.items.filter(entry => !knownBeforeRequest.has(entry.id))
      setEntries(current => {
        const known = new Set(current.map(entry => entry.id))
        return [...current, ...result.items.filter(entry => !known.has(entry.id))]
      })
      setContinuation(result.continuation)
      return added
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not load more articles')
      return []
    } finally {
      if (serial === requestSerial.current) setLoadingMore(false)
    }
  }, [continuation, entries, loadingMore, notify, query, stream, streamUnreadOnly, searchStream, dates, libraryMode, online])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await api.reload()
      await Promise.all([loadNavigation(), loadEntries(), loadStatus()])
      notify('Articles reloaded')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not refresh the reader')
    } finally {
      setRefreshing(false)
    }
  }, [loadEntries, loadNavigation, notify, loadStatus])

  const beginPull = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const list = listRef.current
    pullEligible.current = Boolean(window.matchMedia('(max-width: 1040px)').matches && list && list.scrollTop <= 0 && !refreshing && event.touches.length === 1)
    pullStartY.current = event.touches[0]?.clientY || 0
    pullStartX.current = event.touches[0]?.clientX || 0
  }, [refreshing])

  const continuePull = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!pullEligible.current) return
    const touch = event.touches[0]
    const y = (touch?.clientY || 0) - pullStartY.current
    const x = (touch?.clientX || 0) - pullStartX.current
    if (Math.abs(y) < Math.abs(x) * 1.2) return
    const distance = resistedPullDistance(y)
    if (distance > 0) event.preventDefault()
    setPullDistance(distance)
  }, [])

  const releasePull = useCallback(() => {
    const shouldRefresh = pullEligible.current && shouldReleaseToRefresh(pullDistance)
    pullEligible.current = false
    setPullDistance(0)
    if (shouldRefresh) void refresh()
  }, [pullDistance, refresh])

  const beginSourcePull = useCallback((event: React.TouchEvent<HTMLElement>) => {
    const list = sourceListRef.current
    sourcePullEligible.current = Boolean(window.matchMedia('(max-width: 1040px)').matches && list && list.scrollTop <= 0 && !refreshing && event.touches.length === 1)
    sourcePullStartY.current = event.touches[0]?.clientY || 0
  }, [refreshing])

  const continueSourcePull = useCallback((event: React.TouchEvent<HTMLElement>) => {
    if (!sourcePullEligible.current) return
    const distance = resistedPullDistance((event.touches[0]?.clientY || 0) - sourcePullStartY.current)
    if (distance > 0) event.preventDefault()
    setSourcePullDistance(distance)
  }, [])

  const releaseSourcePull = useCallback(() => {
    const shouldRefresh = sourcePullEligible.current && shouldReleaseToRefresh(sourcePullDistance)
    sourcePullEligible.current = false
    setSourcePullDistance(0)
    if (shouldRefresh) void refresh()
  }, [sourcePullDistance, refresh])

  const revealReaderChrome = useCallback(() => {
    const top = articleRef.current?.querySelector<HTMLElement>('.article-scroll')?.scrollTop || 0
    readerChromeScroll.current = initialReaderChromeScrollState(Math.max(0, top - ARTICLE_BOUNDARY_ZONE_SIZE))
    setReaderChromeHidden(false)
  }, [])

  useReadingProgress(selected, articleRef, view === 'reader' && mobilePane === 'article', revealReaderChrome, notify)

  const handleArticleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!window.matchMedia('(max-width: 1040px)').matches || view !== 'reader' || mobilePane !== 'article') return
    const scroll = event.currentTarget
    const edge = articleEdgeState(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight, ARTICLE_BOUNDARY_ZONE_SIZE, ARTICLE_BOUNDARY_DISTANCE)
    const available = edge?.direction === 'previous' ? previousArticleAvailable : edge?.direction === 'next' ? nextArticleAvailable : false
    const boundary = edge ? { direction: edge.direction, progress: edge.progress, ready: edge.ready && available } : null
    articleBoundaryGesture.current = boundary
      ? { direction: boundary.direction, travel: edge!.distance, ready: boundary.ready }
      : { direction: null, travel: 0, ready: false }
    if (boundary?.ready && !articleBoundaryHaptic.current) {
      articleBoundaryHaptic.current = true
      navigator.vibrate?.(12)
    } else if (!boundary?.ready) articleBoundaryHaptic.current = false
    articleBoundaryStore.set(boundary)

    const logicalTop = Math.max(0, scroll.scrollTop - ARTICLE_BOUNDARY_ZONE_SIZE)
    const style = getComputedStyle(scroll)
    const chromeHeight = (parseFloat(style.scrollPaddingTop) || 0) + (parseFloat(style.scrollPaddingBottom) || 0)
    if (!readerChromeCanAutoHide(scroll.scrollHeight, scroll.clientHeight, ARTICLE_BOUNDARY_ZONE_SIZE, chromeHeight)) {
      readerChromeScroll.current = initialReaderChromeScrollState(logicalTop)
      setReaderChromeHidden(false)
      return
    }
    const next = updateReaderChromeScroll(readerChromeScroll.current, logicalTop)
    readerChromeScroll.current = next
    setReaderChromeHidden(current => current === next.hidden ? current : next.hidden)
  }, [articleBoundaryStore, mobilePane, nextArticleAvailable, previousArticleAvailable, view])

  const beginReaderChromeTap = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!readerChromeHidden) return
    readerChromeTap.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
  }, [readerChromeHidden])

  const moveReaderChromeTap = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = readerChromeTap.current
    if (!start || start.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) readerChromeTap.current = null
  }, [])

  const finishReaderChromeTap = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = readerChromeTap.current
    readerChromeTap.current = null
    if (start?.pointerId === event.pointerId) revealReaderChrome()
  }, [revealReaderChrome])

  useEffect(() => {
    const abort = () => { navigationRequest.current?.abort(); statusRequest.current?.abort() }
    const reload = () => { void Promise.all([loadNavigation(), loadStatus()]).catch(() => {}) }
    const restored = (event: PageTransitionEvent) => { if (event.persisted) reload() }
    reload()
    window.addEventListener('pagehide', abort)
    window.addEventListener('pageshow', restored)
    window.addEventListener('online', reload)
    return () => { abort(); window.removeEventListener('pagehide', abort); window.removeEventListener('pageshow', restored); window.removeEventListener('online', reload) }
  }, [loadNavigation, loadStatus])

  const synced = useEffectEvent(() => {
    void loadNavigation().catch(() => {})
    void loadStatus().catch(() => {})
    if (view === 'reader') void loadEntries(stream, 'keep', stream.kind === 'view' ? 'replace-in-place' : true)
    setTopicsRefreshKey(current => current + 1)
  })
  const stateChanged = useEffectEvent((event: MessageEvent) => {
    const change = JSON.parse(event.data) as { ids: string[]; operation: 'read' | 'unread' | 'star' | 'unstar'; revisions?: Record<string, number> } | null
    if (!change) { synced(); return }
    const ids = new Set(change.ids)
    const patch = change.operation === 'read' ? { read: true } : change.operation === 'unread' ? { read: false } : change.operation === 'star' ? { starred: true } : { starred: false }
    setEntries(current => current.map(entry => ids.has(entry.id) ? { ...entry, ...patch, stateRevision: change.revisions?.[entry.id] ?? entry.stateRevision } : entry))
    void loadNavigation().catch(() => {})
    if (view === 'reader' && stream.kind === 'view') void loadEntries(stream, 'keep', 'replace-in-place')
    setTopicsRefreshKey(value => value + 1)
  })
  useEffect(() => {
    if (!online) return
    const events = new EventSource('/api/events')
    const navigationUpdated = () => { void loadNavigation().catch(() => {}) }
    const pulseUpdated = () => setTopicsRefreshKey(current => current + 1)
    events.addEventListener('pulse', pulseUpdated)
    events.addEventListener('open', navigationUpdated)
    events.addEventListener('navigation', navigationUpdated)
    events.addEventListener('sync', synced)
    events.addEventListener('connections', synced)
    events.addEventListener('state', stateChanged as EventListener)
    return () => {
      events.removeEventListener('pulse', pulseUpdated)
      events.removeEventListener('open', navigationUpdated)
      events.removeEventListener('navigation', navigationUpdated)
      events.removeEventListener('sync', synced)
      events.removeEventListener('connections', synced)
      events.removeEventListener('state', stateChanged as EventListener)
      events.close()
    }
  }, [loadNavigation, online])

  // Label changes keep pagination and the mounted article intact.
  useEffect(() => {
    if (preparedStreamLoad.current === stream) {
      preparedStreamLoad.current = null
      return
    }
    if (pendingLocation) return
    const timer = window.setTimeout(() => void loadEntries(stream), query ? 260 : 0)
    return () => window.clearTimeout(timer)
  }, [stream.kind, stream.id, unreadOnly, query, loadEntries, pendingLocation])

  const checkedOnOpen = useRef('')
  useLayoutEffect(() => {
    if (checkedOnOpen.current !== selectedId) checkedOnOpen.current = ''
  }, [selectedId])
  useEffect(() => {
    if (pendingLocation || libraryMode === 'offline' || !online || !selectedId || entries.some(entry => entry.id === selectedId)) return
    let cancelled = false
    api.entry(selectedId).then(result => {
      if (cancelled || !result.entry) return
      checkedOnOpen.current = result.entry.id
      setEntries(current => current.some(entry => entry.id === result.entry!.id) ? current : [result.entry!, ...current])
    }).catch(error => !cancelled && notify(error instanceof Error ? error.message : 'Paper could not open that article'))
    return () => { cancelled = true }
  }, [entries, notify, selectedId, libraryMode, online, pendingLocation])

  const checkMediaId = listedEntry && online && (refreshOffline || listedEntry.enclosuresUnchecked && status.backend === 'freshrss')
    ? listedEntry.id : ''
  useEffect(() => {
    setOfflineMedia(null)
    if (!checkMediaId || (!refreshOffline && checkedOnOpen.current === checkMediaId)) return
    let cancelled = false
    void api.entry(checkMediaId).then(({ entry }) => {
      if (cancelled || !entry) return
      checkedOnOpen.current = entry.id
      if (refreshOffline) setOfflineMedia({ id: entry.id, enclosures: entry.enclosures })
      else setEntries(items => items.map(item => item.id === entry.id
        ? { ...item, enclosures: entry.enclosures, enclosuresUnchecked: entry.enclosuresUnchecked } : item))
    }).catch(() => {
      if (!cancelled && refreshOffline) setOfflineMedia({ id: checkMediaId, useCached: true })
    })
    return () => { cancelled = true }
  }, [checkMediaId, refreshOffline])

  useEffect(() => {
    const marker = loadMoreRef.current
    const root = listRef.current
    if (!marker || !root || !continuation) return
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) void loadMore()
    }, { root, rootMargin: '240px' })
    observer.observe(marker)
    return () => observer.disconnect()
  }, [continuation, loadMore])

  useEffect(() => {
    if (!pendingLocation) return
    const needsNavigation = [pendingLocation.stream, pendingLocation.searchStream].some(source => source?.kind === 'feed' || source?.kind === 'category' || source?.kind === 'view')
    if (online && needsNavigation && !navigation) return
    const generation = readerGeneration.current
    let cancelled = false
    const resolve = async () => {
      const offline = pendingLocation.library === 'offline' || !online ? await offlineArticles() : []
      const sources = !online && !navigation ? offlineNavigation(offline) : navigation
      const pulse = online && (pendingLocation.collection || pendingLocation.collectionNumber) ? await api.pulse() : undefined
      const collections = pulse?.collections || routeCollections.current
      let removalNotice = ''
      let fetchedId = ''
      const missing = async (load: () => Promise<{ entry: Entry | null }>) => {
        try {
          const { entry } = await load()
          fetchedId = entry?.id || ''
          return entry
        } catch (error) {
          if (error instanceof ApiError && error.status === 410 && error.code === 'removed_by_retention') { removalNotice = error.message; return null }
          if (error instanceof ApiError && error.status === 404) return null
          throw error
        }
      }
      const result = await resolveReaderLocation(pendingLocation, { navigation: sources, entries: [...routeEntries.current.values(), ...offline], collections, collectionAliases: pulse?.collectionAliases },
        value => online ? missing(() => api.entryByNumber(value)) : Promise.resolve(null),
        id => online ? missing(() => api.entry(id)) : Promise.resolve(null))
      if (cancelled || generation !== readerGeneration.current) return
      const { location, entry, collection, notice } = result
      if (fetchedId) checkedOnOpen.current = fetchedId
      routeCollections.current = collections
      if (entry) { routeEntries.current.set(entry.id, entry); setEntries(current => [entry, ...current.filter(item => item.id !== entry.id)]) }
      if (!online && !navigation) setNavigation(sources)
      setView(location.view)
      setLinkedCollection(location.view === 'pulse' ? location.collection : undefined)
      setCollectionFilter(location.collectionFilter)
      setLibraryMode(!online && location.view === 'reader' && location.stream.kind === 'all' && !location.library ? 'offline' : location.library || 'stream')
      setPulseContext(location.view === 'reader' && collection ? { id: collection.id, title: collection.headline, ids: collection.sources.map(item => item.id) } : null)
      setStream(location.stream)
      setSelectedId(location.selectedId)
      setUnreadOnly(location.unreadOnly)
      setQuery(location.query)
      setSearchStream(location.searchStream?.kind === 'view' ? allStream : location.searchStream || allStream); setSearchUnread(location.searchUnread || false); setAfter(location.after || ''); setBefore(location.before || '')
      setMobilePane(location.mobilePane)
      setPendingLocation(null)
      resolvingLocation.current = false
      if (removalNotice || notice) notify(removalNotice || notice)
    }
    void resolve().catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : 'Could not open this link') })
    return () => { cancelled = true }
  }, [pendingLocation, navigation, online, notify])

  useEffect(() => {
    if (pendingLocation || resolvingLocation.current || selectedId && !routeEntries.current.get(selectedId)?.linkNumber) return
    const location: ReaderLocation = { view, stream, selectedId, unreadOnly, query, mobilePane, searchStream, searchUnread, after, before, library: libraryMode, collection: view === 'pulse' ? linkedCollection : pulseContext?.id, collectionFilter }
    history.replaceState(location, '', readerLocationUrl(location, readerLinks.current))
  }, [mobilePane, query, selectedId, stream, unreadOnly, view, searchStream, searchUnread, after, before, libraryMode, pulseContext, linkedCollection, collectionFilter, pendingLocation, navigation, entries])

  useEffect(() => {
    const onPopState = () => {
      readerGeneration.current += 1
      resolvingLocation.current = true
      setPendingLocation(readReaderLocation())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('paper-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.readerFont = readerFont
  }, [readerFont])

  useEffect(() => {
    document.documentElement.dataset.readerSize = readerSize
    document.documentElement.dataset.readerSpacing = readerSpacing
    document.documentElement.dataset.readerWidth = readerWidth
    localStorage.setItem('paper-reader-size', readerSize)
  }, [readerSize, readerSpacing, readerWidth])

  useLayoutEffect(() => {
    revealReaderChrome()
    articleBoundaryGesture.current = { direction: null, travel: 0, ready: false }
    articleBoundaryStore.set(null)
  }, [articleBoundaryStore, mobilePane, revealReaderChrome, selectedId, view])

  useLayoutEffect(() => () => articleNavigation.cancel(), [articleNavigation, stream.id, stream.kind, selectedId, unreadOnly, query, mobilePane, view])

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 1040px)')
    const onChange = () => {
      setMobileLayout(mobile.matches)
      if (!mobile.matches) revealReaderChrome()
    }
    onChange()
    mobile.addEventListener('change', onChange)
    window.addEventListener('orientationchange', revealReaderChrome)
    return () => {
      mobile.removeEventListener('change', onChange)
      window.removeEventListener('orientationchange', revealReaderChrome)
    }
  }, [revealReaderChrome])

  const pushLocation = useCallback((next: Partial<ReaderLocation>) => {
    readerGeneration.current += 1
    const location: ReaderLocation = { view, stream, selectedId, unreadOnly, query, mobilePane, searchStream, searchUnread, after, before, library: libraryMode, collection: view === 'pulse' ? linkedCollection : pulseContext?.id, ...next }
    resolvingLocation.current = false
    setPendingLocation(null)
    history.pushState(location, '', readerLocationUrl(location, readerLinks.current))
  }, [mobilePane, query, selectedId, stream, unreadOnly, view, searchStream, searchUnread, after, before, libraryMode, pulseContext, linkedCollection])

  const openStream = useCallback((target: StreamRef) => {
    setLibraryMode('stream'); setPulseContext(null)
    if (target.kind === 'view') {
      setUnreadOnly(false)
      setSearchUnread(false)
      setAfter(''); setBefore('')
    }
    pushLocation({ ...(target.kind === 'view' && { unreadOnly: false, after: '', before: '' }), view: 'reader', stream: target, selectedId: '', query: '', mobilePane: 'stories', library: 'stream', collection: undefined })
    setView('reader')
    setStream(target)
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
    requestAnimationFrame(() => listRef.current?.focus())
  }, [pushLocation])

  useEffect(() => {
    if (!pendingLocation && navigation?.savedViews && stream.kind === 'view' && viewQuery === undefined) {
      notify('This saved view was deleted.')
      openStream(allStream)
    }
  }, [navigation, pendingLocation, stream.kind, viewQuery, notify, openStream])

  function viewDownloadAction(id: string) {
    return <button type="button" disabled={!online || download.busy} onClick={() => {
      void download.start(signal => downloadPages({ stream: { kind: 'view', id, title: '' }, unread: false, query: '' }, signal), notify)
    }}>Download for offline</button>
  }

  const openLibrary = useCallback((mode: 'recent' | 'offline') => {
    setLibraryMode(mode)
    setPulseContext(null)
    setEntryContext(null)
    pushLocation({ view: 'reader', stream: allStream, library: mode, selectedId: '', query: '', mobilePane: 'stories', collection: undefined })
    setView('reader')
    setStream(allStream)
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
    requestAnimationFrame(() => listRef.current?.focus())
  }, [pushLocation])

  const openEntryContext = useCallback((entry: Entry, left: number, top: number) => {
    setEntryContext({
      entry,
      left: Math.max(8, Math.min(left, window.innerWidth - 224)),
      top: Math.max(8, Math.min(top, window.innerHeight - 362)),
    })
  }, [])

  const switchFolder = useCallback((direction: 1 | -1) => {
    if (stream.kind !== 'category' || !navigation) return
    const folders = navigation.folders.filter(folder => !unreadOnly || folder.unread > 0)
    const currentIndex = folders.findIndex(folder => folder.id === stream.id)
    const folder = folders[currentIndex + direction]
    if (!folder) return
    navigator.vibrate?.(8)
    openStream({ kind: 'category', id: folder.id, title: folder.title })
  }, [navigation, openStream, stream, unreadOnly])

  const beginStoryGesture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (!touch || event.touches.length !== 1) return
    if (stream.kind === 'category') {
      pullEligible.current = false
      setPullDistance(0)
    } else beginPull(event)
    const point = { x: touch.clientX, y: touch.clientY }
    const list = event.currentTarget
    storyGestureStart.current = {
      ...point,
      atTop: list.scrollTop <= 2,
      atBottom: !continuation && !loadingMore && list.scrollHeight - list.clientHeight - list.scrollTop <= 2,
    }
    storyGestureLast.current = point
  }, [beginPull, continuation, loadingMore, stream.kind])

  const continueStoryGesture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (stream.kind !== 'category') continuePull(event)
    const touch = event.touches[0]
    if (touch) storyGestureLast.current = { x: touch.clientX, y: touch.clientY }
  }, [continuePull, stream.kind])

  const releaseStoryGesture = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const start = storyGestureStart.current
    const changed = event.changedTouches[0]
    const end = changed ? { x: changed.clientX, y: changed.clientY } : storyGestureLast.current
    storyGestureStart.current = null
    storyGestureLast.current = null
    releasePull()
    if (!start || !end) return
    const swipe = swipeDirection(start, end)
    if (swipe === 'left') switchFolder(1)
    if (swipe === 'right') switchFolder(-1)
    if (stream.kind === 'category' && swipe === 'up' && start.atBottom) switchFolder(1)
    if (stream.kind === 'category' && swipe === 'down' && start.atTop) switchFolder(-1)
  }, [releasePull, stream.kind, switchFolder])

  const manageFeed = useCallback((feed: Feed) => {
    setSettingsFeedView('manage')
    setSettingsFeedId(feed.id)
    setSettingsSection('feeds')
    setOverlays({ ...closedOverlays, settings: true })
  }, [])

  const unsubscribeFeed = useCallback(async (feed: Pick<Feed, 'id' | 'title'>) => {
    setEntryContext(null)
    try {
      await api.removeFeed(feed.id)
      const reader = currentReader.current
      if (reader.stream.kind === 'feed' && reader.stream.id === feed.id) openStream(allStream)
      else if (reader.selected?.feedId === feed.id) {
        setSelectedId('')
        setMobilePane('stories')
        pushLocation({ selectedId: '', mobilePane: 'stories' })
      }
      setEntries(current => current.filter(entry => entry.feedId !== feed.id))
      await loadNavigation()
      notify(`${feed.title} unsubscribed`)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not remove this feed')
    }
  }, [loadNavigation, notify, openStream, pushLocation])

  const openLibraryView = useCallback((view: 'briefings' | 'highlights') => {
    setPulseContext(null)
    pushLocation({ view, selectedId: '', query: '', mobilePane: 'stories', collection: undefined })
    setView(view)
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
  }, [pushLocation])

  const openTopics = useCallback(() => {
    pushLocation({ view: 'pulse', selectedId: '', query: '', mobilePane: 'stories', collection: pulseContext?.id })
    setLinkedCollection(pulseContext?.id)
    setCollectionFilter(undefined)
    setView('pulse')
    setSelectedId('')
    setQuery('')
    setMobilePane('stories')
  }, [pushLocation])

  const openSources = useCallback(() => {
    setPulseContext(null)
    pushLocation({ view: 'reader', selectedId: '', query: '', mobilePane: 'sources', collection: undefined })
    setView('reader')
    setSelectedId('')
    setQuery('')
    setMobilePane('sources')
    requestAnimationFrame(() => sourceListRef.current?.focus())
  }, [pushLocation])

  useEffect(() => playback.subscribe(({ id, url, position, updatedAt }) => {
    const update = (files: Entry['enclosures']) => files?.map(file => file.url === url && (file.updatedAt ?? 0) < updatedAt
      ? { ...file, position, updatedAt } : file)
    setEntries(current => current.map(entry => entry.id === id ? { ...entry, enclosures: update(entry.enclosures) } : entry))
    setOfflineMedia(current => current?.id === id ? { ...current, enclosures: update(current.enclosures) } : current)
  }), [])

  const openedId = listedEntry?.id
  useEffect(() => {
    if (openedId) void playback.retry(openedId).catch(() => {})
  }, [openedId])
  useEffect(() => {
    const reconnect = () => { void playback.retry().catch(() => {}) }
    reconnect()
    window.addEventListener('online', reconnect)
    return () => window.removeEventListener('online', reconnect)
  }, [])

  const openEntry = useCallback((entry: Entry) => {
    pushLocation({ selectedId: entry.id, mobilePane: 'article' })
    setSelectedId(entry.id)
    setMobilePane('article')
    requestAnimationFrame(() => articleRef.current?.focus())
  }, [pushLocation])

  const openTopicEntry = useCallback(async (id: string, context?: { id: string; title: string; ids: string[]; linkNumber?: number }) => {
    try {
      const result = await api.entry(id)
      if (!result.entry) throw new Error('Paper could not find this article')
      const entry = result.entry
      checkedOnOpen.current = entry.id
      setLibraryMode('stream'); setPulseContext(context || null); setLinkedCollection(context?.id)
      if (context) sessionStorage.setItem(`paper-collection:${context.id}`, JSON.stringify(context))
      setEntries(current => current.some(item => item.id === entry.id) ? current.map(item => item.id === entry.id ? entry : item) : [entry, ...current])
      if (context) {
        routeCollections.current = [...routeCollections.current.filter(item => item.id !== context.id),
          { id: context.id, linkNumber: context.linkNumber, headline: context.title, sources: context.ids.map(id => ({ id })) }]
        readerLinks.current.collections = routeCollections.current
      }
      routeEntries.current.set(entry.id, entry)
      readerLinks.current.entries = [...routeEntries.current.values()]
      pushLocation({ view: 'reader', stream: allStream, selectedId: entry.id, unreadOnly: false, query: '', mobilePane: 'article', library: 'stream', collection: context?.id })
      setView('reader')
      setStream(allStream)
      setUnreadOnly(false)
      setQuery('')
      setSelectedId(entry.id)
      setMobilePane('article')
      requestAnimationFrame(() => articleRef.current?.focus())
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not open this article')
    }
  }, [notify, pushLocation])

  const closeEntry = useCallback(() => {
    if (pulseContext) { openTopics(); return }
    const closingId = selectedId
    pushLocation({ selectedId: '', mobilePane: 'stories' })
    setSelectedId('')
    setMobilePane('stories')
    requestAnimationFrame(() => {
      listRef.current?.focus()
      if (window.matchMedia('(max-width: 1040px)').matches) storyRowRefs.current.get(closingId)?.scrollIntoView({ block: 'start' })
    })
  }, [pushLocation, selectedId, pulseContext, openTopics])

  const changeMobilePane = useCallback((pane: MobilePane) => {
    pushLocation({ mobilePane: pane })
    setMobilePane(pane)
  }, [pushLocation])

  const changeUnreadOnly = useCallback((value: boolean) => {
    pushLocation({ unreadOnly: value, selectedId: '' })
    setUnreadOnly(value)
    setSelectedId('')
  }, [pushLocation])

  useLayoutEffect(() => {
    if (!selectedId || loading) return
    storyRowRefs.current.get(selectedId)?.scrollIntoView({ block: 'center', inline: 'nearest' })
    if (atStreamEnd) loadMoreRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    else if (atStreamStart) streamStartRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedId, loading, atStreamEnd, atStreamStart])

  useEffect(() => {
    manuallyUnreadId.current = ''
  }, [selectedId])

  const updateEntry = useCallback((id: string, patch: Partial<Entry>) => {
    setEntries(current => current.map(entry => entry.id === id ? { ...entry, ...patch } : entry))
  }, [])

  useEffect(() => {
    const replay = () => { void replayArticleEdits(patchOffline, ({ id, patch, queued, notice }) => {
      if (notice && !queued && patch.read === false && selectedIdRef.current === id) manuallyUnreadId.current = id
      updateEntry(id, { ...patch, ...queued })
      if (!queued && patch.lastReadAt && patch.readingPosition !== undefined) rememberPosition(id, patch.readingPosition, patch.lastReadAt)
      if (notice) notify(notice)
    })?.catch(() => { /* The pending edit remains in IndexedDB. */ }) }
    replay()
    const timer = setInterval(replay, 15000)
    window.addEventListener('online', replay)
    window.addEventListener('focus', replay)
    window.addEventListener('paper-offline-edits', replay)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', replay)
      window.removeEventListener('focus', replay)
      window.removeEventListener('paper-offline-edits', replay)
    }
  }, [notify, updateEntry])

  const setEntryState = useCallback(async (entry: Entry, operation: 'read' | 'unread' | 'star' | 'unstar', quiet = false, origin: 'reader' | 'pulse' | 'automatic' = 'reader') => {
    if (operation === 'unread') manuallyUnreadId.current = entry.id
    else if (operation === 'read' && manuallyUnreadId.current === entry.id) manuallyUnreadId.current = ''
    const field = operation === 'read' || operation === 'unread' ? 'read' : 'starred'
    const to = operation === 'read' || operation === 'star'
    const patch = { [field]: to }
    const queue = () => queueArticleEdit({ kind: 'state', id: entry.id, field, from: entry[field], to })
    setActionError(null)
    updateEntry(entry.id, patch)
    let undoToken: string | string[] = ''
    let revision = entry.stateRevision
    try {
      if (!online || entry.offline) {
        await queue()
        if (!quiet) notify('Saved on this device.')
        return
      }
      const result = await api.editState([entry.id], operation, origin, {
        expectedRevisions: status.backend === 'standalone' && revision !== undefined ? { [entry.id]: revision } : undefined, undo: !quiet,
      })
      undoToken = result.undoToken || ''
      revision = result.revisions?.[entry.id] ?? revision
      const confirmed = { ...patch, stateRevision: revision, modifiedAtMs: result.modifiedAtMs }
      updateEntry(entry.id, confirmed)
      void patchOffline(entry.id, confirmed).catch(() => notify('State saved. Download the article again to update its offline copy.'))
    } catch (error) {
      if (online && (error instanceof TypeError || (error as Error).name === 'TimeoutError')) {
        try {
          await queue()
          notify('Change saved on this device. Paper will retry.')
          return
        } catch (storageError) { error = storageError }
      }
      if (origin === 'automatic') manuallyUnreadId.current = entry.id
      setActionError({ id: entry.id, message: error instanceof Error ? error.message : 'Paper could not save the change', operation })
      const current = error instanceof ApiError ? error.states?.[entry.id] : undefined
      updateEntry(entry.id, current ? { read: current.read, starred: current.starred, stateRevision: current.revision } : { read: entry.read, starred: entry.starred })
      notify(error instanceof Error ? error.message : 'Paper could not save the change')
      return
    }
    if (!quiet && (status.backend !== 'standalone' || undoToken)) {
      const inverse = operation === 'read' ? 'unread' : operation === 'unread' ? 'read' : operation === 'star' ? 'unstar' : 'star'
      notify(operation === 'star' ? 'Starred' : operation === 'unstar' ? 'Star removed' : operation === 'read' ? 'Marked read' : 'Marked unread', {
        label: 'Undo',
        run: () => {
          if (!undoToken) { void setEntryState({ ...entry, ...patch, stateRevision: revision }, inverse, true, origin); return }
          void api.undo(undoToken).then(async () => {
            const current = await api.entry(entry.id)
            if (current.entry) {
              updateEntry(entry.id, current.entry)
              const { read, starred, stateRevision, modifiedAtMs } = current.entry
              await patchOffline(entry.id, { read, starred, stateRevision, modifiedAtMs })
            }
            await loadNavigation()
          }).catch(error => notify(error instanceof Error ? error.message : 'Could not undo this change'))
        },
      })
    }
    void loadNavigation().catch(() => notify('The change was saved. Counts will refresh shortly.'))
  }, [loadNavigation, notify, updateEntry, online, status.backend])

  const markTopicRead = useCallback(async (ids: string[], expectedRevisions?: Record<string, number>): Promise<boolean> => {
    if (!ids.length) return true
    const idSet = new Set(ids)
    const generation = readerGeneration.current
    const refreshAfterFailure = () => {
      setTopicsRefreshKey(current => current + 1)
      void loadNavigation().catch(() => {})
      if (generation === readerGeneration.current) void loadEntries(undefined, 'keep', 'replace-in-place')
    }
    try {
      const standalone = status.backend === 'standalone'
      const result = await api.editState(ids, 'read', 'pulse', { undo: true, expectedRevisions: standalone ? expectedRevisions : undefined })
      setEntries(current => current.map(entry => idSet.has(entry.id) ? { ...entry, read: true, stateRevision: result.revisions[entry.id] ?? entry.stateRevision } : entry))
      setTopicsRefreshKey(current => current + 1)
      void loadNavigation().catch(() => {})
      const { undoToken } = result
      notify(`${idSet.size.toLocaleString()} ${idSet.size === 1 ? 'article' : 'articles'} marked read`, standalone && !undoToken ? undefined : {
        label: 'Undo',
        run: () => void (async () => {
          try {
            if (undoToken) await api.undo(undoToken)
            else await api.editState(ids, 'unread', 'pulse')
            setEntries(current => current.map(entry => idSet.has(entry.id) ? { ...entry, read: false } : entry))
            setTopicsRefreshKey(current => current + 1)
            void loadNavigation().catch(() => {})
          } catch (error) {
            refreshAfterFailure()
            notify(error instanceof Error ? error.message : 'Paper could not restore the articles')
          }
        })(),
      })
      return true
    } catch (error) {
      refreshAfterFailure()
      notify(error instanceof Error ? error.message : 'Paper could not mark this coverage read')
      return false
    }
  }, [loadEntries, loadNavigation, notify, status.backend])

  const fetchFullText = useCallback(async (target: Entry | null = selected, quiet = false, force = false) => {
    if (!target?.url || target.kind !== 'article' || (target.fullText && !force) || fetchingFullTextId) return
    setFetchingFullTextId(target.id)
    setFullTextError(null)
    try {
      if (!target.fullText) feedVersions.current.set(target.id, target)
      const article = await api.fullText(target.url, force, target.id)
      const full = { ...target,
        contentHtml: article.contentHtml,
        excerpt: article.excerpt || target.excerpt,
        readingMinutes: article.readingMinutes,
        author: target.author || article.byline,
        fullText: true,
      }
      fullVersions.current.set(target.id, full)
      updateEntry(target.id, articleContent(full))
      if (!quiet) {
        const preference = recordFullTextSuccess(localStorage, target.feedId, target.id, readingPreferences.value(`learned:${target.feedId}`) === 'on')
        if (preference.becameEnabled) readingPreferences.set(`learned:${target.feedId}`, 'on')
        notify(preference.becameEnabled
          ? `Future ${target.feedTitle} articles will load in full automatically`
          : article.cached ? 'Full article loaded from cache' : 'Full article loaded')
      }

    } catch (error) {
      setFullTextError({ id: target.id, message: error instanceof Error ? error.message : 'Paper could not fetch the full article' })
    } finally {
      setFetchingFullTextId('')
    }
  }, [fetchingFullTextId, notify, readingPreferences, selected, updateEntry])

  useEffect(() => {
    if (!online || !selected || selected.fullText || selected.kind !== 'article' || mobilePane !== 'article' || !preferencesReady || fullMode === 'never' || (fullMode !== 'always' && !shouldAutomaticallyFetchFullArticle(selected, learnedFullText)) || automaticFullTextAttempts.current.has(selected.id)) return
    const timer = window.setTimeout(() => { automaticFullTextAttempts.current.add(selected.id); void fetchFullText(selected, true) }, 120)
    return () => window.clearTimeout(timer)
  }, [learnedFullText, preferencesReady, fetchFullText, mobilePane, selected, fullMode, online])

  useEffect(() => {
    if (view !== 'reader' || !autoRead || !selected || !shouldAutoMarkRead(selected, mobilePane, manuallyUnreadId.current)) return
    let timer: number | undefined
    const schedule = () => {
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        timer = window.setTimeout(() => void setEntryState(selected, 'read', true, 'automatic'), 1000)
      }
    }
    const cancel = () => window.clearTimeout(timer)
    schedule()
    document.addEventListener('visibilitychange', schedule)
    window.addEventListener('focus', schedule)
    window.addEventListener('blur', cancel)
    return () => {
      cancel()
      document.removeEventListener('visibilitychange', schedule)
      window.removeEventListener('focus', schedule)
      window.removeEventListener('blur', cancel)
    }
  }, [view, selected, mobilePane, setEntryState, autoRead, online])

  const move = useCallback((direction: 1 | -1): Promise<boolean> => articleNavigation.run(async signal => {
    if (pulseContext && selected) {
      const index = pulseContext.ids.indexOf(selected.id)
      const id = pulseContext.ids[index + direction]
      if (!id) return null
      const result = await api.entry(id)
      if (signal.aborted || !result.entry) return null
      return () => { setEntries(current => current.some(item => item.id === id) ? current : [...current, result.entry!]); openEntry(result.entry!) }
    }
    if (loading) return null
    const commitEntry = (entry: Entry) => {
      articleBoundaryStore.set(null)
      openEntry(entry)
    }
    const currentIndex = selected ? entries.findIndex(entry => entry.id === selected.id) : direction > 0 ? -1 : entries.length
    const next = entries[currentIndex + direction]
    if (next) return () => commitEntry(next)

    // Fetch without changing the current list. The navigation controller only
    // commits a result if the user is still here and the request has not expired.
    let cursor = direction > 0 ? continuation : previousContinuation
    const seen = new Set<string>()
    while (navigator.onLine && cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const result = await api.entries(query ? searchStream : stream, streamUnreadOnly, query, cursor, signal, query ? dates : {}, direction < 0)
      if (signal.aborted) return null
      const known = new Set(entries.map(entry => entry.id))
      const more = result.items.filter(entry => !known.has(entry.id))
      if (more[0]) return () => {
        setEntries(current => {
          const currentIds = new Set(current.map(entry => entry.id))
          const added = more.filter(entry => !currentIds.has(entry.id))
          return direction > 0 ? [...current, ...added] : [...added, ...current]
        })
        if (direction > 0) setContinuation(result.continuation)
        else setPreviousContinuation(result.previousContinuation || '')
        commitEntry(direction > 0 ? more[0] : more.at(-1)!)
      }
      cursor = direction > 0 ? result.continuation : result.previousContinuation || ''
    }
    if (libraryMode !== 'stream' || query || pulseContext || !['category', 'feed'].includes(stream.kind) || !navigation) return null
    const sources = stream.kind === 'category' ? navigation.folders : navigationFeeds(navigation)
    const sourceIndex = sources.findIndex(source => source.id === stream.id)
    if (sourceIndex < 0) return null
    const copies = navigator.onLine ? undefined : await offlineArticles()
    let candidateIndex = sourceIndex + direction
    while (candidateIndex >= 0 && candidateIndex < sources.length) {
      const source = sources[candidateIndex]
      if (!unreadOnly || source.unread > 0) {
        const target: StreamRef = { kind: stream.kind, id: source.id, title: source.title }
        const result = copies
          ? { items: copies.filter(entry => inOfflineStream(entry, target) && (!unreadOnly || !entry.read)), continuation: '', previousContinuation: '', order: 'newest' as const }
          : await api.entries(target, unreadOnly, '', '', signal, {}, direction < 0)
        if (signal.aborted) return null
        if (result.items.length) return () => {
          const destination = direction > 0 ? result.items[0] : result.items.at(-1)!
          // Invalidate old list requests and avoid fetching this folder twice.
          requestSerial.current += 1
          preparedStreamLoad.current = target
          loadedEntriesScope.current = JSON.stringify([libraryMode, target.kind, target.id, unreadOnly && target.kind !== 'starred', '', {}])
          pushLocation({ stream: target, selectedId: destination.id, query: '', mobilePane: 'article' })
          setStream(target)
          setEntries(result.items)
          setEntryOrder(result.order || 'newest')
          setContinuation(result.continuation)
          setPreviousContinuation(result.previousContinuation || '')
          setSelectedId(destination.id)
          setQuery('')
          setMobilePane('article')
          setLoading(false)
          setLoadingMore(false)
          articleBoundaryStore.set(null)
          requestAnimationFrame(() => articleRef.current?.focus())
        }
      }
      candidateIndex += direction
    }
    return null
  }, setArticleNavigationBusy, error => notify(error instanceof Error ? error.message : 'Paper could not open the next article')),
  [articleBoundaryStore, articleNavigation, continuation, previousContinuation, entries, navigation, notify, openEntry, pushLocation, query, selected, stream, unreadOnly, streamUnreadOnly, pulseContext, searchStream, dates, libraryMode, loading])

  const settleArticleBoundary = useCallback((direction: ArticleBoundaryDirection | null, smooth = true) => {
    const scroll = articleRef.current?.querySelector<HTMLElement>('.article-scroll')
    if (!scroll || !direction) return
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
    const top = direction === 'previous'
      ? Math.min(ARTICLE_BOUNDARY_ZONE_SIZE, maximum / 2)
      : Math.max(Math.min(ARTICLE_BOUNDARY_ZONE_SIZE, maximum / 2), maximum - ARTICLE_BOUNDARY_ZONE_SIZE)
    scroll.scrollTo({ top, behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' })
  }, [])

  const releaseArticleGesture = useCallback((cancelled = false) => {
    const boundary = articleBoundaryGesture.current
    articleBoundaryGesture.current = { direction: null, travel: 0, ready: false }
    articleBoundaryHaptic.current = false
    articleBoundaryStore.set(null)
    if (!cancelled && boundary.ready && boundary.direction) {
      // A smooth scroll must not continue into the destination article.
      settleArticleBoundary(boundary.direction, false)
      void move(boundary.direction === 'next' ? 1 : -1)
      return
    }
    settleArticleBoundary(boundary.direction)
  }, [articleBoundaryStore, move, settleArticleBoundary])

  const markAllRead = useCallback(async () => {
    if (libraryMode !== 'stream' || !online) { notify('Open a feed or search while connected to mark articles read.'); return }
    if (query || stream.kind === 'view') {
      const generation = readerGeneration.current
      const source = query ? searchStream : stream
      try {
        const preview = await api.previewRead(source, query, query ? dates.after : '', query ? dates.before : '')
        if (generation !== readerGeneration.current) return
        setBulkPreview({ ...preview, label: source.kind === 'view' ? source.title : `Search results in ${source.title}` })
      } catch (error) { notify(error instanceof Error ? error.message : 'Could not preview this action') }
      return
    }
    const generation = readerGeneration.current
    const known = new Map(entries.map(entry => [entry.id, entry.stateRevision]))
    try {
      const result = await api.markStreamRead(stream)
      const stillHere = generation === readerGeneration.current
      if (stillHere && streamUnreadOnly) {
        articleNavigation.cancel()
        requestSerial.current += 1
        setContinuation(''); setPreviousContinuation('')
        setLoadingMore(false)
        setLoading(false)
      }
      setEntries(current => current.flatMap(entry => {
        if (!known.has(entry.id) || known.get(entry.id) !== entry.stateRevision && !entry.read) return [entry]
        return stillHere && streamUnreadOnly ? [] : [{ ...entry, read: true }]
      }))
      if (stillHere) setSelectedId('')
      await loadNavigation()
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} entries read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            await Promise.all([loadNavigation(), generation === readerGeneration.current ? loadEntries(stream) : Promise.resolve()])
            notify('Mark all read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify('Nothing to mark read')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not mark this stream read')
    }
  }, [stream, streamUnreadOnly, loadNavigation, loadEntries, notify, query, searchStream, dates, libraryMode, online, articleNavigation, entries])

  const markFeedRead = useCallback(async (feed: Feed) => {
    const target: StreamRef = { kind: 'feed', id: feed.id, title: feed.title }
    const known = new Map(entries.filter(entry => entry.feedId === feed.id).map(entry => [entry.id, entry.stateRevision]))
    const generation = readerGeneration.current
    try {
      const result = await api.markStreamRead(target)
      const stillHere = generation === readerGeneration.current && currentReader.current.stream.kind === target.kind && currentReader.current.stream.id === target.id
      setEntries(current => current.flatMap(entry => {
        if (!known.has(entry.id) || known.get(entry.id) !== entry.stateRevision && !entry.read) return [entry]
        return stillHere && unreadOnly ? [] : [{ ...entry, read: true }]
      }))
      if (stillHere && unreadOnly) {
        articleNavigation.cancel()
        requestSerial.current += 1
        setContinuation(''); setPreviousContinuation(''); setLoadingMore(false); setLoading(false); setSelectedId('')
      }
      await loadNavigation()
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} ${feed.title} entries read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            await loadNavigation()
            if (generation === readerGeneration.current && currentReader.current.stream.kind === target.kind && currentReader.current.stream.id === target.id) await loadEntries(target)
            notify('Mark feed read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify('Nothing to mark read')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not mark this feed read')
    }
  }, [loadEntries, loadNavigation, notify, unreadOnly, entries, articleNavigation])

  const markFolderRead = useCallback(async (folder: Folder) => {
    const target: StreamRef = { kind: 'category', id: folder.id, title: folder.title }
    const known = new Map(entries.filter(entry => folder.feeds.some(feed => feed.id === entry.feedId)).map(entry => [entry.id, entry.stateRevision]))
    const generation = readerGeneration.current
    try {
      const result = await api.markStreamRead(target)
      const stillHere = generation === readerGeneration.current && currentReader.current.stream.kind === target.kind && currentReader.current.stream.id === target.id
      setEntries(current => current.flatMap(entry => {
        if (!known.has(entry.id) || known.get(entry.id) !== entry.stateRevision && !entry.read) return [entry]
        return stillHere && unreadOnly ? [] : [{ ...entry, read: true }]
      }))
      if (stillHere && unreadOnly) {
        articleNavigation.cancel()
        requestSerial.current += 1
        setContinuation(''); setPreviousContinuation(''); setLoadingMore(false); setLoading(false); setSelectedId('')
      }
      await loadNavigation()
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} ${folder.title} entries read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            await loadNavigation()
            if (generation === readerGeneration.current && currentReader.current.stream.kind === target.kind && currentReader.current.stream.id === target.id) await loadEntries(target)
            notify('Mark folder read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify('Nothing to mark read')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Paper could not mark this folder read')
    }
  }, [loadEntries, loadNavigation, notify, unreadOnly, entries, articleNavigation])

  const markRelativeRead = useCallback(async (entry: Entry, direction: 'above' | 'below') => {
    setEntryContext(null)
    if (libraryMode !== 'stream' || !online) { notify('Open a feed or search while connected to use relative read actions.'); return }
    let serial = requestSerial.current
    try {
      const displayed = currentReader.current.entries
      const anchor = displayed.find(item => item.id === entry.id)
      if (query && !anchor) throw new Error('The search results changed. Choose an article again.')
      if (query && displayed.length > MAX_DISPLAYED_SEARCH_IDS) throw new Error('Narrow the search before marking above or below.')
      const searchOptions = query ? { ...dates, snapshot: anchor?.searchSnapshot, displayedIds: displayed.map(item => item.id) } : undefined
      const result = await api.markRelativeRead(query ? searchStream : stream, entry.id, direction, streamUnreadOnly, query, entryOrder, searchOptions ?? { after: '', before: '' })
      const changed = new Set(result.ids)
      setEntries(current => current.map(item => changed.has(item.id) ? { ...item, read: true } : item))
      // Keep the list mounted, including on no-op actions, instead of replacing
      // it with skeleton rows and resetting its scroll position.
      if (result.count) {
        const stillHere = serial === requestSerial.current
        serial = stillHere ? serial + 1 : -1
        await Promise.all([loadNavigation(), stillHere ? loadEntries(stream, 'keep', 'replace-in-place') : Promise.resolve()])
      }
      if (result.count && result.undoToken) {
        notify(`Marked ${result.count} ${direction} read`, { label: 'Undo', run: () => {
          void api.undo(result.undoToken!).then(async () => {
            setEntries(current => current.map(item => changed.has(item.id) ? { ...item, read: false } : item))
            await Promise.all([loadNavigation(), serial === requestSerial.current ? loadEntries(stream, 'keep', 'replace-in-place') : Promise.resolve()])
            notify('Mark read undone')
          }).catch(error => notify(error instanceof Error ? error.message : 'Paper could not undo that change'))
        } })
      } else notify(`Nothing unread ${direction}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : `Paper could not mark articles ${direction} read`)
    }
  }, [entryOrder, loadEntries, loadNavigation, notify, query, stream, streamUnreadOnly, searchStream, dates, libraryMode, online])

  const destinations = useMemo<ReaderDestination[]>(() => [
    ...(status.readwiseConfigured ? [{ id: 'readwise' as const, name: 'Readwise Reader' }] : []),
    ...(status.saveDestinations ?? []),
  ], [status.readwiseConfigured, status.saveDestinations])

  const saveArticle = useCallback(async (entry: Entry, destination: ReaderDestination) => {
    if (saveBusy || !online || (destination.id === 'readwise' && entry.readwiseSavedAt)) return
    setChooseSaveFor(null)
    setSaveBusy(true)
    try {
      if (destination.id === 'readwise') {
        const result = await api.saveReadwise(entry.url, entry.title)
        updateEntry(entry.id, { readwiseSavedAt: result.savedAt })
      } else {
        const tags = uniqueFeeds(navigation).find(feed => feed.id === entry.feedId)?.categories ?? []
        const { note } = await api.saveArticle(destination.id, entry.url, entry.title, tags)
        if (note) return notify(`Saved to ${destination.name}. ${note}`)
      }
      notify(`Saved to ${destination.name}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : `Could not save to ${destination.name}`)
    } finally { setSaveBusy(false) }
  }, [saveBusy, online, navigation, updateEntry, notify])

  const startSave = useCallback(() => {
    if (!selected || saveBusy || !online) return
    if (!destinations.length) return notify('Enable a save destination in Settings > Reading & connections')
    if (destinations.length === 1) void saveArticle(selected, destinations[0])
    else setChooseSaveFor(selected)
  }, [selected, saveBusy, online, destinations, notify, saveArticle])
  const readwiseOnly = destinations.length === 1 && destinations[0].id === 'readwise'
  const savedToReadwise = readwiseOnly && Boolean(selected?.readwiseSavedAt)
  const saveLabel = savedToReadwise ? 'Saved to Readwise' : destinations.length === 1 ? `Save to ${readwiseOnly ? 'Readwise' : destinations[0].name}` : 'Save article'

  const createKirbyNote = useCallback(async (quote: string) => {
    if (!selected) return
    if (!status.kirbyConfigured) return notify('Enable Kirby notes in Settings > Reading & connections')
    setSelectionContext(null)
    const editor = window.open('about:blank', '_blank')
    if (editor) editor.opener = null
    try {
      const result = await api.createKirbyNote(selected.title, selected.url, quote)
      if (editor) {
        editor.location.replace(result.result.panelUrl)
        notify('Kirby note draft created')
      } else {
        notify('Kirby note draft created', { label: 'Open Kirby', run: () => window.open(result.result.panelUrl, '_blank', 'noopener') })
      }
      window.getSelection()?.removeAllRanges()
    } catch (error) {
      editor?.close()
      notify(error instanceof Error ? error.message : 'Paper could not create the Kirby note')
    }
  }, [notify, selected, status.kirbyConfigured])

  const commands = useMemo(() => [
    { label: 'Reload articles', hint: 'r', run: refresh },
    { label: unreadOnly ? 'Show all articles' : 'Show unread articles', hint: 'u', run: () => changeUnreadOnly(!unreadOnly) },
    { label: 'Mark this stream read', hint: 'Shift A', run: markAllRead },
    { label: 'Manage feeds', hint: '', run: () => { setSettingsSection('feeds'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Manage article rules', hint: '', run: () => { setSettingsSection('filters'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Article reports', hint: '', run: () => { setSettingsSection('reports'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Activity log', hint: '', run: () => { setSettingsSection('activity'); setOverlays({ ...closedOverlays, settings: true }) } },
    { label: 'Appearance', hint: 'Aa', run: () => setOverlays({ ...closedOverlays, appearance: true }) },
    { label: 'Settings', hint: ',', run: () => setOverlays({ ...closedOverlays, settings: true }) },
    { label: 'Keyboard shortcuts', hint: '?', run: () => setOverlays({ ...closedOverlays, help: 'shortcuts' }) },
  ], [changeUnreadOnly, refresh, unreadOnly, markAllRead])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (chooseSaveFor || discussionTarget || bulkPreview || reportEntry || selectionContext || entryContext) return
      const target = event.target instanceof Element ? event.target : document.body
      const typing = Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))
      if (event.defaultPrevented || target.closest('[role="dialog"],[role="menu"],[data-organization-handle],.enclosure-player')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOverlays({ ...closedOverlays, command: true })
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (typing || overlays.command || overlays.help || overlays.settings || overlays.appearance) return
      const key = event.key
      const direction = movementDirection(key)
      if (view === 'highlights' && (direction || key === 'Enter' || key === 'u' || key === 'Escape')) return
      if ((event.shiftKey && key.startsWith('Arrow')) || (key === 'Enter' && target.closest('a,button,summary'))) return
      if (direction) {
        event.preventDefault()
        void move(direction)
      } else if (key === 'Enter' && selected) {
        event.preventDefault()
        openEntry(selected)
      } else if (key === 'o' && selected?.url) {
        window.open(selected.url, '_blank', 'noopener')
      } else if (key === 'b' && selected?.url) {
        const opened = window.open(selected.url, '_blank', 'noopener')
        opened?.blur()
        window.focus()
      } else if (key === 'q') {
        event.preventDefault()
        if (!event.repeat) startSave()
      } else if (key === 'm' && selected) {
        void setEntryState(selected, selected.read ? 'unread' : 'read')
      } else if (key === 's' && selected) {
        void setEntryState(selected, selected.starred ? 'unstar' : 'star')
      } else if (key === 'A' && event.shiftKey) {
        event.preventDefault()
        void markAllRead()
      } else if (key === 'r') {
        event.preventDefault()
        void refresh()
      } else if (key === 'f' && selected?.kind === 'article') {
        event.preventDefault()
        void fetchFullText()
      } else if (key === 'Escape' || key === 'u') {
        closeEntry()
      } else if (key === '[') {
        setSidebarVisible(value => !value)
      } else if (key === ',') {
        setOverlays({ ...closedOverlays, settings: true })
      } else if (key === '?') {
        setOverlays({ ...closedOverlays, help: 'shortcuts' })
      } else if (key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, closeEntry, move, openEntry, overlays, selected, refresh, fetchFullText, markAllRead, chooseSaveFor, startSave, setEntryState, discussionTarget, bulkPreview, reportEntry, selectionContext, entryContext])

  function openSettings() {
    setSettingsFeedId('')
    setOverlays({ ...closedOverlays, settings: true })
  }

  const appClass = `app ${sidebarVisible ? '' : 'sidebar-hidden'} ${readerChromeHidden ? 'mobile-reader-chrome-hidden' : ''}`
  return (<>
    {!overlays.settings && <PreferenceNotice />}
    <div
      className={`${appClass}${discussionTarget ? ' discussion-open' : ''}`}
      data-mobile-pane={mobilePane}
      data-view={view}
      onPointerDownCapture={beginReaderChromeTap}
      onPointerMoveCapture={moveReaderChromeTap}
      onPointerUpCapture={finishReaderChromeTap}
      onPointerCancelCapture={() => { readerChromeTap.current = null }}
      onFocusCapture={() => { if (readerChromeHidden) revealReaderChrome() }}
      onKeyDownCapture={() => { if (readerChromeHidden) revealReaderChrome() }}
    >
      <header className="topbar">
        <button className="wordmark" onClick={() => openStream(allStream)} aria-label="Open all articles">
          <img className="brand-logo brand-logo-dark" src="/brand/paper-logo.svg" alt="" />
          <img className="brand-logo brand-logo-light" src="/brand/paper-logo-light.svg" alt="" />
        </button>
        <div className="search-box">
          <Icon name="search" />
          <input ref={searchRef} value={query} onChange={event => { setView('reader'); setLibraryMode(current => current === 'offline' || !online ? 'offline' : 'stream'); setPulseContext(null); setSelectedId(''); setMobilePane('stories'); setQuery(event.target.value) }} aria-label="Search articles" aria-describedby={searchHint ? 'search-hint' : undefined} placeholder="Search articles" />
          <kbd>/</kbd>
          <button aria-label="Search syntax" title="Search syntax" onClick={() => setOverlays({ ...closedOverlays, help: 'search' })}><Icon name="info" /></button>
        </div>
        <button className="command-button" onClick={() => setOverlays({ ...closedOverlays, command: true })}><span>Commands</span><kbd>Ctrl K</kbd></button>
      </header>

      <aside className="sidebar panel">
        <div className="sidebar-heading">
          <span>Library</span>
          {mobileLayout && <>
            <div className="source-filter"><ArticleFilter unreadOnly={unreadOnly} onChange={changeUnreadOnly} /></div>
            <button className="icon-button" aria-label="Settings" onClick={openSettings}><Icon name="settings" /></button>
          </>}
        </div>
        <nav
          className={`source-nav ${sourcePullDistance > 0 ? 'pulling pull-active' : ''} ${refreshing ? 'pull-active' : ''}`}
          aria-label="Feed sources"
          ref={sourceListRef}
          tabIndex={0}
          onTouchStart={beginSourcePull}
          onTouchMove={continueSourcePull}
          onTouchEnd={releaseSourcePull}
          onTouchCancel={releaseSourcePull}
          style={{ '--pull-distance': `${sourcePullDistance || (refreshing ? 44 : 0)}px` } as React.CSSProperties}
        >
          <div className={`pull-refresh-indicator ${shouldReleaseToRefresh(sourcePullDistance) ? 'ready' : ''} ${refreshing ? 'refreshing' : ''}`}><Icon name="back" /><span>{refreshing ? 'Refreshing' : shouldReleaseToRefresh(sourcePullDistance) ? 'Release to refresh' : 'Pull to refresh'}</span></div>
          <div className="source-nav-content">
          <SourceButton active={view === 'reader' && libraryMode === 'stream' && !query && stream.kind === 'all'} icon="feed" label="All articles" count={navigation?.unread || 0} onClick={() => openStream(allStream)} />
          <SourceButton active={view === 'reader' && libraryMode === 'stream' && !query && stream.kind === 'starred'} icon="star" label="Starred" count={navigation?.starred || 0} onClick={() => openStream(starredStream)} />
          <SourceButton active={view === 'reader' && libraryMode === 'recent'} icon="reader" label="Continue reading" count={0} onClick={() => openLibrary('recent')} />
          <SourceButton active={view === 'reader' && libraryMode === 'offline'} icon="feed" label="Offline articles" count={0} onClick={() => openLibrary('offline')} />
          <SourceButton active={view === 'briefings'} icon="reader" label="Briefings" count={0} onClick={() => openLibraryView('briefings')} />
          <SourceButton active={view === 'highlights'} icon="bookmark" label="Highlights" count={0} onClick={() => openLibraryView('highlights')} />
          <SourceButton active={view === 'pulse'} icon="topics" label="Pulse" count={0} onClick={openTopics} />
          <div className="nav-rule" />
          {mobileLayout && navigation && unreadOnly && navigation.unread === 0 && visibleFolders.length === 0 && visibleUncategorized.length === 0 && <div className="sources-empty">
            <p>All caught up</p>
            <button onClick={() => changeUnreadOnly(false)}>Show all feeds</button>
          </div>}
          <SavedViews downloadAction={viewDownloadAction} navigation={navigation} active={view === 'reader' && libraryMode === 'stream' && stream.kind === 'view' ? stream.id : ''} online={online} onOpen={openStream} onChanged={loadNavigation} initialQuery={currentSearchQuery(query, searchStream, searchUnread, dates.after, dates.before)} />
          <OrganizationSidebar snapshot={organization} navigation={navigation} active={!query ? stream : null} unreadOnly={unreadOnly} online={online} onSnapshot={applyOrganizationSnapshot} onOpen={openStream} onMarkFeed={feed => void markFeedRead(feed)} onMarkFolder={folder => void markFolderRead(folder)} onManage={manageFeed} onAddFeed={() => { setSettingsFeedId(''); setSettingsFeedView('discover'); setSettingsSection('feeds'); setOverlays({ ...closedOverlays, settings: true }) }} />
          </div>
        </nav>
        <footer className="sidebar-footer">
          <button onClick={openSettings}><Icon name="settings" /> Settings</button>
          <button onClick={() => setTheme(current => toggledTheme(current, systemDark))} aria-label={darkThemeActive ? 'Use light mode' : 'Use dark mode'} title={darkThemeActive ? 'Use light mode' : 'Use dark mode'}><Icon name={darkThemeActive ? 'sun' : 'moon'} /></button>
        </footer>
      </aside>

      {view === 'reader' ? <><section className="story-pane panel">
        <div className="story-toolbar">
          <button className="mobile-back icon-button" onClick={() => changeMobilePane('sources')} aria-label="Back to sources"><Icon name="back" /></button>
          <div className="stream-title"><h1>{query ? 'Search' : libraryMode === 'recent' ? 'Continue reading' : libraryMode === 'offline' ? 'Offline articles' : stream.title}</h1><span>{visibleStreamTotal === null ? entries.length : `${visibleStreamTotal} unread`}</span></div>
          <button className={`icon-button ${refreshing ? 'spinning' : ''}`} onClick={() => void refresh()} aria-label={status.backend === 'standalone' ? 'Reload articles' : 'Refresh'} title={status.backend === 'standalone' ? 'Reload articles Paper already has. Check feeds in Settings.' : `Import articles from ${status.backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'}`}><Icon name="refresh" /></button>
          <button className="icon-button" disabled={!online || libraryMode !== 'stream'} onClick={() => void markAllRead()} aria-label={query ? "Mark search results read" : "Mark stream read"}><Icon name="check" /></button>
        </div>
        <div className="reader-status" role="status">{!online ? 'Offline. Saved articles are available below.' : (navigationError || statusError || syncError) ? `Sync needs attention: ${navigationError || statusError || syncError}` : lastSync ? `Last synced ${relativeDate(lastSync)}` : status.backend === 'standalone' ? 'Ready to fetch feeds' : 'Waiting for synchronization'}{(navigationError || statusError || syncError) && online && <button onClick={() => void refresh()}>Retry</button>}</div>
        {query && online && libraryMode === 'stream' && <div className="search-controls">
          {searchHint && <span id="search-hint" role="status">{searchHint}</span>}
          {stream.kind === 'view' ? <span>Search in {stream.title}</span> : <label>Search in<select aria-label="Search scope" value={searchStream.id} onChange={event => {
            const id = event.target.value
            const folder = navigation?.folders.find(item => item.id === id)
            const feed = uniqueFeeds(navigation).find(item => item.id === id)
            setSearchStream(id === 'starred' ? starredStream : folder ? { kind: 'category', id, title: folder.title } : feed ? { kind: 'feed', id, title: feed.title } : allStream)
          }}><option value="all">All feeds</option><option value="starred">Starred</option>{navigation?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.title}</option>)}{uniqueFeeds(navigation).map(feed => <option key={feed.id} value={feed.id}>{feed.title}</option>)}</select></label>}
          <label>State<select value={searchUnread ? 'unread' : 'all'} onChange={event => setSearchUnread(event.target.value === 'unread')}><option value="all">Entire archive</option><option value="unread">Unread only</option></select></label>
          <label>From<input type="date" value={after} onChange={event => setAfter(event.target.value)} /></label><label>Through<input type="date" value={before} onChange={event => setBefore(event.target.value)} /></label>
          <button onClick={() => { setQuery(''); setAfter(''); setBefore('') }}>Clear search</button>
        </div>}
        <OfflineDownloads download={download}>
          {libraryMode === 'stream' && online && <>
            {stream.kind === 'view' && !query && viewDownloadAction(stream.id)}
            {(stream.kind === 'category' || query) && <button disabled={download.busy} onClick={() => void download.start(signal => downloadPages({
              stream: query ? searchStream : stream, query, unread: !!query && searchUnread, dates: query ? dates : {},
            }, signal))}>{query ? 'Download search results' : 'Download folder'}</button>}
            <button disabled={download.busy} onClick={() => setPicks(picks ? null : new Map())}>{picks ? 'End selection' : 'Select articles'}</button>
            {picks && <button disabled={!picks.size || download.busy} onClick={() => { void download.start(() => picks.values()); setPicks(null) }}>Download selected ({picks.size})</button>}
          </>}
          {libraryMode === 'offline' && <button disabled={download.busy} onClick={() => {
            if (window.confirm('Remove all offline articles and their saved images from this device?')) void clearOffline().then(() => { download.measure(); void loadEntries() }).catch(error => notify(error.message))
          }}>Clear offline copies</button>}
        </OfflineDownloads>
        {download.message && <div className="reader-status" role="status">{download.message} {download.busy && <button onClick={download.cancel}>Cancel download</button>}</div>}
        <div className="filter-row">
          {mobileLayout || starredView || libraryMode !== 'stream'
            ? <span className="story-filter-label">{libraryMode === 'stream' && streamUnreadOnly ? 'Unread' : 'All'}</span>
            : <ArticleFilter unreadOnly={query ? searchUnread : unreadOnly} onChange={query ? setSearchUnread : changeUnreadOnly} />}
          {!query && libraryMode === 'stream' && <select className="story-order" aria-label="Article order" title="Remember order for this feed or folder" value={entryOrder} disabled={loading || savingOrder} onChange={event => void changeEntryOrder(event.target.value as 'newest' | 'oldest')}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>}
          <span>{loading
            ? 'Loading'
            : entries.length
              ? visibleStreamTotal === null ? `${entries.length} loaded` : `${entries.filter(entry => !entry.read).length} of ${visibleStreamTotal} loaded`
              : 'No articles'}</span>
        </div>
        <div className={`story-list ${pullDistance > 0 ? 'pulling pull-active' : ''} ${refreshing ? 'pull-active' : ''}`} ref={listRef} tabIndex={0} aria-label="Articles" onTouchStart={beginStoryGesture} onTouchMove={continueStoryGesture} onTouchEnd={releaseStoryGesture} onTouchCancel={releaseStoryGesture} style={{ '--pull-distance': `${pullDistance || (refreshing ? 44 : 0)}px` } as React.CSSProperties}>
          <div className={`pull-refresh-indicator ${shouldReleaseToRefresh(pullDistance) ? 'ready' : ''} ${refreshing ? 'refreshing' : ''}`}><Icon name="back" /><span>{refreshing ? 'Refreshing' : shouldReleaseToRefresh(pullDistance) ? 'Release to refresh' : 'Pull to refresh'}</span></div>
          <div className="story-list-content">
            {loading && <StorySkeleton />}
            {!loading && entries.length > 0 && previousFolder && <div className="stream-boundary" ref={streamStartRef}>
              <span>Beginning</span>
            </div>}
            {!loading && entries.map(entry => <StoryRow
              key={entry.id}
              ref={element => {
                if (element) storyRowRefs.current.set(entry.id, element)
                else storyRowRefs.current.delete(entry.id)
              }}
              checked={picks ? picks.has(entry.id) : undefined}
              onCheck={() => setPicks(old => {
                const next = new Map(old)
                if (next.has(entry.id)) next.delete(entry.id)
                else next.set(entry.id, entry)
                return next
              })}
              entry={entry}
              active={entry.id === selectedId}
              onOpen={() => openEntry(entry)}
              onContext={(left, top) => openEntryContext(entry, left, top)}
            />)}
            {listError && <div className="list-error" role="alert"><p>{listError}</p><button onClick={() => void loadEntries()}>Try again</button></div>}
            {!listError && !loading && !entries.length && <EmptyList onAddFeed={status.backend === 'standalone' && navigation && !uniqueFeeds(navigation).length ? () => { setSettingsSection('feeds'); setOverlays({ ...closedOverlays, settings: true }) } : undefined} query={query} libraryMode={libraryMode} unreadOnly={streamUnreadOnly} onShowAll={() => changeUnreadOnly(false)} />}
            {!loading && <div className={`load-more-marker${!continuation && !listError ? ' stream-boundary' : ''}`} ref={loadMoreRef}>
              {loadingMore ? 'Loading more' : continuation || listError ? '' : <>
                <span>End</span>
              </>}
            </div>}
          </div>
        </div>
      </section>

      <main className="reader-pane panel">
        {selected ? <ArticleView
          ref={articleRef}
          active={view === 'reader' && mobilePane === 'article'}
          entry={selected}
          showPlayers={!refreshOffline || offlineMedia?.id === selected.id}
          feedIconUrl={feedIcons.get(selected.feedId) || ''}
          onBack={closeEntry}
          collectionTitle={pulseContext?.title || ''}
          actionError={actionError?.id === selected.id ? actionError.message : ''}
          onRetryAction={() => { if (actionError?.id === selected.id) void setEntryState(selected, actionError.operation) }}
          fullTextError={fullTextError?.id === selected.id ? fullTextError.message : ''}
          backLabel={pulseContext ? 'Back to collection' : 'Back to stories'}
          saveLabel={destinations.length ? saveLabel : ''}
          saveDisabled={!online || saveBusy || savedToReadwise}
          saveCaption={savedToReadwise ? 'Saved' : saveBusy ? 'Saving...' : readwiseOnly ? 'Readwise' : 'Save'}
          online={online}
          fullMode={fullMode}
          onFullMode={mode => { preferences.set(`fullText:${selected.feedId}`, mode); automaticFullTextAttempts.current.delete(selected.id) }}
          onFeedText={() => { const feed = feedVersions.current.get(selected.id); if (feed) { automaticFullTextAttempts.current.add(selected.id); updateEntry(selected.id, articleContent(feed)) } else void api.entry(selected.id).then(result => { if (result.entry) { automaticFullTextAttempts.current.add(selected.id); updateEntry(selected.id, articleContent(result.entry)) } }).catch(error => notify(error.message)) }}
          onRefreshText={() => void fetchFullText(selected, false, true)}
          onOffline={() => download.busy ? download.cancel() : void download.start(() => [selected], notify)}
          offlineBusy={download.busy}
          onRemoveOffline={libraryMode === 'offline' ? () => void removeOffline(selected.id).then(() => {
            download.measure()
            if (currentReader.current.libraryMode !== 'offline') return
            setSelectedId(current => current === selected.id ? '' : current)
            void loadEntries()
          }) : undefined}
          onPrevious={() => void move(-1)} onNext={() => void move(1)}
          onToggleRead={() => void setEntryState(selected, selected.read ? 'unread' : 'read')}
          onToggleStar={() => void setEntryState(selected, selected.starred ? 'unstar' : 'star')}
          onSendWebhook={status.manualWebhooks?.some(scope => (!scope.feedId || scope.feedId === selected.feedId) &&
            (!scope.folderId || navigation?.folders.find(folder => folder.id === scope.folderId)?.feeds.some(feed => feed.id === selected.feedId)))
            ? () => {
              setSaveBusy(true)
              void api.sendToWebhook(selected.id).then(({ count, message }) => notify([`Queued for ${count} delivery target${count === 1 ? '' : 's'}.`, message].filter(Boolean).join(' ')))
                .catch(error => notify(error.message)).finally(() => setSaveBusy(false))
            } : undefined}
          webhookBusy={saveBusy}
          onSave={startSave}
          onCopyUrl={() => void copyArticleUrl(selected)}
          onFullText={() => { const full = fullVersions.current.get(selected.id); if (full) updateEntry(selected.id, articleContent(full)); else void fetchFullText() }}
          onReport={() => setReportEntry(selected)}
          discussionConfigured={status.discussionConfigured}
          onKirby={status.kirbyConfigured ? createKirbyNote : undefined}
          notify={notify}
          onDiscuss={() => setDiscussionTarget({ entry: selected, quote: '' })}
          fullTextBusy={fetchingFullTextId === selected.id}
          onAppearance={() => setOverlays({ ...closedOverlays, appearance: true })}
          onScroll={handleArticleScroll}
          boundaryStore={articleBoundaryStore}
          navigationBusy={articleNavigationBusy}
          onTouchEnd={releaseArticleGesture}
          previousAvailable={previousArticleAvailable}
          nextAvailable={nextArticleAvailable}
          previousTitle={previousArticleTitle}
          nextTitle={nextArticleTitle}
          onSelectionContext={setSelectionContext}
          onTextSelected={revealReaderChrome}
        /> : <ReaderEmpty onCommand={() => setOverlays({ ...closedOverlays, command: true })} />}
      </main></> : view === 'highlights' ? <Highlights online={online} onBack={openSources} /> : view === 'briefings'
        ? <BriefingLibrary onBack={openSources} refreshKey={topicsRefreshKey} onOpenEntry={id => void openTopicEntry(id)} onMarkedRead={ids => {
          const changed = new Set(ids)
          setEntries(current => current.map(entry => changed.has(entry.id) ? { ...entry, read: true } : entry))
          setTopicsRefreshKey(current => current + 1)
          void loadNavigation().catch(() => notify('The source stories are read. Counts will refresh shortly.'))
        }} />
        : <TopicsLibrary initialCollection={linkedCollection} initialFilter={collectionFilter} discussionConfigured={status.discussionConfigured} onCollectionChange={collection => {
          if (collection) routeCollections.current = [...routeCollections.current.filter(item => item.id !== collection.id), collection]
          readerLinks.current.collections = routeCollections.current
          if (collection?.id === linkedCollection) return
          pushLocation({ view: 'pulse', selectedId: '', collection: collection?.id, collectionFilter: undefined })
          setLinkedCollection(collection?.id)
          setCollectionFilter(undefined)
        }} refreshKey={topicsRefreshKey} onBack={openSources} onOpenEntry={(id, context) => void openTopicEntry(id, context)} onMarkRead={markTopicRead} notify={notify} />}

      <MobileTabs boundaryStore={articleBoundaryStore}>
        <button className={view === 'reader' && mobilePane === 'sources' ? 'active' : ''} onClick={openSources}><Icon name="folder" /><span>Sources</span></button>
        <button className={view !== 'reader' || mobilePane === 'stories' ? 'active' : ''} onClick={() => view === 'briefings' || view === 'highlights' ? openLibraryView(view) : view === 'pulse' ? openTopics() : changeMobilePane('stories')}><Icon name={view === 'highlights' ? 'bookmark' : view === 'briefings' ? 'reader' : view === 'pulse' ? 'topics' : 'feed'} /><span>{view === 'highlights' ? 'Highlights' : view === 'briefings' ? 'Briefings' : view === 'pulse' ? 'Pulse' : 'Stories'}</span></button>
        <button className={mobilePane === 'article' ? 'active' : ''} disabled={!selected} onClick={() => selected && changeMobilePane('article')}><Icon name="bookmark" /><span>Reading</span></button>
      </MobileTabs>

      {chooseSaveFor && <Modal title="Save article to" onClose={() => setChooseSaveFor(null)}>
        <div className="command-list">{destinations.map(destination => <button key={destination.id} disabled={!online || (destination.id === 'readwise' && !!chooseSaveFor.readwiseSavedAt)}
          onClick={() => void saveArticle(chooseSaveFor, destination)}>{destination.name}</button>)}</div>
      </Modal>}
      {bulkPreview && <Modal title="Mark search results read" onClose={() => !bulkBusy && setBulkPreview(null)}><p>{bulkPreview.label}: {bulkPreview.count} unread articles will be marked read.</p><button disabled={bulkBusy || !bulkPreview.count} onClick={() => {
        const generation = readerGeneration.current
        setBulkBusy(true)
        void api.confirmRead(bulkPreview.token).then(async result => { setBulkPreview(null); await Promise.all([generation === readerGeneration.current ? loadEntries() : Promise.resolve(), loadNavigation()]); notify(`Marked ${result.count} articles read`, { label: 'Undo', run: () => void api.undo(result.undoToken).then(() => Promise.all([generation === readerGeneration.current ? loadEntries() : Promise.resolve(), loadNavigation()])).catch(error => notify(error.message)) }) }).catch(error => notify(error.message)).finally(() => setBulkBusy(false))
      }}>{bulkBusy ? 'Marking read...' : `Mark ${bulkPreview.count} read`}</button><button disabled={bulkBusy} onClick={() => setBulkPreview(null)}>Cancel</button></Modal>}
      {overlays.command && <CommandPalette commands={commands} onClose={() => setOverlays(closedOverlays)} />}
      {overlays.help === 'search' && <Modal title="Search syntax" onClose={() => setOverlays(closedOverlays)}>
        <p>Words match prefixes. Use quotes for a phrase, like <code>"night sky"</code>.</p>
        <p>Use <code>OR</code> for alternatives and <code>-</code> or <code>NOT</code> to exclude. Try <code>(moon OR mars) -landing</code>.</p>
        <p>Limit a search with <code>title:</code>, <code>author:</code>, <code>feed:</code>, <code>folder:</code> or <code>url:</code>. For example, <code>url:"example.org/wiki/Paper_(reader)"</code> matches that URL fragment. Filter by <code>is:read</code>, <code>is:unread</code> or <code>is:starred</code>. Use <code>minminutes:</code> and <code>maxminutes:</code> for reading time.</p>
        <p>Use <code>after:</code> or <code>before:</code> with a date like <code>2026-01-31</code> or a period like <code>7d</code>, <code>2w</code>, <code>3m</code> or <code>1y</code>.</p>
      </Modal>}
      {overlays.help === 'shortcuts' && <ShortcutHelp onSearchHelp={() => setOverlays({ ...closedOverlays, help: 'search' })} onClose={() => setOverlays(closedOverlays)} />}
      {entryContext && <EntryContextMenu key={entryContext.entry.id} state={entryContext} unsubscribeAvailable={Boolean(organization?.capabilities.unsubscribe && uniqueFeeds(navigation).some(feed => feed.id === entryContext.entry.feedId))} relativeAvailable={libraryMode === 'stream' && online} onClose={() => setEntryContext(null)} onOpen={() => { setEntryContext(null); openEntry(entryContext.entry) }} onCopyUrl={() => { void copyArticleUrl(entryContext.entry); setEntryContext(null) }} onToggleRead={() => { const entry = entryContext.entry; setEntryContext(null); void setEntryState(entry, entry.read ? 'unread' : 'read') }} onToggleStar={() => { const entry = entryContext.entry; setEntryContext(null); void setEntryState(entry, entry.starred ? 'unstar' : 'star') }} onReport={() => { setReportEntry(entryContext.entry); setEntryContext(null) }} onMarkAbove={() => void markRelativeRead(entryContext.entry, 'above')} onMarkBelow={() => void markRelativeRead(entryContext.entry, 'below')} onUnsubscribe={() => void unsubscribeFeed({ id: entryContext.entry.feedId, title: entryContext.entry.feedTitle })} />}
      {online && selectionContext && selectionContext.entryId === selectedId && (selectionContext.save || status.kirbyConfigured || status.discussionConfigured) && <SelectionContextMenu state={selectionContext} kirbyConfigured={status.kirbyConfigured} discussionConfigured={status.discussionConfigured} onClose={() => setSelectionContext(null)} onCreate={() => void createKirbyNote(selectionContext.quote)} onDiscuss={() => { if (!status.discussionConfigured) return notify('Article discussion is not configured'); if (selected) setDiscussionTarget({ entry: selected, quote: selectionContext.quote }); setSelectionContext(null) }} />}
      {discussionTarget && <ArticleDiscussion key={discussionTarget.entry.id} entry={discussionTarget.entry} initialQuote={discussionTarget.quote} onClose={() => setDiscussionTarget(null)} />}
      {overlays.settings && <Settings backend={status.backend} section={settingsSection} setSection={setSettingsSection} initialFeedId={settingsFeedId} initialFeedView={settingsFeedView} navigation={navigation} onChanged={loadNavigation} onFiltersChanged={reloadFilteredLibrary} onFiltersMatching={setFiltersMatching} notify={notify} onConnectionsChanged={loadStatus} onOpenEntry={id => { setOverlays(closedOverlays); void openTopicEntry(id) }} onClose={() => { setOverlays(closedOverlays); setSettingsFeedView('manage') }} />}
      {overlays.appearance && <AppearancePopover theme={theme} setTheme={setTheme} readerFont={readerFont} setReaderFont={value => preferences.set('font', value)} readerSize={readerSize} setReaderSize={setReaderSize} readerSpacing={readerSpacing} setReaderSpacing={value => preferences.set('spacing', value)} readerWidth={readerWidth} setReaderWidth={value => preferences.set('width', value)} onClose={() => setOverlays(closedOverlays)} />}
      {reportEntry && <ReportProblemModal entry={reportEntry} onClose={() => setReportEntry(null)} onSaved={() => { setReportEntry(null); notify('Problem reported') }} />}
      {toast && <div className="toast" role="status"><span>{toast.message}</span>{toast.action && <button onClick={() => { toast.action?.(); setToast(null) }}>{toast.actionLabel}</button>}</div>}
    </div>
  </>)
}

function SourceButton({ active, icon, label, count, onClick }: { active: boolean; icon: 'feed' | 'star' | 'reader' | 'topics' | 'bookmark'; label: string; count: number; onClick: () => void }) {
  return <button className={`source-row ${active ? 'active' : ''}`} onClick={onClick}><Icon name={icon} /><span className="source-label">{label}</span>{count > 0 && <span className="source-count">{count}</span>}</button>
}

function ArticleFilter({ unreadOnly, onChange }: { unreadOnly: boolean; onChange: (unread: boolean) => void }) {
  return <div className="segmented" role="group" aria-label="Article filter">
    <button className={unreadOnly ? 'active' : ''} aria-pressed={unreadOnly} onClick={() => onChange(true)}>Unread</button>
    <button className={!unreadOnly ? 'active' : ''} aria-pressed={!unreadOnly} onClick={() => onChange(false)}>All</button>
  </div>
}

function EntryContextMenu({ state, unsubscribeAvailable, relativeAvailable, onClose, onOpen, onCopyUrl, onToggleRead, onToggleStar, onReport, onMarkAbove, onMarkBelow, onUnsubscribe }: {
  unsubscribeAvailable: boolean
  state: EntryContextState
  relativeAvailable: boolean
  onClose: () => void
  onOpen: () => void
  onCopyUrl: () => void
  onToggleRead: () => void
  onToggleStar: () => void
  onReport: () => void
  onMarkAbove: () => void
  onMarkBelow: () => void
  onUnsubscribe: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useMenuFocus(ref)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    const closePointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const closeKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const closeScroll = () => onClose()
    window.addEventListener('pointerdown', closePointer)
    window.addEventListener('keydown', closeKey)
    window.addEventListener('resize', closeScroll)
    window.addEventListener('scroll', closeScroll, true)
    return () => {
      window.removeEventListener('pointerdown', closePointer)
      window.removeEventListener('keydown', closeKey)
      window.removeEventListener('resize', closeScroll)
      window.removeEventListener('scroll', closeScroll, true)
    }
  }, [onClose])

  return <div ref={ref} className="feed-context-menu entry-context-menu" role="menu" aria-label={`${state.entry.title} options`} style={{ left: state.left, top: state.top }}>
    <strong>{state.entry.title}</strong>
    <button role="menuitem" onClick={onOpen}><Icon name="reader" /> Open article</button>
    <button role="menuitem" onClick={onCopyUrl}><Icon name="copy" /> Copy article URL</button>
    <button role="menuitem" onClick={onToggleRead}><Icon name={state.entry.read ? 'archive' : 'check'} /> {state.entry.read ? 'Mark unread' : 'Mark read'}</button>
    <button role="menuitem" onClick={onToggleStar}><Icon name="star" className={state.entry.starred ? 'filled' : ''} /> {state.entry.starred ? 'Remove star' : 'Star article'}</button>
    <button role="menuitem" onClick={onReport}><Icon name="report" /> Report a problem</button>
    <span className="context-menu-rule" />
    <button role="menuitem" disabled={!relativeAvailable} onClick={onMarkAbove}><Icon name="check" /> Mark all above read</button>
    <button role="menuitem" disabled={!relativeAvailable} onClick={onMarkBelow}><Icon name="check" /> Mark all below read</button>
    <span className="context-menu-rule" />
    <button role="menuitem" className={`danger entry-unsubscribe ${confirmRemove ? 'confirming' : ''}`} disabled={!unsubscribeAvailable} onClick={() => confirmRemove ? onUnsubscribe() : setConfirmRemove(true)}>
      <Icon name="close" /><span>{confirmRemove ? 'Confirm unsubscribe' : 'Unsubscribe from feed'}<small title={state.entry.feedTitle}>{state.entry.feedTitle}</small></span>
    </button>
  </div>
}

function SelectionContextMenu({ state, onClose, onCreate, onDiscuss, kirbyConfigured, discussionConfigured }: {
  kirbyConfigured: boolean
  discussionConfigured: boolean
  state: SelectionContextState
  onClose: () => void
  onCreate: () => void
  onDiscuss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useMenuFocus(ref)

  useEffect(() => {
    const closePointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const closeKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const closeScroll = () => onClose()
    window.addEventListener('pointerdown', closePointer)
    window.addEventListener('keydown', closeKey)
    window.addEventListener('resize', closeScroll)
    window.addEventListener('scroll', closeScroll, true)
    return () => {
      window.removeEventListener('pointerdown', closePointer)
      window.removeEventListener('keydown', closeKey)
      window.removeEventListener('resize', closeScroll)
      window.removeEventListener('scroll', closeScroll, true)
    }
  }, [onClose])

  return <div ref={ref} className="feed-context-menu selection-context-menu" role="menu" aria-label="Selected text options" style={{ left: state.left, top: state.top }}>
    {state.save && <button role="menuitem" onClick={() => { onClose(); state.save?.() }}><Icon name="bookmark" /> Save highlight</button>}
    {discussionConfigured && <button role="menuitem" onClick={onDiscuss}><Icon name="reader" /> Ask about this</button>}
    {kirbyConfigured && <button role="menuitem" onClick={onCreate}><Icon name="plus" /> Create note in Kirby</button>}
  </div>
}

const StoryRow = forwardRef<HTMLElement, { checked?: boolean; onCheck?: () => void; entry: Entry; active: boolean; onOpen: () => void; onContext: (left: number, top: number) => void }>(function StoryRow({ checked, onCheck, entry, active, onOpen, onContext }, ref) {
  const thumbnail = articleImageSource(entry)
  const [thumbnailReady, setThumbnailReady] = useState(false)
  const pressTimer = useRef<number | undefined>(undefined)
  const pressOrigin = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)

  const cancelPress = () => {
    window.clearTimeout(pressTimer.current)
    pressTimer.current = undefined
  }

  useEffect(() => cancelPress, [])
  useEffect(() => {
    setThumbnailReady(false)
    if (!thumbnail) return
    let cancelled = false
    const image = new Image()
    image.onload = () => { if (!cancelled) setThumbnailReady(true) }
    image.onerror = () => { if (!cancelled) setThumbnailReady(false) }
    image.src = thumbnail
    return () => { cancelled = true }
  }, [thumbnail])
  const showThumbnail = Boolean(thumbnail && thumbnailReady)
  return <article
    ref={ref}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
    className={`story-row kind-${entry.kind} ${showThumbnail ? '' : 'no-thumbnail'} ${active ? 'active' : ''} ${entry.read ? 'read' : ''}`}
    onPointerDown={event => {
      if (event.pointerType === 'mouse') return
      cancelPress()
      suppressClick.current = false
      const { clientX, clientY } = event
      pressOrigin.current = { x: clientX, y: clientY }
      pressTimer.current = window.setTimeout(() => {
        suppressClick.current = true
        navigator.vibrate?.(12)
        onContext(clientX, clientY)
      }, 450)
    }}
    onPointerMove={event => {
      if (Math.hypot(event.clientX - pressOrigin.current.x, event.clientY - pressOrigin.current.y) > 8) cancelPress()
    }}
    onPointerUp={cancelPress}
    onPointerCancel={cancelPress}
    onContextMenu={event => {
      event.preventDefault()
      event.stopPropagation()
      cancelPress()
      onContext(event.clientX, event.clientY)
    }}
    onClick={event => {
      if (suppressClick.current) {
        event.preventDefault()
        event.stopPropagation()
        suppressClick.current = false
        return
      }
      onOpen()
    }}
  >
    {checked !== undefined && <input className="download-check" type="checkbox" checked={checked} aria-label={`Select ${entry.title}`} onClick={event => event.stopPropagation()} onChange={onCheck} />}
    <button className="story-open" aria-label={entry.displayTitle || entry.title} title={entry.displayTitle ? `Original: ${entry.title}` : undefined} />
    {showThumbnail && <img className="story-thumb" src={thumbnail} alt="" onError={() => setThumbnailReady(false)} />}
    <button className="row-options" aria-label={`Options for ${entry.title}`} onClick={event => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); onContext(box.left, box.bottom) }}>⋯</button>
    <div className="story-copy">
      <div className="story-source"><span>{entry.feedTitle}</span><time>{relativeTime(entry.timestamp)}</time></div>
      <h2 title={entry.displayTitle ? `Original: ${entry.title}` : undefined}>{entry.displayTitle || entry.title}</h2>
      {(entry.searchExcerpt || entry.excerpt) && <p>{entry.searchExcerpt || entry.excerpt}</p>}
      <div className="story-meta"><span>{entry.readingMinutes} min</span>{entry.offline && <span>{entry.fullText ? 'Full text' : 'Feed text'} · {entry.offline.cached}/{entry.offline.images} images cached{entry.offline.skippedForStorage ? ` · ${entry.offline.skippedForStorage} skipped for storage` : ''}{entry.offline.unverified ? ` (${entry.offline.unverified} unverified)` : ''}</span>}{entry.readingPosition !== undefined && <span>{Math.round(entry.readingPosition * 100)}% read</span>}{entry.readwiseSavedAt && <span>Readwise</span>}{entry.starred && <Icon name="star" className="filled" />}</div>
    </div>
  </article>
})

function MobileTabs({ boundaryStore, children }: { boundaryStore: ArticleBoundaryStore; children: React.ReactNode }) {
  const nextEdgeActive = useSyncExternalStore(boundaryStore.subscribe, () => boundaryStore.getSnapshot()?.direction === 'next')
  return <nav className={`mobile-tabs${nextEdgeActive ? ' next-edge-active' : ''}`} aria-label="Mobile navigation">{children}</nav>
}

const ArticleView = forwardRef<HTMLElement, {
  active: boolean
  entry: Entry
  feedIconUrl: string
  showPlayers: boolean
  onBack: () => void
  backLabel: string
  collectionTitle: string
  actionError: string
  onRetryAction: () => void
  fullTextError: string
  onSendWebhook?: () => void
  webhookBusy: boolean
  saveLabel: string
  saveCaption: string
  saveDisabled: boolean
  online: boolean
  fullMode: FullTextMode
  onFullMode: (mode: FullTextMode) => void
  onFeedText: () => void
  onRefreshText: () => void
  onOffline: () => void
  offlineBusy: boolean
  onRemoveOffline?: () => void
  onPrevious: () => void
  onNext: () => void
  onToggleRead: () => void
  onToggleStar: () => void
  onSave: () => void
  onCopyUrl: () => void
  onFullText: () => void
  onReport: () => void
  onDiscuss: () => void
  discussionConfigured: boolean
  onKirby?: (quote: string) => void
  notify: (message: string) => void
  fullTextBusy: boolean
  onAppearance: () => void
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void
  boundaryStore: ArticleBoundaryStore
  navigationBusy: boolean
  onTouchEnd: (cancelled?: boolean) => void
  previousAvailable: boolean
  nextAvailable: boolean
  previousTitle: string
  nextTitle: string
  onTextSelected: () => void
  onSelectionContext: (state: SelectionContextState | null) => void
}>(function ArticleView({ active, entry, feedIconUrl, showPlayers, onBack, backLabel, collectionTitle, actionError, onRetryAction, fullTextError, onSendWebhook, webhookBusy, saveLabel, saveCaption, saveDisabled, online, fullMode, onFullMode, onFeedText, onRefreshText, onOffline, offlineBusy, onRemoveOffline, onPrevious, onNext, onToggleRead, onToggleStar, onSave, onCopyUrl, onFullText, onReport, onDiscuss, discussionConfigured, onKirby, notify, fullTextBusy, onAppearance, onScroll, boundaryStore, navigationBusy, onTouchEnd, previousAvailable, nextAvailable, previousTitle, nextTitle, onSelectionContext, onTextSelected }, ref) {
  const content = useRef<HTMLDivElement>(null)
  const annotations = useAnnotations(online, entry.id)
  const body = entry.fullText ? 'full' : 'feed'
  const found = usePassageRanges(content, annotations.items, body, entry.contentHtml)
  const [notesFor, setNotesFor] = useState('')
  const chrome = useRef<HTMLDivElement>(null)
  const [hasSelection, setHasSelection] = useState(false)
  useLayoutEffect(() => {
    const scroll = content.current
    const controls = chrome.current
    if (!scroll || !controls) return
    // Set the inset before the parent's reading-position restore. Transforms
    // leave this height intact when the controls hide.
    const measure = () => {
      const height = controls.offsetHeight
      if (height) scroll.style.setProperty('--reader-controls-height', `${height}px`)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(controls)
    return () => observer?.disconnect()
  }, [active, entry.id, collectionTitle, online, actionError, fullTextError, hasSelection])
  useEffect(() => {
    const update = () => {
      const root = onKirby || discussionConfigured ? content.current : content.current?.querySelector<HTMLElement>('.article-content')
      const selected = Boolean(root && selectedTextWithin(root))
      setHasSelection(selected)
      if (selected) onTextSelected()
    }
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [discussionConfigured, onKirby, onTextSelected])
  const articleBody = () => content.current?.querySelector<HTMLElement>('.article-content')
  const selectedPassage = (left: number, top: number) => {
    const quote = content.current && selectedTextWithin(content.current)
    if (!quote || !online) return false
    const root = articleBody()
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const projection = root && range && root.contains(range.commonAncestorContainer) ? passageText(root) : null
    const position = projection && range && projection.selection(range)
    const anchor = position && projection ? anchorPassage(projection.text, position, body) : null
    if (!anchor && !onKirby && !discussionConfigured) return false
    onSelectionContext({
      entryId: entry.id, quote, left: Math.max(8, Math.min(left, window.innerWidth - 232)),
      top: Math.max(8, Math.min(top, window.innerHeight - 164)),
      save: anchor ? () => {
        void api.addAnnotation({ entryId: entry.id, anchor }).then(() => {
          annotations.refresh()
          notify('Highlight saved')
        }).catch(error => notify(error.message))
      } : undefined,
    })
    return true
  }
  const openSelectionContext = (event: React.MouseEvent<HTMLDivElement>) => {
    if (selectedPassage(event.clientX, event.clientY)) { event.preventDefault(); event.stopPropagation() }
  }
  return <article className={`article-view kind-${entry.kind}`} tabIndex={-1} ref={ref} onKeyDown={event => {
    if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && selectedPassage(24, 160)) event.preventDefault()
  }}>
    {notesFor === entry.id && <ArticleNotes online={online} key={entry.id} entryId={entry.id} {...annotations} found={found} onKirby={onKirby}
      passage={() => { const root = articleBody(); return { body, text: root ? passageText(root).text : '' } }} onClose={() => setNotesFor('')} />}
    <div ref={chrome} className="reader-chrome">
      <div className="reader-toolbar">
        <button className="reader-back-button" onClick={onBack} aria-label={backLabel} title={backLabel}><Icon name="back" /></button>
        <div className="reader-actions">
          <button className={entry.starred ? 'active' : ''} onClick={onToggleStar} aria-label={entry.starred ? 'Remove star' : 'Star article'} title={entry.starred ? 'Remove star' : 'Star article'}><Icon name="star" className={entry.starred ? 'filled' : ''} /><span>{entry.starred ? 'Starred' : 'Star'}</span></button>
          <button onClick={onToggleRead} aria-label={entry.read ? 'Mark unread' : 'Mark read'} title={entry.read ? 'Mark unread' : 'Mark read'}><Icon name={entry.read ? 'archive' : 'check'} /><span>{entry.read ? 'Mark unread' : 'Mark read'}</span></button>
          {saveLabel && <button onClick={onSave} disabled={saveDisabled} aria-label={saveLabel} title={saveLabel}><Icon name="bookmark" /><span>{saveCaption}</span></button>}
          {entry.kind === 'article' && <button className={entry.fullText ? 'active' : ''} onClick={onFullText} disabled={fullTextBusy || !online} aria-label={fullTextBusy ? 'Fetching full article' : entry.fullText ? 'Showing full article' : 'Fetch full article'} title={entry.fullText ? 'Showing full article' : 'Fetch full article'}><Icon name="reader" /><span>{fullTextBusy ? 'Fetching...' : entry.fullText ? 'Full text' : 'Full article'}</span></button>}
          <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label="Open original" title="Open original"><Icon name="external" /><span>Original</span></a>
          <button onClick={onCopyUrl} aria-label="Copy article URL" title="Copy article URL"><Icon name="copy" /><span>Copy URL</span></button>
          <button onClick={onReport} aria-label="Report a problem" title="Report a problem"><Icon name="report" /><span>Report</span></button>
          {discussionConfigured && <button disabled={!online} onClick={onDiscuss} aria-label="Discuss article" title="Discuss article"><Icon name="discussion" /><span>Discuss</span></button>}
        </div>
        <button className="type-button" onClick={onAppearance} aria-label="Appearance">Aa</button>
      </div>
      {!online && <div className="offline-banner" role="status">Offline. Changes stay on this device until Paper reconnects.</div>}
      {actionError && <div className="article-error" role="alert">{actionError} <button disabled={!online} onClick={onRetryAction}>Retry change</button></div>}
      {fullTextError && <div className="article-error" role="alert">{fullTextError} <button disabled={fullTextBusy || !online} onClick={onRefreshText}>Retry full article</button></div>}
      <div className="article-options">
        {collectionTitle && <button className="collection-return" title="Back to collection" onClick={onBack}>{collectionTitle}</button>}
        <button disabled={!previousAvailable || navigationBusy} onClick={onPrevious}>Previous</button><button disabled={!nextAvailable || navigationBusy} onClick={onNext}>Next</button>
        <details><summary>Article options</summary><div className="article-options-menu">
          {entry.kind === 'article' && <><button disabled={!entry.fullText || !online} onClick={onFeedText}>Show feed version</button><button disabled={fullTextBusy || !online} onClick={onRefreshText}>Refresh full article</button><label>Full text for this feed<select value={fullMode} onChange={event => onFullMode(event.target.value as FullTextMode)}><option value="auto">Auto</option><option value="always">Always</option><option value="never">Never automatically</option></select></label></>}
          {saveLabel && <button disabled={saveDisabled} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onSave() }}>{saveLabel}</button>}
          <button disabled={!online} onClick={event => {
            const details = event.currentTarget.closest('details')
            if (details) { details.open = false; details.querySelector('summary')?.focus() }
            annotations.refresh()
            setNotesFor(entry.id)
          }}>Article notes</button>
          {onSendWebhook && <button disabled={!online || webhookBusy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onSendWebhook() }}>Send to webhook</button>}
          <button onClick={onOffline}>{offlineBusy ? 'Cancel download' : 'Save offline'}</button>
          {onRemoveOffline && <button onClick={async () => {
            let needsConfirmation = true
            if (online && navigator.onLine) {
              try { needsConfirmation = (await api.annotationPage({ entryId: entry.id, limit: 1 })).items.length > 0 }
              catch { /* Confirm when the server cannot verify the article. */ }
            }
            if ((!needsConfirmation && navigator.onLine) || window.confirm('Remove this offline copy? Any highlights and notes stay on the server.')) onRemoveOffline()
          }}>Remove offline copy</button>}
        </div></details>
        {online && hasSelection && <button onPointerDown={event => event.preventDefault()} onClick={() => selectedPassage(24, 160)}>Use selected text</button>}
      </div>
    </div>
    {navigationBusy && <div className="article-navigation-status" role="status">Loading article...</div>}
    <div ref={content} className="article-scroll" onScroll={onScroll} onTouchEndCapture={() => onTouchEnd(Boolean(content.current && selectedTextWithin(content.current)))} onTouchCancelCapture={() => onTouchEnd(true)} onContextMenu={openSelectionContext}>
      <ArticleEdgeZone direction="previous" title={previousTitle} available={previousAvailable} store={boundaryStore} />
      <div key={entry.id} className="article-document">
        <ArticleDocument entry={entry} feedIconUrl={feedIconUrl} showPlayers={showPlayers} />
      </div>
      <ArticleEdgeZone direction="next" title={nextTitle} available={nextAvailable} store={boundaryStore} />
    </div>
  </article>
})

function ArticleEdgeZone({ direction, title, available, store }: {
  direction: ArticleBoundaryDirection
  title: string
  available: boolean
  store: ArticleBoundaryStore
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const active = state?.direction === direction
  const progress = active ? state.progress : 0
  return <div
    className={`article-edge-zone ${direction} ${active ? 'active' : ''} ${active && state?.ready ? 'ready' : ''} ${available ? '' : 'unavailable'}`}
    style={{ '--edge-progress': progress } as React.CSSProperties}
    aria-hidden="true"
  >
    <Icon name="back" />
    <span><small>{available ? active && state?.ready ? 'Release to open' : direction === 'next' ? 'Next article' : 'Previous article' : direction === 'next' ? 'End' : 'Beginning'}</small><strong>{title}</strong></span>
  </div>
}

function selectedTextWithin(root: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return ''
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return ''
  return selection.toString().replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
}

function ArticleDocument({ entry, feedIconUrl, showPlayers }: { entry: Entry; feedIconUrl: string; showPlayers: boolean }) {
  const { contentHtml, kind, url, enclosures, thumbnailUrl } = entry
  const { html, posters } = useMemo(() => prepareArticleMedia({ contentHtml, kind, url, enclosures, thumbnailUrl }),
    [contentHtml, kind, url, enclosures, thumbnailUrl])
  const players = showPlayers && <EnclosurePlayers entry={entry} posters={posters} />
  if (kind !== 'article') return <SocialArticle entry={entry} feedIconUrl={feedIconUrl} html={html}>{players}</SocialArticle>
  return <div className="article-column">
    <ArticleHeader entry={entry} feedIconUrl={feedIconUrl} />
    {players}
    {!(showPlayers && [...posters.values()].includes(thumbnailUrl)) && <ArticleLeadImage entry={entry} />}
    <ArticleBody html={html} />
  </div>
}

function ArticleLeadImage({ entry }: { entry: Entry }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [entry.id, entry.thumbnailUrl])
  if (failed || !articleImageSource(entry) || !shouldShowArticleLeadImage(entry.thumbnailUrl, entry.contentHtml)) return null
  return <figure className="article-lead-image"><img src={articleImageSource(entry)} alt="" onError={() => setFailed(true)} /></figure>
}

function SocialArticle({ entry, feedIconUrl, html, children }: { entry: Entry; feedIconUrl: string; html: string; children: React.ReactNode }) {
  const [thread, setThread] = useState<XThreadPost[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setThread(null)
    if (entry.kind !== 'x') return () => { cancelled = true }
    void api.xThread(entry.url)
      .then(result => {
        if (!cancelled && result.posts.length > 0) setThread(result.posts)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [entry.id, entry.kind, entry.url])
  const videoId = entry.kind === 'youtube' ? youtubeVideoId(entry.url) : ''
  const identity = socialIdentity(entry)
  if (entry.kind === 'x') return <div className="social-column">
    <p className="social-network">X post</p>
    <div className={`x-conversation ${thread?.length ? 'has-thread' : ''}`}>
      <article className="x-root-post">
        <div className="social-author"><FeedMark title={identity.name} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} /><div><strong>{identity.name}</strong>{identity.meta && <span>{identity.meta}</span>}</div></div>
        {children}
        <ArticleBody html={html} className="social-content" />
        <a className="social-original" href={entry.url} target="_blank" rel="noopener noreferrer">View original <Icon name="external" /></a>
      </article>
      {thread && thread.length > 0 && <section className="x-thread" aria-label={`Thread with ${thread.length + 1} posts`}>
        <div className="x-thread-heading"><strong>Thread</strong><span>{thread.length + 1} posts</span></div>
        {thread.map((post, index) => <article key={post.id}>
          <header>
            <FeedMark title={post.author || identity.name} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} />
            <span className="x-thread-author"><strong>{post.author || identity.name}</strong>{identity.meta && <span>{identity.meta}</span>}</span>
            <small>{index + 2} of {thread.length + 1}</small>
          </header>
          <ArticleBody html={formatXPostHtml(post.contentHtml)} className="social-content" />
          <a href={post.url} target="_blank" rel="noopener noreferrer">Open this post <Icon name="external" /></a>
        </article>)}
      </section>}
    </div>
  </div>
  return <div className="social-column">
    <p className="social-network">{socialNetworkName(entry.kind)}</p>
    <div className={`social-card network-${entry.kind}`}>
      <div className="social-author"><FeedMark title={identity.name} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} /><div><strong>{identity.name}</strong>{identity.meta && <span>{identity.meta}</span>}</div></div>
      {entry.kind === 'youtube' && <h1>{entry.title}</h1>}
      {children}
      {videoId && <div className="youtube-frame"><iframe src={`https://www.youtube-nocookie.com/embed/${videoId}`} title={entry.title} loading="lazy" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen /></div>}
      <ArticleBody html={html} className="social-content" />
      <a className="social-original" href={entry.url} target="_blank" rel="noopener noreferrer">View original <Icon name="external" /></a>
    </div>
  </div>
}

function socialIdentity(entry: Entry): { name: string; meta: string } {
  if (entry.kind === 'youtube') return { name: entry.author || entry.feedTitle, meta: 'YouTube' }
  if (entry.kind === 'threads') {
    const handle = entry.title.match(/^@([^:]+):/)?.[1] || entry.feedTitle.match(/@([^\s)]+)/)?.[1] || ''
    return { name: entry.author || handle || entry.feedTitle, meta: handle ? `@${handle} · Threads` : 'Threads' }
  }
  if (entry.kind === 'x') {
    const author = entry.author.match(/^(.+?)\s*\(@([^)]+)\)\s*$/)
    const handle = author?.[2] || xHandle(entry.url)
    const name = author?.[1] || entry.author || entry.feedTitle.replace(/^Twitter\s+@?/i, '')
    return { name, meta: handle ? `@${handle}` : entry.feedTitle !== name ? entry.feedTitle : '' }
  }
  return { name: entry.feedTitle, meta: entry.author && entry.author !== entry.feedTitle ? entry.author : '' }
}

function xHandle(value: string): string {
  try {
    const url = new URL(value)
    if (!['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return ''
    return url.pathname.split('/').filter(Boolean)[0] || ''
  } catch { return '' }
}

function socialNetworkName(kind: Entry['kind']): string {
  const names: Record<Entry['kind'], string> = {
    article: 'Post', x: 'X post', instagram: 'Instagram', threads: 'Threads post', bluesky: 'Bluesky post', mastodon: 'Mastodon post', youtube: 'YouTube',
  }
  return names[kind]
}

function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value)
    if (url.hostname.endsWith('youtu.be')) return url.pathname.split('/').filter(Boolean)[0] || ''
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || ''
    return url.searchParams.get('v') || ''
  } catch { return '' }
}

function ArticleBody({ html, className = '' }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const renderedHtml = useRef('')
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || renderedHtml.current === html) return
    root.innerHTML = html
    renderedHtml.current = html
  }, [html])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const onImageError = (event: Event) => {
      if (event.target instanceof HTMLImageElement) removeBrokenArticleImage(event.target)
    }
    root.addEventListener('error', onImageError, true)
    return () => root.removeEventListener('error', onImageError, true)
  }, [])

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const removeAlreadyBrokenImages = () => {
      for (const image of root.querySelectorAll('img')) {
        if (image.complete && image.naturalWidth === 0) removeBrokenArticleImage(image)
      }
    }
    removeAlreadyBrokenImages()
    const frame = window.requestAnimationFrame(removeAlreadyBrokenImages)
    return () => window.cancelAnimationFrame(frame)
  }, [html])

  return <div ref={ref} className={`article-content ${className}`.trim()} />
}

function ArticleHeader({ entry, feedIconUrl }: { entry: Entry; feedIconUrl: string }) {
  return <header className="article-header">
    <p className="article-kicker">{formatDate(entry.publishedAt)} · {entry.readingMinutes} min read</p>
    <h1>{entry.displayTitle || entry.title}</h1>
    {entry.displayTitle && <details className="original-headline" key={entry.id}>
      <summary>Original headline <span>AI-edited title</span></summary>
      <p>{entry.title}</p>
    </details>}
    <div className="article-byline"><FeedMark title={entry.feedTitle} url={entry.feedUrl || entry.url} iconUrl={feedIconUrl} /><div><strong>{entry.feedTitle}</strong>{authorLine(entry.author) && <span>{authorLine(entry.author)}</span>}</div></div>
  </header>
}

function ReaderEmpty({ onCommand }: { onCommand: () => void }) {
  return <div className="reader-empty"><span className="empty-rule" /><h2>Select an article</h2><p>Choose a story from the list, or use J and K.</p><button onClick={onCommand}>Open commands</button></div>
}

function EmptyList({ onAddFeed, unreadOnly, onShowAll, query = '', libraryMode = 'stream' }: { onAddFeed?: () => void; unreadOnly: boolean; onShowAll: () => void; query?: string; libraryMode?: string }) {
  if (onAddFeed && !query && libraryMode === 'stream') return <div className="list-empty"><Icon name="plus" /><h2>Add your first feed</h2><p>Paper is ready. Add an RSS or Atom feed, discover one from a website, or import an OPML file.</p><button onClick={onAddFeed}>Add feeds</button></div>
  if (query) return <div className="list-empty"><h2>No results</h2><p>Try fewer words, a wider date range, or the entire archive.</p></div>
  if (libraryMode !== 'stream') return <div className="list-empty"><h2>{libraryMode === 'recent' ? 'No recent reading yet' : 'No offline articles yet'}</h2><p>{libraryMode === 'recent' ? 'Articles you open will appear here with their reading position.' : 'Open an article and choose Save offline to keep a copy on this device.'}</p></div>
  return <div className="list-empty"><Icon name="check" /><h2>{unreadOnly ? 'You are caught up' : 'No articles here'}</h2><p>{unreadOnly ? 'This stream has no unread articles.' : 'This stream has no saved articles.'}</p>{unreadOnly && <button onClick={onShowAll}>Show all articles</button>}</div>
}

function StorySkeleton() {
  return <>{Array.from({ length: 7 }, (_, index) => <div className="story-row skeleton" key={index}><span className="skeleton-image"/><div><span/><span/><span/></div></div>)}</>
}

function ReportProblemModal({ entry, onClose, onSaved }: {
  entry: Entry
  onClose: () => void
  onSaved: () => void
}) {
  const [issue, setIssue] = useState<ArticleReport['issue']>(entry.kind === 'article' ? 'content' : 'social')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.reportArticle(entry.id, issue, note.trim(), {
        location: window.location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        theme: document.documentElement.dataset.theme || '',
        userAgent: navigator.userAgent.slice(0, 500),
        fullText: entry.fullText,
      })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not save this report')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Report a problem" onClose={onClose} className="report-modal">
    <form className="report-form" onSubmit={submit}>
      <p className="report-entry-title">{entry.title}</p>
      <label><span>What is wrong?</span><select autoFocus value={issue} onChange={event => setIssue(event.target.value as ArticleReport['issue'])}>
        <option value="content">Missing or broken content</option>
        <option value="media">Image or video problem</option>
        <option value="metadata">Title, author, or feed metadata</option>
        <option value="social">Social post rendering</option>
        <option value="other">Something else</option>
      </select></label>
      <label><span>Note</span><textarea rows={4} value={note} onChange={event => setNote(event.target.value)} placeholder="What did you see?" /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="report-form-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save report'}</button></div>
    </form>
  </Modal>
}

function CommandPalette({ commands, onClose }: { commands: Array<{ label: string; hint: string; run: () => void }>; onClose: () => void }) {
  const [filter, setFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const matches = commands.filter(command => command.label.toLowerCase().includes(filter.toLowerCase()))

  useEffect(() => setSelectedIndex(0), [filter])
  useEffect(() => itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' }), [selectedIndex])

  const runCommand = (command: { run: () => void }) => {
    onClose()
    command.run()
  }

  const moveSelection = (direction: 1 | -1) => {
    if (!matches.length) return
    setSelectedIndex(current => (current + direction + matches.length) % matches.length)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const vimDirection = filter === '' && (event.key === 'j' || event.key === 'k')
    if (event.key === 'ArrowDown' || (vimDirection && event.key === 'j')) {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp' || (vimDirection && event.key === 'k')) {
      event.preventDefault()
      moveSelection(-1)
    } else if (event.key === 'Enter' && matches[selectedIndex]) {
      event.preventDefault()
      runCommand(matches[selectedIndex])
    }
  }

  return <Modal title="Commands" onClose={onClose} className="command-modal">
    <div className="command-search"><Icon name="search" /><input autoFocus value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={onKeyDown} placeholder="Type a command" aria-controls="command-list" aria-activedescendant={matches[selectedIndex] ? `paper-command-${selectedIndex}` : undefined} /></div>
    <div className="command-list" id="command-list" role="listbox">{matches.map((command, index) => <button id={`paper-command-${index}`} role="option" aria-selected={index === selectedIndex} ref={element => { itemRefs.current[index] = element }} className={index === selectedIndex ? 'active' : ''} key={command.label} onMouseEnter={() => setSelectedIndex(index)} onClick={() => runCommand(command)}><span>{command.label}</span>{command.hint && <kbd>{command.hint}</kbd>}</button>)}</div>
  </Modal>
}

function ShortcutHelp({ onClose, onSearchHelp }: { onClose: () => void; onSearchHelp: () => void }) {
  const shortcuts = [
    ['j / ↓', 'Next article'], ['k / ↑', 'Previous article'], ['Ctrl / Cmd K', 'Open commands'], ['Enter', 'Open selected article'], ['o', 'Open original'], ['b', 'Open original in a background tab'], ['q', 'Save article to a connected service'], ['f', 'Fetch full article'], ['m', 'Toggle read'], ['s', 'Toggle star'], ['Shift A', 'Mark this stream read'], ['r', 'Refresh'], ['u / Esc', 'Close article'], ['[', 'Toggle sidebar'], [',', 'Open settings'], ['?', 'Show shortcuts'], ['/', 'Search'],
  ]
  return <Modal title="Keyboard shortcuts" onClose={onClose} className="help-modal"><button onClick={onSearchHelp}>Search syntax</button><dl>{shortcuts.map(([key, label]) => <div key={key}><dt>{key}</dt><dd>{label}</dd></div>)}</dl></Modal>
}

function Settings({ backend, section, setSection, initialFeedId, initialFeedView, navigation, onChanged, onFiltersChanged, onFiltersMatching, notify, onConnectionsChanged, onOpenEntry, onClose }: {
  backend: 'standalone' | 'freshrss' | 'miniflux'
  section: SettingsSection
  setSection: (value: SettingsSection) => void
  initialFeedId: string
  initialFeedView: 'manage' | 'discover'
  navigation: NavigationPayload | null
  onChanged: () => Promise<unknown>
  onFiltersChanged: () => Promise<unknown>
  onFiltersMatching: (matching: boolean) => void
  notify: (message: string) => void
  onConnectionsChanged: () => Promise<void>
  onOpenEntry: (id: string) => void
  onClose: () => void
}) {
  const content = section === 'access' ? <AccessSettings /> : section === 'backend' ? <BackendSettings backend={backend} /> : section === 'feeds'
    ? <FeedSettings initialView={initialFeedView} onChanged={onChanged}><FeedManager backend={backend} initialFeedId={initialFeedId} navigation={navigation} onChanged={onChanged} notify={notify} /></FeedSettings>
    : section === 'filters'
      ? <FiltersSettings onOpenEntry={onOpenEntry} onChanged={onFiltersChanged} notify={notify} onMatchingChange={onFiltersMatching} />
      : section === 'reports'
        ? <ReportsSettings onOpenEntry={onOpenEntry} notify={notify} />
        : section === 'activity'
          ? <ActivitySettings />
          : <div className="connections-settings">
            <ReadingSettings feeds={uniqueFeeds(navigation)} />
            <ConnectionSettings onChanged={onConnectionsChanged} />
            <WebhookSettingsPanel navigation={navigation} feeds={uniqueFeeds(navigation)} onChanged={onConnectionsChanged} />
          </div>
  return <Modal title="Settings" onClose={onClose} className="settings-modal">
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <button className={section === 'access' ? 'active' : ''} onClick={() => setSection('access')}>Access</button>
        <button className={section === 'backend' ? 'active' : ''} onClick={() => setSection('backend')}>Backend &amp; data</button>
        <button className={section === 'feeds' ? 'active' : ''} onClick={() => setSection('feeds')}>Feeds</button>
        <button className={section === 'filters' ? 'active' : ''} onClick={() => setSection('filters')}>Article rules</button>
        <button className={section === 'reports' ? 'active' : ''} onClick={() => setSection('reports')}>Reports</button>
        <button className={section === 'activity' ? 'active' : ''} onClick={() => setSection('activity')}>Activity</button>
        <button className={section === 'connections' ? 'active' : ''} onClick={() => setSection('connections')}>Reading & connections</button>
      </nav>
      <div className="settings-content">{content}</div>
    </div>
  </Modal>
}

function AppearancePopover({ theme, setTheme, readerFont, setReaderFont, readerSize, setReaderSize, readerSpacing, setReaderSpacing, readerWidth, setReaderWidth, onClose }: {
  theme: string
  setTheme: (value: string) => void
  readerFont: ReaderFont
  setReaderFont: (value: ReaderFont) => void
  readerSize: ReaderSize
  setReaderSize: (value: ReaderSize) => void
  readerSpacing: ReaderSpacing
  setReaderSpacing: (value: ReaderSpacing) => void
  readerWidth: ReaderWidth
  setReaderWidth: (value: ReaderWidth) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog)
  useEffect(() => {
    const closeEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', closeEscape)
    return () => window.removeEventListener('keydown', closeEscape)
  }, [onClose])

  return <div className="appearance-layer" onMouseDown={event => event.target === event.currentTarget && onClose()}><section ref={dialog} tabIndex={-1} className="appearance-popover" role="dialog" aria-modal="true" aria-label="Appearance">
    <header><div><h2>Appearance</h2><p>Theme and size stay on this device. Manage shared values and device overrides in Reading &amp; connections.</p></div><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>
    <div className="appearance-group">
      <h3>Theme</h3>
      <ChoiceRow values={['light', 'dark', 'system', 'e-ink']} active={theme} onChange={setTheme} />
    </div>
    <div className="appearance-group">
      <h3>Reading type</h3>
      <div className="font-choices">
        <button className={`font-choice literata ${readerFont === 'literata' ? 'active' : ''}`} onClick={() => setReaderFont('literata')}><span>Literata</span><small>Serif text for long articles.</small></button>
        <button className={`font-choice source ${readerFont === 'source' ? 'active' : ''}`} onClick={() => setReaderFont('source')}><span>Source Sans 3</span><small>A tighter sans serif option.</small></button>
      </div>
      <ReadingChoice label="Size" values={['small', 'medium', 'large']} active={readerSize} onChange={value => setReaderSize(value as ReaderSize)} />
      <ReadingChoice label="Line spacing" values={['compact', 'comfortable', 'spacious']} active={readerSpacing} onChange={value => setReaderSpacing(value as ReaderSpacing)} />
      <ReadingChoice label="Column" values={['narrow', 'standard', 'wide']} active={readerWidth} onChange={value => setReaderWidth(value as ReaderWidth)} />
    </div>
  </section></div>
}

function ChoiceRow({ values, active, onChange }: { values: string[]; active: string; onChange: (value: string) => void }) {
  return <div className="choice-row">{values.map(value => <button key={value} className={active === value ? 'active' : ''} onClick={() => onChange(value)}>{value}</button>)}</div>
}

function ReadingChoice({ label, values, active, onChange }: { label: string; values: string[]; active: string; onChange: (value: string) => void }) {
  return <div className="reading-choice"><span>{label}</span><ChoiceRow values={values} active={active} onChange={onChange} /></div>
}


function FeedManager({ backend, initialFeedId, navigation, onChanged, notify }: {
  backend: 'standalone' | 'freshrss' | 'miniflux'
  initialFeedId: string
  navigation: NavigationPayload | null
  onChanged: () => Promise<unknown>
  notify: (message: string) => void
}) {
  const feeds = useMemo(() => uniqueFeeds(navigation), [navigation])
  const folders = useMemo(() => (navigation?.folders || []).map(folder => folder.title), [navigation])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FeedFilter>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [selectedId, setSelectedId] = useState(initialFeedId)
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('')
  const [url, setUrl] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmedIds, setConfirmedIds] = useState<Set<string> | null>(null)
  const [bulkFolder, setBulkFolder] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const confirmBulkRemove = confirmedIds === selectedIds
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [maintenance, setMaintenance] = useState<FeedMaintenance | null>(null)
  const [maintenanceError, setMaintenanceError] = useState('')
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const next = await api.feedMaintenance()
        if (active) { setMaintenance(next); setMaintenanceError('') }
      } catch { if (active) setMaintenanceError('Could not load last post filters and article counts.') }
    }
    void load()
    return () => { active = false }
  }, [navigation])
  const checks = useFeedChecksView()
  const feedChecks = useMemo(() => new Map(checks?.feeds.map(check => [check.feedId, check])), [checks])
  const duplicates = useMemo(() => duplicateFeedGroups(feeds, feedChecks), [feeds, feedChecks])
  const matchesSearch = (feed: Feed) => `${feed.title} ${feed.url} ${feed.categories.join(' ')}`.toLowerCase().includes(query.toLowerCase())
  const visibleFeeds = feeds.filter(feed => matchesSearch(feed) && feedMatchesAge(feed, filter, maintenance?.staleDays)
    && (filter !== 'attention' || feed.broken) && (filter !== 'moved' || feedChecks.get(feed.id)?.move))
  const attentionFeeds = filter === 'duplicates' ? [] : visibleFeeds.filter(feed => feed.broken)
  const normalGroups = filter === 'duplicates'
    ? duplicates.filter(group => group.feeds.some(matchesSearch)).map(({ feeds, label }) => ({
      title: label + ' · ' + feeds[0].title, feeds, key: label + ':' + feeds[0].id,
    }))
    : groupFeeds(visibleFeeds.filter(feed => !feed.broken), folders).map(group => ({ ...group, key: group.title }))
  const displayFeeds = [...attentionFeeds, ...normalGroups.flatMap(group => group.feeds)]
  const selected = displayFeeds.find(feed => feed.id === selectedId) || displayFeeds[0] || null

  // React retries this render before showing controls for a changed list.
  if (selectedIds.size) {
    const visibleIds = new Set(displayFeeds.map(feed => feed.id))
    const remaining = [...selectedIds].filter(id => visibleIds.has(id))
    if (remaining.length !== selectedIds.size) {
      setSelectedIds(new Set(remaining))
      setConfirmedIds(null)
    }
  }

  useEffect(() => {
    if (!initialFeedId) return
    setSelectedId(initialFeedId)
    setMobileDetailOpen(true)
  }, [initialFeedId])

  useEffect(() => {
    if (!navigation) return
    if (selectedId !== (selected?.id ?? '')) {
      setMobileDetailOpen(false)
      setSelectedId(selected?.id ?? '')
    }
  }, [navigation, selectedId, selected?.id])

  useEffect(() => {
    if (!selected) return
    setTitle(selected.title)
    setFolder(selected.categories[0] || '')
    setConfirmRemove(false)
    setError('')
  }, [selected?.id, selected?.title, selected?.categories.join('|')])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [filter, query])

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      await api.addFeed(url, newTitle, newFolder)
      await onChanged()
      setUrl(''); setNewTitle(''); setNewFolder('')
      setShowAdd(false)
      notify('Feed added')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not add this feed')
    } finally { setBusy(false) }
  }

  const save = async () => {
    if (!selected) return
    setBusy(true); setError('')
    try {
      await api.updateFeed(selected.id, title.trim(), folder.trim(), selected.categories[0] || '')
      await onChanged()
      notify('Feed updated')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not update this feed')
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!selected) return
    if (!confirmRemove) return setConfirmRemove(true)
    setBusy(true); setError('')
    try {
      await api.removeFeed(selected.id)
      setSelectedId('')
      setMobileDetailOpen(false)
      await onChanged()
      notify('Feed unsubscribed')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper could not remove this feed')
    } finally { setBusy(false) }
  }

  const toggleSelection = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleGroupSelection = (groupFeeds: Feed[]) => {
    setSelectedIds(current => {
      const next = new Set(current)
      const allSelected = groupFeeds.every(feed => next.has(feed.id))
      for (const feed of groupFeeds) allSelected ? next.delete(feed.id) : next.add(feed.id)
      return next
    })
  }

  const toggleGroup = (title: string) => setCollapsedGroups(current => {
    const next = new Set(current)
    if (next.has(title)) next.delete(title)
    else next.add(title)
    return next
  })

  const bulkMove = async () => {
    if (!selectedIds.size || busy) return
    setBusy(true); setError('')
    const moved: string[] = []
    try {
      for (const id of selectedIds) {
        const feed = feeds.find(item => item.id === id)
        if (!feed) continue
        await api.updateFeed(id, feed.title, bulkFolder.trim(), feed.categories[0] || '')
        moved.push(id)
      }
      notify(`Moved ${moved.length} feeds to ${bulkFolder.trim() || 'Uncategorized'}`)
    } catch (reason) { setError(`${moved.length} feeds moved. ${reason instanceof Error ? reason.message : 'Could not move the remaining feeds'}`) }
    finally {
      setSelectedIds(current => new Set([...current].filter(id => !moved.includes(id))))
      try { await onChanged() } catch { setError('Changes were saved. Refresh the feed list to update it.') }
      setBusy(false)
    }
  }

  const bulkRemove = async () => {
    if (!selectedIds.size || busy) return
    if (!confirmBulkRemove) return setConfirmedIds(selectedIds)
    setConfirmedIds(null)
    setBusy(true); setError('')
    try {
      for (const id of confirmedIds) { await api.removeFeed(id); setSelectedIds(current => new Set([...current].filter(item => item !== id))) }
      const count = confirmedIds.size
      setSelectedIds(new Set())
      setSelectedId('')
      setMobileDetailOpen(false)
      await onChanged()
      notify(`${count} ${count === 1 ? 'feed' : 'feeds'} unsubscribed`)
    } catch (reason) {
      await onChanged().catch(() => undefined)
      setError(reason instanceof Error ? reason.message : 'Paper could not remove the remaining feeds')
    } finally { setBusy(false) }
  }

  const selectFeed = (id: string) => {
    setSelectedId(id)
    setMobileDetailOpen(true)
  }

  return <div className={`feed-manager ${mobileDetailOpen ? 'mobile-details-open' : ''}`}>
    <header className="feed-manager-heading"><div><h3>Feeds</h3><p>Manage subscriptions and folders. Unsubscribing keeps saved articles and reading state.</p></div><button className="primary" onClick={() => setShowAdd(value => !value)}><Icon name={showAdd ? 'close' : 'plus'} />{showAdd ? 'Cancel' : 'Add feed'}</button></header>
    {showAdd && <form className="feed-add-form" onSubmit={add}>
      <label><span>Feed or website URL</span><input autoFocus type="url" required placeholder="https://example.com/feed.xml" value={url} onChange={event => setUrl(event.target.value)} /></label>
      <label><span>Title, optional</span><input value={newTitle} onChange={event => setNewTitle(event.target.value)} /></label>
      <label><span>Folder, optional</span><input list="paper-feed-folders" value={newFolder} onChange={event => setNewFolder(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Working...' : 'Add feed'}</button>
    </form>}
    <datalist id="paper-feed-folders">{folders.map(name => <option value={name} key={name} />)}</datalist>
    {maintenance && <StaleThresholds days={maintenance.staleDays} onSaved={staleDays => setMaintenance(current => current && ({ ...current, staleDays }))} />}
    {maintenanceError && <p role="alert" className="feed-check-message">{maintenanceError}</p>}
    <div className="feed-manager-tools">
      <label className="feed-search"><Icon name="search" /><input placeholder="Find a feed" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="feed-filters" role="group" aria-label="Feed filter">
        {([['all', 'All'], ['attention', `Needs attention${feeds.some(feed => feed.broken) ? ` (${feeds.filter(feed => feed.broken).length})` : ''}`], ...(backend === 'standalone' ? [['moved', 'Moved feeds']] : []), ['duplicates', `Duplicates${duplicates.length ? ` (${duplicates.length})` : ''}`]] as Array<[FeedFilter, string]>).map(([value, label]) =>
          <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}
        {maintenance && <select aria-label="Filter by last post" value={['first', 'second', 'oldest'].includes(filter) ? filter : 'all'} onChange={event => setFilter(event.target.value as FeedFilter)}>
          <option value="all">Last post</option>
          <option value="first">{maintenance.staleDays[0]} to {maintenance.staleDays[1] - 1} days</option>
          <option value="second">{maintenance.staleDays[1]} to {maintenance.staleDays[2] - 1} days</option>
          <option value="oldest">{maintenance.staleDays[2]}+ days</option>
        </select>}
      </div>
    </div>
    {selectedIds.size > 0 && <div className="feed-bulk-bar"><span>{selectedIds.size} selected</span><label>Move to{backend === 'miniflux' ? <select value={bulkFolder} onChange={event => setBulkFolder(event.target.value)}><option value="">Choose a category</option>{folders.map(name => <option key={name} value={name}>{name}</option>)}</select> : <input list="paper-feed-folders" value={bulkFolder} placeholder="Uncategorized" onChange={event => setBulkFolder(event.target.value)} />}</label><button disabled={busy || backend === 'miniflux' && !bulkFolder} onClick={() => void bulkMove()}>Move selected</button><button onClick={() => { setSelectedIds(new Set()); setConfirmedIds(null) }}>Clear</button><button className={confirmBulkRemove ? 'danger confirming' : 'danger'} onClick={() => void bulkRemove()} disabled={busy}>{confirmBulkRemove ? `Confirm unsubscribe ${selectedIds.size}` : `Unsubscribe ${selectedIds.size}`}</button></div>}
    <div className="feed-manager-grid">
      <section className="feed-manager-list">
        <div className="feed-group-scroll">
          {filter === 'duplicates' && duplicates.length > 0 && <p className="feed-comparison-note">Possible duplicates have similar addresses or share a site and title.</p>}
          {attentionFeeds.length > 0 && <FeedGroup title="Needs attention" feeds={attentionFeeds} selectedId={selected?.id || ''} selectedIds={selectedIds} onSelect={selectFeed} onToggleSelection={toggleSelection} onToggleGroupSelection={toggleGroupSelection} collapsed={collapsedGroups.has('Needs attention')} onToggleCollapsed={() => toggleGroup('Needs attention')} attention />}
          {normalGroups.map(group => <FeedGroup key={group.key} compare={filter === 'duplicates'} counts={maintenance?.articleCounts} title={group.title} feeds={group.feeds} selectedId={selected?.id || ''} selectedIds={selectedIds} onSelect={selectFeed} onToggleSelection={toggleSelection} onToggleGroupSelection={toggleGroupSelection} collapsed={collapsedGroups.has(group.key)} onToggleCollapsed={() => toggleGroup(group.key)} />)}
          {!displayFeeds.length && <div className="feed-list-empty">No feeds match this filter.</div>}
        </div>
      </section>
      <section className="feed-editor">
        {selected ? <>
          <button className="feed-editor-back" onClick={() => setMobileDetailOpen(false)}><Icon name="back" /> Back to feeds</button>
          <div className="feed-editor-heading"><FeedMark title={selected.title} url={selected.siteUrl || selected.url} iconUrl={selected.iconUrl} /><div><strong>{selected.title}</strong><span>{selected.url}</span></div></div>
          {selected.broken && <div className="feed-health-alert"><strong>The feed could not be updated</strong><span>{backend !== 'miniflux' && selected.lastErrorAt ? `Last failed ${relativeDate(selected.lastErrorAt)}.` : 'The latest fetch failed.'}</span></div>}
          {backend === 'freshrss' && !selected.broken && selected.lastErrorAt && <p className="feed-last-post">Last failed {relativeDate(selected.lastErrorAt)}</p>}
          {backend !== 'standalone' && selected.lastCheckedAt && <p className="feed-last-post">Last checked {relativeDate(selected.lastCheckedAt)}</p>}
          {selected.parsingErrorCount !== undefined && selected.parsingErrorCount > 0 && <p className="feed-last-post">{selected.parsingErrorCount} parsing {selected.parsingErrorCount === 1 ? 'error' : 'errors'}{selected.parsingErrorMessage && <><br />{selected.parsingErrorMessage}</>}</p>}
          {!selected.broken && <p className="feed-last-post">{selected.lastPublishedAt ? `Last post ${formatFeedDate(selected.lastPublishedAt)}` : backend === 'miniflux' ? 'Last publication unavailable' : 'No posts have arrived yet'}</p>}
          <label><span>Title</span><input value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label><span>Folder</span>{backend === 'miniflux' ? <select value={folder} onChange={event => setFolder(event.target.value)}>{folders.map(name => <option key={name} value={name}>{name}</option>)}</select> : <input list="paper-feed-folders" placeholder="Uncategorized" value={folder} onChange={event => setFolder(event.target.value)} />}</label>
          <p className="feed-editor-note">{backend === 'miniflux' ? 'Choose an existing Miniflux category. Manage category names and feed URL repair in Miniflux.' : 'Clear the folder to move this feed to Uncategorized. Enter a new name to create a folder.'}</p>
          <FeedOverrides key={`overrides-${selected.id}`} feed={selected} backend={backend} />
          {backend !== 'miniflux' && <FeedRepair key={selected.id} feed={selected} move={feedChecks.get(selected.id)?.move} onChanged={onChanged} />}
          {selected.url && <button className="copy-feed-url" onClick={() => void navigator.clipboard.writeText(selected.url).then(() => notify('Feed URL copied'))}>Copy feed URL</button>}
          <div className="feed-editor-actions"><button className="primary" onClick={() => void save()} disabled={busy || !title.trim()}>Save changes</button><button className={confirmRemove ? 'danger confirming' : 'danger'} onClick={() => void remove()} disabled={busy}>{confirmRemove ? 'Confirm unsubscribe' : 'Unsubscribe'}</button></div>
        </> : <div className="feed-editor-empty">No feeds match this search.</div>}
        {error && <p className="form-error">{error}</p>}
      </section>
    </div>
  </div>
}

function FeedGroup({ title, feeds, selectedId, selectedIds, onSelect, onToggleSelection, onToggleGroupSelection, collapsed, onToggleCollapsed, attention = false, compare, counts }: {
  compare?: boolean
  counts?: Record<string, number>
  title: string
  feeds: Feed[]
  selectedId: string
  selectedIds: Set<string>
  onSelect: (id: string) => void
  onToggleSelection: (id: string) => void
  onToggleGroupSelection: (feeds: Feed[]) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  attention?: boolean
}) {
  const allSelected = feeds.every(feed => selectedIds.has(feed.id))
  return <section className={`feed-folder-group ${attention ? 'attention' : ''}`}>
    <header className="feed-group-header">
      <button className="feed-group-collapse" onClick={onToggleCollapsed} aria-expanded={!collapsed}><Icon name="chevron" className={collapsed ? '' : 'rotated'} /><span>{title}</span><b>{feeds.length}</b></button>
      <button className="feed-group-select" onClick={() => onToggleGroupSelection(feeds)}>{allSelected ? 'Clear' : 'Select all'}</button>
    </header>
    {!collapsed && feeds.map(feed => <div key={feed.id} className={`feed-item-row ${selectedId === feed.id ? 'active' : ''}`}>
      <label className="feed-select"><input type="checkbox" checked={selectedIds.has(feed.id)} onChange={() => onToggleSelection(feed.id)} aria-label={`Select ${feed.title}`} /></label>
      <button className="feed-item-open" onClick={() => onSelect(feed.id)}>
        <FeedMark title={feed.title} url={feed.siteUrl || feed.url} iconUrl={feed.iconUrl} />
        <span><strong>{feed.title}</strong>
          {compare && <><small>{feed.url}</small><small>{feed.categories.join(', ') || 'Uncategorized'} · {counts ? `${counts[feed.id] ?? 0} ${counts[feed.id] === 1 ? 'article' : 'articles'} in Paper` : 'Article count unavailable'}</small></>}
          <small>{feed.broken && !compare ? (feed.lastErrorAt ? `Failed ${relativeDate(feed.lastErrorAt)}` : 'Update failed') : feed.lastPublishedAt ? `Last post ${formatFeedDate(feed.lastPublishedAt)}` : 'Last post unavailable'}</small>
        </span>
        {feed.unread > 0 && <b>{feed.unread}</b>}
      </button>
    </div>)}
  </section>
}

function groupFeeds(feeds: Feed[], folderOrder: string[]): Array<{ title: string; feeds: Feed[] }> {
  const groups = new Map<string, Feed[]>()
  for (const feed of feeds) {
    const title = feed.categories[0] || 'Uncategorized'
    groups.set(title, [...(groups.get(title) || []), feed])
  }
  const order = new Map([...folderOrder, 'Uncategorized'].map((name, index) => [name, index]))
  return [...groups.entries()]
    .map(([title, items]) => ({ title, feeds: items.sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => (order.get(a.title) ?? 10_000) - (order.get(b.title) ?? 10_000) || a.title.localeCompare(b.title))
}

function validDate(value: string | number): boolean {
  return Boolean(value) && value !== '0' && Number.isFinite(new Date(value).getTime()) && new Date(value).getTime() !== 0
}

function formatFeedDate(value: string): string {
  if (!validDate(value)) return 'Date unavailable'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value))
}

function relativeDate(value: string): string {
  if (!validDate(value)) return 'Date unavailable'
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000))
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

function streamUnreadCount(navigation: NavigationPayload | null, stream: StreamRef): number | null {
  if (!navigation) return null
  if (stream.kind === 'all') return navigation.unread
  if (stream.kind === 'category') return navigation.folders.find(folder => folder.id === stream.id)?.unread ?? null
  if (stream.kind === 'feed') return uniqueFeeds(navigation).find(feed => feed.id === stream.id)?.unread ?? null
  return null
}

function navigationFeeds(navigation: NavigationPayload | null): Feed[] {
  const seen = new Set<string>()
  return [...(navigation?.folders.flatMap(folder => folder.feeds) || []), ...(navigation?.uncategorized || [])]
    .filter(feed => { if (seen.has(feed.id)) return false; seen.add(feed.id); return true })
}

function uniqueFeeds(navigation: NavigationPayload | null): Feed[] {
  const byId = new Map<string, Feed>()
  for (const folder of navigation?.folders || []) for (const feed of folder.feeds) byId.set(feed.id, feed)
  for (const feed of navigation?.uncategorized || []) byId.set(feed.id, feed)
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title))
}

function relativeTime(timestamp: number): string {
  if (!validDate(timestamp)) return 'Date unavailable'
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function formatDate(value: string): string {
  if (!validDate(value)) return 'Date unavailable'
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function storedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key) as T | null
  return value && choices.includes(value) ? value : fallback
}
