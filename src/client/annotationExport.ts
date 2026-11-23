import { api } from './api'
import type { Annotation } from '../shared/annotations'

// CommonMark accepts a backslash before any ASCII punctuation. Encode leading
// indentation separately so a pasted tab or four spaces cannot start a code block.
function literal(value: string) {
  return value.replace(/\r\n?/g, '\n')
    .replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '\\$&')
    .replace(/ {2,}$/gm, '')
    .replace(/^[ \t]+/gm, spaces => spaces.replace(/ /g, '&#32;').replace(/\t/g, '&#9;'))
}

function sourceLink(value: string) {
  let url: URL
  try { url = new URL(value) } catch { return '' }
  if (!['http:', 'https:'].includes(url.protocol)) return ''
  return '<' + url.href.replace(/[<>\s\\]/g, encodeURIComponent) + '>'
}

export function annotationMarkdown(items: Annotation[]): string {
  const articles = new Map<string, Annotation[]>()
  for (const item of items) {
    const group = articles.get(item.entryId) ?? []
    group.push(item)
    articles.set(item.entryId, group)
  }
  const sections = []
  for (const rows of articles.values()) {
    const article = rows[0]
    const parts = ['# ' + literal(article.title.replace(/[\r\n]+/g, ' ')), [literal(article.author), literal(article.publishedAt), sourceLink(article.url)].filter(Boolean).join('\n\n')]
    const groups = new Map<number, Annotation[]>()
    for (const row of rows) {
      const id = row.parentId ?? row.id
      const group = groups.get(id) ?? []
      group.push(row)
      groups.set(id, group)
    }
    for (const group of groups.values()) {
      const quote = group.find(row => row.anchor)?.anchor?.quote.exact
      if (quote) parts.push(literal(quote).split('\n').map(line => '> ' + line).join('\n'))
      for (const row of group) if (row.note) parts.push(literal(row.note))
    }
    sections.push(parts.filter(Boolean).join('\n\n'))
  }
  return sections.join('\n\n---\n\n') + '\n'
}

export function downloadAnnotations(items: Annotation[]) {
  downloadMarkdown([annotationMarkdown(items)])
}

function selectedRows(article: Annotation[], selection: ReadonlyMap<number, string>) {
  const parents = new Set(article.filter(row => selection.has(row.id)).map(row => row.parentId))
  return article.filter(row => selection.has(row.id) || parents.has(row.id)
    || (row.parentId !== null && selection.has(row.parentId)))
}

async function* annotatedArticleIds() {
  let after = ''
  while (true) {
    const ids = await api.annotationArticleIds(after)
    if (!ids.length) return
    yield* ids
    after = ids[ids.length - 1]
  }
}

export async function downloadLibrary(selection?: ReadonlyMap<number, string>) {
  const ids = selection ? new Set(selection.values()) : annotatedArticleIds()
  const parts: Blob[] = []
  for await (const id of ids) {
    const article = await api.annotations(id)
    const rows = selection ? selectedRows(article, selection) : article
    if (rows.length) parts.push(new Blob([parts.length ? '\n---\n\n' : '', annotationMarkdown(rows)]))
  }
  downloadMarkdown(parts)
}

function downloadMarkdown(parts: BlobPart[]) {
  const url = URL.createObjectURL(new Blob(parts, { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'paper-highlights.md'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
