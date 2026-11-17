import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { subscribeBookmarklet } from '../subscribe'

export function SubscribeBookmarklet() {
  const link = useRef<HTMLAnchorElement>(null)
  const [publicUrl, setPublicUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void api.status().then(status => { if (active) setPublicUrl(status.publicUrl || location.origin) }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => {
    // React rejects javascript: href props. Set this fixed, locally generated
    // bookmarklet on the DOM link so browsers can save it by dragging.
    if (publicUrl) link.current?.setAttribute('href', subscribeBookmarklet(publicUrl, location.origin))
  }, [publicUrl])
  return <div className="subscribe-bookmarklet">
    <h4>Subscribe from your browser</h4>
    {publicUrl ? <><a ref={link} draggable onClick={event => event.preventDefault()}>Subscribe in Paper</a><p>Drag this link to your bookmarks bar, then use it on a page you want to follow.</p></> : <p>Connect to Paper to load the subscription bookmarklet.</p>}
    <p>On Android, install Paper from your browser, then share a page or feed link to Paper. Review the feed and confirm before subscribing.</p>
  </div>
}
