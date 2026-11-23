import { useEffect, useRef, useState } from 'react'
import { offlineLimit, offlineLimitKey, saveOffline, storageUsed } from '../offline'
import type { Entry, NavigationPayload } from '../types'

export function useOfflineDownload(navigation: NavigationPayload | null) {
  const controller = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failures, setFailures] = useState<string[]>([])
  const [usage, setUsage] = useState<number>()
  const measure = () => { void storageUsed().then(setUsage).catch(() => setUsage(undefined)) }
  useEffect(() => { measure(); return () => controller.current?.abort() }, [])

  async function start(items: (signal: AbortSignal) => Iterable<Entry> | AsyncIterable<Entry>, complete?: (message: string) => void) {
    if (controller.current) return
    const job = new AbortController()
    controller.current = job
    const seen = new Set<string>()
    let saved = 0
    setBusy(true); setFailures([])
    setMessage('Starting download…')
    try {
      for await (const entry of items(job.signal)) {
        job.signal.throwIfAborted()
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        setMessage(`${saved} saved. Downloading ${entry.title}`)
        const folders = navigation?.folders.filter(folder => folder.feeds.some(feed => feed.id === entry.feedId)).map(({ id, title, linkNumber }) => ({ id, title, linkNumber }))
        try {
          const feed = navigation?.uncategorized.find(feed => feed.id === entry.feedId) || navigation?.folders.flatMap(folder => folder.feeds).find(feed => feed.id === entry.feedId)
          const result = await saveOffline(entry, folders || entry.offline?.folders, job.signal, feed?.linkNumber ?? entry.offline?.feedNumber)
          saved++
          const details = [result.feedOnly && 'feed text only', result.missing && `${result.missing} missing image${result.missing === 1 ? '' : 's'}`, result.skippedForStorage && `${result.skippedForStorage} skipped for storage`, result.unverified && `${result.unverified} unverified image${result.unverified === 1 ? '' : 's'}`].filter(Boolean)
          if (details.length) setFailures(old => [...old, entry.title + ': ' + details.join(', ')])
        } catch (error) {
          job.signal.throwIfAborted()
          if ((error as Error).name === 'QuotaExceededError') throw new Error('Storage limit reached. Open Offline articles to see the copies saved.')
          setFailures(old => [...old, entry.title + ': ' + (error as Error).message])
        }
      }
      setMessage(`${saved} of ${seen.size} articles saved.`)
      complete?.(saved === 1 && seen.size === 1 ? 'Saved for offline reading on this device' : `${saved} articles saved.`)
    } catch (error) {
      complete?.(job.signal.aborted ? 'Download canceled.' : (error as Error).message)
      setMessage(job.signal.aborted ? `Download canceled. ${saved} finished.` : `${saved} finished. ${(error as Error).message}`)
    } finally {
      controller.current = null
      setBusy(false); measure()
    }
  }
  return { busy, start, cancel: () => controller.current?.abort(), message, failures, usage, measure }
}

export function OfflineDownloads({ download, children }: { download: ReturnType<typeof useOfflineDownload>; children: React.ReactNode }) {
  const [limit, setLimit] = useState(offlineLimit)
  return <details className="offline-downloads">
    <summary>Offline downloads</summary>
    <div className="offline-actions">{children}</div>
    <p>{download.usage === undefined ? 'Storage estimate unavailable.' : `Paper uses about ${(download.usage / 1048576).toFixed(1)} MiB on this device.`}</p>
    <label>Stop downloads at <input type="number" min="0" step="1" value={limit || ''} placeholder="No limit" aria-label="Storage limit in MiB" onChange={event => {
      const value = Math.max(0, Math.floor(Number(event.target.value) || 0))
      setLimit(value); localStorage.setItem(offlineLimitKey, String(value))
    }} /> MiB</label>
    {download.failures.length > 0 && <ul>{download.failures.map((failure, i) => <li key={i}>{failure}</li>)}</ul>}
  </details>
}
