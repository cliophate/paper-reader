import { useEffect, useRef, type ReactNode } from 'react'
import { useDialogFocus } from '../dialogFocus'
import { Icon } from './Icon'

export function Modal({ title, onClose, children, className = '', busy = false }: {
  title: string; onClose: () => void; children: ReactNode; className?: string; busy?: boolean
}) {
  const dialog = useRef<HTMLElement>(null)
  useDialogFocus(dialog)
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (!busy && event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose, busy])
  return <div className={`modal-backdrop ${className ? `${className}-backdrop` : ''}`} onMouseDown={event => !busy && event.target === event.currentTarget && onClose()}>
    <section ref={dialog} tabIndex={-1} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy}>
      <header><h2>{title}</h2><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close"><Icon name="close" /></button></header>{children}
    </section>
  </div>
}
