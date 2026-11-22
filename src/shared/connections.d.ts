import type { BriefingDeliverySettings, BriefingSchedule, SmtpUpdate } from './briefing-delivery.js'

export type AiProvider = 'none' | 'codex' | 'openai'

export interface OpenAiSettings {
  baseUrl: string
  discussionModel: string
  headlinesModel: string
  groupingModel: string
  shortlistModel: string
  editorModel: string
  tokenConfigured: boolean
  tokenSource: 'environment' | 'settings' | null
}

export interface AiSettings {
  provider: AiProvider
  enabled: boolean
  codexEnabled: boolean
  discussionEnabled: boolean
  briefingsEnabled: boolean
  headlinesEnabled: boolean
  collectionsEnabled: boolean
}

export type SaveDestinationId = 'linkding' | 'wallabag' | 'readeck' | 'raindrop' | 'linkwarden'
export type DestinationSecret = 'token' | 'clientId' | 'clientSecret' | 'username' | 'password'
export type DestinationUpdate = { enabled?: boolean; baseUrl?: string } & Partial<Record<DestinationSecret, string | null>>
export interface SaveDestination {
  id: SaveDestinationId
  name: string
}
export interface DestinationSettings extends SaveDestination {
  enabled: boolean
  baseUrl: string
  savedSecrets: DestinationSecret[]
}

export interface ConnectionsSettings {
  saveDestinations: DestinationSettings[]
  briefingDelivery: BriefingDeliverySettings
  aiRuntime?: { available: boolean; message: string }
  openai: OpenAiSettings
  ai: AiSettings
  readwise: { enabled: boolean; location: string; tokenConfigured: boolean; tokenSource: 'environment' | 'settings' | null }
  kirby: { enabled: boolean; publishUrl: string; tokenConfigured: boolean; tokenSource: 'environment' | 'settings' | null }
}

export interface ConnectionsUpdate extends Partial<Record<SaveDestinationId, DestinationUpdate>> {
  smtp?: SmtpUpdate
  briefingSchedule?: Partial<BriefingSchedule>
  ai?: Partial<AiSettings>
  openai?: Partial<Omit<OpenAiSettings, 'tokenConfigured' | 'tokenSource'>> & { token?: string | null }
  readwise?: { enabled?: boolean; location?: string; token?: string | null }
  kirby?: { enabled?: boolean; publishUrl?: string; token?: string | null }
}
