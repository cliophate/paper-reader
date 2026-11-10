import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Publish a complete private file atomically. Two shared-lock participants may
// start together; the hard link lets exactly one publish without replacement.
export function runtimeSecrets(directory: string): { internalSecret: string; signingSecret: string } {
  const filename = path.join(directory, 'secrets.json')
  if (!fs.existsSync(filename)) {
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ internalSecret: crypto.randomBytes(32).toString('base64url'), signingSecret: crypto.randomBytes(32).toString('base64url') }))
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    try { fs.linkSync(temporary, filename) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    finally { fs.rmSync(temporary, { force: true }) }
    const parent = fs.openSync(directory, 'r')
    try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
  }
  if (!fs.lstatSync(filename).isFile()) throw new Error('Invalid private secrets file')
  let saved: { internalSecret?: unknown; signingSecret?: unknown }
  try { saved = JSON.parse(fs.readFileSync(filename, 'utf8')) }
  catch { throw new Error('Could not read private secrets file. Restore its backup before restarting.') }
  if (typeof saved.internalSecret !== 'string' || saved.internalSecret.length < 32 || typeof saved.signingSecret !== 'string' || saved.signingSecret.length < 32) throw new Error('Invalid private secrets file. Restore its backup before restarting.')
  fs.chmodSync(filename, 0o600)
  return { internalSecret: saved.internalSecret, signingSecret: saved.signingSecret }
}
