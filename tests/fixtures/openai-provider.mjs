import http from 'node:http'
import { once } from 'node:events'

// Local Chat Completions fixture. Requests and keys are synthetic.
export async function startOpenaiFixture() {
  const requests = []
  const closed = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ body, authorization: request.headers.authorization, path: request.url })
    response.on('close', () => closed.push(body.model))
    const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    const result = value => json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })
    if (body.model === 'hang') return
    if (body.model === 'slow-body') { response.writeHead(200); response.write('{'); return }
    if (body.model === 'redirect') { response.writeHead(307, { Location: '/stolen' }); response.end(); return }
    if (body.model === 'size-header') { response.writeHead(200, { 'Content-Length': 5 * 1024 * 1024 }); response.end(); return }
    if (body.model === 'size-body') { response.writeHead(200); response.end('x'.repeat(4 * 1024 * 1024 + 1)); return }
    if (body.model === 'broken-json') { response.end('synthetic-secret not JSON'); return }
    if (body.model === 'invalid-json-content') { json({ choices: [{ message: { content: 'synthetic-secret not JSON' }, finish_reason: 'stop' }] }); return }
    if (body.model.startsWith('status-')) { json({ error: { message: request.headers.authorization } }, Number(body.model.slice(7))); return }
    if (body.model.startsWith('fallback') && body.response_format?.type === 'json_schema') {
      json({ error: { message: 'response_format json_schema is not supported' } }, 400); return
    }
    if (body.model === 'fallback-invalid') { result({ groups: 'invalid' }); return }
    if (body.model === 'truncated') { json({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }); return }
    if (body.model === 'refused') { json({ choices: [{ message: { content: '{}', refusal: 'synthetic-secret' }, finish_reason: 'stop' }] }); return }
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = (content, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\r\n\r\n`
      if (body.model === 'stream-error') { response.end('data: {"error":{"message":"synthetic-secret"}}\n\n'); return }
      if (body.model === 'stream-invalid') { response.end('data: broken synthetic-secret\n\n'); return }
      if (body.model === 'stream-large') { response.end(delta('x'.repeat(24001))); return }
      if (body.model === 'stream-truncated') { response.end(delta('hello')); return }
      if (body.model === 'stream-length') { response.end(delta('hello', 'length') + 'data: [DONE]\n\n'); return }
      if (body.model === 'stream-tools') { response.end('data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n'); return }
      if (body.model === 'stream-hang') { response.write(delta('hello')); return }
      const wire = Buffer.from(': keepalive\r\n\r\n' + delta('Hello ') + delta('café 🌱') + delta('', 'stop') + 'data: [DONE]\r\n\r\n')
      // Separate bytes exercise UTF-8 and SSE framing across chunks.
      for (let i = 0; i < wire.length; i += 3) response.write(wire.subarray(i, i + 3))
      response.end(); return
    }
    if (!body.response_format) { json({ choices: [{ message: { content: 'OK' } }] }); return }
    result({ groups: [], model: body.model })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, requests, closed, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
