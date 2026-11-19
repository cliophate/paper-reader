export interface PulseSource {
  linkNumber?: number
  stateRevision?: number
  id: string
  feedId: string
  read: boolean
  publication: string
  domain: string
  title: string
  url: string
  author: string
  publishedAt: string
  timestamp: number
  thumbnailUrl: string
  isNew: boolean
  sequence: number
  development?: string
  addedAt: string
}

export interface PulseSummaryLine {
  text: string
  entryIds: string[]
}

export interface PulseCatchUp {
  latest: PulseSummaryLine[]
  background: PulseSummaryLine[]
}

export interface PulseCollection {
  linkNumber?: number
  id: string
  headline: string
  scope: string
  createdAt: string
  updatedAt: string
  revision: number
  questionsRevision?: string
  seenThrough: number
  newCount: number
  unreadCount: number
  publicationCount: number
  articleCount: number
  quiet: boolean
  sources: PulseSource[]
  catchUp?: PulseCatchUp
}

export interface PulsePayload {
  collections: PulseCollection[]
  collectionAliases?: Array<{ id: string; linkNumber?: number; targetId: string }>
  revision: string
  status: {
    enabled: boolean
    running: boolean
    lastCompletedAt: string | null
    failed: boolean
  }
}
