import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractReadableArticle, fetchHtml } from '../src/server/reader.js'

afterEach(() => vi.unstubAllGlobals())

describe('reader extraction', () => {
  it('extracts the article and removes page chrome and scripts', () => {
    const paragraphs = Array.from({ length: 8 }, (_, index) => `<p>Paragraph ${index + 1} contains concrete reporting and enough words for the reader parser to recognise the body of this test article.</p>`).join('')
    const article = extractReadableArticle(`<!doctype html><html><head><title>A useful test article</title></head><body>
      <nav>Home Topics Subscribe Account</nav>
      <main><article><h1>A useful test article</h1><p class="byline">By Ada Example</p>${paragraphs}<script>alert('no')</script></article></main>
      <footer>Copyright and unrelated links</footer>
    </body></html>`, 'https://example.test/posts/useful')

    expect(article.title).toContain('A useful test article')
    expect(article.contentHtml).toContain('Paragraph 8')
    expect(article.contentHtml).not.toContain('<nav')
    expect(article.contentHtml).not.toContain('<script')
    expect(article.readingMinutes).toBeGreaterThanOrEqual(1)
  })

  it('rejects pages without enough readable text', () => {
    expect(() => extractReadableArticle('<html><body><p>Short.</p></body></html>', 'https://example.test/short'))
      .toThrow()
  })

  it('rejects publisher login walls instead of treating them as articles', () => {
    const wall = `<html><body><article><h1>Member article</h1><p>This article is FREE, but only for humans.</p><p>Log in or register to continue.</p><p>${'Username Password Remember Me '.repeat(20)}</p></article></body></html>`
    expect(() => extractReadableArticle(wall, 'https://www.bankeronwheels.com/member-article/'))
      .toThrow('requires you to sign in')
  })

  it('keeps lazy article images and resolves their URLs', () => {
    const paragraphs = Array.from({ length: 8 }, (_, index) => `<p>Paragraph ${index + 1} contains enough detailed reporting for the article parser to keep this body intact.</p>`).join('')
    const article = extractReadableArticle(`<html><body><article><h1>Lazy images</h1><img src="blank.gif" data-src="/media/hero.jpg">${paragraphs}</article></body></html>`, 'https://example.test/posts/lazy')
    expect(article.contentHtml).toContain('src="https://example.test/media/hero.jpg"')
  })

  it('contacts no fallback service by default when the publisher blocks access', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchHtml(new URL('https://93.184.216.34/blocked'))).rejects.toThrow('status 403')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uses the opt-in reader fallback when the publisher returns 403', async () => {
    const articleHtml = '<html><body><article><h1>Blocked article</h1><p>The complete article body is available through the fallback reader.</p></article></body></html>'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { html: articleHtml } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const sourceUrl = new URL('https://93.184.216.34/story')
    await expect(fetchHtml(sourceUrl, true)).resolves.toEqual({ html: articleHtml, finalUrl: sourceUrl })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://r.jina.ai/https://93.184.216.34/story')
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Accept: 'application/json',
      DNT: '1',
      'X-Return-Format': 'html',
    })
  })

  it('does not proxy ordinary not-found responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Not found', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHtml(new URL('https://93.184.216.34/missing'))).rejects.toThrow('status 404')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 406, 429])('uses the reader fallback for status %s', async status => {
    const articleHtml = '<html><body><article><h1>Fallback article</h1><p>The fallback returned enough readable text for Paper to display this blocked article in its own reader view.</p></article></body></html>'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Blocked', { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { html: articleHtml } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchHtml(new URL('https://93.184.216.34/story'), true)).resolves.toMatchObject({ html: articleHtml })
  })
})
