import type { Enclosure } from '../shared/enclosures.js'
export type { BriefingSelection } from '../shared/briefings.js'

export type StreamKind = 'all' | 'starred' | 'category' | 'feed'

export interface StreamRef {
  linkNumber?: number
  kind: StreamKind
  id: string
  title: string
}

export interface Feed {
  urlRef?: string
  linkNumber?: number
  id: string
  title: string
  url: string
  siteUrl: string
  iconUrl: string
  categories: string[]
  unread: number
  lastPublishedAt: string | null
  lastCheckedAt: string | null
  parsingErrorCount?: number
  parsingErrorMessage?: string
  lastErrorAt: string | null
  broken: boolean
}

export interface Folder {
  linkNumber?: number
  id: string
  title: string
  unread: number
  feeds: Feed[]
}

export type EntryKind = 'article' | 'x' | 'instagram' | 'threads' | 'bluesky' | 'mastodon' | 'youtube'

// Symbol keys survive server-side object spreads and stay out of JSON responses.
export const indexedSearchText = Symbol('indexedSearchText')
export interface Entry {
  [indexedSearchText]?: { title: string; author: string; feedTitle: string; contentText: string; fullContentText: string }
  searchSnapshot?: string
  linkNumber?: number
  stateRevision?: number
  searchExcerpt?: string
  enclosures?: Enclosure[]
  enclosuresUnchecked?: boolean
  readingPosition?: number
  lastReadAt?: string
  readwiseSavedAt?: string
  displayTitle?: string
  id: string
  feedId: string
  feedTitle: string
  feedUrl: string
  title: string
  author: string
  url: string
  contentHtml: string
  excerpt: string
  publishedAt: string
  timestamp: number
  crawledAt?: number
  // Adapter-provided arrival order, separate from the immutable Paper ID.
  sourceOrder?: string
  read: boolean
  starred: boolean
  readingMinutes: number
  thumbnailUrl: string
  kind: EntryKind
}

export interface NavigationPayload {
  unread: number
  starred: number
  folders: Folder[]
  uncategorized: Feed[]
}
