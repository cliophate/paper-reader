import { once } from 'node:events'
import net from 'node:net'

export async function startSmtpFixture() {
  const connections = new Set()
  const messages = []
  const senders = []
  const fixture = { mode: 'accept', connections: 0, messages, senders, beforeAccept: undefined, port: 0, close }
  const server = net.createServer(socket => {
    connections.add(socket)
    fixture.connections++
    socket.once('close', () => connections.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    socket.write('220 fixture.test ready\r\n')
    let pending = ''
    let body = null
    socket.on('data', chunk => {
      pending += chunk
      let boundary
      while ((boundary = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        if (body !== null) {
          if (line !== '.') { body.push(line); continue }
          messages.push(body.join('\r\n'))
          body = null
          if (fixture.mode === 'drop-after-data') return socket.destroy()
          Promise.resolve().then(() => fixture.beforeAccept?.()).then(() => {
            if (!socket.destroyed) socket.write('250 2.0.0 fixture accepted synthetic-private-echo\r\n')
          }).catch(() => socket.destroy())
        } else if (line.startsWith('EHLO ')) socket.write('250-fixture.test\r\n250 AUTH PLAIN\r\n')
        else if (line.startsWith('AUTH ')) socket.write(fixture.mode === 'auth' ? '535 5.7.8 rejected synthetic-private-echo\r\n' : '235 2.7.0 authenticated\r\n')
        else if (line.startsWith('MAIL FROM:')) {
          // Like real relays, reject a display name in the envelope sender.
          const sender = /^MAIL FROM:<([^<>\s]*)>/.exec(line)?.[1]
          if (sender === undefined) { socket.write('501 5.1.7 bad sender syntax\r\n'); continue }
          senders.push(sender)
          socket.write('250 sender accepted\r\n')
        }
        else if (line.startsWith('RCPT TO:')) {
          if (fixture.mode === 'drop') return socket.destroy()
          socket.write(fixture.mode === 'recipient' ? '550 5.1.1 rejected synthetic-private-echo\r\n' : '250 recipient accepted\r\n')
        } else if (line === 'DATA') {
          body = []
          socket.write('354 send the message\r\n')
        } else if (line === 'STARTTLS') socket.write('454 4.7.0 TLS unavailable\r\n')
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('500 unexpected command\r\n')
      }
    })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  fixture.port = server.address().port
  return fixture

  async function close() {
    for (const socket of connections) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
