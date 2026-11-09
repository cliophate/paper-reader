import { describe, expect, it } from 'vitest'
import { initialReaderChromeScrollState, readerChromeCanAutoHide, updateReaderChromeScroll } from '../src/client/readerChrome'

describe('mobile reader chrome', () => {
  it('hides after sustained downward reading', () => {
    let state = initialReaderChromeScrollState()
    state = updateReaderChromeScroll(state, 48)
    state = updateReaderChromeScroll(state, 92)
    expect(state.hidden).toBe(true)
  })

  it('reveals after a short upward movement', () => {
    let state = { ...initialReaderChromeScrollState(180), hidden: true }
    state = updateReaderChromeScroll(state, 162)
    expect(state.hidden).toBe(true)
    state = updateReaderChromeScroll(state, 146)
    expect(state.hidden).toBe(false)
  })

  it('always reveals near the top', () => {
    const state = updateReaderChromeScroll({ top: 100, direction: 1, travel: 80, hidden: true }, 20)
    expect(state).toEqual(initialReaderChromeScrollState(20))
  })

  it('ignores small direction changes', () => {
    const state = updateReaderChromeScroll({ top: 120, direction: 1, travel: 0, hidden: true }, 116)
    expect(state.hidden).toBe(true)
  })

  it('does not hide chrome when a short article only scrolls through its boundary zones', () => {
    expect(readerChromeCanAutoHide(946, 754, 96)).toBe(false)
  })

  it('allows chrome hiding when the article has meaningful reading distance', () => {
    expect(readerChromeCanAutoHide(1800, 754, 96)).toBe(true)
  })
})
