import type { ReaderBackend } from './backend.js'
import type { PaperDatabase } from './db.js'
import { loadConfig, stateDirectory, type Config } from './config.js'
import { createReaderBackend } from './create-backend.js'
import { openCoordinatedStorage } from './storage-bootstrap.js'
import { runtimeSecrets } from './runtime-secrets.js'

export async function openRuntimeStorage(setup?: (config: Config, database: PaperDatabase) => Promise<ReaderBackend | undefined>) {
  // Validate configuration without writing generated settings. These temporary
  // values are replaced before any service can use the configuration.
  const pendingSecrets = { internalSecret: 'pending', signingSecret: 'pending' }
  let config = loadConfig(pendingSecrets)
  const storage = await openCoordinatedStorage(stateDirectory())
  try {
    let backend: ReaderBackend | undefined
    if (config.sourcePending) {
      if (!setup) throw new Error('Open Paper to choose a feed source before running a briefing.')
      backend = await setup(config, storage.database)
      if (!backend) config = loadConfig(pendingSecrets)
    }
    if (!backend) {
      backend = createReaderBackend(config, storage.database)
      await backend.initialize?.()
    }
    storage.database.bindBackend(backend.identity)
    const secrets = runtimeSecrets(storage.stateDir)
    Object.assign(config, loadConfig(secrets))
    return { ...storage, config, backend }
  } catch (error) { storage.close(); throw error }
}
