import type { FeedMove } from '../../shared/feed-checks'
import { FeedCheckDetails } from './FeedChecks'
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Feed } from '../types'
import { fullTextMode, setFullTextMode, type FullTextMode } from '../fullTextPreferences'
export function FeedRepair({ feed, move, onChanged }: { feed: Feed; move?: FeedMove; onChanged: () => Promise<unknown> }) {
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewFeed>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [mode, setMode] = useState<FullTextMode>(() => fullTextMode(feed.id))
  useEffect(() => { setUrl(''); setPreview(null); setError(''); setMessage(''); setMode(fullTextMode(feed.id)) }, [feed.id])
  const check = async () => {
    setBusy(true); setError(''); setPreview(null); setMessage('')
    try { setPreview(await api.previewFeed(url.trim())) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not validate this feed') }
    finally { setBusy(false) }
  }
  const repair = async (target: { url: string } | { repairRef: string }) => {
    setBusy(true); setError('')
    try { await api.repairFeed(feed.id, target, feed.urlRef ?? feed.url); setPreview(null); setUrl(''); setMessage('Feed URL repaired. Existing articles and reading state were preserved.'); await onChanged() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not repair this feed') }
    finally { setBusy(false) }
  }
  const repairRef = move?.repairRef
  return <section className="feed-repair">
    {move && <div className="feed-move">
      {move.redirects.map((hop, index) => <p key={index}>{hop.status === 301 || hop.status === 308 ? 'Permanent' : 'Temporary'} redirect (HTTP {hop.status})<br />{hop.url || 'Private destination'}</p>)}
      {move.declaredUrl && <p>New address declared by the feed<br />{move.declaredUrl}</p>}
      {move.suggestedUrl && move.redirects.length > 1 && !move.declaredUrl && <p>Suggested address<br />{move.suggestedUrl}</p>}
      {repairRef && <button disabled={busy} onClick={() => void repair({ repairRef })}>Use new address</button>}
    </div>}
    <FeedCheckDetails feedId={feed.id} />
    <label>Full article preference on this device<select value={mode} onChange={event => { const next = event.target.value as FullTextMode; setMode(next); setFullTextMode(feed.id, next) }}><option value="auto">Auto</option><option value="always">Always load full text</option><option value="never">Never load automatically</option></select></label>
    <details><summary>Repair feed URL</summary><p>Check a replacement RSS or Atom endpoint, then replace the URL while keeping this subscription and its articles.</p>
      <label>Replacement URL<input type="url" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setPreview(null); setMessage('') }} placeholder="https://example.com/feed.xml" /></label>
      <button disabled={busy || !url.trim()} onClick={() => void check()}>{busy ? 'Working...' : 'Check replacement'}</button>
      {preview && <div><strong>{preview.title || 'Feed preview'}</strong><p className="feed-url">{preview.url}</p>{preview.items.length ? <ol>{preview.items.map((item, index) => <li key={index}>{item.title}<small>{item.date}</small></li>)}</ol> : <p>The feed is valid but currently has no articles.</p>}<button disabled={busy} onClick={() => void repair({ url: preview.url })}>Replace feed URL</button></div>}
    </details>
    {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status">{message}</p>}
  </section>
}
