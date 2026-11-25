import { isMediaFileUrl } from './media-file-url.js'
import type { Enclosure } from '../shared/enclosures.js'
import { MAX_ENCLOSURES, MAX_ENCLOSURE_URL_BYTES } from './enclosure-limits.js'

interface Candidate {
  url: string
  type?: unknown
  medium?: unknown
  player?: boolean
  size?: unknown
  duration?: unknown
}

const mediaTypes: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
}

function nonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER) return parsed
}

export function durationSeconds(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d+(?::[0-5]\d){1,2}$/.test(value)) {
    return nonnegativeNumber(value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0))
  }
  return nonnegativeNumber(value)
}

export function mediaEnclosures<T>(files: T[], toCandidate: (file: T) => Candidate): Enclosure[] {
  const media = new Map<string, Enclosure>()
  let urlBytes = 0
  for (const file of files) {
    const candidate = toCandidate(file)
    const prior = media.get(candidate.url)
    if (!prior && media.size >= MAX_ENCLOSURES) continue
    if (!isMediaFileUrl(candidate.url)) continue
    let type = typeof candidate.type === 'string' ? candidate.type.trim().toLowerCase() : ''
    if (!type || type === 'application/octet-stream' || type === 'audio' || type === 'video') {
      const medium = String(candidate.medium || type)
      const extension = /\.([a-z0-9]+)$/i.exec(new URL(candidate.url).pathname)?.[1].toLowerCase()
      const inferred = extension && Object.hasOwn(mediaTypes, extension) && mediaTypes[extension]
      type = inferred && (!medium || medium === 'application/octet-stream' || inferred.startsWith(medium + '/')) ? inferred : medium
    }
    if (candidate.player && (type === 'video' || type === 'audio')) continue
    if (!/^(audio|video)(?:\/[\w.+-]+(?:\s*;[^\r\n]*)?)?$/.test(type)) continue
    const size = nonnegativeNumber(candidate.size)
    const duration = durationSeconds(candidate.duration)
    if (!prior) {
      const bytes = Buffer.byteLength(candidate.url)
      if (urlBytes + bytes > MAX_ENCLOSURE_URL_BYTES) continue
      urlBytes += bytes
    }
    media.set(candidate.url, { url: candidate.url, type: prior?.type.includes('/') ? prior.type : type,
      size: Number.isSafeInteger(size) ? size : prior?.size, duration: duration ?? prior?.duration })
  }
  return [...media.values()]
}
