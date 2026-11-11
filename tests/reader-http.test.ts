import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchHtml } from '../src/server/reader.js'

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
