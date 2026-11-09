const RETWEET_PREFIX = /^RT[\s\u2002]+([\s\S]*?)<br\s*\/?>/i
const QUOTE_SEPARATOR = /<hr\b[^>]*>/i
const QUOTED_AUTHOR = /^([\s\S]*?):[\s\u2002]+([\s\S]*)$/

export function formatXPostHtml(html: string): string {
  let body = proxyXVideos(stripXgoChrome(html.trim()))
  let repostLabel = ''

  body = body.replace(RETWEET_PREFIX, (_match, author: string) => {
    repostLabel = `<p class="x-repost-label">Reposted from <strong>${author.trim()}</strong></p>`
    return ''
  })

  const separator = body.search(QUOTE_SEPARATOR)
  const main = groupTrailingMedia((separator < 0 ? body : body.slice(0, separator)).trim())
  const quoted = separator < 0 ? '' : body.slice(separator).replace(QUOTE_SEPARATOR, '').trim()

  return [
    repostLabel,
    `<div class="x-post-body">${main}</div>`,
    quoted ? formatQuotedPost(quoted) : '',
  ].join('')
}

function stripXgoChrome(html: string): string {
  if (!/Powered by xgo\.ing/i.test(html)) return html
  const metricsStart = html.indexOf('<div><span><span>💬</span>')
  const prefix = '<div><div><div>'
  if (!html.startsWith(prefix) || metricsStart < prefix.length) return html
  return html.slice(prefix.length, metricsStart).replace(/<\/div><\/div>\s*$/, '').trim()
}

function proxyXVideos(html: string): string {
  return html
    .replace(/(<video\b)(?![^>]*\bplaysinline\b)/gi, '$1 playsinline')
    .replace(/\bsrc=(['"])(https:\/\/video\.twimg\.com\/[^'"]+)\1/gi, (_match, quote: string, source: string) => {
      const url = source.replace(/&amp;/g, '&')
      return `src=${quote}/api/x/media?url=${encodeURIComponent(url)}${quote}`
    })
}

function formatQuotedPost(html: string): string {
  const contents = html.match(/^<div\b[^>]*class=["'][^"']*\brsshub-quote\b[^"']*["'][^>]*>([\s\S]*)<\/div>$/i)?.[1]
    || html.match(/^<div\b[^>]*>([\s\S]*)<\/div>$/i)?.[1]
    || html
  const authorMatch = contents.match(QUOTED_AUTHOR)
  if (!authorMatch) return `<aside class="x-quoted-post"><div class="x-quote-kicker">Quoted post</div><div class="x-quote-body">${contents}</div></aside>`

  return `<aside class="x-quoted-post"><div class="x-quote-kicker">Quoted post</div><div class="x-quote-author">${authorMatch[1].trim()}</div><div class="x-quote-body">${groupTrailingMedia(authorMatch[2].trim())}</div></aside>`
}

export function formatInstagramHtml(html: string): string {
  const videoUrl = html.match(/href="([^"]+\.mp4(?:\?[^"]*)?)"/i)?.[1]
  if (!videoUrl) return html
  const poster = html.match(/<img\b[^>]*src="([^"]+)"/i)?.[1] || ''
  return `<video controls playsinline preload="metadata"${poster ? ` poster="${poster}"` : ''} src="${videoUrl}"></video>`
}

export function formatThreadsHtml(html: string): string {
  return html
    .replace(/^\s*<p>\s*<strong>@?[^<]+<\/strong>:\s*<\/p>/i, '')
    .replace(/<p>\s*<\/p>\s*$/i, '')
    .trim()
}

export function formatYoutubeHtml(html: string): string {
  const description = html.match(/<figcaption\b[^>]*class="[^"]*enclosure-description[^"]*"[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1]
  if (description) return `<div class="youtube-description">${description.trim()}</div>`
  return html.replace(/<figure\b[^>]*class="[^"]*enclosure[^"]*"[^>]*>[\s\S]*?<\/figure>/i, '').trim()
}

function groupTrailingMedia(html: string): string {
  const media = html.match(/(?:<br\s*\/?>\s*)*((?:<img\b[^>]*>\s*(?:<br\s*\/?>\s*)*)+)$/i)
  if (!media) return html
  const images = media[1].match(/<img\b[^>]*>/gi) || []
  if (!images.length) return html
  return `${html.slice(0, media.index).replace(/(?:<br\s*\/?>\s*)+$/i, '')}<div class="x-media-grid media-count-${Math.min(images.length, 4)}">${images.join('')}</div>`
}
