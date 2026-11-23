import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Annotation, PassageAnchor } from '../../shared/annotations'
import { api } from '../api'
import { downloadAnnotations, downloadLibrary } from '../annotationExport'
import { anchorPassage, locatePassage, passageIndex, passageText } from '../passage'
import { Icon } from './Icon'
import { Modal } from './Modal'

const empty: Annotation[] = []

export function useAnnotations(online: boolean, entryId: string) {
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<{ entryId: string; items: Annotation[]; error?: string }>()
  const refresh = useCallback(() => setVersion(value => value + 1), [])
  useEffect(() => {
    if (!online) { setResult(undefined); return }
    const controller = new AbortController()
    api.annotations(entryId, controller.signal).then(items => {
      if (!controller.signal.aborted) setResult({ entryId, items })
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ entryId, items: [], error: error.message })
    })
    return () => controller.abort()
  }, [entryId, online, version])
  const current = online && result?.entryId === entryId ? result : undefined
  return { items: current?.items ?? empty, loading: online && !current, error: current?.error, refresh }
}

export function usePassageRanges(content: RefObject<HTMLDivElement | null>, items: Annotation[], body: PassageAnchor['body'], html: string) {
  const [found, setFound] = useState<Set<number>>(new Set())
  useLayoutEffect(() => {
    const root = content.current?.querySelector<HTMLElement>('.article-content')
    if (!root || !items.length) { setFound(new Set()); return }
    const projection = passageText(root)
    const index = passageIndex(projection.text)
    const matches = new Set<number>(), ranges: Range[] = []
    for (const item of items) {
      if (!item.anchor || item.parentId !== null) continue
      const position = locatePassage(index, body, item.anchor)
      const range = position && projection.range(position)
      if (range) { ranges.push(range); matches.add(item.id) }
    }
    setFound(matches)
    if (typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set('paper-passages', new Highlight(...ranges))
      return () => { CSS.highlights.delete('paper-passages') }
    }
  }, [content, items, body, html])
  return found
}

type Editor = { note: string; editing?: Annotation; parentId?: number }

export function ArticleNotes({ online, entryId, items, loading, error, refresh, found, passage, onClose, onKirby }: ReturnType<typeof useAnnotations> & {
  passage: () => { body: PassageAnchor['body']; text: string }
  online: boolean; entryId: string; found: Set<number>; onClose: () => void; onKirby?: (quote: string) => void
}) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [source, setSource] = useState<ReturnType<typeof passage> | null>(null)
  const passageField = useRef<HTMLTextAreaElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  async function write(operation: () => Promise<unknown>) {
    setBusy(true); setProblem('')
    try { await operation(); setEditor(null); setSource(null); refresh() }
    catch (error) { setProblem(error instanceof Error ? error.message : 'Could not save this change.'); refresh() }
    finally { setBusy(false) }
  }
  function remove(item: Annotation) {
    const message = item.note ? 'Delete this note?' : 'Delete this highlight and its attached notes?'
    if (window.confirm(message)) void write(() => api.removeAnnotation(item.id, item.revision))
  }
  const notes = new Map<number, Annotation[]>()
  for (const item of items) if (item.parentId !== null) {
    const group = notes.get(item.parentId) ?? []
    group.push(item); notes.set(item.parentId, group)
  }
  function renderNote(item: Annotation) {
    return <div key={item.id} className="saved-note"><p>{item.note}</p>
      <div className="annotation-actions"><button onClick={() => setEditor({ note: item.note, editing: item })}>Edit note</button><button onClick={() => remove(item)}>Delete note</button></div>
    </div>
  }
  return createPortal(<Modal title="Article notes" onClose={onClose} busy={busy} className="annotation-dialog">
    {(error || problem) && <p role="alert">{problem || error} <button onClick={refresh}>Reload notes</button></p>}
    {!online && <p role="status">Reconnect to save your changes.</p>}
    {loading && <p role="status">Loading notes...</p>}
    <fieldset disabled={busy}>
      {source ? <div>
        {/* Chromium disables arrow-key selection in a native readonly textarea. */}
        <label>Select a passage<textarea ref={passageField} autoFocus aria-readonly="true" rows={8} spellCheck={false}
          value={source.text} onBeforeInput={event => event.preventDefault()} onChange={() => {}} /></label>
        <div className="annotation-actions">
          <button disabled={!online} onClick={() => {
            const field = passageField.current!
            const anchor = anchorPassage(source.text, { start: field.selectionStart, end: field.selectionEnd }, source.body)
            if (!anchor.quote.exact.trim()) { setProblem('Select text to highlight.'); field.focus(); return }
            void write(() => api.addAnnotation({ entryId, anchor }))
          }}>Save highlight</button>
          <button onClick={() => setSource(null)}>Cancel</button>
        </div>
      </div> : editor ? <form onSubmit={event => {
        event.preventDefault()
        if (!online) return
        void write(() => editor.editing ? api.editNote(editor.editing.id, editor.editing.revision, editor.note)
          : api.addAnnotation({ entryId, parentId: editor.parentId, note: editor.note }))
      }}>
        <label>{editor.editing ? 'Edit note' : editor.parentId ? 'Highlight note' : 'Article note'}
          <textarea autoFocus rows={4} maxLength={32000} value={editor.note} onChange={event => setEditor({ ...editor, note: event.target.value })} />
        </label>
        <div className="annotation-actions"><button disabled={!online || !editor.note.trim()}>Save note</button><button type="button" onClick={() => setEditor(null)}>Cancel</button></div>
      </form> : <>
        <div className="annotation-actions">
          <button disabled={!online} onClick={() => setSource(passage())}>Select passage</button>
          <button onClick={() => setEditor({ note: '' })}>Add article note</button>
          <button disabled={!items.length} onClick={() => downloadAnnotations(items)}>Export Markdown</button></div>
        {online && !loading && !error && !items.length && <p>No highlights or notes yet.</p>}
        {items.filter(item => item.parentId === null).map(item => <section key={item.id} className="annotation-row">
          {item.anchor ? <><blockquote>{item.anchor.quote.exact}</blockquote>
            <small>{item.anchor.body === 'full' ? 'Full text' : 'Feed text'}{!found.has(item.id) && ' · Passage not found'}</small>
            <details><summary>Highlight options</summary><div className="annotation-actions">
              <button onClick={() => setEditor({ note: '', parentId: item.id })}>Add highlight note</button>
              {onKirby && <button onClick={() => onKirby(item.anchor!.quote.exact)}>Create note in Kirby</button>}
              <button onClick={() => remove(item)}>Delete highlight</button>
            </div></details>
            {notes.get(item.id)?.map(renderNote)}
          </> : renderNote(item)}
        </section>)}
      </>}
    </fieldset>
  </Modal>, document.body)
}

