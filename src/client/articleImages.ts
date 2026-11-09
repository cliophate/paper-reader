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

export function shouldShowArticleLeadImage(thumbnailUrl: string, contentHtml: string): boolean {
  const thumbnailKey = imageKey(thumbnailUrl)
  if (!thumbnailKey) return false

  const imageTags = contentHtml.match(/<img\b[^>]*>/gi) || []
  for (const tag of imageTags) {
    const attributes = [...tag.matchAll(/\b(?:src|srcset)=["']([^"']+)["']/gi)]
    for (const attribute of attributes) {
      const candidates = attribute[0].toLowerCase().startsWith('srcset')
        ? attribute[1].split(',').map(value => value.trim().split(/\s+/)[0])
        : [attribute[1]]
      if (candidates.some(candidate => imageKey(candidate) === thumbnailKey)) return false
    }
  }
  return true
}

function imageKey(value: string): string {
  let decoded = value.trim()
  for (let pass = 0; pass < 3 && decoded.includes('&amp;'); pass += 1) decoded = decoded.replace(/&amp;/g, '&')
  try {
    const url = new URL(decoded)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    const pathname = decodeURIComponent(url.pathname)
      .replace(/-\d{2,4}x\d{2,4}(?=\.(?:avif|gif|jpe?g|png|webp)$)/i, '')
    return `${url.hostname.toLowerCase()}${pathname}`
  } catch {
    return ''
  }
}
