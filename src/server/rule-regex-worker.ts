import { parentPort } from 'node:worker_threads'
import type { Candidate, RegexExpression, RegexJob } from './rule-regex.js'

function compile(node: RegexExpression): (row: Candidate, terms?: Candidate) => boolean {
  switch (node.kind) {
    case 'sql': return (_, terms) => Boolean(terms?.[node.column])
    case 'not': {
      const match = compile(node.child)
      return (row, terms) => !match(row, terms)
    }
    case 'and': case 'or': {
      const children = node.children.map(compile)
      return node.kind === 'and' ? (row, terms) => children.every(test => test(row, terms)) : (row, terms) => children.some(test => test(row, terms))
    }
    case 'regex': {
      const regex = new RegExp(node.pattern, node.flags)
      regex.test('')
      const fields = node.field === 'text' ? ['content_text', 'full_content_text']
        : node.field ? [node.field] : ['title', 'content_text', 'full_content_text']
      return row => fields.some(field => regex.test(String(row[field])))
    }
  }
}

let rows: Candidate[] = []
parentPort!.on('message', (message: 'ready' | { snapshot: string } | RegexJob) => {
  if (message === 'ready' || 'snapshot' in message) {
    if (message !== 'ready') rows = JSON.parse(message.snapshot)
    parentPort!.postMessage('ready')
    return
  }
  try {
    const test = compile(message.expression)
    const terms = new Map(message.terms?.map(term => [term.sequence, term]))
    const matches = rows.filter(row => row.sequence > message.after && test(row, terms.get(row.sequence)))
    parentPort!.postMessage({ matches: matches.map(row => row.sequence) })
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    parentPort!.postMessage({ invalid: true })
  }
})
