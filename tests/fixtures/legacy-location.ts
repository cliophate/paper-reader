// The URL writer shipped before reader routes, retained as a bookmark fixture.
import type { ReaderLocation } from '../../src/client/location'
import type { StreamKind } from '../../src/client/types'

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


function defaultTitle(kind: StreamKind): string {
  return kind === 'starred' ? 'Starred' : kind === 'all' ? 'All articles' : ''
}
