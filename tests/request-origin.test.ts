import express from 'express'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { requireSameOrigin } from '../src/server/request-origin'

describe('browser request origins', () => {
  it('rejects another website before it can mutate reader state', async () => {
    const app = express()
    let edits = 0
    app.use(requireSameOrigin('https://paper.example.test'))
    app.post('/edit', (_req, res) => { edits++; res.json({ ok: true }) })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/edit`
    try {
      expect((await fetch(url, { method: 'POST', headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
      expect((await fetch(url, { method: 'POST', headers: { origin: 'null' } })).status).toBe(403)
      expect((await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
      expect(edits).toBe(0)
      expect((await fetch(url, { method: 'POST', headers: { origin: 'https://paper.example.test' } })).status).toBe(200)
      expect((await fetch(url, { method: 'POST' })).status).toBe(200)
      expect(edits).toBe(2)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})
