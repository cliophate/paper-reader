import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PulseCollection, PulseSummaryLine } from '../../shared/pulse'
import { Icon } from './Icon'

export function PulseCatchUp({ collection, latest, background, options, onOpenEntry }: {
  collection: PulseCollection; latest: PulseSummaryLine[]; background: PulseSummaryLine[]
  options: (label: string) => ReactNode; onOpenEntry: (id: string) => void
}) {
  const articles = new Map(collection.sources.map(source => [source.id, source]))
  const citationIds = [...new Set([...latest, ...background].flatMap(line => line.entryIds))]
  const renderLine = (line: PulseSummaryLine) => <>{line.text}{' '}<span className="pulse-citations">{line.entryIds.map(id => {
    const source = articles.get(id)
    if (!source) return null
    const href = collection.linkNumber && source.linkNumber ? `/collection/${collection.linkNumber}/a/${source.linkNumber}?unread=0`
      : `/?${new URLSearchParams({ view: 'reader', collection: collection.id, entry: id, unread: '0' })}`
    return <a key={id} href={href} title={source.title} aria-label={`Source: ${source.title}`} onClick={event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault(); onOpenEntry(id)
    }}>[{citationIds.indexOf(id) + 1}]</a>
  })}</span></>
  return <div className="pulse-summaries">
    {latest.length > 0 && <SummarySection title="Latest" options={options('Latest options')}><ul className="pulse-latest">{latest.map(line => <li className="summary-square" key={line.text}>{renderLine(line)}</li>)}</ul></SummarySection>}
    {background.length > 0 && <SummarySection title="Background" options={options('Background options')}><p className="pulse-background">{background.map((line, index) => <Fragment key={line.text}>{index > 0 && ' '}{renderLine(line)}</Fragment>)}</p></SummarySection>}
  </div>
}

function SummarySection({ title, options, children }: { title: string; options: ReactNode; children: ReactNode }) {
  const id = useId()
  const [expanded, setExpanded] = useState(true)
  const [showInfo, setShowInfo] = useState(false)
  return <section aria-label={title}>
    <div className="pulse-summary-header">
      <h3><button aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{title}<Icon name="chevron" /></button></h3>
      <button className="pulse-summary-icon" aria-label={`About ${title}`} aria-expanded={showInfo} aria-controls={`${id}-info`} onClick={() => setShowInfo(!showInfo)}><Icon name="info" /></button>
      {options}
    </div>
    <p id={`${id}-info`} className="pulse-summary-info" hidden={!showInfo}>AI wrote this summary using the linked articles.</p>
    <div id={id} hidden={!expanded}>{children}</div>
  </section>
}

export function PulseCollectionOptions({ label, name, actions }: { label: string; name: string; actions: () => ReactNode }) {
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDetailsElement>(null)
  const menuItems = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const anchor = menu.current
    const items = menuItems.current
    const scroll = anchor?.closest('.topics-scroll')
    if (!open || !anchor || !items || !scroll) return
    const trigger = anchor.getBoundingClientRect()
    const viewport = scroll.getBoundingClientRect()
    const above = trigger.top - viewport.top
    const below = viewport.bottom - trigger.bottom
    const opensUp = items.offsetHeight + 8 > below && above > below
    const left = Math.max(viewport.left + 8, Math.min(trigger.left, viewport.left + scroll.clientWidth - items.offsetWidth - 8))
    items.dataset.opensUp = String(opensUp)
    items.style.left = `${left - trigger.left}px`
    items.style.maxHeight = `${Math.max(0, (opensUp ? above : below) - 8)}px`
  }, [open])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  const closeMenu = () => {
    if (!menu.current) return
    menu.current.open = false
    menu.current.querySelector('summary')?.focus()
  }
  return <details className="pulse-collection-options" name={name} ref={menu} onToggle={event => setOpen(event.currentTarget.open)} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
  }} onKeyDown={event => { if (event.key === 'Escape' && event.currentTarget.open) { event.stopPropagation(); closeMenu() } }}>
    <summary className="pulse-summary-icon" aria-label={label}>⋯</summary>
    {open && <div className="pulse-options-menu" ref={menuItems} onClick={event => {
      if (event.target instanceof HTMLButtonElement && event.target.type === 'button') closeMenu()
    }} onSubmit={closeMenu}>{actions()}</div>}
  </details>
}
