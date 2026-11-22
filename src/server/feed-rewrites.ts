import { JSDOM } from 'jsdom'
import type { ExtractionRules } from '../shared/feed-overrides.js'

function absoluteImageSet(value: string, base: string) {
  const candidates: string[] = []
  // A source URL may contain commas. Only trailing commas or the comma after a descriptor end a candidate.
  const token = /[\s,]*([^\s,]\S*)\s*/y
  let offset = 0
  while (offset < value.length) {
    token.lastIndex = offset
    const match = token.exec(value)
    if (!match) break
    let source = match[1]
    let descriptor = ''
    offset = token.lastIndex
    if (source.endsWith(',')) {
      let end = source.length
      while (source[end - 1] === ',') end--
      source = source.slice(0, end)
    } else {
      const end = value.indexOf(',', offset)
      descriptor = value.slice(offset, end < 0 ? value.length : end).trim()
      offset = end < 0 ? value.length : end + 1
    }
    if (descriptor && !/^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) continue
    const url = URL.parse(source, base)
    if (url && ['https:', 'http:'].includes(url.protocol)) candidates.push(descriptor ? `${url.href} ${descriptor}` : url.href)
  }
  return candidates.join(', ')
}

export function applyFeedRewrites(root: ParentNode, base: string, rules: ExtractionRules) {
  for (const selector of rules.removeSelectors) {
    for (const element of root.querySelectorAll(selector)) element.remove()
  }
  if (rules.lazyImages) {
    for (const image of root.querySelectorAll('img, source')) {
      const src = image.getAttribute('data-src') || image.getAttribute('data-lazy-src')
      if (src) image.setAttribute('src', src)
      const srcset = image.getAttribute('data-srcset') || image.getAttribute('srcset')
      if (srcset) {
        image.setAttribute('srcset', absoluteImageSet(srcset, base))
        image.removeAttribute('data-srcset')
      }
    }
  }
  if (rules.stripTracking) {
    for (const link of root.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.getAttribute('href')!, base)
        if (!['http:', 'https:'].includes(url.protocol)) continue
        stripTrackingParameters(url)
        link.setAttribute('href', url.href)
      } catch { /* The sanitizer checks the original link. */ }
    }
  }
}

function stripTrackingParameters(url: URL) {
  if (!url.search) return
  // Preserve the spelling and order of the remaining parameters, including signed values.
  const fields = url.search.slice(1).split('&')
  const retained = fields.filter(field => {
    const equals = field.indexOf('=')
    let name = equals < 0 ? field : field.slice(0, equals)
    try { name = decodeURIComponent(name) } catch { return true }
    return !/^(?:utm_|(?:fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$)/i.test(name)
  })
  if (retained.length !== fields.length) url.search = retained.join('&')
}

export function rewriteFeedHtml(html: string, base: string, rules?: ExtractionRules): string {
  if (!rules || !rules.removeSelectors.length && !rules.lazyImages && !rules.stripTracking) return html
  const fragment = JSDOM.fragment(html)
  applyFeedRewrites(fragment, base, rules)
  const container = fragment.ownerDocument.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
