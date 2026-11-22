import { useEffect, useState } from 'react'
import type { StaleDays } from '../../shared/feed-checks'
import { api } from '../api'

export function StaleThresholds({ days, onSaved }: { days: StaleDays; onSaved: (days: StaleDays) => void }) {
  const [values, setValues] = useState(days.map(String))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [first, second, oldest] = days
  useEffect(() => { setValues([first, second, oldest].map(String)) }, [first, second, oldest])
  async function save() {
    setBusy(true)
    try {
      const result = await api.saveStaleDays(values.map(Number))
      onSaved(result.staleDays)
      setMessage('Last post filters saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save last post filters.') }
    finally { setBusy(false) }
  }
  return <details className="feed-check-controls feed-thresholds">
    <summary>Last post filters</summary>
    <p>Choose when each age band starts. A quiet feed can still be healthy.</p>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      {['First band', 'Second band', 'Oldest band'].map((label, index) =>
        <label key={label}>{label} in days<input type="number" required min={index ? Number(values[index - 1]) + 1 : 1} max={36500} step={1}
          value={values[index]} onChange={event => { setValues(values.map((value, i) => i === index ? event.target.value : value)); setMessage('') }} /></label>)}
      <button disabled={busy}>Save filters</button>
    </form>
    {message && <p role="status">{message}</p>}
  </details>
}
