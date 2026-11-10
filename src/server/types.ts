export type StreamKind = 'all' | 'starred' | 'category' | 'feed'

export interface StreamRef {
  kind: StreamKind
  id: string
  title: string
}

export interface Feed {
  id: string
  title: string
  url: string
  siteUrl: string
  iconUrl: string
  categories: string[]
  unread: number
  lastPublishedAt: string | null
  lastCheckedAt: string | null
  lastErrorAt: string | null
  broken: boolean
}

export interface Folder {
  id: string
  title: string
  unread: number
  feeds: Feed[]
}

export type EntryKind = 'article' | 'x' | 'instagram' | 'threads' | 'bluesky' | 'mastodon' | 'youtube'

export interface Entry {
  searchExcerpt?: string
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

export interface BriefingSelection {
  intro?: string
  news: Array<{
    collectionId?: string
    backgroundEntryIds?: string[]
    headline: string
    summary: string
    entryIds: string[]
    role?: 'lead' | 'brief'
    imageEntryId?: string
  }>
  worthNoticing: Array<{
    entryId: string
    reason: string
    summary: string
  }>
  social: Array<{
    entryId: string
    summary: string
    imageEntryId?: string
  }>
}
