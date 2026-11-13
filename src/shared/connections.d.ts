export interface AiSettings {
  enabled: boolean
  codexEnabled: boolean
  discussionEnabled: boolean
  briefingsEnabled: boolean
  headlinesEnabled: boolean
  collectionsEnabled: boolean
}

export interface ConnectionsSettings {
  aiRuntime?: { available: boolean; message: string }
  ai: AiSettings
  readwise: { enabled: boolean; location: string; tokenConfigured: boolean; tokenSource: 'environment' | 'settings' | null }
  kirby: { enabled: boolean; publishUrl: string; tokenConfigured: boolean; tokenSource: 'environment' | 'settings' | null }
}

export interface ConnectionsUpdate {
  ai?: Partial<AiSettings>
  readwise?: { enabled?: boolean; location?: string; token?: string | null }
  kirby?: { enabled?: boolean; publishUrl?: string; token?: string | null }
}
