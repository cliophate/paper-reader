import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CollectionAnswer } from '../../shared/discussion'
import type { PulseCollection } from '../../shared/pulse'
import { api } from '../api'
import { Icon } from './Icon'

interface Reply {
  id: number
  question: string
  answer: CollectionAnswer
  more: boolean
}

export function CollectionQuestions({ collection, revision, onOpenEntry }: {
  collection: PulseCollection; revision: string; onOpenEntry: (id: string) => void
}) {
  const heading = useId()
  const suggestionsRequest = useRef<AbortController | null>(null)
  const answerRequest = useRef<AbortController | null>(null)
  const replyId = useRef(0)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(true)
  const [suggestionsError, setSuggestionsError] = useState('')
  const [replies, setReplies] = useState<Reply[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answerError, setAnswerError] = useState('')

  const getSuggestions = useCallback(async (refresh: boolean) => {
    if (suggestionsRequest.current) return
    const controller = new AbortController()
    suggestionsRequest.current = controller
    setLoadingSuggestions(true)
    setSuggestionsError('')
    try {
      const { questions } = await api.collectionSuggestions(collection.id, revision, refresh, controller.signal)
      if (!controller.signal.aborted) setSuggestions(questions)
    } catch (error) {
      if (!controller.signal.aborted) setSuggestionsError(error instanceof Error ? error.message : 'Paper could not get suggested questions.')
    } finally {
      if (suggestionsRequest.current === controller) { suggestionsRequest.current = null; setLoadingSuggestions(false) }
    }
  }, [collection.id, revision])

  useEffect(() => {
    void getSuggestions(false)
    return () => {
      suggestionsRequest.current?.abort()
      suggestionsRequest.current = null
      answerRequest.current?.abort()
      answerRequest.current = null
    }
  }, [getSuggestions])

  const ask = async (text: string, previousAnswer?: string, custom = false) => {
    text = text.trim()
    if (!text || answerRequest.current) return
    const controller = new AbortController()
    answerRequest.current = controller
    setAsking(true)
    setAnswerError('')
    try {
      const answer = await api.collectionAnswer(collection.id, revision, text, previousAnswer, controller.signal)
      if (controller.signal.aborted) return
      const reply = { id: ++replyId.current, question: text, answer, more: previousAnswer !== undefined }
      setReplies(current => [...current.slice(-19), reply])
      if (custom) setQuestion(current => current.trim() === text ? '' : current)
    } catch (error) {
      if (!controller.signal.aborted) setAnswerError(error instanceof Error ? error.message : 'Paper could not answer right now.')
    } finally {
      if (answerRequest.current === controller) { answerRequest.current = null; setAsking(false) }
    }
  }

  return <section className="collection-questions" aria-labelledby={heading}>
    <header>
      <h3 id={heading}>Go deeper</h3>
      <button type="button" className="collection-questions-refresh" disabled={loadingSuggestions} onClick={() => void getSuggestions(true)}>New suggestions</button>
    </header>
    {suggestions.length > 0 && <ul className="collection-suggestions">
      {suggestions.map(suggestion => <li key={suggestion}><button type="button" disabled={asking} onClick={() => void ask(suggestion)}>{suggestion}</button></li>)}
    </ul>}
    {loadingSuggestions && <p className="collection-questions-status" role="status">Getting suggested questions...</p>}
    {suggestionsError && <p className="collection-questions-status" role="alert">{suggestionsError}</p>}
    {!suggestions.length && !loadingSuggestions && !suggestionsError && <p className="collection-questions-status">No suggested questions for this collection.</p>}
    <form onSubmit={event => { event.preventDefault(); void ask(question, undefined, true) }}>
      <label><Icon name="edit" /><input aria-label="Ask your own question" value={question} maxLength={4000} onChange={event => setQuestion(event.target.value)} placeholder="Ask your own question" /></label>
      <button type="submit" disabled={asking || !question.trim()}>Ask</button>
    </form>
    {asking && <p className="collection-questions-status" role="status">Reading the collection...</p>}
    {answerError && <p className="collection-questions-status" role="alert">{answerError}</p>}
    <div className="collection-replies" aria-live="polite">
      {replies.map(reply => <CollectionReply key={reply.id} reply={reply} collection={collection} onOpenEntry={onOpenEntry} asking={asking}
        onMore={() => void ask(reply.question, reply.answer.entryIds.length ? reply.answer.text : '')} />)}
    </div>
  </section>
}

function CollectionReply({ reply, collection, onOpenEntry, asking, onMore }: {
  reply: Reply; collection: PulseCollection; onOpenEntry: (id: string) => void; asking: boolean; onMore: () => void
}) {
  const sourcesId = useId()
  const [showSources, setShowSources] = useState(false)
  const sources = reply.answer.entryIds.flatMap(id => collection.sources.find(source => source.id === id) || [])
  return <article className="collection-reply">
    <h4>{reply.more ? `More on "${reply.question}"` : reply.question}</h4>
    <p>{reply.answer.text}</p>
    <div className="collection-reply-actions">
      <button type="button" disabled={asking} onClick={onMore}>Tell me more</button>
      <button type="button" aria-controls={sourcesId} aria-expanded={showSources} onClick={() => setShowSources(open => !open)}>{showSources ? 'Hide sources' : 'Show sources'}</button>
    </div>
    <div id={sourcesId} hidden={!showSources}>
      {sources.length ? <ul className="collection-reply-sources">
        {sources.map(source => <li key={source.id}>
          <a href={`/?${new URLSearchParams({ collection: collection.id, entry: source.id, unread: '0' })}`} onClick={event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            onOpenEntry(source.id)
          }}>{source.title}</a>
          <span>{source.publication}</span>
        </li>)}
      </ul> : <p className="collection-questions-status">No articles were cited.</p>}
    </div>
  </article>
}
