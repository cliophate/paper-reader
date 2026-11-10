import type { PaperDatabase, PageOptions } from './db.js'
import type { EntryOptions, EntrySource } from './backend.js'
import type { StreamRef } from './types.js'

export type { EntrySource } from './backend.js'

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

  async entries(stream: StreamRef, options: EntryOptions = {}) {
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
