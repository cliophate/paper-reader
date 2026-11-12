import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

// Serve only the built client. This server has no backend or account access.
const root = path.resolve('dist')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' }
http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://fixture').pathname)
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return }
    const body = await fs.readFile(file)
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(body)
  } catch {
    response.writeHead(404).end()
  }
}).listen(4317, '127.0.0.1')
