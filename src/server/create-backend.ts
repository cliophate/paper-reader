import type { ReaderBackend } from './backend.js'
import type { Config } from './config.js'
import { FreshRssClient } from './freshrss.js'
import type { PaperDatabase } from './db.js'
import { StandaloneBackend } from './standalone-backend.js'
import { MinifluxClient } from './miniflux.js'

export function createReaderBackend(config: Pick<Config, 'freshRss' | 'trustedFeedOrigins'> & Partial<Pick<Config, 'backend' | 'miniflux'>>, database?: PaperDatabase): ReaderBackend {
  if (config.backend === 'standalone') {
    if (!database) throw new Error('Standalone mode requires coordinated storage')
    return new StandaloneBackend(database)
  }
  if (config.backend === 'miniflux') {
    if (!config.miniflux) throw new Error('Miniflux connection settings are required')
    return new MinifluxClient(config.miniflux)
  }
  return new FreshRssClient(config.freshRss, config.trustedFeedOrigins)
}
