import type { NextFunction, Request, Response } from 'express'

// Reject state changes initiated by another website. Remote access needs proxy auth.
export function requireSameOrigin(publicUrl: string) {
  const expected = new URL(publicUrl).origin
  return (request: Request, response: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
    const origin = request.header('origin')
    if ((origin && origin !== expected) || request.header('sec-fetch-site') === 'cross-site') {
      return response.status(403).json({ error: 'Cross-site requests are not allowed' })
    }
    next()
  }
}
