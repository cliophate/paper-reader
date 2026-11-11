import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { extractReadableArticle, fetchHtml } from '../src/server/reader.js'

const transport = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }))
vi.mock('node:http', async importOriginal => ({ ...await importOriginal<typeof import('node:http')>(), request: transport.request }))

beforeEach(() => {
  transport.lookup.mockReset()
  transport.request.mockReset()
  // A direct global fetch must never bypass the pinned transport.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unpinned request')))
})
afterEach(() => vi.unstubAllGlobals())

it('extracts an article containing an invalid UTF-8 byte with a replacement character', async () => {
  transport.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  const body = Buffer.concat([
    Buffer.from('<html><head><title>Synthetic article</title></head><body><article><h1>Synthetic article</h1><p>Damaged '),
    Buffer.from([0xff]),
    Buffer.from(' byte.</p>' + '<p>This synthetic paragraph provides enough reporting for readable article extraction.</p>'.repeat(8) + '</article></body></html>'),
  ])
  transport.request.mockImplementation((_url: URL, _options: RequestOptions, respond: (response: IncomingMessage) => void) =>
    Object.assign(new EventEmitter(), { end() {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      respond(response as IncomingMessage)
      response.end(body)
    } }))

  const { html, finalUrl } = await fetchHtml(new URL('http://publisher.test/story'))
  const article = extractReadableArticle(html, finalUrl.href)
  expect(article.title).toBe('Synthetic article')
  expect(article.contentHtml).toContain('Damaged \ufffd byte.')
  expect(article.contentHtml).toContain('This synthetic paragraph')
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  [401, 'undecodable'], [403, 'undecodable'], [406, 'undecodable'], [429, 'undecodable'],
  [403, 'oversized'], [403, 'stalled'],
] as const)('reaches the fallback for status %s with an %s body without reading it', async (status, body) => {
  transport.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
  const response = Object.assign(new PassThrough(), { statusCode: status, headers: {
    'content-type': 'text/html; charset=utf-8',
    ...(body === 'oversized' ? { 'content-length': String(6 * 1024 * 1024) } : {}),
  } })
  const read = vi.spyOn(response, 'read')
  transport.request.mockImplementation((url: URL, _options: RequestOptions, respond: (response: IncomingMessage) => void) =>
    Object.assign(new EventEmitter(), { end() {
      if (url.pathname === '/start') {
        const redirect = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: '/blocked' } })
        respond(redirect as IncomingMessage)
        redirect.end()
      } else {
        respond(response as IncomingMessage)
        if (body !== 'stalled') response.end(Buffer.from([0xc3, 0x28]))
      }
    } }))
  const html = '<p>Synthetic fallback article</p>'
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { html } })))

  await expect(fetchHtml(new URL('http://publisher.test/start'), true)).resolves.toEqual({
    html, finalUrl: new URL('http://publisher.test/blocked'),
  })
  expect(response.destroyed).toBe(true)
  expect(read).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledOnce()
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe('https://r.jina.ai/http://publisher.test/blocked')
})

it('refuses private DNS answers before connecting or resolving again', async () => {
  transport.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  await expect(fetchHtml(new URL('http://private.test/story'))).rejects.toMatchObject({ code: 'policy', message: 'Paper cannot fetch private network addresses' })
  expect(transport.lookup).toHaveBeenCalledExactlyOnceWith('private.test', { all: true, verbatim: true })
  expect(transport.request).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('pins the checked public address at connection time despite a private second DNS answer', async () => {
  transport.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  transport.request.mockImplementation((_url: URL, options: RequestOptions, respond: (response: IncomingMessage) => void) => {
    const request = new EventEmitter()
    return Object.assign(request, { end() {
      options.lookup!('rebind.test', { all: true }, (error, addresses) => {
        expect(error).toBeNull()
        expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }])
        const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/html' } })
        respond(response as IncomingMessage)
        response.end('<p>Synthetic article</p>')
      })
    } })
  })
  await expect(fetchHtml(new URL('http://rebind.test/story'))).resolves.toMatchObject({ html: '<p>Synthetic article</p>' })
  expect(transport.lookup).toHaveBeenCalledTimes(1)
  expect(transport.request).toHaveBeenCalledTimes(1)
  expect(transport.request.mock.calls[0][1].headers).toMatchObject({
    'User-Agent': 'Mozilla/5.0 (compatible; PaperReader/1.0; +https://github.com/cliophate/paper-reader)',
    'Accept-Language': 'en-US,en;q=0.8',
  })
  expect(fetch).not.toHaveBeenCalled()
})
