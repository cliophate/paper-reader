import { useLayoutEffect, useRef, useState } from 'react'
import type { Enclosure } from '../../shared/enclosures'
import { articleImageSource } from '../articleImages'
import { playback } from '../api'
import type { Entry } from '../types'

export function EnclosurePlayers({ entry, files, posters }: { entry: Entry; files: Enclosure[]; posters: ReadonlyMap<string, string> }) {
  return files.map((file, i) => {
    const kind = file.type.startsWith('audio') ? 'audio' : 'video'
    const label = `${kind}${files.length > 1 ? ` ${i + 1}` : ''}`
    const poster = posters.get(file.url)
    return <Player key={JSON.stringify([entry.id, file.url])} file={file} kind={kind} poster={poster && articleImageSource(entry, poster)} label={label} title={entry.title} id={entry.id} />
  })
}

function Player({ file, kind, poster, label, title, id }: {
  file: Enclosure; kind: 'audio' | 'video'; poster?: string; label: string; title: string; id: string
}) {
  const media = useRef<HTMLMediaElement | null>(null)
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState(false)
  const [brokenPoster, setBrokenPoster] = useState<string>()
  const preview = poster !== brokenPoster ? poster : undefined
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
    <div className={preview ? 'enclosure-preview' : undefined}>
      {preview && <img src={preview} alt="" onError={() => setBrokenPoster(preview)} />}
      {(!started || failed) && <button type="button" onClick={play} aria-label={`Play ${label} for ${title}`}><span>Play {label}</span></button>}
      {kind === 'audio' ? <audio {...props} /> : <video {...props} poster={preview} playsInline />}
    </div>
    {failed && <p role="status">This {kind} could not play. <a href={file.url} target="_blank" rel="noopener noreferrer">Open media file</a></p>}
  </div>
}
