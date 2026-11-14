import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../types'
import type { Discussion, DiscussionProvider } from '../../shared/discussion'

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/discussion${path}`, { method, signal, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Discussion request failed')
  return data
}

export function ArticleDiscussion({ entry, initialQuote, onClose }: { entry: Entry; initialQuote: string; onClose: () => void }) {
  const [discussion, setDiscussion] = useState<Discussion | null>(null)
  const [provider, setProvider] = useState<DiscussionProvider | null>(null)
  const [question, setQuestion] = useState('')
  const [quote, setQuote] = useState(initialQuote)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [sending, setSending] = useState(false)
  const [connected, setConnected] = useState(true)
  const [sourceId, setSourceId] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLElement>(null)
  const nearBottom = useRef(true)
  const alive = useRef(true)
  const pending = useRef<{ requestId: string; question: string; quote: string } | null>(null)
  const busy = discussion?.messages.some(message => message.status === 'running') || false

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    let events: EventSource | undefined
    const previousFocus = document.activeElement as HTMLElement | null
    input.current?.focus()
    void (async () => {
      try {
        const state = await request<{ discussion: Discussion | null; enabled: boolean; provider: DiscussionProvider }>(`?entryId=${encodeURIComponent(entry.id)}`, 'GET', undefined, controller.signal)
        if (!alive.current) return
        setProvider(state.provider)
        if (!state.enabled) throw new Error('Article discussions are not enabled.')
        const value = state.discussion || await request<Discussion>('', 'POST', { entryId: entry.id, fullText: Boolean(entry.fullText) }, controller.signal)
        if (!alive.current) return
        setDiscussion(value); setReady(true)
        events = new EventSource(`/api/discussion/events?entryId=${encodeURIComponent(entry.id)}`)
        events.onmessage = event => {
          const value: Discussion | null = JSON.parse(event.data)
          // E-ink readers receive the completed reply without repainting every delta.
          if (document.documentElement.dataset.theme === 'e-ink' && value?.messages.at(-1)?.status === 'running') {
            setDiscussion(current => current?.messages.at(-1)?.status === 'running' ? current : value)
            setConnected(true)
            return
          }
          setDiscussion(current => value && current && current.revision > value.revision ? current : value); setConnected(true)
          if (!value) { setReady(false); setError('This discussion was deleted. Close and reopen to start again.') }
        }
        events.onerror = () => setConnected(false)
        events.onopen = () => setConnected(true)
      } catch (error) { if (alive.current && !controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not open discussion') }
    })()
    return () => { alive.current = false; controller.abort(); events?.close(); previousFocus?.focus() }
  }, [entry.id])

  useEffect(() => {
    if (nearBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [discussion])

  async function send() {
    if (!question.trim() || sending || busy) return
    setSending(true); setError('')
    // Reuse the ID after a lost HTTP response. The server deduplicates retries.
    if (!pending.current || pending.current.question !== question || pending.current.quote !== quote) pending.current = { requestId: crypto.randomUUID(), question, quote }
    try {
      const result = await request<Discussion>('/message', 'POST', { entryId: entry.id, ...pending.current })
      if (!alive.current) return
      // SSE is authoritative, but this also handles a not-yet-open event stream.
      setDiscussion(current => current && current.revision > result.revision ? current : result)
      setQuestion(''); setQuote(''); pending.current = null; nearBottom.current = true
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Could not send question') }
    finally { if (alive.current) setSending(false) }
  }

  async function action(kind: 'stop' | 'delete') {
    if (kind === 'delete' && !window.confirm('Delete this discussion and its saved article text?')) return
    try {
      await request(kind === 'stop' ? '/stop' : '', kind === 'stop' ? 'POST' : 'DELETE', { entryId: entry.id })
      if (kind === 'delete') onClose()
    } catch (error) { setError(error instanceof Error ? error.message : 'Request failed') }
  }

  const source = discussion?.source.paragraphs.find(paragraph => paragraph.id === sourceId)
  function renderText(text: string) {
    return text.split(/(\[P\d+\])/g).map((part, i) => {
      const id = part.slice(1, -1)
      return /^\[P\d+\]$/.test(part) && discussion?.source.paragraphs.some(p => p.id === id)
        ? <button key={i} className="discussion-citation" onClick={() => setSourceId(id)} aria-label={`Read source paragraph ${id}`}>{part}</button> : part
    })
  }

  return <section className="discussion-panel" ref={panel} role="dialog" aria-label="Article discussion" onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); sourceId ? setSourceId('') : onClose() }
    if (event.key === 'Tab') {
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),a[href]') || [])]
      const first = elements[0], last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <header className="discussion-header"><div><strong>Discuss</strong><span>{provider ? `${provider.provider === 'codex' ? 'Codex worker' : provider.provider === 'openai' ? 'OpenAI-compatible API' : 'AI off'}${provider.model ? ` · ${provider.model}` : ''}` : 'Loading provider...'}</span></div><button onClick={onClose} aria-label="Return to article">Back to article</button></header>
    <div className="discussion-source"><strong>{discussion?.source.title || entry.title}</strong><small>{discussion?.source.warning || 'Preparing article text...'}</small>
      {discussion && discussion.source.kind !== (entry.fullText ? 'fulltext' : 'feed') && <small>This conversation uses a different article version. Delete it to start with the version currently open.</small>}
    </div>
    <div className="discussion-messages" ref={list} onScroll={() => { const el = list.current!; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {ready && !discussion?.messages.length && <p className="discussion-empty">Ask a question about the article, or bring your own interpretation. Sending shares the article text and this conversation with {provider?.provider === 'codex' ? 'your Codex worker' : 'your configured OpenAI-compatible API' }.</p>}
      {discussion?.messages.map(message => <article key={message.id} className={`discussion-message ${message.role}`}><small>{message.role === 'user' ? 'You' : 'Paper'}</small>
        {message.quote && <blockquote>{message.quote}</blockquote>}
        <div>{renderText(message.text)}</div>
        {message.status === 'running' && <small role="status">{message.text ? 'Writing...' : 'Thinking...'}</small>}
        {message.error && <p className="discussion-error">{message.error}</p>}
      </article>)}
    </div>
    {source && <aside className="discussion-passage"><button onClick={() => setSourceId('')} aria-label="Close source passage">Close</button><strong>Source paragraph {source.id}</strong><p>{source.text}</p></aside>}
    <form className="discussion-compose" onSubmit={event => { event.preventDefault(); void send() }}>
      {quote && <blockquote>{quote}<button type="button" onClick={() => setQuote('')}>Remove passage</button></blockquote>}
      {!connected && <p role="status">Reconnecting. Your response stays saved on the server.</p>}
      {error && <p role="alert" className="discussion-error">{error}</p>}
      <label className="sr-only" htmlFor="discussion-question">Your question</label>
      <textarea id="discussion-question" ref={input} value={question} maxLength={4000} placeholder="Ask about this article..." onChange={event => setQuestion(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send() }
      }} />
      <div><button type="button" disabled={!ready || busy || sending} onClick={() => void action('delete')}>Delete discussion</button>
        {busy ? <button type="button" onClick={() => void action('stop')}>Stop</button> : <button type="submit" disabled={!ready || sending || !question.trim()}>{sending ? 'Sending...' : 'Send'}</button>}
      </div>
    </form>
  </section>
}
