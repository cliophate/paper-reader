import type { NextFunction, Request, Response } from 'express'

const FRAME_POLICY = "frame-ancestors 'none'"

export function preventFraming(_request: Request, response: Response, next: NextFunction) {
  const setHeader = response.setHeader
  // Express can replace the CSP when it generates redirects or errors. Keep any existing
  // policy intact and add framing as its own policy, since browsers enforce every policy.
  response.setHeader = function (name, value) {
    if (name.toLowerCase() === 'content-security-policy') {
      const policies: string[] = Array.isArray(value) ? value : [String(value)]
      const present = policies.some(header => header.split(',').some(policy => policy.trim() === FRAME_POLICY))
      value = present ? value : policies.map(String).join(', ') + `, ${FRAME_POLICY}`
    }
    return setHeader.call(this, name, value)
  }
  response.set('Content-Security-Policy', FRAME_POLICY)
  response.set('X-Frame-Options', 'DENY')
  next()
}
