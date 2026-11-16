export function minifluxBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('MINIFLUX_BASE_URL must be a complete HTTP or HTTPS URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('MINIFLUX_BASE_URL must use HTTP or HTTPS without credentials, query parameters or fragments')
  }
  return url.href.replace(/\/+$/, '')
}
