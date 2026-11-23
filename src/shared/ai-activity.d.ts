export type ActivityFeature = 'headlines' | 'grouping' | 'catchUp' | 'briefing' | 'discussion' | 'questions' | 'suggestions' | 'connection'
export type AiTrigger = 'manual' | 'scheduled' | 'sync' | 'automatic'
export type AiOutcome = 'ok' | 'error' | 'cancelled' | 'limited' | 'running' | 'busy' | 'interrupted'
export interface ModelPrice { model: string; input: number; output: number }
export interface AiPolicy {
  daily: number | null
  featureLimits: Partial<Record<ActivityFeature, number>>
  feeds: string[]
  folders: string[]
  folderNames?: Record<string, string>
  prices: ModelPrice[]
}
export interface AiActivityItem {
  id: number
  feature: ActivityFeature
  trigger: AiTrigger
  provider: 'codex' | 'openai' | 'none'
  model: string
  started: number
  duration: number
  reason: string | null
  outcome: AiOutcome
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  estimatedUsd: number | null
}
export interface AiActivityView {
  features: Record<ActivityFeature, { label: string; sends: string; background: boolean }>
  items: AiActivityItem[]
  policy: AiPolicy
  used: Partial<Record<ActivityFeature, number>>
  timeZone: string
}
