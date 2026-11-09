import type { PaperDatabase, PageOptions } from './db.js'
import type { Entry, NavigationPayload, StreamRef } from './types.js'

export interface EntrySource {
  briefingEntries?(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; before: Date }): Promise<Entry[]>
  navigation(): Promise<NavigationPayload>
  entries(stream: StreamRef, options?: { unreadOnly?: boolean; limit?: number; after?: Date; before?: Date }): Promise<Entry[]>
  entriesPage(stream: StreamRef, options?: { unreadOnly?: boolean; limit?: number; continuation?: string; query?: string }): Promise<{ items: Entry[]; continuation: string }>
  entry(id: string): Promise<Entry | null>
  entryIds(stream: StreamRef, unreadOnly?: boolean): Promise<string[]>
}

// Keep a stable source reference while the first background import completes.
export function switchingEntrySource(useLocal: () => boolean, local: EntrySource, remote: EntrySource): EntrySource {
  const current = () => useLocal() ? local : remote
  return {
    navigation: () => current().navigation(),
    entry: id => current().entry(id),
    entries: (stream, options) => current().entries(stream, options),
    entriesPage: (stream, options) => current().entriesPage(stream, options),
    entryIds: (stream, unreadOnly) => current().entryIds(stream, unreadOnly),
    briefingEntries: (stream, options) => {
      const source = current()
      return source.briefingEntries ? source.briefingEntries(stream, options) : source.entries(stream, options)
    },
  }
}

export class PaperRepository implements EntrySource {
  constructor(private readonly db: PaperDatabase) {}

  async briefingEntries(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; before: Date }) {
    return this.db.briefingEntries(stream, options)
  }

  async navigation() {
    return this.db.localNavigation()
  }

  async entries(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; after?: Date; before?: Date } = {}) {
    return this.db.localEntries(stream, options)
  }

  async entriesPage(stream: StreamRef, options: PageOptions = {}) {
    return this.db.localEntriesPage(stream, options)
  }

  async entry(id: string) {
    return this.db.localEntry(id)
  }

  async entryIds(stream: StreamRef, unreadOnly = false) {
    return this.db.localEntryIds(stream, unreadOnly)
  }
}
