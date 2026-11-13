import type { PaperDatabase, PageOptions } from './db.js'
import type { EntryOptions, EntryPageOptions, EntrySource } from './backend.js'
import type { StreamRef } from './types.js'

export type { EntrySource } from './backend.js'

// Keep a stable source reference while the first background import completes.
export function switchingEntrySource(useLocal: () => boolean, local: EntrySource, remote: EntrySource): EntrySource {
  const current = () => useLocal() ? local : remote
  return {
    navigation: signal => current().navigation(signal),
    entry: (id, signal) => current().entry(id, signal),
    entries: (stream, options) => current().entries(stream, options),
    entriesPage: (stream, options) => current().entriesPage(stream, options),
    entryIds: (stream, unreadOnly, signal) => current().entryIds(stream, unreadOnly, signal),
    briefingEntries: (stream, options) => {
      const source = current()
      return source.briefingEntries ? source.briefingEntries(stream, options) : source.entries(stream, options)
    },
  }
}

export class PaperRepository implements EntrySource {
  constructor(private readonly db: PaperDatabase) {}

  async briefingEntries(stream: StreamRef, options: { unreadOnly?: boolean; limit?: number; before: Date; signal?: AbortSignal }) {
    options.signal?.throwIfAborted()
    return this.db.briefingEntries(stream, options)
  }

  async navigation(signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.db.localNavigation()
  }

  async entries(stream: StreamRef, options: EntryOptions = {}) {
    options.signal?.throwIfAborted()
    return this.db.localEntries(stream, options)
  }

  async entriesPage(stream: StreamRef, options: PageOptions & EntryPageOptions = {}) {
    options.signal?.throwIfAborted()
    return this.db.localEntriesPage(stream, options)
  }

  async entry(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.db.localEntry(id)
  }

  async entryIds(stream: StreamRef, unreadOnly = false, signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.db.localEntryIds(stream, unreadOnly)
  }
}
