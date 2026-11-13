import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let directory: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-init-worker-'))
  fs.mkdirSync(path.join(directory, 'scripts'))
  fs.copyFileSync('scripts/init-config.mjs', path.join(directory, 'scripts/init-config.mjs'))
  fs.copyFileSync('.env.example', path.join(directory, '.env.example'))
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
const init = (...args: string[]) => execFileSync(process.execPath, [path.join(directory, 'scripts/init-config.mjs'), ...args], { encoding: 'utf8' })
const envFile = () => path.join(directory, '.env')

it('generates a separate private worker secret without printing it', () => {
  const output = init()
  const content = fs.readFileSync(envFile(), 'utf8')
  const secrets = [...content.matchAll(/^PAPER_(?:AI_WORKER|INTERNAL|SIGNING)_SECRET=(.+)$/gm)].map(match => match[1])
  expect(secrets).toHaveLength(3)
  expect(new Set(secrets).size).toBe(3)
  for (const secret of secrets) { expect(secret).toHaveLength(64); expect(output).not.toContain(secret) }
  expect(fs.statSync(envFile()).mode & 0o777).toBe(0o600)
})

it('adds a worker secret to existing configuration and preserves it on repeated upgrades', () => {
  const original = 'CODEX_ENABLED=true\nREADWISE_TOKEN=synthetic-retained-token\n'
  fs.writeFileSync(envFile(), original)
  init('--ai-worker-secret')
  const content = fs.readFileSync(envFile(), 'utf8')
  expect(content).toContain(original)
  expect(content).toMatch(/PAPER_AI_WORKER_SECRET=[A-Za-z0-9_-]{64}/)
  init('--ai-worker-secret')
  expect(fs.readFileSync(envFile(), 'utf8')).toBe(content)
  expect(fs.statSync(envFile()).mode & 0o777).toBe(0o600)
})

it('replaces only an unconfigured worker secret during upgrade', () => {
  fs.writeFileSync(envFile(), 'PAPER_AI_WORKER_SECRET=replace-me\nCODEX_ENABLED=true\n')
  init('--ai-worker-secret')
  expect(fs.readFileSync(envFile(), 'utf8')).toMatch(/^PAPER_AI_WORKER_SECRET=[A-Za-z0-9_-]{64}\nCODEX_ENABLED=true\n$/)
})
