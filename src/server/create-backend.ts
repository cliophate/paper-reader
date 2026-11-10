import type { ReaderBackend } from './backend.js'
import type { Config } from './config.js'
import { FreshRssClient } from './freshrss.js'

// FreshRSS remains required until the standalone backend and migration are ready.
export function createReaderBackend(config: Pick<Config, 'freshRss' | 'trustedFeedOrigins'>): ReaderBackend {
  return new FreshRssClient(config.freshRss, config.trustedFeedOrigins)
}
