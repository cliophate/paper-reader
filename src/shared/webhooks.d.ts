export type WebhookKind = 'webhook' | 'ntfy' | 'apprise'
export type WebhookEvent = 'new_entries' | 'starred_entry' | 'save_entry'
export interface WebhookSubscription {
  name: string
  events: WebhookEvent[]
  feedId: string
  folderId: string
}
export interface WebhookTarget extends WebhookSubscription {
  id: string
  kind: WebhookKind
}
export interface WebhookCreate extends WebhookSubscription {
  kind: WebhookKind
  url: string
  credential?: string
}
export interface WebhookDelivery {
  id: string
  target: string
  event: WebhookEvent | 'test' | 'rule_entry' | 'overflow'
  state: 'collecting' | 'pending' | 'sending' | 'delivered' | 'failed' | 'skipped'
  attempts: number
  status: number | null
  nextRetry: number | null
  error: string
  created: number
}
export interface WebhookSettings {
  targets: WebhookTarget[]
  deliveries: WebhookDelivery[]
}
