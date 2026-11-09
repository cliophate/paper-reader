import { useEffect, useLayoutEffect, type RefObject } from 'react'
import { api } from './api'
import type { Entry } from './types'
interface Position { position: number; at: string }
function stored(): Record<string, Position> { try { return JSON.parse(localStorage.getItem('paper-reading-positions') || '{}') } catch { return {} } }
export function useReadingProgress(entry: Entry | null, ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    if (!entry || !enabled) return
    const scroll = ref.current?.querySelector<HTMLElement>('.article-scroll')
    if (!scroll) return
    const local = stored()[entry.id]
    const position = local && (!entry.lastReadAt || local.at > entry.lastReadAt) ? local.position : entry.readingPosition || 0
    const inset = window.matchMedia('(max-width: 1040px)').matches ? 96 : 0
    const restore = () => { scroll.scrollTop = inset + Math.max(0, scroll.scrollHeight - scroll.clientHeight - inset * 2) * position }
    restore()
    const frame = requestAnimationFrame(restore)
    return () => cancelAnimationFrame(frame)
  }, [entry?.id, enabled, ref])
  useEffect(() => {
    if (!entry || !enabled) return
    const scroll = ref.current?.querySelector<HTMLElement>('.article-scroll')
    if (!scroll) return
    const id = entry.id
    let timer: ReturnType<typeof setTimeout> | undefined
    let position = entry.readingPosition || 0
    let dirty = false
    const flush = () => {
      clearTimeout(timer)
      if (!dirty) return
      dirty = false
      const values = stored()
      values[id] = { position, at: new Date().toISOString() }
      const limited = Object.fromEntries(Object.entries(values).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 200))
      try { localStorage.setItem('paper-reading-positions', JSON.stringify(limited)) } catch { /* Server progress remains available. */ }
      if (navigator.onLine && api.saveProgress) void api.saveProgress(id, position).catch(() => undefined)
    }
    const inset = window.matchMedia('(max-width: 1040px)').matches ? 96 : 0
    const update = () => {
      const maximum = scroll.scrollHeight - scroll.clientHeight - inset * 2
      position = maximum > 0 ? Math.max(0, Math.min(1, (scroll.scrollTop - inset) / maximum)) : 1
      dirty = true; clearTimeout(timer); timer = setTimeout(flush, 800)
    }
    // A visit belongs in recent reading even before the first scroll.
    dirty = true; const local = stored()[id]; position = local && (!entry.lastReadAt || local.at > entry.lastReadAt) ? local.position : entry.readingPosition || 0
    timer = setTimeout(flush, 1000)
    scroll.addEventListener('scroll', update)
    window.addEventListener('pagehide', flush)
    const visibility = () => { if (document.hidden) flush() }
    document.addEventListener('visibilitychange', visibility)
    return () => { scroll.removeEventListener('scroll', update); window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', visibility); flush() }
  }, [entry?.id, enabled, ref])
}
