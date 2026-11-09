import { describe, expect, it } from 'vitest'
import { movementDirection } from '../src/client/keyboard'

describe('movementDirection', () => {
  it.each([
    ['j', 1],
    ['ArrowDown', 1],
    ['k', -1],
    ['ArrowUp', -1],
  ])('maps %s to %i', (key, direction) => {
    expect(movementDirection(key)).toBe(direction)
  })

  it('ignores unrelated keys', () => {
    expect(movementDirection('Enter')).toBeNull()
  })
})
