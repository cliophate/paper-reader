import type { Entry, NavigationPayload, StreamRef } from './types.js'

export type EntryStateOperation = 'read' | 'unread' | 'star' | 'unstar'

export interface EntryOptions {
  unreadOnly?: boolean
  limit?: number
  after?: Date
  before?: Date
}

export interface EntryPageOptions {
  unreadOnly?: boolean
  limit?: number
  continuation?: string
  query?: string
}

export interface BackendPageOptions extends EntryPageOptions {
  after?: Date
  before?: Date
}

export interface EntryPage {
  items: Entry[]
  continuation: string
}

export interface EntrySource {
  briefingEntries?(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; before: Date }): Promise<Entry[]>
  navigation(): Promise<NavigationPayload>
  entries(stream: StreamRef, options?: EntryOptions): Promise<Entry[]>
  entriesPage(stream: StreamRef, options?: EntryPageOptions): Promise<EntryPage>
  entry(id: string): Promise<Entry | null>
  entryIds(stream: StreamRef, unreadOnly?: boolean): Promise<string[]>
}

export interface ReaderBackend extends EntrySource {
  entriesPage(stream: StreamRef, options?: BackendPageOptions): Promise<EntryPage>
  entriesByIds(ids: string[]): Promise<Entry[]>
  editEntries(ids: string[], operation: EntryStateOperation): Promise<void>
  addFeed(url: string, title?: string, folder?: string): Promise<void>
  editFeed(id: string, title: string, folder: string, currentFolder: string): Promise<void>
  removeFeed(id: string): Promise<void>
  repairFeed?(id: string, url: string, expectedUrl: string): Promise<void>
}
