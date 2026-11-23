import type { PassageAnchor } from '../shared/annotations'

const REQUIRED_CONTEXT = 24
const startsWithWordChar = /^[\p{L}\p{M}\p{N}_]/u
const endsWithWordChar = /[\p{L}\p{M}\p{N}_]$/u

export interface PassagePosition { start: number; end: number }

// Keep whitespace outside the marked range, including in anchors saved by older clients.
function trimmedAnchor({ body, quote, position }: PassageAnchor): PassageAnchor {
  const exact = quote.exact.trim()
  const leading = quote.exact.length - quote.exact.trimStart().length
  const start = position.start + leading
  return {
    body, position: { start, end: start + exact.length },
    quote: { exact, prefix: (quote.prefix + quote.exact.slice(0, leading)).slice(-64),
      suffix: (quote.exact.slice(leading + exact.length) + quote.suffix).slice(0, 64) },
  }
}

export function anchorPassage(text: string, { start, end }: PassagePosition, body: PassageAnchor['body']): PassageAnchor {
  return trimmedAnchor({
    body, position: { start, end },
    quote: { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - 64), start), suffix: text.slice(end, end + 64) },
  })
}

// offsets[n] is the DOM text offset of normalized boundary n, in UTF-16 units.
export function passageIndex(raw: string) {
  const offsets: number[] = []
  const text = raw.replace(/\s+|[^\s]+/g, (run, offset: number) => {
    if (/\s/.test(run[0])) { offsets.push(offset); return ' ' }
    for (let i = 0; i < run.length; i++) offsets.push(offset + i)
    return run
  })
  offsets.push(raw.length)
  return { text, offsets }
}

export function locatePassage(source: string | ReturnType<typeof passageIndex>, body: PassageAnchor['body'], anchor: PassageAnchor): PassagePosition | null {
  const { text, offsets } = typeof source === 'string' ? passageIndex(source) : source
  const normalize = (value: string) => value.replace(/\s+/g, ' ')
  const trimmed = trimmedAnchor(anchor)
  const exact = normalize(trimmed.quote.exact)
  if (!exact) return null
  const prefix = normalize(trimmed.quote.prefix)
  const suffix = normalize(trimmed.quote.suffix)
  if (!prefix && !suffix) return text === exact ? { start: 0, end: offsets[text.length] } : null
  let best: PassagePosition | null = null
  let score = -1, tied = false
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
    let left = 0, right = 0
    while (left < prefix.length && text[at - left - 1] === prefix[prefix.length - left - 1]) left++
    while (right < suffix.length && text[at + exact.length + right] === suffix[right]) right++
    // Require the nearest 24 characters on each available side. A common
    // sentence ending on one side cannot compensate for a different subject.
    if (left < Math.min(REQUIRED_CONTEXT, prefix.length) || right < Math.min(REQUIRED_CONTEXT, suffix.length)) continue
    // With no saved neighbor at the article edge, reject a new continuation of the word.
    if (!suffix && endsWithWordChar.test(exact) && startsWithWordChar.test(text.slice(at + exact.length))) continue
    if (!prefix && startsWithWordChar.test(exact) && endsWithWordChar.test(text.slice(0, at))) continue
    const start = offsets[at]
    const positionHint = start === trimmed.position.start &&
      (body === anchor.body || (left === prefix.length && right === suffix.length))
    const rank = (left + right) * 2 + Number(positionHint)
    if (rank > score) {
      best = { start, end: offsets[at + exact.length] }; score = rank; tied = false
    } else if (rank === score) tied = true
  }
  return tied ? null : best
}

// Range.toString() joins adjacent paragraphs. Keep their boundaries in saved quotes.
export function passageText(root: HTMLElement) {
  const nodes: Array<{ node: Text; start: number; end: number }> = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let text = '', previousBlock: Element | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeName === 'BR') { text += '\n'; continue }
    if (!(node instanceof Text) || !node.length) continue
    const block = node.parentElement?.closest('p,li,blockquote,pre,div,h1,h2,h3,h4,h5,h6,td,figcaption') ?? null
    if (previousBlock !== block && text && !text.endsWith('\n')) text += '\n'
    previousBlock = block
    const start = text.length
    text += node.data
    nodes.push({ node, start, end: text.length })
  }
  return {
    text,
    selection(range: Range): PassagePosition | null {
      if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null
      const selected = nodes.filter(({ node }) => range.intersectsNode(node))
      const first = selected[0], last = selected.at(-1)
      if (!first || !last) return null
      const start = first.start + (range.startContainer === first.node ? range.startOffset : 0)
      const end = range.endContainer === last.node ? last.start + range.endOffset : last.end
      return text.slice(start, end).trim() ? { start, end } : null
    },
    range({ start, end }: PassagePosition) {
      const first = nodes.find(node => node.end > start)
      const last = nodes.find(node => node.end >= end)
      if (!first || !last) return null
      const range = document.createRange()
      range.setStart(first.node, Math.max(0, start - first.start))
      range.setEnd(last.node, end - last.start)
      return range
    },
  }
}
