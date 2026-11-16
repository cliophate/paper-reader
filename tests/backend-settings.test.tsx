import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BackendSettings } from '../src/client/components/BackendSettings'

describe('backend setup guidance', () => {
  it('explains native Miniflux setup and supported capabilities without offering FreshRSS migration', () => {
    const markup = renderToStaticMarkup(<BackendSettings backend="miniflux" />)
    expect(markup).toContain('MINIFLUX_BASE_URL')
    expect(markup).toContain('MINIFLUX_API_KEY')
    expect(markup).toContain('2.3.2')
    expect(markup).toContain('Choose a real category')
    expect(markup).not.toContain('Move a FreshRSS snapshot')
    expect(markup).not.toContain('migration-cli.js')
  })
})
