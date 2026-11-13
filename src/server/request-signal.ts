import type { IncomingMessage, ServerResponse } from 'node:http'
import { AiError } from './ai-errors.js'

export async function withRequestSignal<T>(request: IncomingMessage, response: ServerResponse, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort(new AiError('cancelled'))
  request.once('aborted', cancel)
  response.once('close', cancel)
  try {
    if (request.aborted || response.destroyed) cancel()
    return await task(controller.signal)
  } finally {
    request.off('aborted', cancel)
    response.off('close', cancel)
  }
}
