import { describe, expect, it, vi } from 'vitest'
import { switchingEntrySource, type EntrySource } from '../src/server/repository'

describe('first import activation', () => {
  it('switches existing consumers to the local source when backfill completes', async () => {
    let ready = false
    const source = (label: string) => ({
      navigation: vi.fn(async () => ({ label })), entry: vi.fn(async () => ({ label })),
      entries: vi.fn(async () => [{ label }]), entriesPage: vi.fn(async () => ({ items: [{ label }], continuation: '' })),
      entryIds: vi.fn(async () => [label]),
    }) as unknown as EntrySource
    const remote = source('remote'), local = source('local')
    const shared = switchingEntrySource(() => ready, local, remote)
    const stream = { kind: 'all' as const, id: 'all', title: 'All' }
    expect(await shared.entryIds(stream)).toEqual(['remote'])
    ready = true
    expect(await shared.entryIds(stream)).toEqual(['local'])
    expect(await shared.navigation()).toEqual({ label: 'local' })
    expect(await shared.entry('one')).toEqual({ label: 'local' })
    expect(await shared.briefingEntries!(stream, { before: new Date() })).toEqual([{ label: 'local' }])
  })
})
