import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingService, resolveWritersFolder } from '../src/server/briefing.js'
import { PaperDatabase } from '../src/server/db.js'
import type { EntrySource } from '../src/server/backend.js'
import type { Config } from '../src/server/config.js'
import type { NavigationPayload, StreamRef } from '../src/server/types.js'

const navigation = (folders: Array<[string, string]>): NavigationPayload => ({
  unread: 0, starred: 0, uncategorized: [], folders: folders.map(([id, title]) => ({ id, title, unread: 0, feeds: [] })),
})

describe('Writers folder resolution', () => {
  it('uses an opaque navigation ID and follows stable identity through a rename', () => {
    expect(resolveWritersFolder(navigation([['opaque:42', 'Writers']]), true)).toEqual({
      status: 'found', stream: { kind: 'category', id: 'opaque:42', title: 'Writers' },
    })
    expect(resolveWritersFolder(navigation([['opaque:42', 'Essays'], ['opaque:99', 'Writers']]), true, 'opaque:42').stream?.id).toBe('opaque:42')
  })

  it('distinguishes a missing default, a deleted selected folder, and ambiguous titles', () => {
    expect(resolveWritersFolder(navigation([]), true)).toEqual({ status: 'missing', stream: null })
    expect(resolveWritersFolder(navigation([['replacement', 'Writers']]), true, 'deleted')).toEqual({ status: 'disappeared', stream: null })
    expect(resolveWritersFolder(navigation([['one', 'Writers'], ['two', 'Writers']]), false)).toEqual({ status: 'ambiguous', stream: null })
  })

  it('resolves FreshRSS by its current navigation title instead of retaining name-based IDs', () => {
    expect(resolveWritersFolder(navigation([['remote:renamed', 'Essays']]), false, 'remote:old')).toEqual({ status: 'missing', stream: null })
    expect(resolveWritersFolder(navigation([['remote:new', 'Writers']]), false, 'remote:old').stream?.id).toBe('remote:new')
    expect(resolveWritersFolder(navigation([]), false, 'remote:old').stream).toBeNull()
  })
})

describe('briefing candidate reads', () => {
  let directory: string
  let db: PaperDatabase
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-briefing-folders-'))
    db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
  })
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

  function fixture(local: boolean) {
    db.bindBackend({ id: 'fixture:briefing', kind: local ? 'standalone' : 'freshrss' })
    const getNavigation = vi.fn().mockResolvedValue(navigation([['opaque:chosen', 'Writers']]))
    const read = vi.fn(async (_stream: StreamRef) => { throw new Error('Synthetic stop after candidate lookup') })
    const source: EntrySource = {
      navigation: getNavigation, entries: read, entriesPage: async () => ({ items: [], continuation: '' }),
      entry: async () => null, entryIds: async () => [],
      ...(local ? { briefingEntries: read } : {}),
    }
    const config = { ai: { briefingsEnabled: true }, codex: { enabled: true }, briefing: { includeReadUntil: '' } } as Config
    return { service: new BriefingService(config, db, source), getNavigation, read }
  }

  it('persists the selected standalone ID across service restart and avoids a deleted or replacement folder', async () => {
    const { service, getNavigation, read } = fixture(true)
    await expect(service.generate('morning', true)).rejects.toThrow(/Synthetic stop/)
    expect(read.mock.calls.map(([stream]) => stream.id)).toEqual(['opaque:chosen', 'all'])
    expect(db.getSyncValue('briefing_writers_folder_id')).toBe('opaque:chosen')
    db.close()
    db = new PaperDatabase(path.join(directory, 'paper.sqlite'))
    const restarted = fixture(true)
    restarted.getNavigation.mockResolvedValue(navigation([['opaque:chosen', 'Essays']]))
    await expect(restarted.service.generate('morning', true)).rejects.toThrow(/Synthetic stop/)
    expect(restarted.read.mock.calls[0][0]).toEqual({ kind: 'category', id: 'opaque:chosen', title: 'Essays' })
    restarted.getNavigation.mockResolvedValue(navigation([['different', 'Writers']]))
    restarted.read.mockClear()
    await expect(restarted.service.generate('morning', true)).rejects.toThrow(/Synthetic stop/)
    expect(restarted.read.mock.calls.map(([stream]) => stream.id)).toEqual(['all'])
    expect(getNavigation).toHaveBeenCalledTimes(1)
  })

  it('keeps FreshRSS current-title behavior and fails before reading on ambiguous lookup', async () => {
    const { service, getNavigation, read } = fixture(false)
    await expect(service.generate('morning', true)).rejects.toThrow(/Synthetic stop/)
    expect(read.mock.calls[0][0].id).toBe('opaque:chosen')
    expect(db.getSyncValue('briefing_writers_folder_id')).toBe('')
    getNavigation.mockResolvedValue(navigation([['opaque:renamed', 'Essays']]))
    read.mockClear()
    await expect(service.generate('morning', true)).rejects.toThrow(/Synthetic stop/)
    expect(read.mock.calls.map(([stream]) => stream.id)).toEqual(['all'])
    getNavigation.mockResolvedValue(navigation([['new', 'Writers']]))
    read.mockClear()
    await expect(service.generate('morning', true)).rejects.toThrow(/Synthetic stop/)
    expect(read.mock.calls[0][0].id).toBe('new')
    getNavigation.mockResolvedValue(navigation([['one', 'Writers'], ['two', 'Writers']]))
    read.mockClear()
    await expect(service.generate('morning', true)).rejects.toThrow(/More than one Writers folder/)
    expect(read).not.toHaveBeenCalled()
  })
})
