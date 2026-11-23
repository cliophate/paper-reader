import { useEffect, useRef, type RefObject } from 'react'
export function useDialogFocus(ref: RefObject<HTMLElement | null>) {
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = opener.current
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('summary,button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el => {
      if (el.closest('[hidden],[inert]')) return false
      for (let details = el.closest('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])') ?? null) {
        if (!details.querySelector(':scope > summary')?.contains(el)) return false
      }
      return true
    })
    if (!dialog.contains(document.activeElement)) (focusable()[0] || dialog).focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const elements = focusable(), first = elements[0], last = elements.at(-1)
      if (!first) { event.preventDefault(); dialog.focus(); return }
      if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus() }
  }, [ref])
}

export function useMenuFocus(ref: RefObject<HTMLElement | null>) {
  useDialogFocus(ref)
  useEffect(() => {
    const menu = ref.current
    if (!menu) return
    const move = (event: KeyboardEvent) => {
      const items = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)')]
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
      if (next >= 0) { event.preventDefault(); event.stopPropagation(); items[next]?.focus() }
    }
    menu.addEventListener('keydown', move)
    return () => menu.removeEventListener('keydown', move)
  }, [ref])
}
