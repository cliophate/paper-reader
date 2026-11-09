import { describe, expect, it } from 'vitest'
import { parseXMediaUrl } from '../src/server/x-media.js'

describe('X media proxy URL validation', () => {
  it('accepts direct Twitter video media', () => {
    expect(parseXMediaUrl('https://video.twimg.com/amplify_video/123/vid/avc1/1280x720/example.mp4?tag=29').hostname).toBe('video.twimg.com')
  })

  it.each([
    'http://video.twimg.com/video.mp4',
    'https://example.com/video.mp4',
    'https://video.twimg.com.example.com/video.mp4',
    'https://user:pass@video.twimg.com/video.mp4',
  ])('rejects unsafe media URL %s', url => {
    expect(() => parseXMediaUrl(url)).toThrow('Paper only proxies X video media')
  })
})
