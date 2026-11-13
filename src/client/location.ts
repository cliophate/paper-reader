import type { Entry, NavigationPayload, StreamKind, StreamRef } from './types'

export type MobilePane = 'sources' | 'stories' | 'article'

export interface ReaderLocation {
  articleNumber?: number
  collectionNumber?: number
  view: 'reader' | 'briefings' | 'pulse'
  stream: StreamRef
  selectedId: string
  unreadOnly: boolean
  query: string
  mobilePane: MobilePane
  collection?: string
  library?: 'stream' | 'recent' | 'offline'
  searchStream?: StreamRef
  searchUnread?: boolean
  after?: string
  before?: string
}

export function readLegacyReaderLocation(search: string): ReaderLocation {
  const params = new URLSearchParams(search)
  const kind = validKind(params.get('kind'))
  const pane = validPane(params.get('pane'))
  const id = params.get('id') || kind
  const title = params.get('title') || defaultTitle(kind)
  const selectedId = params.get('entry') || ''
  return {
    ...(params.get('collection') ? { collection: params.get('collection')! } : {}),
    ...(['recent', 'offline'].includes(params.get('library') || '') ? { library: params.get('library') as 'recent' | 'offline' } : {}),
    ...(params.has('searchKind') ? { searchStream: { kind: validKind(params.get('searchKind')), id: params.get('searchId') || 'all', title: params.get('searchTitle') || 'All articles' } } : {}),
    ...(params.has('searchUnread') ? { searchUnread: params.get('searchUnread') === '1' } : {}),
    ...(params.has('after') ? { after: params.get('after')! } : {}),
    ...(params.has('before') ? { before: params.get('before')! } : {}),
    view: validView(params.get('view')),
    stream: { kind, id, title },
    selectedId,
    unreadOnly: params.get('unread') !== '0',
    query: params.get('q') || '',
    mobilePane: selectedId && !params.has('pane') ? 'article' : pane,
  }
}

export interface ReaderLinks {
  navigation?: NavigationPayload | null
  entries?: Entry[]
  collections?: Array<{ id: string; linkNumber?: number; headline: string; sources: Array<{ id: string }> }>
}

const oldParameters = ['kind', 'id', 'title', 'entry', 'view', 'collection', 'library', 'searchKind', 'searchId', 'searchTitle', 'searchUnread']
const number = (value?: string) => value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined

export function readerSlug(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '')
}

export function readReaderLocation(input = window.location.pathname + window.location.search): ReaderLocation {
  const url = new URL(input, 'http://paper.test')
  if (url.pathname === '/' && oldParameters.some(key => url.searchParams.has(key))) return readLegacyReaderLocation(url.search)
  const params = url.searchParams
  const location: ReaderLocation = { view: 'reader', stream: { kind: 'all', id: 'all', title: 'All articles' },
    selectedId: '', unreadOnly: params.get('unread') !== '0', query: params.get('q') || '', mobilePane: 'sources' }
  const parts = url.pathname.split('/').slice(1)
  if (parts.at(-1) === '') parts.pop()
  const place = parts[0]
  if (place === 'feed' || place === 'folder') {
    // A three-segment path ends with a slug, even when that slug is "a".
    if ([2, 3, 4, 5].includes(parts.length) && number(parts[1])) {
      location.stream = { kind: place === 'feed' ? 'feed' : 'category', id: '', title: '', linkNumber: number(parts[1]) }
      if ((parts.length === 4 || parts.length === 5) && parts.at(-2) === 'a') location.articleNumber = number(parts.at(-1))
    }
  } else if (place === 'a' && parts.length === 2) location.articleNumber = number(parts[1])
  else if (place === 'collection' && [2, 4].includes(parts.length)) {
    location.collectionNumber = number(parts[1])
    location.view = 'pulse'
    if (parts.length === 4 && parts[2] === 'a') { location.articleNumber = number(parts[3]); location.view = 'reader' }
  } else if (['starred', 'recent', 'offline', 'briefings', 'pulse'].includes(place) && [1, 3].includes(parts.length)) {
    if (place === 'starred') location.stream = { kind: 'starred', id: 'starred', title: 'Starred' }
    else if (place === 'recent' || place === 'offline') location.library = place
    else location.view = place as 'briefings' | 'pulse'
    if (parts.length === 3 && parts[1] === 'a' && location.view === 'reader') location.articleNumber = number(parts[2])
  }
  location.mobilePane = params.has('pane') ? validPane(params.get('pane')) : location.articleNumber ? 'article' : 'sources'
  const scope = params.get('in')?.split('/')
  if (scope?.length === 2 && ['feed', 'folder'].includes(scope[0]) && number(scope[1])) {
    location.searchStream = { kind: scope[0] === 'feed' ? 'feed' : 'category', id: '', title: '', linkNumber: number(scope[1]) }
  }
  if (location.query) {
    // Old search links left `unread` out for all articles, so only an explicit `unread=1` limits a search.
    location.searchUnread = params.get('unread') === '1'
    if (!location.searchStream && location.stream.kind === 'starred') location.searchStream = location.stream
  }
  for (const key of ['after', 'before'] as const) if (params.has(key)) location[key] = params.get(key)!
  return location
}

