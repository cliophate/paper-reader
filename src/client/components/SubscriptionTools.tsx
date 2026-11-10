import { useState, type FormEvent } from 'react'
import { subscriptionToolsApi as api } from '../subscriptionToolsApi'
import type { DiscoveryResult, ImportChoice, ImportPreview, ImportResult, ImportRow } from '../../shared/subscription-tools'
import './SubscriptionTools.css'

const MAX_BYTES = 1024 * 1024
export function SubscriptionTools({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const [url, setUrl] = useState('')
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [candidate, setCandidate] = useState('')
  const [xml, setXml] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [choices, setChoices] = useState<ImportChoice[]>([])
  const [result, setResult] = useState<{ result: ImportResult; rows: ImportRow[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [exported, setExported] = useState<{ xml: string; omitted: number } | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('')
    try { await action() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The subscription request failed.') }
    finally { setBusy(false) }
  }
  function showPreview(value: ImportPreview) {
    setPreview(value); setResult(null)
    setChoices(value.rows.map(row => ({
      key: row.key,
      action: row.problem ? 'skip' : row.suggestedId ? 'reuse' : row.matches.length || row.repeatedUrl || row.folderConflict || row.folders.length > 1 ? 'skip' : 'create',
      ...(row.suggestedId ? { existingId: row.suggestedId } : {}),
      folders: row.suggestedId ? null : row.folderConflict || row.folders.length > 1 ? [] : row.folders.filter(Boolean),
    })))
  }
  async function refresh() {
    try { await onChanged(); setRefreshFailed(false) }
    catch { setRefreshFailed(true) }
  }
  function submit(event: FormEvent, action: () => Promise<void>) { event.preventDefault(); void run(action) }
  function update(key: string, patch: Partial<ImportChoice>) { setChoices(previous => previous.map(choice => choice.key === key ? { ...choice, ...patch } : choice)) }
  async function apply() {
    if (!preview) return
    const current = preview
    // Clear before sending. A lost response must never invite replay of writes.
    setPreview(null)
    try {
      const applied = await api.apply(current.token, choices)
      setResult({ result: applied, rows: current.rows })
    } catch (reason) {
      throw new Error(`${reason instanceof Error ? reason.message : 'The import response was lost.'} Some items may have changed. Refresh and make a new preview before retrying.`)
    } finally { await refresh() }
  }
  function download() {
    if (!exported) return
    const blob = new Blob([exported.xml], { type: 'text/x-opml;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a'); anchor.href = href; anchor.download = 'paper-subscriptions.opml'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }

  return <section className="subscription-tools" aria-labelledby="subscription-tools-title">
    <h3 id="subscription-tools-title">Discover and transfer feeds</h3>
    <p>Find feeds on a website, or transfer subscriptions using OPML. Existing subscriptions keep their IDs, titles and URLs when reused.</p>
    <fieldset disabled={busy} className="subscription-tools-controls">
      <form aria-label="Discover feeds" onSubmit={event => submit(event, async () => {
        setDiscovery(null); setCandidate(''); setPreview(null)
        const found = await api.discover(url); setDiscovery(found)
        if (found.candidates.length === 1) setCandidate(found.candidates[0].url)
      })}>
        <label>Website or feed URL<input type="url" value={url} required maxLength={4096} placeholder="https://example.com/" onChange={event => { setUrl(event.target.value); setDiscovery(null); setCandidate('') }} /></label>
        <button type="submit">Find feeds</button>
      </form>
      {discovery && <div className="discovery-results">
        {discovery.candidates.length ? <>
          <fieldset><legend>Choose a feed</legend>{discovery.candidates.map(feed => <label className="discovery-choice" key={feed.url}>
            <input type="radio" name="discovered-feed" value={feed.url} checked={candidate === feed.url} onChange={() => setCandidate(feed.url)} />
            <span>{feed.title} <small>{feed.format.toUpperCase()} · {feed.url}</small></span>
          </label>)}</fieldset>
          <button type="button" disabled={!candidate} onClick={() => void run(async () => { const feed = discovery.candidates.find(feed => feed.url === candidate)!; showPreview(await api.previewFeed(feed.url, feed.title)) })}>Preview selected feed</button>
        </> : <p role="status">No RSS or Atom links were advertised on this page. Try the publisher's feed URL.</p>}
      </div>}
      <form aria-label="Import OPML" onSubmit={event => submit(event, async () => {
        setPreview(null)
        if (new TextEncoder().encode(xml).length > MAX_BYTES) throw new Error('OPML exceeds the 1 MiB limit.')
        showPreview(await api.preview(xml))
      })}>
        <label>OPML file, up to 1 MiB<input type="file" accept=".opml,.xml,text/xml,application/xml,text/x-opml" onChange={event => {
          const file = event.target.files?.[0]
          setPreview(null); setXml('')
          if (file) void run(async () => {
            if (file.size > MAX_BYTES) throw new Error('OPML exceeds the 1 MiB limit.')
            setXml(await file.text())
          })
        }} /></label>
        <details><summary>Or paste OPML</summary><label>OPML XML<textarea value={xml} onChange={event => { setXml(event.target.value); setPreview(null) }} rows={5} spellCheck={false} /></label></details>
        <button type="submit" disabled={!xml.trim()}>Preview import</button>
      </form>
      <div className="opml-export">
        <button type="button" onClick={() => void run(async () => { setExported(null); setExported(await api.export()) })}>Prepare OPML export</button>
        {exported && <><p role="status">Export ready. {exported.omitted > 0 ? `${exported.omitted} outlines were omitted because their URLs were invalid or contained credentials or token parameters.` : 'No subscription URLs were omitted.'} The file contains subscription titles, URLs and folder memberships.</p><button type="button" onClick={download}>Download OPML</button></>}
      </div>
    </fieldset>
    {preview && <form className="opml-preview" aria-label="Confirm subscription import" onSubmit={event => submit(event, apply)}>
      <h4>Review {preview.rows.length} subscription{preview.rows.length === 1 ? '' : 's'}</h4>
      <p>Duplicate policy: reuse a named subscription or skip it. Reuse keeps its title and URL. Distinct subscriptions are never merged by URL. FreshRSS cannot create a second subscription with an already subscribed URL.</p>
      {preview.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <fieldset disabled={busy}>
        {preview.rows.map(row => {
          const choice = choices.find(choice => choice.key === row.key)!
          const folderOptions = [...new Set([...preview.folders, ...row.folders.filter(Boolean)])]
          return <fieldset className="opml-row" key={row.key}><legend>{row.title}</legend>
            <p className="subscription-url">{row.url}</p>
            <p>Source groups: {row.sourcePaths.map(path => path.length ? JSON.stringify(path) : 'Uncategorized').join(', ')}</p>
            {row.problem && <p role="alert">{row.problem}</p>}
            {row.identityConflict && <p>Identity conflict: the exported ID now has a different URL. Choose an existing subscription explicitly to keep its current URL, or skip.</p>}
            {row.folderConflict && <p>Folder collision: different source paths or existing folder names map to the same flat name. Choose the destination explicitly.</p>}
            {row.repeatedUrl && <p>Other source subscriptions use this URL. Choose each action explicitly.</p>}
            <label>Action for {row.title}<select value={choice.action === 'reuse' ? `reuse:${choice.existingId}` : choice.action} onChange={event => {
              const selected = event.target.value
              update(row.key, selected.startsWith('reuse:') ? { action: 'reuse', existingId: selected.slice(6), folders: null } : { action: selected as 'skip' | 'create', existingId: undefined, folders: [] })
            }}><option value="skip">Skip</option>{!row.problem && <>
              <option value="create">Create a subscription</option>
              {row.matches.map(match => <option key={match.id} value={`reuse:${match.id}`}>Reuse {match.title} · {match.url} · {match.folders.join(', ') || 'Uncategorized'}</option>)}
            </>}</select></label>
            {choice.action !== 'skip' && <>
              {preview.multipleMemberships ? <label>Destination folders, one per line<textarea value={choice.folders?.join('\n') ?? ''} onChange={event => update(row.key, { folders: event.target.value.split('\n').filter(Boolean) })} rows={2} /></label> : <label>Destination for {row.title}<select value={choice.folders === null ? '__keep' : choice.folders[0] || ''} onChange={event => update(row.key, { folders: event.target.value === '__keep' ? null : event.target.value ? [event.target.value] : [] })}>
                {choice.action === 'reuse' && <option value="__keep">Keep existing folders</option>}
                <option value="">Uncategorized</option>{folderOptions.map(folder => <option key={folder} value={folder}>{folder}</option>)}
              </select></label>}
              <label>Use a different flat folder name<input type="text" maxLength={120} value={choice.folders?.[0] && !folderOptions.includes(choice.folders[0]) ? choice.folders[0] : ''} onChange={event => update(row.key, { folders: event.target.value ? [event.target.value] : [] })} placeholder="New folder name" /></label>
            </>}
          </fieldset>
        })}
        <button type="submit" disabled={!choices.some(choice => choice.action !== 'skip')}>Apply reviewed import</button>
        <button type="button" onClick={() => setPreview(null)}>Cancel preview</button>
      </fieldset>
    </form>}
    {result && <div className="opml-results" role="status"><h4>Import results</h4><ul>{result.result.results.map(item => <li key={item.key}><strong>{result.rows.find(row => row.key === item.key)?.title}</strong>: {item.status}. {item.message}</li>)}</ul><p>Make a new preview before retrying any failed items.</p></div>}
    {busy && <p role="status">Working on subscriptions...</p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    {refreshFailed && <p role="alert">Subscription requests finished, but navigation could not refresh. Their results still apply. <button disabled={busy} onClick={() => void run(refresh)}>Refresh navigation</button></p>}
  </section>
}
