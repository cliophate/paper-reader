import { useState } from 'react'
import type { PulseCollection, PulsePayload, StoryChoice } from '../../shared/pulse'
import { Modal } from './Modal'

function choiceLabel(choice: StoryChoice) {
  if (choice.kind === 'snooze') return `Snoozed until ${new Date(choice.until).toLocaleString()}`
  return choice.kind === 'follow' ? 'Following' : 'Muted'
}

export function PulseStorySettings({ payload, onClear, onBriefings, onClose }: {
  payload: PulsePayload; onClear: (id: string) => Promise<void>; onBriefings: (enabled: boolean) => Promise<void>; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingBriefings, setPendingBriefings] = useState<boolean | null>(null)
  async function save(action: () => Promise<void>) {
    setBusy(true)
    try { await action(); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save Pulse settings') }
    finally { setBusy(false); setPendingBriefings(null) }
  }
  return <Modal title="Pulse settings" className="pulse-settings" busy={busy} onClose={onClose}>
    <label><input type="checkbox" checked={pendingBriefings ?? Boolean(payload.useStoryChoicesInBriefings)} disabled={busy}
      onChange={event => {
        const enabled = event.target.checked
        setPendingBriefings(enabled)
        void save(() => onBriefings(enabled))
      }} /> Prioritize followed stories and skip muted stories in briefings</label>
    <h3>Story choices</h3>
    {payload.storyChoices?.length ? <ul>{payload.storyChoices.map(({ id, headline, choice }) => <li key={id}>
      <div>{headline}<small>{choiceLabel(choice)}</small></div>
      <button disabled={busy} aria-label={`Clear choice for ${headline}`} onClick={() => void save(() => onClear(id))}>Clear</button>
    </li>)}</ul> : <p>No saved story choices.</p>}
    {error && <p role="alert">{error}</p>}
  </Modal>
}

export function StoryChoiceDialog({ collection, onSave, onClose }: {
  collection: PulseCollection; onSave: (choice: StoryChoice | null) => Promise<void>; onClose: () => void
}) {
  const [kind, setKind] = useState<StoryChoice['kind'] | 'clear'>(collection.followed ? 'follow' : 'clear')
  const [preset, setPreset] = useState('tomorrow')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save() {
    const until = new Date()
    if (preset === 'custom') until.setTime(new Date(custom).getTime())
    else {
      until.setDate(until.getDate() + (preset === 'tomorrow' ? 1 : 7))
      until.setHours(8, 0, 0, 0)
    }
    if (kind === 'snooze' && !(until.getTime() > Date.now())) { setError('Choose a future snooze time'); return }
    setBusy(true)
    try {
      await onSave(kind === 'clear' ? null : kind === 'snooze' ? { kind, until: until.getTime() } : { kind })
      onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save story choice'); setBusy(false) }
  }
  return <Modal title="Story options" className="pulse-settings" onClose={onClose} busy={busy}>
    <p>{collection.headline}</p>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy}><legend>Show in Pulse</legend>
        {([['clear', 'Default'], ['follow', 'Follow'], ['mute', 'Mute'], ['snooze', 'Snooze']] as const).map(([value, label]) => <label key={value}>
          <input type="radio" name="story-choice" checked={kind === value} onChange={() => setKind(value)} />
          {label}
        </label>)}
      </fieldset>
      {kind === 'mute' && <p>Articles keep their read status. To clear unread articles first, use Mark read on the collection in the Pulse list.</p>}
      {kind === 'snooze' && <><label>Snooze until <select disabled={busy} value={preset} onChange={event => setPreset(event.target.value)}>
        <option value="tomorrow">Tomorrow at 8 am</option><option value="week">Next week at 8 am</option><option value="custom">Custom time</option>
      </select></label>{preset === 'custom' && <label>Date and time <input type="datetime-local" required disabled={busy} value={custom} onChange={event => setCustom(event.target.value)} /></label>}</>}
      {error && <p role="alert">{error}</p>}
      <div className="pulse-mark-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
    </form>
  </Modal>
}
