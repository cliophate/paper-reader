#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('codex fixture'); process.exit(0) }
const mode = args[args.indexOf('--model') + 1]
fs.appendFileSync(path.join(process.env.HOME, 'starts'), JSON.stringify({ args, pid: process.pid }) + '\n')
const capture = { argv: args, env: process.env, pid: process.pid, cwd: process.cwd() }
function wait() {
  fs.writeFileSync(path.join(process.env.HOME, 'running.json'), JSON.stringify(capture))
  setInterval(() => {}, 1000)
}
function result(input) {
  if (mode?.startsWith('stderr:')) { console.error(`OpenAI Codex v0.167.0\n--------\nworkdir: /tmp/fixture\nmodel: fixture\nprovider: fixture\n--------\nuser\n${input}\nERROR: ${mode.slice(7)}`); console.log(JSON.stringify({ type: 'turn.failed', error: { message: mode.slice(7) } })); process.exit(1) }
  if (mode === 'fail') { console.error(input); process.exit(1) }
  if (mode === 'hang') { wait(); return }
  if (mode === 'invalid') return '{broken private article'
  return JSON.stringify({ ...capture, input })
}
if (args[0] === 'exec') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const output = result(input)
  if (output) fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], output)
} else if (args[0] === 'run') {
  const output = result(fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8'))
  if (output) console.log(output)
} else {
  const send = event => process.stdout.write(JSON.stringify(event) + '\n')
  let model
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const event = JSON.parse(line)
    if (event.method === 'initialize') send({ id: event.id, result: {} })
    if (event.method === 'thread/start') {
      model = event.params.model
      send({ id: event.id, result: { thread: { id: 'fixture-thread' } } })
    }
    if (event.method === 'turn/start') {
      send({ method: 'item/agentMessage/delta', params: { delta: 'Fixture ' } })
      if (model === 'invalid') { send({ id: 2, result: {} }); return }
      if (model?.startsWith('stderr:')) { console.error('user\nHTTP 401 invalid schema'); send({ id: event.id, error: { message: model.slice(7) } }); return }
      if (model === 'hang') { wait(); return }
      if (model === 'fail') { console.error('private article'); process.exit(1) }
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { delta: 'reply.' } })
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      }, 10)
    }
  })
}
