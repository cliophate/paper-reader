import { describe, expect, it } from 'vitest'
import { isDarkTheme, toggledTheme } from '../src/client/appearance.js'

describe('appearance toggle', () => {
  it('switches explicit themes', () => {
    expect(toggledTheme('light', false)).toBe('dark')
    expect(toggledTheme('dark', false)).toBe('light')
  })

  it('switches away from the effective system theme', () => {
    expect(isDarkTheme('system', true)).toBe(true)
    expect(toggledTheme('system', true)).toBe('light')
    expect(toggledTheme('system', false)).toBe('dark')
  })

  it('treats the e-ink preset as a light theme', () => {
    expect(isDarkTheme('e-ink', true)).toBe(false)
    expect(toggledTheme('e-ink', true)).toBe('dark')
  })
})
