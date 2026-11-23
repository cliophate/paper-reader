import type { DiscoveryCandidate, DiscoveryResult, ImportChoice, ImportPreview, ImportResult } from '../shared/subscription-tools'

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/subscription-tools/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'The subscription request failed.')
  return value as T
}
export const subscriptionToolsApi = {
  discover: (url: string) => request<DiscoveryResult>('discover', { url }),
  preview: (xml: string) => request<ImportPreview>('preview', { xml }),
  previewFeed: (feed: DiscoveryCandidate) => request<ImportPreview>('preview-feed', feed),
  apply: (token: string, choices: ImportChoice[]) => request<ImportResult>('apply', { token, choices }),
  export: () => request<{ xml: string; omitted: number }>('export'),
}
