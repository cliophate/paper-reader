import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'

let directory: string
let child: ChildProcess | undefined
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }
  fs.rmSync(directory, { recursive: true, force: true })
})

function request(port: number, route: string, host?: string, method = 'GET', headers = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, setHost: false,
      headers: { ...(host === undefined ? {} : { Host: host }), ...headers } }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }))
    })
    req.on('error', reject); req.end()
  })
}

async function start(publicUrl: string) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-request-security-'))
  fs.mkdirSync(path.join(directory, 'dist'))
  fs.mkdirSync(path.join(directory, 'dist/assets'))
  fs.writeFileSync(path.join(directory, 'dist/index.html'), '<!doctype html><title>Synthetic Paper</title>')
  const listener = http.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.resolve('src/server/index.ts')], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: '1', STATE_DIR: directory,
      PAPER_BACKEND: 'standalone', HOST: '127.0.0.1', PORT: String(port),
      ...(publicUrl ? { PUBLIC_URL: publicUrl } : {}),
      PAPER_SYNC_ENABLED: 'false', CODEX_ENABLED: 'false', OPENCODE_ENABLED: 'false',
    },
  })
  let output = ''
  child.stdout!.on('data', chunk => { output += chunk }); child.stderr!.on('data', chunk => { output += chunk })
  for (let i = 0; i < 200; i++) {
    try { if ((await request(port, '/health', '127.0.0.1:8080')).status === 200) return port } catch {}
    if (child.exitCode !== null) break
    await delay(50)
  }
  throw new Error(`Synthetic server did not start: ${output}`)
}

it('rejects rebinding hosts before GET routes, writes, HEAD and OPTIONS', async () => {
  const port = await start('https://PaPeR.example.test:8443')
  for (const route of ['/', '/api/entries', '/api/navigation', '/api/reading', '/health']) {
    const response = await request(port, route, 'rebind.example.test')
    expect(response.status, route).toBe(421)
    expect(response.headers['content-type']).toMatch(/^text\/plain/)
    expect(response.body).toBe('Misdirected Request')
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS']) {
    expect((await request(port, '/api/status', 'rebind.example.test', method)).status).toBe(421)
  }
  for (const host of ['paper.example.test', 'paper.example.test:443', 'paper.example.test:8444',
    'paper.example.test.evil:8443', 'localhost.evil', '127.0.0.2', 'localhost:65536', 'localhost:abc',
    'localhost:', 'localhost@evil.test', 'evil.test@localhost', 'localhost/path', 'localhost,evil.test',
    'localhost.', '127.1', '0x7f000001', '::1', '[::1]:abc', '']) {
    expect((await request(port, '/api/status', host)).status, host).toBe(421)
  }
  expect((await request(port, '/api/status', 'evil.test', 'GET', {
    'X-Forwarded-Host': 'paper.example.test:8443', Forwarded: 'host="paper.example.test:8443"',
  })).status).toBe(421)
}, 15000)

it.each(['https://PaPeR.example.test:8443', 'https://paper.example.test', 'http://paper.example.test', ''])(
  'accepts configured and loopback hosts with PUBLIC_URL=%s', async publicUrl => {
    const port = await start(publicUrl)
    const hosts = ['localhost', 'LOCALHOST:5173', '127.0.0.1', '127.0.0.1:8080', '[::1]', '[::1]:54321']
    if (publicUrl) {
      const url = new URL(publicUrl)
      hosts.push(url.host, `${url.hostname.toUpperCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`)
    }
    for (const host of hosts) {
      for (const route of ['/api/status', '/health']) {
        expect((await request(port, route, host, 'GET', { 'X-Forwarded-Host': 'evil.test' })).status, host).toBe(200)
      }
    }
    if (!publicUrl) expect((await request(port, '/api/status', 'paper.example.test')).status).toBe(421)
  }, 15000,
)

it('lets internal automation reach secret-protected routes by container name', async () => {
  const port = await start('https://paper.example.test')
  const response = await request(port, '/api/internal/briefings/generate', 'paper:8080', 'POST', { 'Content-Type': 'application/json' })
  expect(response.status).toBe(401)
  expect((await request(port, '/api/internal', 'paper:8080')).status).toBe(421)
}, 15000)

it('blocks framing on SPA HTML, API, health, errors and rejected hosts', async () => {
  const port = await start('https://paper.example.test')
  for (const [route, host, method, status] of [
    ['/', 'localhost', 'GET', 200], ['/reading', 'localhost', 'GET', 200],
    ['/assets', 'localhost', 'GET', 301],
    ['/api/status', 'localhost', 'GET', 200], ['/health', 'localhost', 'GET', 200],
    ['/api/entries?kind=unknown', 'localhost', 'GET', 400],
    ['/missing', 'localhost', 'DELETE', 404],
    ['/api/status', 'evil.test', 'GET', 421],
    ['/api/entries/state', 'localhost', 'POST', 403],
  ] as const) {
    const response = await request(port, route, host, method, { Origin: method === 'POST' ? 'https://evil.test' : 'https://paper.example.test' })
    expect(response.headers['content-security-policy'], route).toBe(
      status === 301 || status === 404 ? "default-src 'none'; frame-ancestors 'none'" : "frame-ancestors 'none'",
    )
    expect(response.headers['x-frame-options'], route).toBe('DENY')
    expect(response.status, route).toBe(status)
    if (route === '/' || route === '/reading') expect(response.body).toContain('<title>Synthetic Paper</title>')
  }
}, 15000)
