import type { ArticleEdgeState } from './mobileGestures'

export type ArticleBoundaryState = Pick<ArticleEdgeState, 'direction' | 'progress' | 'ready'>

// Only the two edge indicators subscribe. Scrolling does not rerender the app,
// story rows, or the article's media.
export function createArticleBoundaryStore() {
  let state: ArticleBoundaryState | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: ArticleBoundaryState | null) {
      if (state === next || (state && next && state.direction === next.direction
        && state.ready === next.ready && Math.abs(state.progress - next.progress) < 0.015)) return
      state = next
      listeners.forEach(listener => listener())
    },
  }
}

export type ArticleBoundaryStore = ReturnType<typeof createArticleBoundaryStore>
