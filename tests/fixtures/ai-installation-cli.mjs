#!/usr/bin/env node
import fs from 'node:fs'
import readline from 'node:readline'
const args = process.argv.slice(2)
function output(schema) {
  if (schema?.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, output(value)]))
  if (schema?.type === 'array') return []
  if (schema?.type === 'boolean') return true
  return 'Fixture briefing from the isolated worker.'
}
if (args[0] === 'exec') {
  for await (const chunk of process.stdin) { /* Drain the supplied fixture prompt. */ }
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'))
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(output(schema)))
  fs.appendFileSync(`${process.env.HOME}/.codex/fixture-runs`, Object.keys(schema.properties).join(',') + '\n')
} else {
  const send = event => process.stdout.write(JSON.stringify(event) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const event = JSON.parse(line)
    if (event.method === 'initialize') send({ id: event.id, result: {} })
    if (event.method === 'thread/start') send({ id: event.id, result: { thread: { id: 'fixture' } } })
    if (event.method === 'turn/start') {
      send({ method: 'item/agentMessage/delta', params: { delta: 'Fixture discussion reply.' } })
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    }
  })
}
