import { describe, expect, it, vi } from 'vitest'
import type { EntrySource } from '../src/server/backend.js'
import { switchingEntrySource } from '../src/server/repository.js'

describe('first import activation', () => {
  it('switches existing consumers to the local source when backfill completes', async () => {
    let ready = false
    const source = (label: string) => ({
      navigation: vi.fn(async () => ({ unread: 0, starred: 0, folders: [], uncategorized: [] })),
      entry: vi.fn(async () => null), entries: vi.fn(async () => []),
      entriesPage: vi.fn(async () => ({ items: [], continuation: label })),
      entryIds: vi.fn(async () => [label]),
    } satisfies EntrySource)
    const remote = source('remote'), local = source('local')
    const shared = switchingEntrySource(() => ready, local, remote)
    const stream = { kind: 'all' as const, id: 'all', title: 'All' }
    expect(await shared.entryIds(stream)).toEqual(['remote'])
    const pageOptions = { unreadOnly: true, limit: 10, continuation: 'page-2', query: 'fixture' }
    expect(await shared.entriesPage(stream, pageOptions)).toEqual({ items: [], continuation: 'remote' })
    expect(remote.entriesPage).toHaveBeenCalledWith(stream, pageOptions)
    ready = true
    expect(await shared.entryIds(stream)).toEqual(['local'])
    await shared.navigation()
    expect(local.navigation).toHaveBeenCalledOnce()
    expect(remote.navigation).not.toHaveBeenCalled()
    expect(await shared.entry('one')).toBeNull()
    expect(local.entry).toHaveBeenCalledWith('one')
    expect(await shared.entriesPage(stream, pageOptions)).toEqual({ items: [], continuation: 'local' })
    expect(local.entriesPage).toHaveBeenCalledWith(stream, pageOptions)
    const options = { before: new Date(), after: new Date(0), unreadOnly: true, limit: 5 }
    await shared.entries(stream, options)
    expect(local.entries).toHaveBeenCalledWith(stream, options)
    await shared.briefingEntries!(stream, options)
    expect(local.entries).toHaveBeenCalledTimes(2)
    expect(local.entries).toHaveBeenLastCalledWith(stream, options)
    expect(remote.entries).not.toHaveBeenCalled()
  })

  it('uses the selected source briefing method when available', async () => {
    const source: EntrySource = {
      navigation: async () => ({ unread: 0, starred: 0, folders: [], uncategorized: [] }),
      entry: async () => null,
      entries: vi.fn(async () => []),
      entriesPage: async () => ({ items: [], continuation: '' }),
      entryIds: async () => [],
      briefingEntries: vi.fn(async () => []),
    }
    const shared = switchingEntrySource(() => true, source, source)
    const stream = { kind: 'all' as const, id: 'all', title: 'All' }
    const options = { before: new Date(), unreadOnly: false, limit: 25 }

    await shared.briefingEntries!(stream, options)

    expect(source.briefingEntries).toHaveBeenCalledWith(stream, options)
    expect(source.entries).not.toHaveBeenCalled()
  })
})
