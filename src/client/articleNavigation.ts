// Loading must finish before we change the reader or start an animation.
// A cancelled or timed-out request must never open its late result.
export function createArticleNavigation(timeoutMs = 10_000) {
  let active: AbortController | null = null
  return {
    cancel() { active?.abort() },
    async run(
      prepare: (signal: AbortSignal) => Promise<(() => void) | null>,
      onBusy: (busy: boolean) => void,
      onError: (error: unknown) => void,
    ): Promise<boolean> {
      if (active) return false
      const controller = new AbortController()
      active = controller
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
      let abort: () => void = () => {}
      const cancelled = new Promise<null>(resolve => {
        abort = () => resolve(null)
        controller.signal.addEventListener('abort', abort, { once: true })
      })
      onBusy(true)
      try {
        const commit = await Promise.race([prepare(controller.signal), cancelled])
        if (controller.signal.aborted || !commit) return false
        commit()
        return true
      } catch (error) {
        if (!controller.signal.aborted) onError(error)
        return false
      } finally {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        active = null
        onBusy(false)
        if (timedOut) onError(new Error('The next article took too long to load. Please try again.'))
      }
    },
  }
}
