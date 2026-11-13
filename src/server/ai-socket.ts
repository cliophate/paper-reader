import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import type http from 'node:http'

export async function listenAiSocket(server: http.Server, socketPath: string) {
  if (!path.isAbsolute(socketPath)) throw new Error('PAPER_AI_WORKER_SOCKET must be an absolute path')
  if (Buffer.byteLength(socketPath) > 103) throw new Error('PAPER_AI_WORKER_SOCKET exceeds the 103-byte Unix socket path limit')
  const directory = await fs.stat(path.dirname(socketPath))
  if (directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) {
    throw new Error('The AI socket directory must belong to the worker UID with mode 0700')
  }
  const release = await lockSocket(socketPath)
  try {
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
    // Node unlinks its listening socket during close. Keep the lock until then.
    server.once('close', release)
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    release()
    throw error
  }
}

async function lockSocket(socketPath: string): Promise<() => void> {
  const file = await fs.open(`${socketPath}.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error('The AI socket lock must belong to the worker UID with mode 0600')
    // flock shares the inherited open file description with this helper. EOF
    // releases it even if the worker dies without running shutdown handlers.
    const holder = spawn(process.execPath, ['-e', `
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', 3] });
      if (result.status !== 0) process.exit(result.status === 73 ? 73 : 1);
      process.stdin.resume();
      process.stdout.write('locked');
    `], { stdio: ['pipe', 'pipe', 'ignore', file.fd] })
    holder.stdin!.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      holder.once('error', () => reject(new Error('Could not start AI socket lock helper')))
      holder.once('exit', code => reject(new Error(code === 73 ? 'AI socket is still in use' : 'Could not acquire AI socket lock; install flock')))
      holder.stdout!.once('data', () => resolve())
    })
    const lost = () => { throw new Error('AI socket lock helper exited unexpectedly') }
    holder.once('exit', lost)
    return () => { holder.off('exit', lost); holder.stdin!.end() }
  } finally { await file.close() }
}
