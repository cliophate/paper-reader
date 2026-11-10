import { createServer, type Server, type RequestListener } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { discoveryTransport } from '../src/server/discovery-transport'
import { discoverFeeds } from '../src/server/feed-discovery'
const servers: Server[] = []
async function fixture(handler: RequestListener) {
  const instance = createServer(handler); servers.push(instance)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))) })

describe('discovery using the production HTTP transport', () => {
  it('follows redirects, decodes compressed HTML, resolves base and returns candidate choices', async () => {
    const origin = await fixture((req, res) => {
      if (req.url === '/') { res.writeHead(302, { Location: '/nested/page' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
      res.end(gzipSync('<base href="../feeds/"><link rel="alternate" type="application/rss+xml" title="News" href="rss"><link rel="alternate" type="application/atom+xml" title="Replies" href="atom">'))
    })
    const result = await discoverFeeds(origin, discoveryTransport([origin]))
    expect(result.responseUrl).toBe(origin + '/nested/page')
    expect(result.candidates.map(candidate => candidate.url)).toEqual([origin + '/feeds/rss', origin + '/feeds/atom'])
  })
  it('rejects private requests and redirects unless each origin is explicitly configured', async () => {
    const target = await fixture((_req, res) => { res.end('<rss version="2.0"><channel/></rss>') })
    const origin = await fixture((_req, res) => { res.writeHead(302, { Location: target }); res.end() })
    await expect(discoverFeeds(origin, discoveryTransport([]))).rejects.toThrow()
    await expect(discoverFeeds(origin, discoveryTransport([origin]))).rejects.toThrow()
    expect((await discoverFeeds(origin, discoveryTransport([origin, target]))).candidates).toHaveLength(1)
  })
  it('rejects HTTP errors, empty responses and unsupported content instead of treating them as feeds', async () => {
    const origin = await fixture((req, res) => {
      if (req.url === '/error') res.writeHead(503)
      else if (req.url === '/empty') res.writeHead(204)
      else res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    const transport = discoveryTransport([origin])
    await expect(discoverFeeds(origin + '/error', transport)).rejects.toThrow(/HTTP 503/)
    await expect(discoverFeeds(origin + '/empty', transport)).rejects.toThrow(/HTTP 204/)
    await expect(discoverFeeds(origin + '/json', transport)).rejects.toThrow(/HTML page/)
  })
  it('bounds concurrent discovery work and frees slots after completion', async () => {
    const pending: Array<() => void> = []
    const origin = await fixture((_req, res) => { pending.push(() => res.end('<rss version="2.0"><channel/></rss>')) })
    const transport = discoveryTransport([origin])
    const first = transport(origin), second = transport(origin)
    await expect(transport(origin)).rejects.toThrow(/already running/)
    // Wait for fixture requests, without relying on wall-clock sleeps.
    while (pending.length < 2) await new Promise(resolve => setImmediate(resolve))
    pending.splice(0).forEach(finish => finish())
    await Promise.all([first, second])
    const third = transport(origin)
    while (pending.length < 1) await new Promise(resolve => setImmediate(resolve))
    pending[0](); await third
  })
})
