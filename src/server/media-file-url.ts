// Feeds sometimes label an HTML player page as audio or video.
export function isMediaFileUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.replace(/\.$/, '')
  if (/\.x?html?\/?$/i.test(url.pathname)) return false
  if (/(^|\.)youtu\.be$/.test(host)) return false
  if (/(^|\.)youtube(?:-nocookie)?\.com$/.test(host)) return !/^\/(?:embed|watch|shorts|live)(?:\/|$)/.test(url.pathname)
  if (['player.vimeo.com', 'www.vimeo.com', 'vimeo.com'].includes(host)) {
    return /^\/(?:progressive_redirect|external|play)\//.test(url.pathname) || /\.(?:mp4|webm|mov)$/i.test(url.pathname)
  }
  return true
}
