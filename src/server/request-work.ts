import type { NextFunction, Request, Response } from 'express'

const pending = new Set<Promise<unknown>>()

// Track execution, including work that outlives a disconnected HTTP client.
export function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    const work = Promise.resolve().then(() => handler(request, response, next)).catch(next)
    pending.add(work)
    void work.finally(() => pending.delete(work))
  }
}

export async function drainRequests() {
  while (pending.size) await Promise.allSettled([...pending])
}
