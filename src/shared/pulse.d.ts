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

export type StoryChoice = { kind: 'follow' | 'mute' } | { kind: 'snooze'; until: number }
export type SavedStoryChoice = { id: string; headline: string; choice: StoryChoice }

export interface PulseCollection {
  followed?: boolean
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
  latestPublishedAt: string
  recentArticleCount: number
  recentPublicationCount: number
  active: boolean
  archived: boolean
  quiet: boolean
  sources: PulseSource[]
  catchUp?: PulseCatchUp
}

export interface PulsePayload {
  storyChoices?: SavedStoryChoice[]
  useStoryChoicesInBriefings?: boolean
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
