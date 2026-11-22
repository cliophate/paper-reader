import { useLayoutEffect, useRef, useState } from 'react'
import type { Enclosure } from '../../shared/enclosures'
import { MAX_ENCLOSURES } from '../../server/enclosure-limits'
import { playback } from '../api'
import type { Entry } from '../types'

export function EnclosurePlayers({ entry }: { entry: Entry }) {
  return entry.enclosures?.slice(0, MAX_ENCLOSURES).map((file, i, files) => {
    const kind = file.type.startsWith('audio') ? 'audio' : 'video'
    const label = `${kind}${files.length > 1 ? ` ${i + 1}` : ''}`
    return <Player key={JSON.stringify([entry.id, file.url])} file={file} kind={kind} label={label} title={entry.title} id={entry.id} />
  })
}

function Player({ file, kind, label, title, id }: {
  file: Enclosure; kind: 'audio' | 'video'; label: string; title: string; id: string
}) {
  const media = useRef<HTMLMediaElement | null>(null)
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState(false)
  const saved = useRef(file.position || 0)
  const lastWrite = useRef(0)
  const ready = useRef(false)

  useLayoutEffect(() => {
    const player = media.current!
    const flush = () => {
      if (!ready.current || player.seeking) return
      const seconds = player.ended ? 0 : player.currentTime
      if (Number.isFinite(seconds) && saved.current !== seconds) {
        saved.current = seconds
        lastWrite.current = Date.now()
        void playback.save({ id, url: file.url, position: seconds, updatedAt: lastWrite.current }).catch(() => {})
      }
    }
    const update = () => { if (Date.now() - lastWrite.current >= 10_000) flush() }
    const hide = () => { if (document.hidden) flush() }
    player.addEventListener('timeupdate', update)
    for (const event of ['pause', 'ended', 'seeked']) player.addEventListener(event, flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hide)
    return () => {
      flush()
      player.removeEventListener('timeupdate', update)
      for (const event of ['pause', 'ended', 'seeked']) player.removeEventListener(event, flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [id, file.url])

  function play() {
    const player = media.current!
    ready.current = false
    setFailed(false)
    setStarted(true)
    // Assign the URL inside the user gesture. Some browsers treat preload as a hint.
    player.hidden = false
    player.src = file.url
    if (!started) {
      const pending = playback.pending(id, file.url)
      saved.current = pending && pending.updatedAt > (file.updatedAt ?? 0) ? pending.position : file.position || 0
      // Set the default playback start position before play or interaction with native controls.
      if (saved.current > 0) player.currentTime = saved.current
    }
    player.focus()
    void player.play().catch(error => { if (error.name !== 'AbortError') setFailed(true) })
  }

  const props = {
    ref: (node: HTMLMediaElement | null) => { media.current = node },
    controls: true, preload: 'none', hidden: !started, tabIndex: 0, 'aria-label': `${label} for ${title}`,
    onError: () => setFailed(true),
    onLoadedMetadata: () => { ready.current = true },
  }
  return <div className="enclosure-player">
    {(!started || failed) && <button type="button" onClick={play} aria-label={`Play ${label} for ${title}`}>Play {label}</button>}
    {kind === 'audio' ? <audio {...props} /> : <video {...props} playsInline />}
    {failed && <p role="status">This {kind} could not play. <a href={file.url} target="_blank" rel="noopener noreferrer">Open media file</a></p>}
  </div>
}
