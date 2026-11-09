import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Config } from './config.js'

export async function runOpenCode(
  config: Config['openCode'],
  model: string,
  instruction: string,
  input: unknown,
): Promise<unknown> {
  if (!config.enabled) throw new Error('OpenCode is disabled')
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-recap-'))
  const inputPath = path.join(temporaryDirectory, 'input.json')
  await fs.writeFile(inputPath, JSON.stringify(input), { mode: 0o600 })

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.bin, [
        'run',
        '--pure',
        '--agent', 'paper-recap',
        '--model', model,
        '--format', 'default',
        instruction,
        '--file', inputPath,
      ], {
        cwd: config.configDir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => child.kill('SIGTERM'), 240_000)
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => {
        clearTimeout(timeout)
        if (code !== 0) return reject(new Error(`OpenCode exited with ${code}: ${stderr.slice(-1200)}`))
        resolve(stdout)
      })
    })
    return parseJsonOutput(output)
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function parseJsonOutput(output: string): unknown {
  const fenced = output.match(/```json\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] || output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)
  if (!candidate.trim()) throw new Error('OpenCode returned no JSON')
  return JSON.parse(candidate)
}
