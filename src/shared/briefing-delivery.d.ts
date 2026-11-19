export type BriefingKind = 'morning' | 'evening'
export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface SmtpFields {
  host: string
  port: number
  security: SmtpSecurity
  user: string
  from: string
  to: string
}

export interface BriefingSchedule {
  enabled: boolean
  morning: string
  evening: string
}

export interface BriefingDeliverySettings {
  smtp: SmtpFields & { passwordConfigured: boolean; passwordSource: 'settings' | 'environment' | null }
  schedule: BriefingSchedule
  timeZone: string
}

export type SmtpUpdate = Partial<SmtpFields> & { password?: string | null }
export type DeliveryState = 'pending' | 'generating' | 'ready' | 'sending' | 'retrying' | 'delivered' | 'failed' | 'unconfirmed' | 'skipped' | 'missed'

export interface DeliveryHistoryItem {
  id: string
  kind: BriefingKind
  scheduledAt: number
  state: DeliveryState
  attempts: number
  lastError: string | null
}
