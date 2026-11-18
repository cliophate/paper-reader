export const FEED_ICON_TYPES = {
  png: 'image/png',
  ico: 'image/x-icon',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  webp: 'image/webp',
} as const

export type FeedIconExtension = keyof typeof FEED_ICON_TYPES
export const MAX_FEED_ICON_BYTES = 256 * 1024
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex')
const iconPath = /^\/feed-icons\/([a-f0-9]{64})\.(png|ico|gif|jpg|webp)$/

export function feedIconPath(pathname: string): { hash: string; extension: FeedIconExtension } | null {
  const match = iconPath.exec(pathname)
  return match && match[0] === pathname ? { hash: match[1], extension: match[2] as FeedIconExtension } : null
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) && bytes.readUInt32BE(8) === 13
    && bytes.toString('latin1', 12, 16) === 'IHDR' && Boolean(bytes.readUInt32BE(16) && bytes.readUInt32BE(20))
}

function isIconBitmap(bytes: Buffer): boolean {
  if (isPng(bytes)) return true
  if (bytes.length < 12) return false
  const headerSize = bytes.readUInt32LE(0)
  if (headerSize >= bytes.length) return false
  if (headerSize === 12) return Boolean(bytes.readUInt16LE(4) && bytes.readUInt16LE(6) && bytes.readUInt16LE(8) === 1)
  return [40, 52, 56, 108, 124].includes(headerSize)
    && Boolean(bytes.readUInt32LE(4) && bytes.readUInt32LE(8) && bytes.readUInt16LE(12) === 1)
}

export function rasterIcon(bytes: Buffer): FeedIconExtension | null {
  if (bytes.length > MAX_FEED_ICON_BYTES) return null
  if (isPng(bytes)) return 'png'
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))
      && bytes.readUInt16LE(6) && bytes.readUInt16LE(8)) return 'gif'
  if (bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'jpg'
  if (bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP'
      && bytes.readUInt32LE(4) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16))) return 'webp'
  if (bytes.length >= 23 && bytes.readUInt32LE(0) === 0x00010000) {
    const count = bytes.readUInt16LE(4)
    const directoryEnd = 6 + count * 16
    if (count && directoryEnd < bytes.length) {
      for (let entry = 6; entry < directoryEnd; entry += 16) {
        const size = bytes.readUInt32LE(entry + 8)
        const offset = bytes.readUInt32LE(entry + 12)
        if (!size || offset < directoryEnd || offset + size > bytes.length
            || !isIconBitmap(bytes.subarray(offset, offset + size))) return null
      }
      return 'ico'
    }
  }
  return null
}
