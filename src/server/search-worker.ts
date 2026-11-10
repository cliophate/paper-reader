import { parentPort, workerData } from 'node:worker_threads'
import { PaperDatabase, type PageOptions } from './db.js'
import type { StreamRef } from './types.js'

// The server already owns coordinated storage. Never initialize or migrate here.
const database = new PaperDatabase(String(workerData.databasePath), { readOnly: true })
const port = parentPort!
let acknowledge: ((error?: string) => void) | undefined
port.on('message', async (message: { type: string; id: number; stream: StreamRef; options: PageOptions; error?: string }) => {
  if (message.type === 'saved') { acknowledge?.(message.error); return }
  if (message.type !== 'search') return
  try {
    const page = database.searchEntriesPage(message.stream, message.options)
    let step = page.next()
    while (!step.done) {
      await new Promise<void>((resolve, reject) => {
        acknowledge = error => { acknowledge = undefined; error ? reject(new Error(error)) : resolve() }
        port.postMessage({ type: 'snapshot', id: message.id, snapshot: step.value })
      })
      step = page.next()
    }
    port.postMessage({ type: 'result', id: message.id, page: step.value })
  } catch (error) {
    const detail = error instanceof Error ? error.message : ''
    const expected = /^(This list changed\.|Search expired\.|Invalid article cursor)/.test(detail)
    port.postMessage({ type: 'error', id: message.id, unavailable: !expected, error: expected ? detail : 'Search could not complete. Try again.' })
  }
})
