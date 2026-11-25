import type { Entry } from './types'

export function articleImageSource(entry: Entry, url = entry.thumbnailUrl) {
  if (!entry.offline && navigator.onLine) return url
  if (!url || !navigator.serviceWorker?.controller) return undefined
  try { return '/_offline/image?' + new URLSearchParams({ url: new URL(url, entry.url).href }) }
  catch { return undefined }
}

export function removeBrokenArticleImage(image: HTMLImageElement): void {
  const figure = image.closest('figure')
  if (figure && figure.querySelectorAll('img').length === 1) {
    figure.remove()
    return
  }
  const picture = image.closest('picture')
  if (picture) picture.remove()
  else image.remove()
}

export function shouldShowArticleLeadImage(thumbnailUrl: string, contentHtml: string, baseUrl?: string): boolean {
  const thumbnailKey = imageKey(thumbnailUrl, baseUrl)
  if (!thumbnailKey) return false
  if (!/<img\b/i.test(contentHtml)) return true
  const template = document.createElement('template')
  template.innerHTML = contentHtml
  return !opensWithImage(template.content) && !articleBodyImageKeys(template.content, baseUrl).has(thumbnailKey)
}

function opensWithImage(body: DocumentFragment): boolean {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent?.trim()) return false
    } else if (node.nodeName === 'IMG') {
      const image = node as HTMLImageElement
      return Boolean(image.getAttribute('src') || image.getAttribute('srcset') || image.closest('picture')?.querySelector('source[srcset]'))
    } else if (!['A', 'ARTICLE', 'DIV', 'FIGURE', 'P', 'PICTURE', 'SOURCE', 'SPAN'].includes(node.nodeName)) return false
  }
  return false
}

export function articleBodyImageKeys(body: DocumentFragment, baseUrl?: string): Set<string> {
  const keys = new Set<string>()
  for (const image of body.querySelectorAll('img, picture > source[srcset]')) {
    const candidates = (image.getAttribute('srcset') || '').split(',').map(value => value.trim().split(/\s+/)[0])
    for (const src of [image.getAttribute('src'), ...candidates]) {
      if (src) keys.add(imageKey(src, baseUrl))
    }
  }
  return keys
}

export function imageKey(value: string, baseUrl?: string): string {
  if (!value.trim()) return ''
  let decoded = value.trim()
  for (let pass = 0; pass < 3 && decoded.includes('&amp;'); pass += 1) decoded = decoded.replace(/&amp;/g, '&')
  try {
    const url = new URL(decoded, baseUrl || undefined)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    const pathname = decodeURIComponent(url.pathname)
      .replace(/-\d{2,4}x\d{2,4}(?=\.(?:avif|gif|jpe?g|png|webp)$)/i, '')
    return `${url.hostname.toLowerCase()}${pathname}`
  } catch {
    return ''
  }
}
