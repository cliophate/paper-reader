import type { NextFunction, Request, Response } from 'express'

export function preventFraming(_request: Request, response: Response, next: NextFunction) {
  const setHeader = response.setHeader
  // Express can replace the CSP when it generates redirects or errors.
  response.setHeader = function (name, value) {
    if (name.toLowerCase() === 'content-security-policy') {
      const policies: string[] = Array.isArray(value) ? value : [String(value)]
      value = policies.map(policy => [
        ...policy.split(';').map(directive => directive.trim()).filter(directive => directive && !/^frame-ancestors(?:\s|$)/i.test(directive)),
        "frame-ancestors 'none'",
      ].join('; '))
    }
    return setHeader.call(this, name, value)
  }
  response.set('Content-Security-Policy', "frame-ancestors 'none'")
  response.set('X-Frame-Options', 'DENY')
  next()
}
