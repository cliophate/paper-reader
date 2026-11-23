// @vitest-environment jsdom
import { DatabaseSync } from 'node:sqlite'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { ReadingPreferenceConflict, ReadingPreferenceStore, migrateReadingPreferences } from '../src/server/reading-preference-store'
import { ApiError } from '../src/client/api'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReadingPreferences } from '../src/client/readingPreferences'
import type { ReadingSnapshot, ReadingWrite } from '../src/server/reading-preference-values'

const empty: ReadingSnapshot = { revision: 0, generation: 0, values: {} }
let server: { readingPreferences: ReturnType<typeof vi.fn<() => Promise<ReadingSnapshot>>>; saveReadingPreferences: ReturnType<typeof vi.fn<(write: ReadingWrite) => Promise<ReadingSnapshot>>> }
let disconnect: (() => void) | undefined
function browser() {
  disconnect?.()
  const store = new ReadingPreferences(localStorage, server)
  disconnect = store.connect()
  return store
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  server = { readingPreferences: vi.fn(async () => empty), saveReadingPreferences: vi.fn() }
})
afterEach(() => { disconnect?.(); disconnect = undefined; vi.unstubAllGlobals() })

it('offers legacy settings once, keeps local choices on decline and never sends article IDs or device settings', async () => {
  localStorage.setItem('paper-reader-font', 'source')
  localStorage.setItem('paper-reader-size', 'large')
  localStorage.setItem('paper-theme', 'dark')
  localStorage.setItem('paper-full-mode:feed/one', 'always')
  localStorage.setItem('paper-full-text-feeds', JSON.stringify({ 'feed/two': { articles: ['sample'], enabled: true } }))
  const store = browser()
  await vi.waitFor(() => expect(store.getSnapshot().offer).toBe(true))
  expect(store.getSnapshot().legacy).toEqual({ font: 'source', markRead: 'automatic', spacing: 'comfortable', width: 'standard', 'fullText:feed/one': 'always', 'learned:feed/two': 'on' })
  await store.migrate(false)
  const next = browser()
  await vi.waitFor(() => expect(next.getSnapshot().overrides.font).toBe('source'))
  expect(next.getSnapshot().offer).toBe(false)
  expect(server.saveReadingPreferences).not.toHaveBeenCalled()
})

it('preserves differences as overrides even if a second browser wins the first import', async () => {
  localStorage.setItem('paper-auto-read', 'manual')
  localStorage.setItem('paper-reader-font', 'source')
  const store = browser()
  await vi.waitFor(() => expect(store.getSnapshot().offer).toBe(true))
  server.saveReadingPreferences.mockResolvedValue({ revision: 1, generation: 0, values: { font: { value: 'source', revision: 1, token: '1'.repeat(32) }, width: { value: 'wide', revision: 1, token: '1'.repeat(32) } } })
  store.migrate(true)
  await vi.waitFor(() => expect(store.getSnapshot().notices[0]?.text).toContain('device overrides'))
  expect(store.getSnapshot().overrides).toEqual({ markRead: 'manual', width: 'standard' })
  expect(store.value('font')).toBe('source')
  await store.override('width', false)
  expect(store.value('width')).toBe('wide')
})

