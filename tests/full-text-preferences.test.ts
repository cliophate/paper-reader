import { describe, expect, it } from 'vitest'
import { automaticFullTextFeeds, recordFullTextSuccess } from '../src/client/fullTextPreferences'

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) || null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('full article preferences', () => {
  it('learns a feed after three different manual fetches', () => {
    const storage = new MemoryStorage()
    expect(recordFullTextSuccess(storage, 'feed/one', 'one').enabled).toBe(false)
    expect(recordFullTextSuccess(storage, 'feed/one', 'one').enabled).toBe(false)
    expect(recordFullTextSuccess(storage, 'feed/one', 'two').enabled).toBe(false)
    expect(recordFullTextSuccess(storage, 'feed/one', 'three')).toEqual({ enabled: true, becameEnabled: true })
    expect(automaticFullTextFeeds(storage)).toEqual(new Set(['feed/one']))
  })
})
