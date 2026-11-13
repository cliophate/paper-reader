import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = path.join(directory, '.env')
if (process.argv.includes('--ai-worker-secret')) {
  const existing = fs.readFileSync(target, 'utf8')
  const match = existing.match(/^PAPER_AI_WORKER_SECRET=(.*)$/m)
  if (match && match[1].trim() && match[1].trim() !== 'replace-me') {
    console.log('PAPER_AI_WORKER_SECRET is already set. Nothing was changed.')
  } else {
    const line = `PAPER_AI_WORKER_SECRET=${crypto.randomBytes(48).toString('base64url')}`
    const next = match ? existing.replace(/^PAPER_AI_WORKER_SECRET=.*$/m, line) : `${existing}\n${line}\n`
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, target)
    } finally { fs.rmSync(temporary, { force: true }) }
    console.log('Added a private AI worker secret to .env with mode 0600.')
  }
  process.exit(0)
}
const content = fs.readFileSync(path.join(directory, '.env.example'), 'utf8')
  .replace('PAPER_INTERNAL_SECRET=replace-me', `PAPER_INTERNAL_SECRET=${crypto.randomBytes(48).toString('base64url')}`)
  .replace('PAPER_AI_WORKER_SECRET=replace-me', `PAPER_AI_WORKER_SECRET=${crypto.randomBytes(48).toString('base64url')}`)
  .replace('PAPER_SIGNING_SECRET=replace-me', `PAPER_SIGNING_SECRET=${crypto.randomBytes(48).toString('base64url')}`)
  + `\nPAPER_UID=${process.getuid?.() ?? 1000}\nPAPER_GID=${process.getgid?.() ?? 1000}\n`
try {
  fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true, mode: 0o700 })
  console.log('Created .env with mode 0600. Standalone mode is ready. Set PUBLIC_URL before remote access, or select FreshRSS and add its connection.')
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env already exists. Nothing was changed.')
    process.exitCode = 1
  } else throw error
}