it('uses cached values after a reload and sends only queued shared keys on reconnect', async () => {
  const shared: ReadingSnapshot = { revision: 2, generation: 0, values: { font: { value: 'source', revision: 2, token: '2'.repeat(32) } } }
  server.readingPreferences.mockResolvedValue(shared)
  const store = browser()
  await vi.waitFor(() => expect(store.value('font')).toBe('source'))
  server.saveReadingPreferences.mockRejectedValue(new TypeError('Offline'))
  await store.set('spacing', 'compact')
  await store.override('font', true)
  await store.set('font', 'literata')
  server.saveReadingPreferences.mockClear()
  const next = browser()
  await vi.waitFor(() => expect(next.value('spacing')).toBe('compact'))
  expect(next.value('font')).toBe('literata')
  await vi.waitFor(() => expect(server.saveReadingPreferences.mock.lastCall?.[0].values.spacing).toBe('compact'))
  const updated = { revision: 4, generation: 0, values: { ...shared.values, spacing: { value: 'compact', revision: 4, token: '4'.repeat(32) }, width: { value: 'wide', revision: 3, token: '3'.repeat(32) } } }
  server.saveReadingPreferences.mockResolvedValue(updated)
  window.dispatchEvent(new Event('online'))
  await vi.waitFor(() => expect(next.getSnapshot().pending).toHaveLength(0))
  expect(server.saveReadingPreferences.mock.lastCall![0].values).toEqual({ spacing: 'compact' })
  expect(next.value('width')).toBe('wide')
  server.saveReadingPreferences.mockResolvedValue({ revision: 5, generation: 1, values: {} })
  next.reset()
  await vi.waitFor(() => expect(next.getSnapshot().shared.revision).toBe(5))
  expect(next.value('spacing')).toBe('comfortable')
  expect(next.getSnapshot().overrides.font).toBe('literata')
})

it.each([408, 429, 503])('retries an edit after HTTP %i', async status => {
  const tab = browser()
  await vi.waitFor(() => expect(tab.getSnapshot().hasSnapshot).toBe(true))
  server.saveReadingPreferences.mockRejectedValueOnce(new ApiError('Try again.', status))
  await tab.set('width', 'wide')
  expect(tab.getSnapshot().pending).toHaveLength(1)
  server.saveReadingPreferences.mockResolvedValue({ revision: 1, generation: 0, values: { width: { value: 'wide', revision: 1, token: '1'.repeat(32) } } })
  await tab.sync()
  expect(tab.getSnapshot().pending).toEqual([])
  expect(tab.getSnapshot().overrides).toEqual({})
  expect(tab.value('width')).toBe('wide')
})

function liveServer() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  migrateReadingPreferences(db)
  const store = new ReadingPreferenceStore(db)
  server.readingPreferences.mockImplementation(async () => store.snapshot())
  server.saveReadingPreferences.mockImplementation(async write => {
    try { return store.write(write) } catch (error) {
      if (error instanceof ReadingPreferenceConflict) throw new ApiError(error.message, 409, error.code, undefined, undefined, error.snapshot)
      throw error
    }
  })
  return { db, store }
}

it.each(['reset', 'edit'] as const)('drops an offline width change after a competing %s and refreshes once', async action => {
  const { db, store } = liveServer()
  try {
    const tab = browser()
    await vi.waitFor(() => expect(tab.getSnapshot().hasSnapshot).toBe(true))
    await tab.set('width', 'narrow')
    server.saveReadingPreferences.mockRejectedValueOnce(new TypeError('Offline'))
    await tab.set('width', 'wide')
    const [queued] = tab.getSnapshot().pending
    const token = store.snapshot().values.width!.token
    expect(queued).toMatchObject({ generation: 0, base: { width: token } })
    store.write({ ...queued, device: 'b'.repeat(32), action, values: action === 'edit' ? { width: 'standard' } : {}, base: action === 'edit' ? { width: token } : {} })
    await tab.sync()
    expect(tab.getSnapshot().pending).toEqual([])
    expect(tab.getSnapshot().shared).toEqual(store.snapshot())
    expect(tab.value('width')).toBe('standard')
    expect(tab.getSnapshot().notices.map(notice => notice.text)).toEqual([action === 'edit' ? 'A newer value from another device replaced your offline change to width.' : 'Shared reading preferences were reset.'])
    await tab.dismissNotice()
    await tab.sync()
    expect(tab.getSnapshot().notices.map(notice => notice.text)).toEqual([])
  } finally { db.close() }
})

