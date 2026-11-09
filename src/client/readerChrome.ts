export interface ReaderChromeScrollState {
  top: number
  direction: -1 | 0 | 1
  travel: number
  hidden: boolean
}

const TOP_REVEAL_POINT = 24
const HIDE_START_POINT = 72
const HIDE_TRAVEL = 40
const REVEAL_TRAVEL = 32
const MINIMUM_READING_TRAVEL = 320
const MINIMUM_READING_VIEWPORT_RATIO = 0.5

export function readerChromeCanAutoHide(scrollHeight: number, clientHeight: number, edgeZoneSize = 0): boolean {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight) || clientHeight <= 0) return false
  const contentTravel = Math.max(0, scrollHeight - clientHeight - Math.max(0, edgeZoneSize) * 2)
  return contentTravel >= Math.max(MINIMUM_READING_TRAVEL, clientHeight * MINIMUM_READING_VIEWPORT_RATIO)
}

export function initialReaderChromeScrollState(top = 0): ReaderChromeScrollState {
  return { top, direction: 0, travel: 0, hidden: false }
}

export function updateReaderChromeScroll(state: ReaderChromeScrollState, scrollTop: number): ReaderChromeScrollState {
  const top = Math.max(0, scrollTop)
  if (top <= TOP_REVEAL_POINT) return initialReaderChromeScrollState(top)

  const delta = top - state.top
  if (Math.abs(delta) < 0.5) return { ...state, top }

  const direction: -1 | 1 = delta > 0 ? 1 : -1
  const travel = direction === state.direction ? state.travel + Math.abs(delta) : Math.abs(delta)
  let hidden = state.hidden

  if (direction === 1 && top > HIDE_START_POINT && travel >= HIDE_TRAVEL) hidden = true
  if (direction === -1 && travel >= REVEAL_TRAVEL) hidden = false

  return {
    top,
    direction,
    travel: hidden === state.hidden ? travel : 0,
    hidden,
  }
}
