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
  worthNoticing: Array<{ entryId: string; reason: string; summary: string }>
  social: Array<{ entryId: string; summary: string; imageEntryId?: string }>
}

export interface BriefingSummary {
  id: string
  kind: 'morning' | 'evening'
  subject: string
  status: string
  windowStart: string
  cutoff: string
  createdAt: string
  deliveredAt: string | null
  acknowledgedAt: string | null
  feedback: 'useful' | 'too_broad' | 'missed' | null
  entryCount: number
  unreadCount: number
  missingCount: number
}

export interface BriefingSource {
  id: string
  title: string
  url: string
  feedTitle: string
  author: string
  read: boolean
  thumbnailUrl: string
  kind: string
  text: string
}

export interface BriefingDetail extends BriefingSummary {
  selection: BriefingSelection
  sourceIds: string[]
  sources: BriefingSource[]
  html: string
  text: string
}

export interface BriefingReadResult {
  briefing: BriefingDetail
  sourceIds: string[]
}
