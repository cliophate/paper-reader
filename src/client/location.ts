import type { StreamKind, StreamRef } from './types'

export type MobilePane = 'sources' | 'stories' | 'article'

export interface ReaderLocation {
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

export const defaultReaderLocation: ReaderLocation = {
  view: 'reader',
  stream: { kind: 'all', id: 'all', title: 'All articles' },
  selectedId: '',
  unreadOnly: true,
  query: '',
  mobilePane: 'sources',
}

export function readReaderLocation(search = window.location.search): ReaderLocation {
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

export function readerLocationUrl(location: ReaderLocation): string {
  const params = new URLSearchParams()
  const { stream } = location
  if (location.view !== 'reader') params.set('view', location.view)
  if (stream.kind !== 'all') params.set('kind', stream.kind)
  if (stream.id !== stream.kind && !(stream.kind === 'all' && stream.id === 'all')) params.set('id', stream.id)
  if (stream.title !== defaultTitle(stream.kind)) params.set('title', stream.title)
  if (location.selectedId) params.set('entry', location.selectedId)
  if (!location.unreadOnly) params.set('unread', '0')
  if (location.collection) params.set('collection', location.collection)
  if (location.library && location.library !== 'stream') params.set('library', location.library)
  if (location.query) {
    params.set('q', location.query)
    if (location.searchStream && location.searchStream.kind !== 'all') { params.set('searchKind', location.searchStream.kind); params.set('searchId', location.searchStream.id); params.set('searchTitle', location.searchStream.title) }
    if (location.searchUnread) params.set('searchUnread', '1')
    if (location.after) params.set('after', location.after)
    if (location.before) params.set('before', location.before)
  }
  if (location.mobilePane !== 'sources') params.set('pane', location.mobilePane)
  const query = params.toString()
  return query ? `/?${query}` : '/'
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
