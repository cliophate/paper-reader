export interface SubscribeQuery { url: string; error: string }

function validUrl(value: string): boolean {
  if (value.length > 4096 || /[\s\\\u0000-\u001f]/.test(value) || !/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return !!url.hostname && !url.username && !url.password
  } catch { return false }
}

export function firstSharedUrl(text: string): string {
  const match = text.match(/https?:\/\/[^\s<>"']+/i)
  if (!match) return ''
  let value = match[0].replace(/[.,;!?:]+$/, '')
  // Keep balanced parentheses in URLs, but discard prose wrapped around a link.
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1)
  }
  return value
}

export function parseSubscribeQuery(search: string): SubscribeQuery {
  const params = new URLSearchParams(search)
  const url = params.get('url')?.trim() || firstSharedUrl(params.get('text') || '') || firstSharedUrl(params.get('title') || '')
  return { url, error: !url ? 'Enter a website or feed URL to find feeds.' : validUrl(url) ? '' : 'Enter a complete HTTP or HTTPS URL without credentials.' }
}

// Only this local route is a supported login destination. Never follow an
// arbitrary returnTo URL supplied to the public login page.
export function subscribeLoginReturn(search: string): string {
  const value = new URLSearchParams(search).get('returnTo') || ''
  if (!/^\/subscribe(?:\?|$)/.test(value) || /[\\\u0000-\u001f]/.test(value)) return ''
  const url = new URL(value, 'https://paper.invalid')
  return url.pathname === '/subscribe' && !url.hash ? url.pathname + url.search : ''
}

export function subscribeBookmarklet(publicUrl: string, currentOrigin: string): string {
  const target = new URL('/subscribe', publicUrl || currentOrigin).href + '?url='
  return `javascript:void(window.open(${JSON.stringify(target)}+encodeURIComponent(location.href),'_blank','noopener'))`
}
