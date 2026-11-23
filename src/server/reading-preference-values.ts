// Used by both the reader and the HTTP endpoint. The first choice is the default.
export const readingChoices = {
  font: ['literata', 'source'],
  spacing: ['comfortable', 'compact', 'spacious'],
  width: ['standard', 'narrow', 'wide'],
  markRead: ['automatic', 'manual'],
} as const
const modeChoices = ['auto', 'always', 'never'] as const
const learnedChoices = ['off', 'on'] as const
export type FullTextMode = typeof modeChoices[number]
export type ReadingKey = keyof typeof readingChoices | `fullText:${string}` | `learned:${string}`
export type ReadingValues = Partial<Record<ReadingKey, string>>

export function choicesFor(key: string): readonly string[] {
  if (Object.hasOwn(readingChoices, key)) return readingChoices[key as keyof typeof readingChoices]
  if (/^(?:fullText|learned):[^\x00-\x1f\x7f]{1,4096}$/u.test(key)) return key.startsWith('fullText:') ? modeChoices : learnedChoices
  return []
}

export interface ReadingSnapshot {
  storeId?: string
  revision: number
  generation: number
  values: Partial<Record<ReadingKey, { value: string; revision: number; token: string }>>
}

export interface ReadingWrite {
  storeId?: string
  knownRevision?: number
  device: string
  writer: string
  sequence: number
  generation: number
  base: Partial<Record<ReadingKey, string>>
  action: 'edit' | 'reset' | 'import'
  values: ReadingValues
}

export function validReadingWrite(input: unknown): input is ReadingWrite {
  if (!input || typeof input !== 'object') return false
  const { device, writer, sequence, action, values, generation, base, storeId, knownRevision } = input as ReadingWrite
  if (typeof device !== 'string' || !/^[a-f0-9]{32}$/.test(device) || !Number.isSafeInteger(sequence) || sequence <= 0) return false
  if (storeId !== undefined && (typeof storeId !== 'string' || !/^[a-f0-9]{32}$/.test(storeId))) return false
  if (knownRevision !== undefined && (!Number.isSafeInteger(knownRevision) || knownRevision < 0)) return false
  if (typeof writer !== 'string' || !/^[a-f0-9]{32}$/.test(writer)) return false
  if (!Number.isSafeInteger(generation) || generation < 0 || !base || typeof base !== 'object' || Array.isArray(base)) return false
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false
  const entries = Object.entries(values)
  if (action === 'edit') {
    if (Object.keys(base).length !== entries.length || !entries.every(([key]) => {
      const token = base[key as ReadingKey]
      return token === 'none' || (typeof token === 'string' && /^[a-f0-9]{32}$/.test(token))
    })) return false
  } else if (Object.keys(base).length) return false
  if (action === 'reset') return entries.length === 0
  return (action === 'edit' || action === 'import') && entries.length > 0
    && entries.every(([key, value]) => typeof value === 'string' && choicesFor(key).includes(value))
}

export type ReadingWriteResult = ReadingSnapshot & { appliedTokens?: ReadingWrite['base'] }