it('allocates writes from two offline tabs atomically and flushes both keys after reload', async () => {
  const { db, store } = liveServer()
  try {
    const first = new ReadingPreferences(localStorage, server)
    const second = new ReadingPreferences(localStorage, server)
    expect(first.getSnapshot().sequence).toBe(second.getSnapshot().sequence)
    await Promise.all([first.set('width', 'wide'), second.set('spacing', 'compact')])
    const tab = browser()
    await vi.waitFor(() => expect(store.snapshot().revision).toBe(2))
    expect(store.snapshot().values).toMatchObject({ width: { value: 'wide' }, spacing: { value: 'compact' } })
    const writes = server.saveReadingPreferences.mock.calls.map(([write]) => write)
    expect(writes.map(write => write.sequence)).toEqual([1, 2])
    expect(new Set(writes.map(write => write.device)).size).toBe(1)
    expect(new Set(writes.map(write => write.writer)).size).toBe(2)
    await vi.waitFor(() => expect(tab.getSnapshot().pending).toEqual([]))
  } finally { db.close() }
})

it.each(['one tab', 'rapid clicks', 'three tabs'])('replays three queued width edits using each preceding receipt with %s', async mode => {
  const { db, store } = liveServer()
  try {
    const offline = new ReadingPreferences(localStorage, server)
    const widths = ['narrow', 'wide', 'standard']
    if (mode === 'rapid clicks') await Promise.all(widths.map(width => offline.set('width', width)))
    else for (const width of widths) {
      const writer = mode === 'three tabs' ? new ReadingPreferences(localStorage, server) : offline
      await writer.set('width', width)
    }
    const tab = browser()
    await vi.waitFor(() => expect(tab.getSnapshot().shared.revision).toBe(3))
    const writes = server.saveReadingPreferences.mock.calls.map(([write]) => write)
    const results = await Promise.all(server.saveReadingPreferences.mock.results.map(call => call.value))
    expect(writes.map(write => write.sequence)).toEqual([1, 2, 3])
    expect(writes.map(write => write.base.width)).toEqual(['none', results[0].values.width!.token, results[1].values.width!.token])
    expect(store.snapshot().values.width?.value).toBe('standard')
    expect(tab.getSnapshot().pending).toEqual([])
    expect(tab.getSnapshot().notices).toEqual([])
  } finally { db.close() }
})

it.each([false, true])('edits the same key during its IndexedDB acknowledgement, with competing write = %s', async competing => {
  const { db, store } = liveServer()
  try {
    const tab = browser()
    await vi.waitFor(() => expect(tab.getSnapshot().hasSnapshot).toBe(true))
    let narrowToken: string | undefined
    if (competing) {
      // A lost response is retried after another device has changed the key.
      server.saveReadingPreferences.mockImplementationOnce(async write => {
        const saved = store.write(write)
        narrowToken = saved.values.width!.token
        store.write({ ...write, device: 'c'.repeat(32), base: { width: narrowToken }, values: { width: 'standard' } })
        return store.write(write)
      })
    }
    let second: Promise<void> | undefined
    const put = IDBObjectStore.prototype.put
    const writing = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
      const request = put.call(this, value, key)
      if (value.shared.revision > 0 && !second) {
        expect(tab.getSnapshot().shared.revision).toBe(0)
        second = tab.set('width', 'wide')
      }
      return request
    })
    try {
      await tab.set('width', 'narrow')
      expect(second).toBeDefined()
      await second
      narrowToken ??= (await server.saveReadingPreferences.mock.results[0].value).values.width!.token
      expect(server.saveReadingPreferences.mock.calls.map(([write]) => write.base.width)).toEqual(['none', narrowToken])
      expect(tab.getSnapshot().notices.map(notice => notice.text)).toEqual(competing ? ['A newer value from another device replaced your offline change to width.'] : [])
      expect(tab.value('width')).toBe(competing ? 'standard' : 'wide')
    } finally { writing.mockRestore() }
  } finally { db.close() }
})

