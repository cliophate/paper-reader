export function movementDirection(key: string): 1 | -1 | null {
  if (key === 'j' || key === 'J' || key === 'ArrowDown') return 1
  if (key === 'k' || key === 'K' || key === 'ArrowUp') return -1
  return null
}
