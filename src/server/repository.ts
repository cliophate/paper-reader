import type { PaperDatabase, PageOptions } from './db.js'
import type { BriefingEntryOptions, EntryOptions, EntryPageOptions, EntrySource } from './backend.js'
import type { Entry, StreamRef } from './types.js'

export type { EntrySource } from './backend.js'

const REMOTE_PAGE_SIZE = 250
const MAX_REMOTE_BRIEFING_PAGES = 5

export async function briefingCandidates(source: EntrySource, stream: StreamRef, options: BriefingEntryOptions): Promise<Entry[]> {
  if (source.briefingEntries) return source.briefingEntries(stream, options)
  const excludedFeeds = options.excludedFeeds
  if (!options.followed?.size && !options.muted?.size && !excludedFeeds?.size) return source.entries(stream, options)

  const limit = options.limit || 1000
  const priority = new Map<string, Entry>()
  const other = new Map<string, Entry>()
  const cursors = new Set<string>()
  let continuation = ''
  let remaining = REMOTE_PAGE_SIZE * MAX_REMOTE_BRIEFING_PAGES
  while (remaining > 0) {
    options.signal?.throwIfAborted()
    const page = await source.entriesPage(stream, { ...options, limit: REMOTE_PAGE_SIZE, continuation })
    const candidates = excludedFeeds?.size ? page.items.filter(entry => !excludedFeeds.has(entry.feedId)).slice(0, remaining) : page.items
    // When exclusions are active, count only articles from eligible feeds toward the scan limit.
    remaining -= excludedFeeds?.size && page.items.length ? candidates.length : REMOTE_PAGE_SIZE
    for (const entry of candidates) {
      if (options.muted?.has(entry.id) || options.surfaced?.has(entry.id)) continue
      if (options.followed?.has(entry.id)) priority.set(entry.id, entry)
      else if (other.size < limit) other.set(entry.id, entry)
    }
    if (priority.size >= limit || (priority.size === (options.followed?.size || 0) && priority.size + other.size >= limit)) break
    continuation = page.continuation
    if (!continuation || cursors.has(continuation)) break
    cursors.add(continuation)
  }
  return [...priority.values(), ...other.values()].slice(0, limit)
}

// Keep a stable source reference while the first background import completes.
export function switchingEntrySource(useLocal: () => boolean, local: EntrySource, remote: EntrySource): EntrySource {
  const current = () => useLocal() ? local : remote
  return {
    navigation: signal => current().navigation(signal),
    entry: (id, signal) => current().entry(id, signal),
    entries: (stream, options) => current().entries(stream, options),
    entriesPage: (stream, options) => current().entriesPage(stream, options),
    entryIds: (stream, unreadOnly, signal) => current().entryIds(stream, unreadOnly, signal),
    briefingEntries: (stream, options) => briefingCandidates(current(), stream, options),
  }
}

export class PaperRepository implements EntrySource {
  constructor(private readonly db: PaperDatabase) {}

  async briefingEntries(stream: StreamRef, options: BriefingEntryOptions) {
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