it('keeps Standard as the base when Wide is selected during the first Narrow snapshot commit', async () => {
  const { db, store } = liveServer()
  const tab = new ReadingPreferences(localStorage, server)
  try {
    const narrow = store.write({ device: 'b'.repeat(32), writer: 'b'.repeat(32), sequence: 1, generation: 0,
      action: 'edit', base: { width: 'none' }, values: { width: 'narrow' } })
    const put = IDBObjectStore.prototype.put
    let click: Promise<void> | undefined
    const committing = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (state, key) {
      const request = put.call(this, state, key)
      if (state.shared.values.width?.token === narrow.values.width!.token && !click) {
        expect(tab.value('width')).toBe('standard')
        click = tab.set('width', 'wide')
      }
      return request
    })
    try {
      disconnect = tab.connect()
      await vi.waitFor(() => expect(tab.getSnapshot().notices[0]?.text).toContain('newer value from another device'))
      await click
      expect(server.saveReadingPreferences.mock.calls[0][0].base.width).toBe('none')
      expect(tab.getSnapshot().shared).toEqual(store.snapshot())
      expect(tab.value('width')).toBe('narrow')
      expect(store.snapshot().revision).toBe(1)
    } finally { committing.mockRestore() }
  } finally { db.close() }
})

it('keeps the displayed Standard token while another tab commits its Narrow acknowledgement', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  const { db, store } = liveServer()
  const other = new ReadingPreferences(localStorage, server)
  const stop = other.connect()
  try {
    await vi.waitFor(() => expect(other.getSnapshot().hasSnapshot).toBe(true))
    await other.set('width', 'standard')
    const standard = store.snapshot().values.width!
    const tab = browser()
    await vi.waitFor(() => expect(tab.getSnapshot().shared.values.width).toEqual(standard))
    const put = IDBObjectStore.prototype.put
    let click: Promise<void> | undefined
    const committing = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (state, key) {
      const request = put.call(this, state, key)
      if (state.shared.values.width?.value === 'narrow' && !click) {
        expect(tab.value('width')).toBe('standard')
        click = tab.set('width', 'wide')
      }
      return request
    })
    try {
      await other.set('width', 'narrow')
      expect(click).toBeDefined()
      await click
      const wide = server.saveReadingPreferences.mock.calls.find(([write]) => write.values.width === 'wide')
      expect(wide?.[0].base.width).toBe(standard.token)
      expect(tab.getSnapshot().notices.map(n => n.text)).toEqual(['A newer value from another device replaced your offline change to width.'])
      expect(tab.value('width')).toBe('narrow')
      expect(store.snapshot().values.width?.value).toBe('narrow')
    } finally { committing.mockRestore() }
  } finally { stop(); db.close() }
})

it('rejects offline Wide after a same-store backup reaches revision one again with Standard', async () => {
  const { db, store } = liveServer()
  try {
    const tab = browser()
    await vi.waitFor(() => expect(tab.getSnapshot().hasSnapshot).toBe(true))
    db.exec('SAVEPOINT backup')
    await tab.set('width', 'narrow')
    server.saveReadingPreferences.mockRejectedValueOnce(new TypeError('Offline'))
    await tab.set('width', 'wide')
    const [queued] = tab.getSnapshot().pending
    const old = tab.getSnapshot().shared
    db.exec('ROLLBACK TO backup; RELEASE backup')
    store.write({ ...queued, device: 'b'.repeat(32), base: { width: 'none' }, values: { width: 'standard' } })
    const restored = store.snapshot()
    expect(restored).toMatchObject({ storeId: old.storeId, generation: old.generation, revision: 1 })
    expect(old.revision).toBe(1)
    expect(queued.base.width).toBe(old.values.width!.token)
    expect(restored.values.width!.token).not.toBe(queued.base.width)
    await tab.sync()
    expect(store.snapshot()).toEqual(restored)
    expect(tab.getSnapshot().shared).toEqual(restored)
    expect(tab.value('width')).toBe('standard')
    expect(tab.getSnapshot().pending).toEqual([])
    expect(tab.getSnapshot().notices.map(n => n.text)).toEqual(['A newer value from another device replaced your offline change to width.'])
  } finally { db.close() }
})

