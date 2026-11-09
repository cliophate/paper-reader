export interface PulseSource {
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

export interface PulseCollection {
  id: string
  headline: string
  scope: string
  createdAt: string
  updatedAt: string
  revision: number
  seenThrough: number
  newCount: number
  unreadCount: number
  publicationCount: number
  articleCount: number
  quiet: boolean
  sources: PulseSource[]
}

export interface PulsePayload {
  collections: PulseCollection[]
  revision: string
  status: {
    enabled: boolean
    running: boolean
    lastCompletedAt: string | null
    failed: boolean
  }
}
