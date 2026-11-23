import { AI_UNAVAILABLE, warnUnsafeAi } from './ai-client.js'
import { aiEnabled, providerConfigured } from './ai-provider.js'
import { BriefingService } from './briefing.js'
import { openRuntimeStorage } from './runtime-storage.js'
import { ConnectionSettings } from './connections.js'
import { PaperRepository } from './repository.js'
import { ReaderService } from './reader.js'
import { storedPulseCollections } from './pulse.js'
import { TopicService } from './topics.js'

const controller = new AbortController()
const cancel = () => controller.abort()
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
warnUnsafeAi()
const storage = await openRuntimeStorage()
try {
const { config, database, backend } = storage
new ConnectionSettings(config)
if (aiEnabled(config) && config.ai.briefingsEnabled && !providerConfigured(config)) throw new Error(AI_UNAVAILABLE)
const repository = new PaperRepository(database)
const reader = new ReaderService(database, config.readerFallbackEnabled)
const entries = backend.identity.kind === 'standalone' || config.sync.localReads && database.getSyncValue('backfill_complete') === 'true' ? repository : backend
database.aiActivity.navigation = signal => entries.navigation(signal)
const coverage = new TopicService(database, entries, () => storedPulseCollections(database).collections)
const service = new BriefingService(config, database, entries, reader, coverage)
const kind = process.argv[2] === 'evening' ? 'evening' : 'morning'
const force = process.argv.includes('--force')
const manual = process.argv.includes('--manual') || process.stdin.isTTY && !process.argv.includes('--scheduled')
const result = await service.generate(kind, force, controller.signal, manual ? 'manual' : 'scheduled')
console.log(JSON.stringify({ id: result.id, subject: result.subject, status: result.status, cutoff: result.cutoff }))

} finally {
  // Cancellation releases the caller before its provider finishes recording the outcome.
  await storage.database.aiActivity.finishPendingAttempts()
  storage.close()
  process.off('SIGINT', cancel)
  process.off('SIGTERM', cancel)
}
