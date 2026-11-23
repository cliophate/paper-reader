import { MAX_ENCLOSURES } from '../server/enclosure-limits'
import { formatInstagramHtml, formatThreadsHtml, formatXPostHtml, formatYoutubeHtml } from './socialHtml'
import type { Entry } from './types'

function mediaUrl(src: string | null, base: string) {
  if (!src?.trim()) return
  try {
    const url = new URL(src, base || undefined)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
  } catch { /* Drop a source without a usable article URL. */ }
}

export function prepareArticleMedia(entry: Pick<Entry, 'kind' | 'url' | 'contentHtml' | 'enclosures' | 'thumbnailUrl'>) {
  const html = entry.kind === 'x' ? formatXPostHtml(entry.contentHtml)
    : entry.kind === 'instagram' ? formatInstagramHtml(entry.contentHtml)
    : entry.kind === 'threads' ? formatThreadsHtml(entry.contentHtml)
    : entry.kind === 'youtube' ? formatYoutubeHtml(entry.contentHtml)
    : entry.contentHtml
  const files = entry.enclosures?.slice(0, MAX_ENCLOSURES) ?? []
  const byUrl = new Map(files.map(file => [file.url, file]))
  const posters = new Map<string, string>()
  const thumbnail = mediaUrl(entry.thumbnailUrl, entry.url)
  if (thumbnail && !byUrl.has(thumbnail)) {
    for (const file of files) {
      if (file.type.startsWith('video')) posters.set(file.url, thumbnail)
    }
  }
  const social = entry.kind !== 'article'
  if (!/<video\b/i.test(html) && !(social && posters.size && /<img\b/i.test(html))) return { html, posters }

  // Parse inertly so embedded copies cannot preload before we remove them.
  const template = document.createElement('template')
  template.innerHTML = html
  for (const media of template.content.querySelectorAll('video')) {
    const poster = mediaUrl(media.getAttribute('poster'), entry.url)
    let removed = false
    for (const source of [media, ...media.querySelectorAll('source[src]')]) {
      const src = source.getAttribute('src')
      if (src === null) continue
      const url = mediaUrl(src, entry.url)
      if (url && !byUrl.has(url)) {
        source.setAttribute('src', url)
        continue
      }
      if (url && poster && !byUrl.has(poster) && byUrl.get(url)?.type.startsWith('video')) posters.set(url, poster)
      if (source === media) media.removeAttribute('src')
      else source.remove()
      removed = true
    }
    if (removed && !media.hasAttribute('src') && !media.querySelector('source[src]')) media.remove()
  }
  if (social && posters.size) {
    const used = new Set(posters.values())
    for (const image of template.content.querySelectorAll('img[src]')) {
      const url = mediaUrl(image.getAttribute('src'), entry.url)
      if (!url || !used.has(url)) continue
      const link = image.closest('a')
      const picture = image.closest('picture') ?? image
      picture.remove()
      if (link && !link.childElementCount && !link.textContent?.trim()) link.remove()
    }
  }
  return { html: template.innerHTML, posters }
}
