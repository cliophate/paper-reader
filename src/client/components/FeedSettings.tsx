import { useState, type ReactNode } from 'react'
import { SubscriptionTools } from './SubscriptionTools'

export function FeedSettings({ children, onChanged }: { children: ReactNode; onChanged: () => Promise<unknown> }) {
  const [transfer, setTransfer] = useState(false)
  return <div className="feed-settings">
    <div className="feed-settings-switch" role="group" aria-label="Feed settings view">
      <button type="button" aria-pressed={!transfer} onClick={() => setTransfer(false)}>Manage feeds</button>
      <button type="button" aria-pressed={transfer} onClick={() => setTransfer(true)}>Discover and transfer</button>
    </div>
    <div className={transfer ? 'feed-settings-transfer' : 'feed-settings-manage'}>
      {transfer ? <SubscriptionTools onChanged={onChanged} /> : children}
    </div>
  </div>
}
