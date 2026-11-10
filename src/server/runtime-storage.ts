import { loadConfig, stateDirectory } from './config.js'
import { createReaderBackend } from './create-backend.js'
import { openCoordinatedStorage } from './storage-bootstrap.js'
import { runtimeSecrets } from './runtime-secrets.js'

export async function openRuntimeStorage() {
  // Validate configuration without writing generated settings. These temporary
  // values are replaced before any service can use the configuration.
  const config = loadConfig({ internalSecret: 'pending', signingSecret: 'pending' })
  const storage = await openCoordinatedStorage(stateDirectory())
  try {
    const backend = createReaderBackend(config, storage.database)
    storage.database.bindBackend(backend.identity)
    const secrets = runtimeSecrets(storage.stateDir)
    Object.assign(config, loadConfig(secrets))
    return { ...storage, config, backend }
  } catch (error) { storage.close(); throw error }
}
