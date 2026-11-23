import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { choicesFor, type ReadingKey } from '../../server/reading-preference-values'
import { currentReadingValue, ReadingPreferences } from '../readingPreferences'
import type { Feed } from '../types'

const PreferencesContext = createContext<ReadingPreferences | null>(null)

export function ReadingPreferencesProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new ReadingPreferences(localStorage))
  useEffect(store.connect, [store])
  return <PreferencesContext.Provider value={store}>{children}</PreferencesContext.Provider>
}

export function useReadingPreferences() {
  const store = useContext(PreferencesContext)!
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return {
    store, state,
    value: (key: ReadingKey) => currentReadingValue(state, key),
    set: (key: ReadingKey, value: string) => store.set(key, value, state),
  }
}

export function PreferenceNotice() {
  const { state, store } = useReadingPreferences()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const offer = mounted && state.offer && !state.pending.some(write => write.action === 'import')
  const message = mounted && state.notices[0]?.text
  return <section className={message || offer ? 'preference-notice' : 'visually-hidden'} aria-label={message || offer ? 'Reading preferences' : undefined}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}>
    <div role="status" aria-atomic="true">
      {message && <p>{message}</p>}
      {offer && <p>Use this browser's reading preferences on your other devices?</p>}
    </div>
    {offer && <>
      <button onClick={() => store.migrate(true)}>Share preferences</button>
      <button onClick={() => store.migrate(false)}>Keep on this device</button>
    </>}
    {message && <button onClick={() => store.dismissNotice()}>Dismiss</button>}
  </section>
}

const labels: Record<string, string> = {
  literata: 'Literata', source: 'Source Sans 3', automatic: 'After opening for one second', manual: 'Only when I mark them read',
  auto: 'Auto', always: 'Always load full text', never: 'Never load automatically', on: 'On', off: 'Off',
}

function PreferenceControl({ name, label }: { name: ReadingKey; label: string }) {
  const { state, store, value, set } = useReadingPreferences()
  const overridden = state.overrides[name] !== undefined
  const pending = state.pending.some(write => write.values[name] !== undefined || write.action === 'reset')
  const source = overridden ? 'Device override' : state.legacy ? 'This browser' : pending ? 'Waiting to sync' : state.shared.values[name] ? 'Shared' : 'Paper default'
  return <div className="preference-control" role="group" aria-label={label}>
    <label className="reading-preference">{label}
      <select value={value(name)} onChange={event => set(name, event.target.value)}>
        {choicesFor(name).map(choice => <option key={choice} value={choice}>{labels[choice] ?? choice[0].toUpperCase() + choice.slice(1)}</option>)}
      </select>
    </label>
    <small>{source}</small>
    {!state.legacy && <button onClick={() => store.override(name, !overridden)}>{overridden ? 'Use shared value' : 'Override on this device'}</button>}
  </div>
}

export function FeedReadingPreferences({ feedId }: { feedId: string }) {
  return <>
    <PreferenceControl name={`fullText:${feedId}`} label="Full text for this feed" />
    <PreferenceControl name={`learned:${feedId}`} label="Load short articles in Auto mode" />
  </>
}

export function ReadingSettings({ feeds }: { feeds: Feed[] }) {
  const { store, state } = useReadingPreferences()
  const [selectedFeed, setSelectedFeed] = useState('')
  const feedNames = new Map(feeds.map(feed => [feed.id, feed.title]))
  // Cached preferences can still be managed while the feed list is offline.
  for (const values of [state.shared.values, state.overrides, state.legacy, ...state.pending.map(write => write.values)]) {
    for (const key of Object.keys(values ?? {})) {
      const id = key.slice(key.indexOf(':') + 1)
      if (key.includes(':') && !feedNames.has(id)) feedNames.set(id, id)
    }
  }
  return <section className="reading-settings">
    <h3>Reading</h3>
    <p>Changes apply to your other devices unless you set a device override. Theme and text size stay on this device under Appearance.</p>
    <PreferenceNotice />
    <PreferenceControl name="markRead" label="Mark articles read" />
    <PreferenceControl name="font" label="Typeface" />
    <PreferenceControl name="spacing" label="Line spacing" />
    <PreferenceControl name="width" label="Reader width" />
    {feedNames.size > 0 && <label className="reading-preference">Full-text preferences
      <select value={selectedFeed} onChange={event => setSelectedFeed(event.target.value)}>
        <option value="">Choose a feed</option>
        {[...feedNames].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select>
    </label>}
    {selectedFeed && <FeedReadingPreferences feedId={selectedFeed} />}
    {state.pending.length > 0 && <p role="status">Shared changes are waiting to sync.</p>}
    <button disabled={!!state.legacy} onClick={() => {
      if (window.confirm('Reset shared reading preferences to Paper defaults on every device? Device overrides will stay in place.')) store.reset()
    }}>Reset shared preferences</button>
  </section>
}
