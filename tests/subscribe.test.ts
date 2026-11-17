import { describe, expect, it } from 'vitest'
import { firstSharedUrl, parseSubscribeQuery, subscribeBookmarklet, subscribeLoginReturn } from '../src/client/subscribe'

describe('subscribe query', () => {
  it('decodes the URL once and ignores action, folder and confirmation parameters', () => {
    const url = 'https://example.test/feed?a=1&b=%2F#section'
    expect(parseSubscribeQuery(`?url=${encodeURIComponent(url)}&confirm=true&action=create&folder=Injected`)).toEqual({ url, error: '' })
    expect(parseSubscribeQuery('?url=https%3A%2F%2Ffirst.test&url=https%3A%2F%2Fsecond.test').url).toBe('https://first.test')
  })
  it('prefers url, then the first link in text, then title', () => {
    expect(parseSubscribeQuery('?url=https://url.test&text=https://text.test&title=https://title.test').url).toBe('https://url.test')
    expect(parseSubscribeQuery('?url=&text=Read+https://text.test/feed+or+https://other.test').url).toBe('https://text.test/feed')
    expect(parseSubscribeQuery('?text=No+link&title=Read+https://title.test').url).toBe('https://title.test')
    expect(parseSubscribeQuery('?url=invalid&text=https://text.test').error).not.toBe('')
  })
  it.each(['', 'example.test', '//example.test', 'javascript:alert(1)', 'file:///etc/passwd', 'https://', 'https://user:password@example.test', 'https://example.test/a b', 'https://example.test/\\evil', `https://example.test/${'a'.repeat(4096)}`])('rejects missing or invalid URL %s', url => {
    expect(parseSubscribeQuery(new URLSearchParams({ url }).toString()).error).not.toBe('')
  })
  it('leaves private address decisions to the existing server transport', () => {
    for (const url of ['http://127.0.0.1/feed', 'http://[::1]/feed', 'https://example.test/feed']) expect(parseSubscribeQuery(new URLSearchParams({ url }).toString())).toEqual({ url, error: '' })
  })
  it.each([
    ['Read <https://example.test/feed>.', 'https://example.test/feed'],
    ['Read (https://example.test/feed).', 'https://example.test/feed'],
    ['https://example.test/a_(b)', 'https://example.test/a_(b)'],
    ['See https://example.test/feed?x=1&y=2, then https://other.test', 'https://example.test/feed?x=1&y=2'],
    ['http://[::1]/feed', 'http://[::1]/feed'],
    ['No link here', ''],
  ])('extracts a shared link from %s', (text, expected) => expect(firstSharedUrl(text)).toBe(expected))
})

it('only accepts a local subscribe login destination', () => {
  const target = '/subscribe?url=https%3A%2F%2Fexample.test%2Fa%3Fx%3D1%26y%3D2'
  expect(subscribeLoginReturn(new URLSearchParams({ returnTo: target }).toString())).toBe(target)
  for (const value of ['https://evil.test/subscribe', '//evil.test/subscribe', '/\\evil.test', '/subscribe/../api', '/subscribe#evil', '/subscribe\n', '/api/subscription-tools/apply']) {
    expect(subscribeLoginReturn(new URLSearchParams({ returnTo: value }).toString())).toBe('')
  }
})

it('builds a bookmarklet for PUBLIC_URL or the current origin and encodes the whole page URL', () => {
  for (const publicUrl of ['', 'https://paper.example.test']) {
    const script = subscribeBookmarklet(publicUrl, 'http://localhost:5173')
    const page = 'https://publisher.test/a?x=1&y=%22#hello'
    const calls: unknown[][] = []
    new Function('window', 'location', script.slice('javascript:'.length))({ open: (...args: unknown[]) => calls.push(args) }, { href: page })
    expect(calls).toEqual([[`${publicUrl || 'http://localhost:5173'}/subscribe?url=${encodeURIComponent(page)}`, '_blank', 'noopener']])
  }
})
