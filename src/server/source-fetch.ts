import { boundedApiRequest, type ApiRequest } from './feed-http.js'

export type SourceRequest = Omit<RequestInit, 'method' | 'body'> & { method?: ApiRequest['method']; body?: string | URLSearchParams }

export async function sourceFetch(url: string, init: SourceRequest, trustedOrigins?: readonly string[]) {
  if (!trustedOrigins) return fetch(url, init)
  const headers = new Headers(init.headers)
  const result = await boundedApiRequest(new URL(url), trustedOrigins, {
    method: init.method, signal: init.signal ?? undefined, body: init.body?.toString(),
    contentType: init.body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json',
    authorization: headers.get('authorization') ?? undefined, minifluxToken: headers.get('x-auth-token') ?? undefined,
  }, 32 * 1024 * 1024)
  return new Response([204, 205, 304].includes(result.status) ? null : result.text, {
    status: result.status, headers: result.retryAfter ? { 'Retry-After': result.retryAfter } : {},
  })
}
