export interface GesturePoint {
  x: number
  y: number
}

export type SwipeDirection = 'left' | 'right' | 'up' | 'down'

export type ArticleEdgeDirection = 'previous' | 'next'

export interface ArticleEdgeState {
  direction: ArticleEdgeDirection
  distance: number
  progress: number
  ready: boolean
}

export function swipeDirection(
  start: GesturePoint,
  end: GesturePoint,
  minimumDistance = 64,
  dominanceRatio = 1.3,
): SwipeDirection | null {
  const x = end.x - start.x
  const y = end.y - start.y
  const horizontal = Math.abs(x)
  const vertical = Math.abs(y)

  if (horizontal >= minimumDistance && horizontal >= vertical * dominanceRatio) return x < 0 ? 'left' : 'right'
  if (vertical >= minimumDistance && vertical >= horizontal * dominanceRatio) return y < 0 ? 'up' : 'down'
  return null
}

export function articleEdgeState(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  zoneSize: number,
  releaseDistance: number,
): ArticleEdgeState | null {
  if (![scrollTop, scrollHeight, clientHeight, zoneSize, releaseDistance].every(Number.isFinite)) return null
  if (zoneSize <= 0 || releaseDistance <= 0) return null

  const maximum = Math.max(0, scrollHeight - clientHeight)
  const restingTop = Math.min(zoneSize, maximum / 2)
  const restingBottom = Math.max(restingTop, maximum - zoneSize)
  const previousDistance = Math.max(0, restingTop - scrollTop)
  const nextDistance = Math.max(0, scrollTop - restingBottom)
  if (!previousDistance && !nextDistance) return null

  const direction: ArticleEdgeDirection = nextDistance > previousDistance ? 'next' : 'previous'
  const distance = direction === 'next' ? nextDistance : previousDistance
  return {
    direction,
    distance,
    progress: Math.min(1, distance / releaseDistance),
    ready: distance >= releaseDistance,
  }
}
