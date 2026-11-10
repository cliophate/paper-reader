import type { ReaderBackend } from './backend.js'
import type { Config } from './config.js'
import { FreshRssClient } from './freshrss.js'
import type { PaperDatabase } from './db.js'
import { StandaloneBackend } from './standalone-backend.js'

export function createReaderBackend(config: Pick<Config, 'freshRss' | 'trustedFeedOrigins'> & Partial<Pick<Config, 'backend'>>, database?: PaperDatabase): ReaderBackend {
  if (config.backend === 'standalone') {
    if (!database) throw new Error('Standalone mode requires coordinated storage')
    return new StandaloneBackend(database)
  }
  return new FreshRssClient(config.freshRss, config.trustedFeedOrigins)
}
