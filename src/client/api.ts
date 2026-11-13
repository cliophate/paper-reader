import type { OrganizationRequest, OrganizationResponse, OrganizationView } from '../shared/organization'
import type { PulsePayload } from '../shared/pulse'
import type { ConnectionsSettings, ConnectionsUpdate } from '../shared/connections'
import type { ActivityRecord, ArticleReport, BriefingDetail, BriefingSummary, CoverageFeedback, Entry, EntryPage, FullArticle, MuteFilter, NavigationPayload, StreamRef, XThreadPost } from './types'

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly currentRevision?: number, readonly states?: Record<string, { read: boolean; starred: boolean; revision: number }>) { super(message) }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init?.signal || (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(90000) : undefined),
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(payload?.error || `Request failed with ${response.status}`, response.status, payload?.code, payload?.currentRevision, payload?.states)
  return payload as T
}

function sourceRequestSignal(signal?: AbortSignal): AbortSignal | undefined {
  return signal && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : signal
}

export const api = {
  organization: (refresh = false, signal?: AbortSignal) => request<OrganizationView>(`/api/organization${refresh ? '?refresh=1' : ''}`, { signal: sourceRequestSignal(signal) }),
  organize: (requestBody: OrganizationRequest) => request<OrganizationResponse>('/api/organization/commands', { method: 'POST', body: JSON.stringify(requestBody) }),
  connections: () => request<ConnectionsSettings>('/api/settings/connections'),
  updateConnections: (settings: ConnectionsUpdate) => request<ConnectionsSettings>('/api/settings/connections', { method: 'PATCH', body: JSON.stringify(settings) }),
  recentReading: () => request<Entry[]>('/api/reading'),
  saveProgress: (id: string, position: number) => request<{ ok: boolean }>('/api/reading', { method: 'POST', body: JSON.stringify({ id, position }), keepalive: true }),
  previewFilter: (phrase: string, scope: string, feedId: string) => request<{ count: number; items: Entry[] }>('/api/filters/preview', { method: 'POST', body: JSON.stringify({ phrase, scope, feedId }) }),
  previewFeed: (url: string) => request<{ url: string; title: string; items: Array<{ title: string; date: string }> }>('/api/feeds/preview', { method: 'POST', body: JSON.stringify({ url }) }),
  repairFeed: (id: string, url: string, expectedUrl: string) => request<{ ok: boolean }>('/api/feeds/repair', { method: 'POST', body: JSON.stringify({ id, url, expectedUrl }) }),
  previewRead: (stream: StreamRef, query: string, after: string, before: string) => request<{ token: string; count: number }>('/api/streams/preview-read', { method: 'POST', body: JSON.stringify({ stream, query, after, before }) }),
  confirmRead: (token: string) => request<{ count: number; undoToken: string }>('/api/streams/confirm-read', { method: 'POST', body: JSON.stringify({ token }) }),
  navigation: () => request<NavigationPayload>('/api/navigation'),
  briefings: () => request<BriefingSummary[]>('/api/briefings'),
  briefing: (id: string) => request<BriefingDetail>(`/api/briefings/${encodeURIComponent(id)}`),
  briefingFeedback: (id: string, feedback: 'useful' | 'too_broad' | 'missed') =>
    request<{ ok: boolean; feedback: string }>(`/api/briefings/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify({ feedback }) }),
  pulse: () => request<PulsePayload>('/api/pulse'),
  visitPulse: (collectionId: string, sequence: number) => request<{ ok: boolean }>('/api/pulse/visit', { method: 'POST', body: JSON.stringify({ collectionId, sequence }), keepalive: true }),
  pulseFeedback: (action: 'not_same' | 'not_useful' | 'merge', clusterId: string, entryId = '', targetClusterId = '') =>
    request<CoverageFeedback>('/api/pulse/feedback', { method: 'POST', body: JSON.stringify({ action, clusterId, entryId, targetClusterId }) }),
  removePulseFeedback: (id: string) => request<{ ok: boolean }>(`/api/pulse/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  activity: (limit = 100) => request<ActivityRecord[]>(`/api/activity?limit=${limit}`),
  filters: () => request<MuteFilter[]>('/api/filters'),
  addFilter: (phrase: string, scope: MuteFilter['scope'], feedId = '') =>
    request<MuteFilter>('/api/filters', { method: 'POST', body: JSON.stringify({ phrase, scope, feedId }) }),
  removeFilter: (id: string) => request<{ ok: boolean }>(`/api/filters/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reports: () => request<ArticleReport[]>('/api/reports'),
  reportArticle: (entryId: string, issue: ArticleReport['issue'], note: string, client: Record<string, unknown>) =>
    request<ArticleReport>('/api/reports', { method: 'POST', body: JSON.stringify({ entryId, issue, note, client }) }),
  setReportStatus: (id: string, status: ArticleReport['status']) =>
    request<{ ok: boolean }>(`/api/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  status: (signal?: AbortSignal) => request<{
    backend: 'standalone' | 'freshrss'
    backendInstance: string
    discussionConfigured: boolean
    readwiseConfigured: boolean
    kirbyConfigured: boolean
    briefingConfigured: boolean
    sync: { lastCompletedAt: string | null; running?: boolean; lastError?: string | null }
  }>('/api/status', { signal: sourceRequestSignal(signal) }),
  sync: () => request<{ ok: boolean }>('/api/sync', { method: 'POST' }),
  setStreamOrder: (stream: StreamRef, order: 'newest' | 'oldest') => request<{ ok: boolean; order: 'newest' | 'oldest' }>('/api/streams/order', { method: 'POST', body: JSON.stringify({ stream, order }) }),
  entries: (stream: StreamRef, unread: boolean, query = '', continuation = '', signal?: AbortSignal, dates: { after?: string; before?: string } = {}) => {
    const params = new URLSearchParams({ kind: stream.kind, id: stream.id, title: stream.title, unread: unread ? '1' : '0' })
    if (query) params.set('q', query)
    if (dates.after) params.set('after', dates.after)
    if (dates.before) params.set('before', dates.before)
    if (continuation) params.set('continuation', continuation)
    return request<EntryPage>(`/api/entries?${params}`, { signal })
  },
  entryByNumber: (number: number) => request<{ entry: Entry }>(`/api/entries/number/${number}`),
  entry: (id: string) => request<{ entry: Entry | null }>('/api/entries/item', { method: 'POST', body: JSON.stringify({ id }) }),
  editState: (ids: string[], operation: 'read' | 'unread' | 'star' | 'unstar', origin: 'reader' | 'pulse' | 'automatic' = 'reader', options: { expectedRevisions?: Record<string, number>; undo?: boolean } = {}) =>
    request<{ ok: boolean; revisions?: Record<string, number>; undoToken?: string }>('/api/entries/state', { method: 'POST', body: JSON.stringify({ ids, operation, origin, ...options }) }),
  markStreamRead: (stream: StreamRef) =>
    request<{ ok: boolean; count: number; undoToken?: string }>('/api/streams/mark-read', { method: 'POST', body: JSON.stringify(stream) }),
  markRelativeRead: (stream: StreamRef, anchorId: string, direction: 'above' | 'below', unreadOnly: boolean, query: string, order?: 'newest' | 'oldest', dates: { after?: string; before?: string } = {}) =>
    request<{ ok: boolean; count: number; ids: string[]; undoToken?: string }>('/api/streams/mark-relative-read', {
      method: 'POST',
      body: JSON.stringify({ stream, anchorId, direction, unreadOnly, query, order, ...dates }),
    }),
  undo: (token: string) => request<{ ok: boolean; count: number }>('/api/undo', { method: 'POST', body: JSON.stringify({ token }) }),
  saveReadwise: (url: string, title: string) =>
    request<{ ok: boolean; savedAt: string }>('/api/readwise', { method: 'POST', body: JSON.stringify({ url, title }) }),
  createKirbyNote: (title: string, sourceUrl: string, quote: string) =>
    request<{ ok: boolean; result: { id: string; panelUrl: string; url: string } }>('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title, sourceUrl, quote }),
    }),
  fullText: (url: string, refresh = false) =>
    request<FullArticle>('/api/fulltext', { method: 'POST', body: JSON.stringify({ url, refresh }) }),
  xThread: (url: string) =>
    request<{ posts: XThreadPost[] }>('/api/x/thread', { method: 'POST', body: JSON.stringify({ url }) }),
  addFeed: (url: string, title = '', folder = '') => request<{ ok: boolean }>('/api/feeds', { method: 'POST', body: JSON.stringify({ url, title, folder }) }),
  updateFeed: (id: string, title: string, folder: string, currentFolder: string) => request<{ ok: boolean }>('/api/feeds', { method: 'PATCH', body: JSON.stringify({ id, title, folder, currentFolder }) }),
  removeFeed: (id: string) => request<{ ok: boolean }>('/api/feeds', { method: 'DELETE', body: JSON.stringify({ id }) }),
}
