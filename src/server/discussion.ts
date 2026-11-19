import { JSDOM } from 'jsdom'
import type { PaperDatabase } from './db.js'
import type { ChatModel } from './chat-model.js'
import type { Discussion, DiscussionSource } from '../shared/discussion.js'
import type { PulseCollection } from '../shared/pulse.js'
import {
  COLLECTION_ANSWER_PROMPT, COLLECTION_ANSWER_SCHEMA, COLLECTION_SUGGESTIONS_PROMPT, COLLECTION_SUGGESTIONS_SCHEMA,
  MAX_COLLECTION_ANSWER_LENGTH, MAX_COLLECTION_QUESTION_LENGTH, CollectionDiscussionError, collectionSources,
  validateCollectionAnswer, validateCollectionSuggestions, type CollectionDiscussionModel,
} from './collection-discussion.js'

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

interface CollectionScope {
  enabled: () => boolean
  get: (id: string) => PulseCollection | undefined
  model: CollectionDiscussionModel
}

export class DiscussionService {
  private pending = new Set<Promise<unknown>>()
  async drain() { this.stopAll(); await Promise.allSettled([...this.pending]) }
  private running = new Map<string, AbortController>()
  private listeners = new Map<string, Set<(value: Discussion | null) => void>>()
  private collectionAnswer?: AbortController
  private suggestionRuns = new Map<string, { controller: AbortController; task: Promise<string[]> }>()
  private suggestions = new Map<string, { revision: string; questions: string[]; refreshedAt?: number }>()
  constructor(private db: PaperDatabase, private model: ChatModel, private collections?: CollectionScope) { db.interruptDiscussions() }

  private track<T>(task: Promise<T>) {
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

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
  stopAll() {
    for (const controller of this.running.values()) controller.abort()
    this.collectionAnswer?.abort()
    for (const { controller } of this.suggestionRuns.values()) controller.abort()
  }
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
    if (this.running.size || this.collectionAnswer) throw new Error('A response is already running. Finish or stop it first.')
    if (discussion.messages.length >= 40) throw new Error('This discussion has reached 20 questions. Start a new discussion to continue.')
    if (discussion.messages.reduce((n, m) => n + m.text.length + (m.quote?.length || 0), 0) > 80000) throw new Error('This discussion has reached its context limit. Start a new discussion to continue.')
    const controller = new AbortController()
    this.running.set(entryId, controller)
    discussion.messages.push({ id: requestId, role: 'user', text: question, quote, status: 'complete' })
    const reply: Discussion['messages'][number] = { id: `${requestId}-reply`, role: 'assistant', text: '', status: 'running' }
    const input = { source: discussion.source, conversation: discussion.messages.filter(m => m.status === 'complete').map(({ role, text, quote }) => ({ role, text, quote })) }
    discussion.messages.push(reply); this.publish(discussion)
    const task = (async () => {
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
    void this.track(task)
    return discussion
  }

  private collection(id: string, revision: string) {
    if (!this.collections?.enabled()) throw new CollectionDiscussionError(503, 'Collection questions are off in Settings.')
    const collection = this.collections.get(id)
    if (!collection) throw new CollectionDiscussionError(404, 'This collection is no longer available.')
    if (collection.questionsRevision !== revision) throw new CollectionDiscussionError(409, 'This collection changed. Show updates in Pulse before asking again.')
    return { collection, model: this.collections.model }
  }

  async suggest(id: string, revision: string, refresh: boolean) {
    const { collection, model } = this.collection(id, revision)
    const key = JSON.stringify([id, revision])
    const running = this.suggestionRuns.get(key)
    if (running) return running.task
    const saved = this.suggestions.get(id)
    const cached = saved?.revision === revision ? saved : undefined
    if (cached && !refresh) return cached.questions
    if (cached?.refreshedAt !== undefined && Date.now() - cached.refreshedAt < 30_000) {
      throw new CollectionDiscussionError(429, 'Wait 30 seconds between requests for new suggestions.')
    }
    if (this.suggestionRuns.size >= 2) throw new CollectionDiscussionError(429, 'Paper is getting suggestions for other collections. Try again shortly.')
    if (cached) cached.refreshedAt = Date.now()
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(85_000)])
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted()
      const articles = collectionSources(this.db, collection).map(({ article }) => article)
      const questions = articles.length ? validateCollectionSuggestions(await model(COLLECTION_SUGGESTIONS_PROMPT, {
        articles, previousQuestions: cached?.questions || [],
      }, COLLECTION_SUGGESTIONS_SCHEMA, signal)) : []
      signal.throwIfAborted()
      this.collection(id, revision)
      this.suggestions.delete(id)
      // Keep one revision per collection, and bound the cache across collections.
      if (this.suggestions.size >= 128) this.suggestions.delete(this.suggestions.keys().next().value!)
      this.suggestions.set(id, { revision, questions, refreshedAt: refresh ? Date.now() : undefined })
      return questions
    }).finally(() => this.suggestionRuns.delete(key))
    this.suggestionRuns.set(key, { controller, task })
    return this.track(task)
  }

  async answer(id: string, revision: string, question: string, previousAnswer: string | undefined, requestSignal: AbortSignal) {
    const { collection, model } = this.collection(id, revision)
    question = question.trim()
    if (!question || question.length > MAX_COLLECTION_QUESTION_LENGTH) throw new CollectionDiscussionError(400, 'Enter a question of up to 4,000 characters.')
    if (previousAnswer !== undefined && previousAnswer.length > MAX_COLLECTION_ANSWER_LENGTH) throw new CollectionDiscussionError(400, 'That reply is too long to use for a follow-up.')
    if (this.running.size || this.collectionAnswer) throw new CollectionDiscussionError(409, 'A response is already running. Try again when it finishes.')
    const controller = new AbortController()
    this.collectionAnswer = controller
    const signal = AbortSignal.any([controller.signal, requestSignal, AbortSignal.timeout(85_000)])
    const task = (async () => {
      signal.throwIfAborted()
      const sources = collectionSources(this.db, collection, question)
      const raw = sources.length ? await model(COLLECTION_ANSWER_PROMPT, {
        articles: sources.map(({ article }) => article), question, previousAnswer,
      }, COLLECTION_ANSWER_SCHEMA, signal) : { answer: '', sourceIds: [] }
      signal.throwIfAborted()
      this.collection(id, revision)
      return validateCollectionAnswer(raw, sources, previousAnswer !== undefined)
    })().finally(() => { this.collectionAnswer = undefined })
    return this.track(task)
  }
}
