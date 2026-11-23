// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, ApiError } from '../src/client/api'
import { clearArticleEdits, lockArticleEdits, overlayQueuedEdits, queueArticleEdit, replayArticleEdits } from '../src/client/offlineQueue'
import type { Entry } from '../src/client/types'

const entry = { id: 'one', read: false, starred: false } as Entry
const queue = (field: 'read' | 'starred', from: boolean, to: boolean) =>
  queueArticleEdit({ id: entry.id, kind: 'state', field, from, to })
const stored = async () => (await overlayQueuedEdits([{ ...entry }]))[0]
const apply = vi.fn(async (_event: unknown) => {})
const patchCopy = vi.fn(async (_id: string, _patch: Partial<Entry>) => {})
const replay = () => replayArticleEdits(patchCopy, apply)
const saved = { ok: true, revisions: {}, undoToken: undefined, modifiedAtMs: undefined }

beforeEach(async () => { lockArticleEdits(false); await clearArticleEdits(); apply.mockClear(); patchCopy.mockClear() })
afterEach(() => vi.restoreAllMocks())

it('keeps only the interrupted star after the read succeeds, including for a legacy download without a modification clock', async () => {
  await Promise.all([queue('read', entry.read, true), queue('starred', entry.starred, true)])
  vi.spyOn(api, 'offlineState').mockResolvedValue({ read: false, starred: false })
  const send = vi.spyOn(api, 'editState').mockResolvedValueOnce(saved).mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue(saved)
  await expect(replay()).rejects.toThrow('disconnected')
  expect(await stored()).toEqual({ ...entry, starred: true })
  await replay()
  expect(send.mock.calls.map(call => call[1])).toEqual(['read', 'star', 'star'])
  expect(await stored()).toEqual(entry)
})

it('checks live state after a dropped write response and does not repeat the delivered write', async () => {
  await queue('starred', false, true)
  const live = vi.spyOn(api, 'offlineState').mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...entry, starred: true })
  const send = vi.spyOn(api, 'editState').mockRejectedValueOnce(new TypeError('response lost'))
  await expect(replay()).rejects.toThrow('response lost')
  expect((await stored()).starred).toBe(true)
  await replay()
  expect(live).toHaveBeenCalledTimes(2)
  expect(send).toHaveBeenCalledTimes(1)
  expect(await stored()).toEqual(entry)
})

it('finishes the offline copy after an interruption without sending the confirmed edit again', async () => {
  await queue('starred', false, true)
  vi.spyOn(api, 'offlineState').mockResolvedValue(entry)
  const send = vi.spyOn(api, 'editState').mockResolvedValue(saved)
  const copy = { ...entry }
  patchCopy.mockRejectedValueOnce(new Error('tab interrupted')).mockImplementationOnce(async (_, patch) => { Object.assign(copy, patch) })
  await replay()
  expect(copy.starred).toBe(false)
  expect((await stored()).starred).toBe(true)
  await replay()
  expect(copy.starred).toBe(true)
  expect(await stored()).toEqual(entry)
  expect(send).toHaveBeenCalledTimes(1)
})

it('preserves an undo queued after the server confirmed the edit and before the copy was repaired', async () => {
  await queue('starred', false, true)
  vi.spyOn(api, 'offlineState').mockResolvedValue({ ...entry, starred: true })
  const send = vi.spyOn(api, 'editState').mockResolvedValue(saved)
  patchCopy.mockRejectedValueOnce(new Error('tab interrupted'))
  await replay()
  await queue('starred', true, false)
  await replay()
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ queued: { starred: false } }))
  await replay()
  expect(send.mock.calls.map(call => call[1])).toEqual(['unstar'])
})

it('keeps the edit when a live-state response ends before the JSON arrives', async () => {
  await queue('read', false, true)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{'))
  await expect(replay()).rejects.toThrow()
  expect((await stored()).read).toBe(true)
})

it.each([false, true])('keeps a second tab’s undo during a write, dropped response = %s', async dropped => {
  await queue('read', false, true)
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<typeof saved>()
  vi.spyOn(api, 'offlineState').mockResolvedValueOnce(entry).mockResolvedValue({ ...entry, read: true })
  const send = vi.spyOn(api, 'editState').mockImplementationOnce(() => { started.resolve(); return response.promise }).mockResolvedValue(saved)
  const first = replay()
  await started.promise
  await queue('read', true, false)
  if (dropped) {
    response.reject(new TypeError('response lost'))
    await expect(first).rejects.toThrow('response lost')
  } else {
    response.resolve(saved)
    await first
  }
  await replay()
  expect(send.mock.calls.map(call => call[1])).toEqual(['read', 'unread'])
})

it('keeps the original from across repeated edits and reports a superseding upstream change', async () => {
  await queue('starred', false, true)
  await queue('starred', true, false)
  vi.spyOn(api, 'offlineState').mockResolvedValue({ ...entry, starred: true })
  const send = vi.spyOn(api, 'editState')
  await replay()
  expect(send).not.toHaveBeenCalled()
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ starred: true }), notice: expect.stringContaining('newer server change') }))
  expect(await stored()).toEqual(entry)
})

it('refetches one standalone revision conflict and preserves a pending record after a second conflict', async () => {
  await queue('read', false, true)
  vi.spyOn(api, 'offlineState').mockResolvedValueOnce({ ...entry, stateRevision: 3 })
    .mockResolvedValueOnce({ ...entry, starred: true, stateRevision: 4 })
    .mockResolvedValueOnce({ ...entry, read: true, stateRevision: 5 })
  const send = vi.spyOn(api, 'editState').mockRejectedValue(new ApiError('changed', 409, 'state-conflict'))
  await expect(replay()).rejects.toThrow('changed')
  expect(send.mock.calls.map(call => call[3]?.expectedRevisions)).toEqual([{ one: 3 }, { one: 4 }])
  expect((await stored()).read).toBe(true)
  await replay()
  expect(send).toHaveBeenCalledTimes(2)
  expect(await stored()).toEqual(entry)
})

it('prevents an older tab from replacing newer queued progress', async () => {
  await queueArticleEdit({ id: entry.id, kind: 'progress', position: 0.5, base: '2026-02-01T12:00:00Z' })
  await expect(queueArticleEdit({ id: entry.id, kind: 'progress', position: 0.9, base: null })).rejects.toThrow('newer')
  expect((await stored()).readingPosition).toBe(0.5)
})
