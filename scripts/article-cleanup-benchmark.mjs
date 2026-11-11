import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanupInputs } from '../tests/fixtures/article-cleanup-inputs.mjs'

// Usage after building: node scripts/article-cleanup-benchmark.mjs [text module]
// A source module can also be measured with: node --import tsx scripts/...
const moduleUrl = pathToFileURL(path.resolve(process.argv[2] || 'dist-server/text.js')).href
if (process.argv[3] === '--case') {
  const { cleanArticleHtml } = await import(moduleUrl)
  const name = process.argv[4], count = Number(process.argv[5])
  const input = cleanupInputs[name](count)
  const start = performance.now()
  const output = cleanArticleHtml(input)
  const ms = performance.now() - start
  assert(output.length > 0)
  console.log(JSON.stringify({ name, count, bytes: Buffer.byteLength(input), ms }))
} else {
  for (const name of Object.keys(cleanupInputs)) {
    for (const count of name === 'enclosure' ? [100, 500, 1000, 1500] : [1000, 5000, 10000]) {
      const child = spawnSync(process.execPath, [...process.execArgv, import.meta.filename, process.argv[2] || 'dist-server/text.js', '--case', name, String(count)], {
        encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH },
      })
      if (child.error?.code === 'ETIMEDOUT') {
        console.log(JSON.stringify({ name, count, timeoutMs: 8000 }))
      } else {
        assert.equal(child.status, 0, child.stderr || child.error?.message)
        process.stdout.write(child.stdout)
      }
    }
  }
}
