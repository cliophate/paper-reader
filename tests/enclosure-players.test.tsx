// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { playback } from '../src/client/api'
import { PlaybackQueue } from '../src/client/playback'
import { PaperDatabase } from '../src/server/db'
import { EnclosurePlayers } from '../src/client/components/EnclosurePlayers'
import type { Entry } from '../src/client/types'

it('sets the resume position before play, saves seeks and pauses, and resets at the end', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  const onPosition = vi.spyOn(playback, 'save').mockResolvedValue(undefined)
  const file = { url: 'https://media.example.test/episode.mp3', type: 'audio/mpeg', position: 12.5 }
  const entry = { id: 'episode', title: 'Episode', enclosures: [file] } as Entry
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  try {
    await act(() => root.render(<EnclosurePlayers entry={entry} posters={new Map()} />))
    const audio = container.querySelector('audio')!
    expect(audio.hasAttribute('src')).toBe(false)
    audio.dispatchEvent(new Event('pause'))
    expect(onPosition).not.toHaveBeenCalled()
    await act(() => container.querySelector('button')!.click())
    expect(play).toHaveBeenCalledTimes(1)
    expect(audio.currentTime).toBe(12.5)
    Object.defineProperty(audio, 'duration', { value: 120 })
    audio.dispatchEvent(new Event('loadedmetadata'))
    expect(audio.currentTime).toBe(12.5)
    audio.currentTime = 9
    await act(() => audio.dispatchEvent(new Event('seeked')))
    expect(onPosition).toHaveBeenLastCalledWith({ id: entry.id, url: file.url, position: 9, updatedAt: expect.any(Number) })
    audio.currentTime = 19
    await act(() => audio.dispatchEvent(new Event('pause')))
    expect(onPosition).toHaveBeenLastCalledWith({ id: entry.id, url: file.url, position: 19, updatedAt: expect.any(Number) })
    Object.defineProperty(audio, 'ended', { value: true })
    await act(() => audio.dispatchEvent(new Event('ended')))
    expect(onPosition).toHaveBeenLastCalledWith({ id: entry.id, url: file.url, position: 0, updatedAt: expect.any(Number) })
  } finally {
    await act(() => root.unmount())
    onPosition.mockRestore()
    play.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('recovers a failed save after reload and keeps the newer server position', async () => {
  const item = { id: 'episode', url: 'https://media.example.test/episode.mp3', position: 42, updatedAt: 100 }
  const disconnected = new PlaybackQueue(async () => { throw new TypeError('Connection lost') })
  await expect(disconnected.save(item)).rejects.toThrow('Connection lost')

  const winner = { position: 65, updatedAt: 101 }
  const send = vi.fn().mockResolvedValue(winner)
  const reopened = new PlaybackQueue(send)
  const receive = vi.fn()
  reopened.subscribe(receive)
  expect(reopened.pending(item.id, item.url)).toEqual(item)
  await reopened.retry(item.id)
  expect(send).toHaveBeenCalledExactlyOnceWith(item)
  expect(receive).toHaveBeenCalledExactlyOnceWith({ ...winner, id: item.id, url: item.url })
  expect(reopened.pending(item.id, item.url)).toBeUndefined()
})

it('keeps a later 60 s pause when two tabs replay the same offline 42 s pause', async () => {
  const db = new PaperDatabase(':memory:')
  const item = { id: 'episode', url: 'https://example.test/file.mp3', position: 42, updatedAt: 100 }
  const connection = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  try {
    db.upsertEntries([{ id: item.id, feedId: 'feed', feedTitle: 'Feed', feedUrl: 'https://example.test/feed',
      title: 'Episode', author: '', url: 'https://example.test/episode', contentHtml: '<p>Episode</p>', excerpt: '',
      publishedAt: '2026-01-01T00:00:00Z', timestamp: 1, read: false, starred: false, readingMinutes: 1,
      thumbnailUrl: '', kind: 'article', enclosures: [{ url: item.url, type: 'audio/mpeg' }] }])
    const send = async (write: typeof item) => db.savePlaybackPosition(write.id, write.url, write.position, write.updatedAt)!
    const listener = new PlaybackQueue(send)
    const delayed = Promise.withResolvers<void>()
    const otherTab = new PlaybackQueue(async write => { await delayed.promise; return send(write) })
    await listener.save(item)
    connection.mockReturnValue(true)
    const duplicate = otherTab.retry()
    await listener.retry()
    connection.mockReturnValue(false)
    const later = { ...item, position: 60, updatedAt: 101 }
    await listener.save(later)
    delayed.resolve()
    await duplicate
    expect(listener.pending(item.id, item.url)).toEqual(later)
    connection.mockReturnValue(true)
    await listener.retry()
    expect(db.localEntry(item.id)!.enclosures![0]).toMatchObject({ position: 60, updatedAt: 101 })
    expect(otherTab.pending(item.id, item.url)).toBeUndefined()
  } finally { connection.mockRestore(); db.close() }
})

it('keeps a queued timestamp when the server returns an earlier clamped timestamp', async () => {
  const item = { id: 'skew', url: 'https://example.test/file.mp3', position: 42, updatedAt: 1_000_000 }
  const queue = new PlaybackQueue(async () => ({ position: 42, updatedAt: 300_000 }))
  try {
    await queue.save(item)
    expect(queue.pending(item.id, item.url)).toEqual(item)
  } finally { queue.clear() }
})