export function linkedStream(stream: StreamRef, links: ReaderLinks): StreamRef | undefined {
  if (stream.kind === 'all' || stream.kind === 'starred') return { kind: stream.kind, id: stream.kind, title: defaultTitle(stream.kind) }
  const items = stream.kind === 'category' ? links.navigation?.folders : [...(links.navigation?.uncategorized || []), ...(links.navigation?.folders.flatMap(folder => folder.feeds) || [])]
  const item = items?.find(item => stream.id ? item.id === stream.id : item.linkNumber === stream.linkNumber)
  return item ? { kind: stream.kind, id: item.id, title: item.title, linkNumber: item.linkNumber } : undefined
}

export async function resolveReaderLocation(input: ReaderLocation, links: ReaderLinks, fetchEntry: (number: number) => Promise<Entry | null>, fetchId: (id: string) => Promise<Entry | null>) {
  const location = { ...input }
  let notice = ''
  location.stream = linkedStream(input.stream, links) || { kind: 'all', id: 'all', title: 'All articles' }
  if (!linkedStream(input.stream, links)) notice = `${input.stream.kind === 'feed' ? 'Feed' : 'Folder'} not found`
  if (input.searchStream) {
    location.searchStream = linkedStream(input.searchStream, links)
    if (!location.searchStream) notice = 'Search source not found'
  }
  const collection = input.collection || input.collectionNumber
    ? links.collections?.find(item => input.collection ? item.id === input.collection : item.linkNumber === input.collectionNumber) : undefined
  if (input.collection || input.collectionNumber) {
    if (collection) { location.collection = collection.id; location.collectionNumber = collection.linkNumber }
    else { notice = 'Collection not found'; location.collection = undefined; location.collectionNumber = undefined; location.view = 'reader' }
  }
  const entry = input.articleNumber
    ? links.entries?.find(item => item.linkNumber === input.articleNumber) || await fetchEntry(input.articleNumber)
    : input.selectedId ? links.entries?.find(item => item.id === input.selectedId) || await fetchId(input.selectedId) : null
  if (input.articleNumber || input.selectedId) {
    location.selectedId = entry?.id || ''
    location.articleNumber = entry?.linkNumber
    if (!entry) { notice = 'Article not found'; if (location.mobilePane === 'article') location.mobilePane = 'stories' }
    else if (location.stream.kind === 'feed' && location.stream.id !== entry.feedId) {
      location.stream = linkedStream({ kind: 'feed', id: entry.feedId, title: entry.feedTitle }, links) || { kind: 'all', id: 'all', title: 'All articles' }
    }
  }
  return { location, entry, collection, notice }
}

export function readerLocationUrl(location: ReaderLocation, links: ReaderLinks = {}): string {
  const params = new URLSearchParams()
  const source = location.query && location.searchStream?.kind === 'starred' ? location.searchStream
    : location.query && location.stream.kind === 'starred' ? { kind: 'all' as const, id: 'all', title: 'All articles' } : location.stream
  const stream = linkedStream(source, links) || source
  const collectionNumber = links.collections?.find(item => item.id === location.collection)?.linkNumber || location.collectionNumber
  const articleNumber = location.selectedId ? links.entries?.find(item => item.id === location.selectedId)?.linkNumber || location.articleNumber : location.articleNumber
  let path = '/'
  if (location.view === 'briefings') path = '/briefings'
  else if (collectionNumber) path = `/collection/${collectionNumber}`
  else if (location.view === 'pulse') path = '/pulse'
  else if (location.library === 'recent' || location.library === 'offline') path = `/${location.library}`
  else if (stream.kind === 'starred') path = '/starred'
  else if ((stream.kind === 'feed' || stream.kind === 'category') && stream.linkNumber) {
    const slug = readerSlug(stream.title)
    path = `/${stream.kind === 'feed' ? 'feed' : 'folder'}/${stream.linkNumber}${slug ? `/${slug}` : ''}`
  }
  if (articleNumber && location.view === 'reader') path = `${path === '/' ? '' : path}/a/${articleNumber}`
  if (location.query && location.searchUnread) params.set('unread', '1')
  else if (!location.unreadOnly) params.set('unread', '0')
  if (location.query) {
    params.set('q', location.query)
    const scope = location.searchStream && (linkedStream(location.searchStream, links) || location.searchStream)
    if (scope?.linkNumber && (scope.kind === 'feed' || scope.kind === 'category')) params.set('in', `${scope.kind === 'feed' ? 'feed' : 'folder'}/${scope.linkNumber}`)
  }
  if (location.after) params.set('after', location.after)
  if (location.before) params.set('before', location.before)
  if (location.mobilePane !== (articleNumber ? 'article' : 'sources')) params.set('pane', location.mobilePane)
  const query = params.toString()
  return path + (query ? `?${query}` : '')
}

function validView(value: string | null): ReaderLocation['view'] {
  if (value === 'briefings') return value
  if (value === 'pulse' || value === 'topics') return 'pulse'
  return 'reader'
}

function validKind(value: string | null): StreamKind {
  return value === 'starred' || value === 'category' || value === 'feed' ? value : 'all'
}

function validPane(value: string | null): MobilePane {
  return value === 'stories' || value === 'article' ? value : 'sources'
}

function defaultTitle(kind: StreamKind): string {
  return kind === 'starred' ? 'Starred' : kind === 'all' ? 'All articles' : ''
}
