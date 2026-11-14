export interface FeedCheckStatus {
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
  backend: 'standalone' | 'freshrss'
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
