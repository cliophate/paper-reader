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

export interface ConnectionsSettings {
  aiRuntime?: { available: boolean; message: string }
  openai: OpenAiSettings
  ai: AiSettings
  readwise: { enabled: boolean; location: string; tokenConfigured: boolean; tokenSource: 'environment' | 'settings' | null }
  kirby: { enabled: boolean; publishUrl: string; tokenConfigured: boolean; tokenSource: 'environment' | 'settings' | null }
}

export interface ConnectionsUpdate {
  ai?: Partial<AiSettings>
  openai?: Partial<Omit<OpenAiSettings, 'tokenConfigured' | 'tokenSource'>> & { token?: string | null }
  readwise?: { enabled?: boolean; location?: string; token?: string | null }
  kirby?: { enabled?: boolean; publishUrl?: string; token?: string | null }
}
