import { describe, expect, it } from 'vitest'
import { readReaderLocation, readerLocationUrl } from '../src/client/location'

describe('reader URL state', () => {
  it('round trips a selected feed and search state', () => {
    const state = {
      view: 'reader' as const,
      stream: { kind: 'feed' as const, id: 'feed/https://example.test/rss', title: 'Example Feed' },
      selectedId: 'tag:example.test,2026:item/1', unreadOnly: false, query: 'quiet computer', mobilePane: 'article' as const,
    }
    expect(readReaderLocation(readerLocationUrl(state).slice(1))).toEqual(state)
  })

  it('falls back safely when URL values are invalid', () => {
    expect(readReaderLocation('?kind=wrong&pane=wrong')).toEqual({
      stream: { kind: 'all', id: 'all', title: 'All articles' },
      view: 'reader',
      selectedId: '', unreadOnly: true, query: '', mobilePane: 'sources',
    })
  })

  it('keeps the briefing library in the URL', () => {
    expect(readReaderLocation('?view=briefings').view).toBe('briefings')
  })

  it('keeps Pulse in the URL and accepts old Topics links', () => {
    expect(readReaderLocation('?view=pulse').view).toBe('pulse')
    expect(readReaderLocation('?view=topics').view).toBe('pulse')
  })

  it('falls back from retired views', () => {
    expect(readReaderLocation('?view=news&standalone=1').view).toBe('reader')
  })
})
