import { describe, expect, it } from 'vitest'
import { articleEdgeState, swipeDirection } from '../src/client/mobileGestures'

describe('mobile swipe recognition', () => {
  it('recognizes deliberate horizontal swipes', () => {
    expect(swipeDirection({ x: 120, y: 80 }, { x: 45, y: 88 })).toBe('left')
    expect(swipeDirection({ x: 45, y: 80 }, { x: 120, y: 72 })).toBe('right')
  })

  it('recognizes deliberate vertical swipes', () => {
    expect(swipeDirection({ x: 80, y: 140 }, { x: 86, y: 60 })).toBe('up')
    expect(swipeDirection({ x: 80, y: 60 }, { x: 74, y: 140 })).toBe('down')
  })

  it('ignores short and diagonal movement', () => {
    expect(swipeDirection({ x: 10, y: 10 }, { x: 48, y: 12 })).toBeNull()
    expect(swipeDirection({ x: 10, y: 10 }, { x: 90, y: 82 })).toBeNull()
  })
})

describe('article edge zones', () => {
  it('measures the visible previous and next zones from scroll position', () => {
    expect(articleEdgeState(96, 1600, 700, 96, 56)).toBeNull()
    expect(articleEdgeState(68, 1600, 700, 96, 56)).toMatchObject({ direction: 'previous', distance: 28, progress: 0.5, ready: false })
    expect(articleEdgeState(860, 1600, 700, 96, 56)).toMatchObject({ direction: 'next', distance: 56, progress: 1, ready: true })
  })

  it('keeps both zones usable for an article shorter than the viewport', () => {
    expect(articleEdgeState(96, 892, 700, 96, 56)).toBeNull()
    expect(articleEdgeState(40, 892, 700, 96, 56)).toMatchObject({ direction: 'previous', ready: true })
    expect(articleEdgeState(152, 892, 700, 96, 56)).toMatchObject({ direction: 'next', ready: true })
  })

  it('rejects invalid geometry', () => {
    expect(articleEdgeState(Number.NaN, 800, 700, 96, 56)).toBeNull()
    expect(articleEdgeState(0, 800, 700, 0, 56)).toBeNull()
  })
})
