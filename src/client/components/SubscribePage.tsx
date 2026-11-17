import { useEffect, useState } from 'react'
import { parseSubscribeQuery } from '../subscribe'
import { SubscriptionTools } from './SubscriptionTools'

export function SubscribePage() {
  const [online, setOnline] = useState(navigator.onLine)
  const [query] = useState(() => parseSubscribeQuery(location.search))
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  return <main className="subscribe-page">
    <header><a href="/">Paper</a><h1>Subscribe to a feed</h1><p>Choose a feed and folder, then confirm to subscribe.</p></header>
    {!online && <p role="alert">You're offline. Connect to Paper to discover feeds and subscribe. Your link is still in the address bar.</p>}
    <SubscriptionTools subscribeOnly initialUrl={query.url} initialError={query.error} online={online} onChanged={async () => {}} />
  </main>
}
