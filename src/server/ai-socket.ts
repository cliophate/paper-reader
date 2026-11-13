import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type http from 'node:http'

export async function listenAiSocket(server: http.Server, socketPath: string) {
  if (!path.isAbsolute(socketPath)) throw new Error('PAPER_AI_WORKER_SOCKET must be an absolute path')
  const directory = await fs.stat(path.dirname(socketPath))
  if (directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) {
    throw new Error('The AI socket directory must belong to the worker UID with mode 0700')
  }
  const existing = await fs.lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Refusing to replace a non-worker socket')
    await new Promise<void>((resolve, reject) => {
      const probe = net.connect(socketPath)
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('AI socket is still in use')) })
      probe.once('connect', () => { probe.destroy(); reject(new Error('AI socket is still in use')) })
      probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(error))
    })
    await fs.unlink(socketPath)
  }
  const mask = process.umask(0o077)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    await fs.chmod(socketPath, 0o600)
  } finally { process.umask(mask) }
}
