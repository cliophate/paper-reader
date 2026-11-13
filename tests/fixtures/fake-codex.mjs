#!/usr/bin/env node
import fs from 'node:fs'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const capture = { argv, env: process.env, cwd: process.cwd() }
if (argv[0] === 'exec') {
  let prompt = ''
  process.stdin.on('data', chunk => { prompt += chunk })
  process.stdin.on('end', () => {
    const schema = JSON.parse(fs.readFileSync(argv[argv.indexOf('--output-schema') + 1], 'utf8'))
    fs.writeFileSync(argv[argv.indexOf('--output-last-message') + 1], JSON.stringify({ ...capture, prompt, schema }))
  })
} else if (argv[0] === 'app-server') {
  const send = event => process.stdout.write(JSON.stringify(event) + '\n')
  let thread
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const event = JSON.parse(line)
    if (event.method === 'initialize') send({ id: event.id, result: {} })
    if (event.method === 'thread/start') {
      thread = event.params
      send({ id: event.id, result: { thread: { id: 'synthetic-thread' } } })
    }
    if (event.method === 'turn/start') {
      send({ method: 'item/agentMessage/delta', params: { delta: JSON.stringify({ ...capture, thread }) } })
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    }
  })
} else {
  process.exitCode = 1
}
