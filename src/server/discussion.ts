import { JSDOM } from 'jsdom'
import type { PaperDatabase } from './db.js'
import type { ChatModel } from './chat-model.js'
import type { Discussion, DiscussionSource } from '../shared/discussion.js'

export function discussionSource(title: string, author: string, url: string, html: string, kind: DiscussionSource['kind']): DiscussionSource {
  if (html.length > 500_000) throw new Error('This article is too large for discussion. Select a shorter article.')
  const dom = new JSDOM(`<body>${html}</body>`)
  try {
    const body = dom.window.document.body
    body.querySelectorAll('script,style,iframe,video,img').forEach(node => node.remove())
    body.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,pre,div,br,figcaption').forEach(node => {
      node.before(dom.window.document.createTextNode('\n\n'))
      node.after(dom.window.document.createTextNode('\n\n'))
    })
    const parts = (body.textContent || '').split(/\n\s*\n/).map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (parts.join('').length < 30) throw new Error('This article has too little text to discuss. Images and videos are not included.')
    if (parts.join('').length > 60000) throw new Error('This article is too long for discussion. No text was sent to the model.')
    return { title, author, url, kind, paragraphs: parts.map((text, i) => ({ id: `P${i + 1}`, text })),
      warning: kind === 'feed' ? 'Using feed text. It may be an excerpt. Images and videos are not included.' : 'Using extracted article text. Extraction may omit content. Images and videos are not included.' }
  } finally { dom.window.close() }
}

export class DiscussionService {
  private running = new Map<string, AbortController>()
  private listeners = new Map<string, Set<(value: Discussion | null) => void>>()
  constructor(private db: PaperDatabase, private model: ChatModel) { db.interruptDiscussions() }

  get(id: string) { return this.db.discussion(id) }
  subscribe(id: string, callback: (value: Discussion | null) => void) {
    const set = this.listeners.get(id) || new Set()
    set.add(callback); this.listeners.set(id, set)
    return () => { set.delete(callback); if (!set.size) this.listeners.delete(id) }
  }
  private publish(discussion: Discussion) {
    discussion.revision = (discussion.revision || 0) + 1
    this.db.saveDiscussion(discussion)
    this.listeners.get(discussion.entryId)?.forEach(callback => callback(discussion))
  }
  create(entryId: string, source: DiscussionSource) {
    const existing = this.get(entryId)
    if (existing) return existing
    const discussion: Discussion = { entryId, revision: 0, source, messages: [] }
    this.publish(discussion)
    return discussion
  }
  stop(id: string) { this.running.get(id)?.abort() }
  stopAll() { for (const controller of this.running.values()) controller.abort() }
  remove(id: string) {
    if (this.running.has(id)) throw new Error('Stop the response before deleting this discussion.')
    this.db.deleteDiscussion(id)
    this.listeners.get(id)?.forEach(callback => callback(null))
  }
  send(entryId: string, requestId: string, question: string, quote: string) {
    const discussion = this.get(entryId)
    if (!discussion) throw new Error('Open a discussion first.')
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new Error('Invalid message ID')
    if (discussion.messages.some(message => message.id === requestId)) return discussion
    question = question.trim(); quote = quote.trim()
    if (!question || question.length > 4000 || quote.length > 6000) throw new Error('Use a question under 4,000 characters and a passage under 6,000 characters.')
    if (quote && !discussion.source.paragraphs.map(p => p.text).join(' ').includes(quote.replace(/\s+/g, ' '))) throw new Error('That passage is not in the saved source. Start a new discussion to use the current article version.')
    if (this.running.size >= 1) throw new Error('A response is already running. Finish or stop it first.')
    if (discussion.messages.length >= 40) throw new Error('This discussion has reached 20 questions. Start a new discussion to continue.')
    if (discussion.messages.reduce((n, m) => n + m.text.length + (m.quote?.length || 0), 0) > 80000) throw new Error('This discussion has reached its context limit. Start a new discussion to continue.')
    const controller = new AbortController()
    this.running.set(entryId, controller)
    discussion.messages.push({ id: requestId, role: 'user', text: question, quote, status: 'complete' })
    const reply: Discussion['messages'][number] = { id: `${requestId}-reply`, role: 'assistant', text: '', status: 'running' }
    const input = { source: discussion.source, conversation: discussion.messages.filter(m => m.status === 'complete').map(({ role, text, quote }) => ({ role, text, quote })) }
    discussion.messages.push(reply); this.publish(discussion)
    void (async () => {
      let lastUpdate = 0
      try {
        reply.text = await this.model(input, controller.signal, text => {
          reply.text = text
          if (Date.now() - lastUpdate >= 100) { this.publish(discussion); lastUpdate = Date.now() }
        })
        reply.status = 'complete'
      } catch (error) {
        reply.status = controller.signal.aborted ? 'stopped' : 'error'
        reply.error = controller.signal.aborted ? 'Response stopped.' : error instanceof Error ? error.message : 'Could not generate a reply.'
      } finally { this.running.delete(entryId); this.publish(discussion) }
    })()
    return discussion
  }
}
