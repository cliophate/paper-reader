import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = path.join(directory, '.env')
const content = fs.readFileSync(path.join(directory, '.env.example'), 'utf8')
  .replace('PAPER_INTERNAL_SECRET=replace-me', `PAPER_INTERNAL_SECRET=${crypto.randomBytes(48).toString('base64url')}`)
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
