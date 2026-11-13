import { createServer, type Server, type RequestListener } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as transport from '../src/server/feed-http.js'
import { SocialAvatarService } from '../src/server/social-avatar.js'
import { XThreadService } from '../src/server/x-thread.js'

const servers: Server[] = []
async function server(handler: RequestListener) {
  const instance = createServer(handler)
  servers.push(instance)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  vi.restoreAllMocks()
})
const avatar = 'https://images.example.test/avatar.jpg'
const xml = `<rss><channel><image><url>${avatar}</url></image></channel></rss>`

for (const kind of ['avatar', 'thread'] as const) {
  describe(`${kind} bounded requests`, () => {
    const load = (origin: string) => kind === 'avatar'
      ? new SocialAvatarService([origin]).iconForFeed(`${origin}/twitter/user/example?token=feed-secret`, 'fallback')
      : new XThreadService(origin).load('https://x.com/example/status/1')
    const refused = async (origin: string, code: string) => {
      if (kind === 'avatar') {
        await expect(load(origin)).resolves.toBe('fallback')
        expect(console.warn).toHaveBeenCalledOnce()
      } else await expect(load(origin)).rejects.toMatchObject({ code })
    }

    it('allows the configured private origin and same-origin redirects', async () => {
      const seen: string[] = []
      const origin = await server((req, res) => {
        seen.push(req.url!)
        if (req.url !== '/result') { res.writeHead(302, { Location: '/result' }); res.end() }
        else res.end(xml)
      })
      expect(await load(origin)).toEqual(kind === 'avatar' ? avatar : [])
      expect(seen).toHaveLength(2)
    })

    it('refuses a private redirect after an allowed hop without leaking the feed query', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const targetHit = vi.fn()
      const target = await server((_req, res) => { targetHit(); res.end(xml) })
      const seen: string[] = []
      const origin = await server((req, res) => {
        seen.push(req.url!)
        res.writeHead(302, { Location: req.url === '/hop' ? `${target}/secret?token=redirect-secret` : '/hop' })
        res.end()
      })
      await refused(origin, 'policy')
      expect(seen).toHaveLength(2)
      expect(targetHit).not.toHaveBeenCalled()
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/feed-secret|redirect-secret|\?token=/)
    })

    it('cuts off a chunked body before the upstream finishes sending it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const total = 4 * 1024 * 1024
      let sent = 0
      let closed!: () => void
      const disconnected = new Promise<void>(resolve => { closed = resolve })
      const origin = await server((_req, res) => {
        const timer = setInterval(() => {
          sent += 64 * 1024
          res.write(Buffer.alloc(64 * 1024, 0x20))
          if (sent >= total) res.end(xml)
        }, 2)
        res.on('close', () => { clearInterval(timer); closed() })
      })
      await refused(origin, 'limit')
      await disconnected
      expect(sent).toBeGreaterThan(2 * 1024 * 1024)
      expect(sent).toBeLessThan(total)
    })

    it('bounds decompressed bodies even when their wire size is small', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const origin = await server((_req, res) => {
        res.setHeader('Content-Encoding', 'gzip')
        res.end(gzipSync(' '.repeat(2 * 1024 * 1024) + xml))
      })
      await refused(origin, 'limit')
    })
  })
}

it('logs only the feed origin and a safe error when a provider error contains credentials', async () => {
  const message = 'Failed https://alice:password@rsshub.example.test/twitter/user/example?token=error-secret'
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(message))
  vi.spyOn(transport, 'boundedFetch').mockRejectedValue(new Error(message))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const service = new SocialAvatarService(['https://rsshub.example.test'])
  await expect(service.iconForFeed('https://rsshub.example.test/twitter/user/example?token=feed-secret', 'fallback')).resolves.toBe('fallback')
  expect(warn).toHaveBeenCalledOnce()
  const logged = JSON.stringify(warn.mock.calls)
  expect(logged).toContain('https://rsshub.example.test')
  expect(logged).not.toMatch(/alice|password|error-secret|feed-secret|\?token=|\/twitter\/user/)
})