it.each(['revision', 'generation', 'store ID', 'legacy conflict'] as const)('discards offline edits when a backup changes the %s', async kind => {
  const { db, store } = liveServer()
  try {
    const tab = browser()
    await vi.waitFor(() => expect(tab.getSnapshot().hasSnapshot).toBe(true))
    await tab.set('width', 'narrow')
    db.exec('SAVEPOINT backup')
    if (kind === 'generation') await tab.reset()
    await tab.set('width', 'wide')
    await tab.override('font', true)
    await tab.set('font', 'source')
    server.saveReadingPreferences.mockRejectedValueOnce(new TypeError('Offline'))
    await tab.set('spacing', 'compact')
    server.saveReadingPreferences.mockRejectedValueOnce(new TypeError('Offline'))
    await tab.set('width', 'standard')
    db.exec('ROLLBACK TO backup; RELEASE backup')
    // A replacement store can already have reached the cached revision. A
    // restored generation can also be older even after new edits arrive.
    if (kind === 'generation' || kind === 'store ID') {
      if (kind === 'store ID') db.exec("UPDATE sync_state SET value = lower(hex(randomblob(16))) WHERE key = 'reading_preferences_id'")
      db.prepare("UPDATE sync_state SET value = ? WHERE key = 'reading_preferences_revision'").run(String(tab.getSnapshot().shared.revision))
    }
    const backup = store.snapshot()
    if (kind === 'legacy conflict') server.saveReadingPreferences.mockRejectedValueOnce(new ApiError('A newer value replaced your edit.', 409, 'reading-key'))
    await tab.sync()
    expect(store.snapshot()).toEqual(backup)
    expect(tab.getSnapshot().shared).toEqual(backup)
    expect(tab.getSnapshot().pending).toEqual([])
    expect(tab.value('width')).toBe('narrow')
    expect(tab.value('font')).toBe('source')
    expect(tab.getSnapshot().notices.map(notice => notice.text)).toEqual(['Paper loaded the restored reading preferences. Paper discarded queued changes.'])
    await tab.set('spacing', 'spacious')
    expect(store.snapshot().values.spacing?.value).toBe('spacious')
    expect(tab.getSnapshot().notices).toHaveLength(1)
  } finally { db.close() }
})

it('keeps a dismissed notice hidden when the page closes before its transaction commits', async () => {
  localStorage.setItem('paper-reader-font', 'source')
  server.readingPreferences.mockResolvedValue({ revision: 1, generation: 0, values: {} })
  const tab = browser()
  await vi.waitFor(() => expect(tab.getSnapshot().notices).toHaveLength(1))
  const interrupted = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => ({} as IDBOpenDBRequest))
  void tab.dismissNotice()
  expect(tab.getSnapshot().notices).toEqual([])
  interrupted.mockRestore()
  const next = browser()
  const seen: string[] = []
  next.subscribe(() => seen.push(...next.getSnapshot().notices.map(notice => notice.text)))
  await vi.waitFor(() => expect(next.getSnapshot().overrides.font).toBe('source'))
  expect(seen).toEqual([])
  expect(next.getSnapshot().notices).toEqual([])
})

it('adopts a restored snapshot on refresh and ignores an older response from another tab', async () => {
  const { db, store } = liveServer()
  const first = new ReadingPreferences(localStorage, server)
  const stop = first.connect()
  try {
    await vi.waitFor(() => expect(first.getSnapshot().hasSnapshot).toBe(true))
    await first.set('width', 'narrow')
    const backup = store.snapshot()
    db.exec('SAVEPOINT backup')
    await first.set('width', 'wide')
    const beforeRestore = store.snapshot()
    let reply!: (snapshot: ReadingSnapshot) => void
    server.readingPreferences.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
    const inFlight = first.sync()
    await vi.waitFor(() => expect(reply).toBeDefined())
    db.exec('ROLLBACK TO backup; RELEASE backup')
    const second = browser()
    await vi.waitFor(() => expect(second.getSnapshot().shared).toEqual(backup))
    reply(beforeRestore)
    await inFlight
    expect(first.getSnapshot().shared).toEqual(backup)
    expect(first.getSnapshot().notices).toHaveLength(1)
  } finally { stop(); db.close() }
})
