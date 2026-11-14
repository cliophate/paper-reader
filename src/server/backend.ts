import type { Entry, NavigationPayload, StreamRef } from './types.js'
import type { BackendIdentity } from './identity.js'
import type { OrganizationCapabilities } from './organization.js'
import type { OrganizationCommand } from '../shared/organization.js'

export class BackendValidationError extends Error {}

export type FeedOperation = 'edit' | 'remove' | 'repair' | 'filter'

export type EntryStateOperation = 'read' | 'unread' | 'star' | 'unstar'

export interface EntryOptions {
  signal?: AbortSignal
  unreadOnly?: boolean
  limit?: number
  after?: Date
  before?: Date
}

export interface EntryPageOptions {
  signal?: AbortSignal
  unreadOnly?: boolean
  limit?: number
  continuation?: string
  query?: string
}

export interface BackendPageOptions extends EntryPageOptions {
  after?: Date
  before?: Date
}

export interface ImportPageOptions {
  signal?: AbortSignal
  limit: number
  continuation?: string
  changedAfter?: Date
  changedBefore: Date
}

export interface EntryPage {
  items: Entry[]
  continuation: string
}

export interface EntrySource {
  briefingEntries?(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; before: Date; signal?: AbortSignal }): Promise<Entry[]>
  navigation(signal?: AbortSignal): Promise<NavigationPayload>
  entries(stream: StreamRef, options?: EntryOptions): Promise<Entry[]>
  entriesPage(stream: StreamRef, options?: EntryPageOptions): Promise<EntryPage>
  entry(id: string, signal?: AbortSignal): Promise<Entry | null>
  entryIds(stream: StreamRef, unreadOnly?: boolean, signal?: AbortSignal): Promise<string[]>
}

export interface ReaderBackend extends EntrySource {
  initialize?(): Promise<void>
  readonly identity: BackendIdentity
  readonly organizationCapabilities: Readonly<OrganizationCapabilities>
  // IDs are opaque to callers. Adapters reject invalid input before any I/O.
  validateFeedId(id: string, operation: FeedOperation): void
  entriesPage(stream: StreamRef, options?: BackendPageOptions): Promise<EntryPage>
  entriesByIds(ids: string[], signal?: AbortSignal): Promise<Entry[]>
  // Optional native change import, independent of reader publication bounds.
  importPage?(options: ImportPageOptions): Promise<EntryPage>
  applyFeedCommand?(command: Extract<OrganizationCommand, { type: 'rename-feed' | 'move-feed' | 'unsubscribe' }>): Promise<void>
  // Set the requested state. Repeating an operation must not toggle it.
  editEntries(ids: string[], operation: EntryStateOperation): Promise<void>
  addFeed(url: string, title?: string, folder?: string): Promise<void>
  editFeed(id: string, title: string, folder: string, currentFolder: string): Promise<void>
  removeFeed(id: string): Promise<void>
  repairFeed?(id: string, url: string, expectedUrl: string): Promise<void>
}