export function Highlights({ online, onBack }: { online: boolean; onBack: () => void }) {
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState<number[]>([])
  const [version, retry] = useState(0)
  const [page, setPage] = useState<{ items: Annotation[]; next: number | null }>()
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [selected, setSelected] = useState(new Map<number, string>())
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  const before = pages.at(-1)
  const term = query.trim().toLocaleLowerCase()
  useEffect(() => {
    setPage(undefined); setError('')
    if (!online) return
    const controller = new AbortController()
    async function load() {
      let cursor = before
      do {
        const result = await api.annotationPage({ before: cursor, signal: controller.signal })
        const parents = new Map(result.items.map(row => [row.id, row.anchor]))
        const items = result.items.map(row => row.parentId === null ? row : {
          ...row, anchor: parents.get(row.parentId) ?? result.parents[row.parentId] ?? null,
        }).filter(row => !term || [row.note, row.anchor?.quote.exact ?? ''].some(text => text.toLocaleLowerCase().includes(term)))
        if (controller.signal.aborted) return
        if (items.length || !result.next) { setPage({ items, next: result.next }); return }
        cursor = result.next
      } while (cursor)
    }
    void load().catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => controller.abort()
  }, [online, before, term, version])

  async function exportLibrary(selection?: Map<number, string>) {
    setExporting(true); setExportError('')
    try {
      await downloadLibrary(selection)
    } catch (error) { setExportError(error instanceof Error ? error.message : 'Could not export notes.') }
    finally { setExporting(false) }
  }
  const visible = page?.items ?? empty
  const nextPage = page?.next
  return <main className="topics-library panel"><div className="topics-scroll"><div className="topics-column highlights-library">
    <header className="topics-header"><div className="topics-heading"><button className="topics-back mobile-back icon-button" onClick={onBack} aria-label="Back to sources"><Icon name="back" /></button><h1 ref={heading} tabIndex={-1}>Highlights</h1></div></header>
    <input type="search" aria-label="Search highlights and notes" placeholder="Search highlights and notes" value={query} onChange={event => { setPages([]); setQuery(event.target.value) }} />
    <div className="annotation-actions"><button disabled={!selected.size || !online || exporting} onClick={() => void exportLibrary(selected)}>Export selected ({selected.size})</button>
      <button disabled={!online || exporting} onClick={() => void exportLibrary()}>Export all</button></div>
    {exportError && <p role="alert">{exportError}</p>}
    {!online ? <p>Connect to view your highlights and notes.</p> : error ? <p role="alert">{error} <button onClick={() => retry(version + 1)}>Retry</button></p>
      : !page ? <p role="status">Loading highlights...</p> : !visible.length && <p>{term ? 'No matches.' : 'No highlights or notes yet.'}</p>}
    {visible.map(item => <section key={item.id} className="annotation-row">
      <header><input type="checkbox" aria-label={`Select ${item.note ? 'note' : 'highlight'} for ${item.title}`} checked={selected.has(item.id)} onChange={event => {
        const next = new Map(selected)
        if (event.target.checked) next.set(item.id, item.entryId); else next.delete(item.id)
        setSelected(next)
      }} /><a href={`/a/${item.linkNumber}`}>{item.title}</a></header>
      {item.anchor && <blockquote>{item.anchor.quote.exact}</blockquote>}
      {item.note && <p>{item.note}</p>}
      <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString()}</time>
    </section>)}
    {!!pages.length && <button onClick={() => setPages(pages.slice(0, -1))}>Previous page</button>}
    {nextPage && <button onClick={() => setPages([...pages, nextPage])}>Next page</button>}
  </div></div></main>
}
