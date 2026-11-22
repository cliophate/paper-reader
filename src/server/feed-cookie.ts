import { decodeHTML } from 'entities'
import { escapeHtml, plainText } from './text.js'

export const MIN_REDACTED_COOKIE_LENGTH = 8

export function cookieValues(cookie: string): string[] {
  const values = cookie.split(';').flatMap(pair => {
    const equals = pair.indexOf('=')
    if (equals < 0) return []
    const value = pair.slice(equals + 1).trim().replace(/^"(.*)"$/, '$1')
    return value ? [value] : []
  })
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

export function reflectsCookie(location: string, values: string[]): boolean {
  // Cookie headers are ASCII. Decode each percent-encoded byte independently so a
  // malformed escape elsewhere in the Location cannot hide an encoded value.
  const decoded = location.replace(/%([a-f\d]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  return values.some(value => location.includes(value) || decoded.includes(value))
}

export function cookieSafeValidator(value: string | undefined, secrets: string[]) {
  return value && secrets.length && reflectsCookie(value, secrets) ? undefined : value
}

export function cookiePattern(values: string[]) {
  return values.length
    ? new RegExp(values.map(value => value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('|'), 'g')
    : undefined
}

export function extractedCookieRedactor(cookie: string) {
  const pattern = cookiePattern(cookieValues(cookie).filter(value => value.length >= MIN_REDACTED_COOKIE_LENGTH))
  if (!pattern) return

  const redacted = (value: string) => {
    let current = value
    let found = false
    // Match at each decoding step, including the form the search index reads.
    for (let pass = 0; ; pass++) {
      const clean = current.replace(pattern, '[*****]')
      found ||= clean !== current
      if (pass === 4) return found ? clean : undefined
      const decoded = decodeHTML(clean)
      if (decoded === clean) return found ? clean : undefined
      current = decoded
    }
  }

  return {
    text: (value: string) => redacted(value) ?? value,
    html(value: string) {
      // Sanitized HTML escapes angle brackets in text and attribute values and
      // double-quotes its attributes. Keep decoded text out of the markup.
      const html = value.replace(/<[^>]*>|[^<]+/g, part => {
        if (part.startsWith('<')) return part.replace(/ [^ =]+="([^"]*)"/g,
          (attribute, content: string) => redacted(content) === undefined ? attribute : '')
        const clean = redacted(part)
        return clean === undefined ? part : escapeHtml(clean)
      })
      // Text extraction can join inline elements or normalize whitespace.
      const clean = redacted(plainText(html))
      return clean === undefined ? html : escapeHtml(clean)
    },
  }
}
