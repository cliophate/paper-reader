export function sourceBaseUrl(value: string, setting: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${setting} must be a complete HTTP or HTTPS URL`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${setting} must use HTTP or HTTPS without credentials, query parameters or fragments`)
  }
  return url.href.replace(/\/+$/, '')
}

export function minifluxBaseUrl(value: string) { return sourceBaseUrl(value, 'MINIFLUX_BASE_URL') }
