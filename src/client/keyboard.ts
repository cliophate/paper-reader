export function movementDirection(key: string): 1 | -1 | null {
  if (key === 'j' || key === 'ArrowDown') return 1
  if (key === 'k' || key === 'ArrowUp') return -1
  return null
}
