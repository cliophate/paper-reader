import { sensitiveParameter } from './feed-url-display.js'

export function signedQueryName(name: string): boolean {
  return sensitiveParameter(name) || /^expires$/i.test(name)
}
