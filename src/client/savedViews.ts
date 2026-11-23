import type { SavedView } from '../shared/saved-views'
import type { StreamRef } from './types'
import { parseSearch } from '../server/search-query'

// Offline downloads can resolve the same query from the navigation snapshot.
export function savedViewQuery(views: readonly SavedView[], id: string) {
  return views.find(view => view.id === id)?.query
}

export interface ViewFilters {
  sources: string[]
  keywords: string
  author: string
  after: string
  before: string
  minminutes: string
  maxminutes: string
  read: string
  stars: string
}

export const emptyFilters: ViewFilters = {
  sources: [], keywords: '', author: '', after: '', before: '', minminutes: '', maxminutes: '', read: '', stars: '',
}

function quoteId(text: string) { return '"' + text.replaceAll('"', '""') + '"' }

export function currentSearchQuery(query: string, stream: StreamRef, unread: boolean, after: string, before: string) {
  if (!query.trim()) return ''
  const scope = []
  if (stream.kind === 'feed' || stream.kind === 'category') scope.push((stream.kind === 'feed' ? 'feedid:' : 'folderid:') + quoteId(stream.id))
  if (stream.kind === 'starred') scope.push('is:starred')
  if (stream.kind === 'view' && stream.viewQuery) scope.push('(' + stream.viewQuery + ')')
  if (unread) scope.push('is:unread')
  if (after) scope.push('after:' + after.slice(0, 10))
  if (before) scope.push('before:' + before.slice(0, 10))
  return scope.length ? ['(' + query + ')', ...scope].join(' ') : query
}

export function filtersQuery(filters: ViewFilters) {
  const sources = filters.sources.map(source => {
    const colon = source.indexOf(':')
    return source.slice(0, colon + 1) + quoteId(source.slice(colon + 1))
  })
  const parts = sources.length > 1 ? ['(' + sources.join(' OR ') + ')'] : sources
  // FTS treats quotation marks as word separators inside names and keywords.
  const keywords = filters.keywords.replaceAll('"', ' ').trim().split(/\s+/).filter(Boolean)
  parts.push(...keywords.map(word => '"' + word + '"'))
  const author = filters.author.replaceAll('"', ' ').trim()
  if (author) parts.push('author:"' + author + '"')
  for (const key of ['after', 'before', 'minminutes', 'maxminutes'] as const) {
    if (filters[key]) parts.push(key + ':' + filters[key])
  }
  if (filters.read) parts.push('is:' + filters.read)
  if (filters.stars) parts.push(filters.stars)
  return parts.join(' ')
}

// Only switch to the form when it can reproduce every term in the query.
export function queryFilters(query: string): ViewFilters | undefined {
  const filters = { ...emptyFilters, sources: [] as string[] }
  if (!query.trim()) return filters
  try {
    const { root, hint } = parseSearch(query)
    if (hint) return
    for (const node of root.kind === 'and' ? root.children : [root]) {
      if (node.kind === 'feedid' || node.kind === 'folderid' || node.kind === 'or') {
        for (const source of node.kind === 'or' ? node.children : [node]) {
          if (source.kind !== 'feedid' && source.kind !== 'folderid') return
          filters.sources.push(source.kind + ':' + source.value)
        }
      } else if (node.kind === 'text' && node.field === 'author') filters.author = node.value
      else if (node.kind === 'text' && !node.field) filters.keywords = [filters.keywords, node.value].filter(Boolean).join(' ')
      else if (node.kind === 'state' && node.value === 'starred') filters.stars = 'is:starred'
      else if (node.kind === 'not' && node.child.kind === 'state' && node.child.value === 'starred') filters.stars = '-is:starred'
      else if (node.kind === 'state') filters.read = node.value
      else if (node.kind === 'after' || node.kind === 'before' || node.kind === 'minminutes' || node.kind === 'maxminutes') filters[node.kind] = String(node.value)
      else return
    }
    if (filters.after && !/^\d+d$|^\d{4}-\d\d-\d\d$/.test(filters.after) || filters.before && !/^\d{4}-\d\d-\d\d$/.test(filters.before)) return
    if (filtersQuery(filters) === query) return filters
  } catch { return }
}
