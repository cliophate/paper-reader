import { createServer, type Server } from 'node:http'
import express, { type ErrorRequestHandler } from 'express'
import { afterEach, expect, it, vi } from 'vitest'
import { fullTextRoute } from '../src/server/fulltext-route.js'
import type { FullArticle } from '../src/server/reader.js'
import { drainRequests } from '../src/server/request-work.js'

const servers: Server[] = []
const pending: Array<{ resolve: (value: FullArticle) => void; reject: (error: Error) => void; signal?: AbortSignal }> = []
const article = { url: 'https://example.test/article', title: 'Fixture', contentHtml: '<p>Fixture</p>' } as FullArticle
async function fixture() {
  const reader = { fetch: vi.fn((_url: string, _age?: number, signal?: AbortSignal) => new Promise<FullArticle>((resolve, reject) => {
    pending.push({ resolve, reject, signal })
  })) }
  const app = express()
  app.use(express.json())
  app.post('/api/fulltext', fullTextRoute(reader))
  app.use(((error, _req, res, _next) => { res.status(500).json({ error: error.message }) }) as ErrorRequestHandler)
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  const request = (signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}/api/fulltext`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: article.url, refresh: true }), signal,
  })
  return { request, reader }
}
afterEach(async () => {
  for (const work of pending.splice(0)) work.resolve(article)
  await drainRequests()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
})

it('rejects the fifth request with a useful error and releases slots on failure and success', async () => {
  const { request, reader } = await fixture()
  const active = Array.from({ length: 4 }, () => request())
  await vi.waitFor(() => expect(reader.fetch).toHaveBeenCalledTimes(4))
  let excess: Response | undefined
  const rejected = request().then(response => { excess = response })
  await vi.waitFor(() => expect(excess?.status).toBe(503))
  await rejected
  expect(await excess!.json()).toEqual({ error: 'Paper is fetching too many full articles. Try again shortly.' })
  expect(reader.fetch).toHaveBeenCalledTimes(4)
  expect(reader.fetch.mock.calls[0][1]).toBe(0)
  pending[0].reject(new Error('Synthetic extraction failure'))
  expect((await active[0]).status).toBe(500)
  const retry = request()
  await vi.waitFor(() => expect(reader.fetch).toHaveBeenCalledTimes(5))
  pending[4].resolve(article)
  expect((await retry).status).toBe(200)
  const again = request()
  await vi.waitFor(() => expect(reader.fetch).toHaveBeenCalledTimes(6))
  for (const work of pending) work.resolve(article)
  expect((await again).status).toBe(200)
  await Promise.all(active)
})

it('aborts disconnected requests and holds their slot until the work has stopped', async () => {
  const { request, reader } = await fixture()
  const controller = new AbortController()
  const disconnected = request(controller.signal).catch(() => null)
  await vi.waitFor(() => expect(reader.fetch).toHaveBeenCalledTimes(1))
  const active = Array.from({ length: 3 }, () => request())
  await vi.waitFor(() => expect(reader.fetch).toHaveBeenCalledTimes(4))
  controller.abort()
  await disconnected
  await vi.waitFor(() => expect(pending[0].signal?.aborted).toBe(true))
  expect((await request()).status).toBe(503)
  pending[0].reject(new Error('Synthetic cancellation'))
  await vi.waitFor(() => expect(pending[0].signal?.aborted).toBe(true))
  const retry = request()
  await vi.waitFor(() => expect(reader.fetch).toHaveBeenCalledTimes(5))
  for (const work of pending) work.resolve(article)
  expect((await retry).status).toBe(200)
  await Promise.all(active)
})
