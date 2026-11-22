import { parentPort, workerData } from 'node:worker_threads'
import { PaperDatabase, type PageOptions } from './db.js'
import type { StreamRef } from './types.js'
import { SearchLimitError } from './search-query.js'
import type { BulkSelection } from './search-service.js'

// The server already owns coordinated storage. Never initialize or migrate here.
const database = new PaperDatabase(String(workerData.databasePath), { readOnly: true })
const port = parentPort!
let acknowledge: ((error?: string) => void) | undefined
port.on('message', async (message: { type: string; id: number; stream: StreamRef; options: PageOptions; selection?: BulkSelection; error?: string }) => {
  if (message.type === 'saved') { acknowledge?.(message.error); return }
  if (message.type !== 'search') return
  try {
    const { selection, stream, options } = message
    if (selection) {
      let result
      switch (selection.kind) {
        case 'preview':
          result = database.previewUnread(stream, options, selection.withRevisions)
          break
        case 'relative':
          result = database.relativeUnreadSelection(stream, selection.anchorId, selection.direction, { ...options, snapshot: selection.snapshot, displayedIds: selection.displayedIds }, selection.withRevisions)
          break
        case 'unread':
          result = database.previewUnread(stream, { includeMuted: true }, false, selection.ids)
          break
      }
      port.postMessage({ type: 'result', id: message.id, value: result })
      return
    }
    const page = database.searchEntriesPage(message.stream, message.options)
    let step = page.next()
    while (!step.done) {
      await new Promise<void>((resolve, reject) => {
        acknowledge = error => { acknowledge = undefined; error ? reject(new Error(error)) : resolve() }
        port.postMessage({ type: 'snapshot', id: message.id, snapshot: step.value })
      })
      step = page.next()
    }
    port.postMessage({ type: 'result', id: message.id, value: step.value })
  } catch (error) {
    const detail = error instanceof Error ? error.message : ''
    const failure = error instanceof SearchLimitError ? 'limit' : /^(This list changed\.|Search expired\.|Invalid article cursor)/.test(detail) ? 'snapshot' : undefined
    port.postMessage({ type: 'error', id: message.id, failure, error: failure ? detail : 'Search could not complete. Try again.' })
  }
})
