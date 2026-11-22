export interface FeedRedirect { status: number; url: string }
export interface FeedMove {
  redirects: FeedRedirect[]
  declaredUrl: string
  suggestedUrl: string
}
export type StaleDays = [number, number, number]
export interface FeedMaintenance {
  staleDays: StaleDays
  articleCounts: Record<string, number>
}
export interface FeedCheckStatus {
  finalUrl?: string
  publisherSiteUrl?: string
  move?: FeedMove
  feedId: string
  lastSuccessAt: number
  nextFetchAt: number
  failures: number
  lastError: string
  lastStatus: number
  retryAfterUntil: number
  cooldownUntil: number
  intervalMinutes: number | null
  state: 'idle' | 'queued' | 'running'
}
export interface FeedChecksView {
  backend: 'standalone' | 'freshrss' | 'miniflux'
  enabled: boolean
  revision: number
  organizationRevision: number
  intervalMinutes: number
  feeds: FeedCheckStatus[]
  folders: Array<{ id: string; title: string }>
}
export interface FeedCheckRevision { expectedRevision: number; expectedOrganizationRevision: number }
export type FeedCheckTarget = { feedId: string } | { folderId: string | null }
export interface FeedCheckResult {
  feedId: string
  status: 'queued' | 'running' | 'cooldown' | 'retry-after' | 'unavailable' | 'queue-full'
  until?: number
}
