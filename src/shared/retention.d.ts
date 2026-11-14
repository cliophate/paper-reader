export interface RetentionPolicy {
  autoReadDays: number | null
  folderDays: Record<string, number | null>
  feedDays: Record<string, number | null>
  readDays: number | null
  unreadDays: number | null
  cacheDays: number | null
}
export interface RetentionCounts { marked: number; deleted: number }
export interface RetentionRun extends RetentionCounts {
  id: number
  startedAt: number
  finishedAt: number | null
  cursor: number
  ceiling: number
  batches: number
}
export interface RetentionView {
  backend: 'standalone' | 'freshrss'
  policy: RetentionPolicy
  revision: number
  folders: Array<{ id: string; title: string }>
  feeds: Array<{ id: string; title: string; folderIds: string[] }>
  lastRun: RetentionRun | null
  cacheRun: { at: number; deleted: number } | null
  error: string
}
export interface RetentionPreview extends RetentionCounts { token: string }
