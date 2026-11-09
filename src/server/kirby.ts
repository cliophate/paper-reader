import type { Config } from './config.js'

export interface KirbyNoteInput {
  title: string
  sourceUrl: string
  quote: string
}

interface KirbyPublishResponse {
  ok?: boolean
  error?: string
  id?: string
  slug?: string
  status?: string
  url?: string
  panelUrl?: string
}

export class KirbyPublisher {
  constructor(private readonly config: Config['kirby']) {}

  get configured(): boolean {
    return Boolean(this.config.publishUrl && this.config.token)
  }

  async createNote(input: KirbyNoteInput): Promise<{ id: string; panelUrl: string; url: string }> {
    if (!this.config.publishUrl || !this.config.token) throw new Error('Kirby note publishing is not configured')

    const form = new FormData()
    form.set('payload', JSON.stringify({
      title: input.title,
      destination: 'notes',
      text: buildKirbyNoteText(input),
    }))

    const response = await fetch(this.config.publishUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.token}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    const payload = await response.json().catch(() => null) as KirbyPublishResponse | null
    if (!response.ok || !payload?.ok) {
      if (response.status === 409) throw new Error('A Kirby draft with this title already exists')
      throw new Error(payload?.error || `Kirby note creation failed with ${response.status}`)
    }
    const pageId = payload.id || (payload.slug ? `notes/${payload.slug}` : '')
    if (!pageId) throw new Error('Kirby created the draft but did not return its page ID')

    return {
      id: pageId,
      panelUrl: kirbyPanelUrl(this.config.publishUrl, pageId),
      url: payload.url || '',
    }
  }
}

export function buildKirbyNoteText(input: KirbyNoteInput): string {
  const title = escapeMarkdownLabel(input.title.trim())
  const sourceUrl = markdownUrl(input.sourceUrl)
  const source = new URL(input.sourceUrl).hostname.replace(/^www\./i, '')
  const quote = normalizeQuote(input.quote)
    .split('\n')
    .map(line => line ? `> ${line}` : '>')
    .join('\n')

  return `**[${title}](${sourceUrl})** <span class='source'>${source}</span>\n\n${quote}`
}

export function kirbyPanelUrl(publishUrl: string, pageId: string): string {
  const panelId = pageId.split('/').map(part => encodeURIComponent(part)).join('+')
  return new URL(`/panel/pages/${panelId}`, publishUrl).toString()
}

function normalizeQuote(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1')
}

function markdownUrl(value: string): string {
  const url = new URL(value)
  return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29')
}
