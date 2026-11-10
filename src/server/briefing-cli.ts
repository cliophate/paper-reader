import { BriefingService } from './briefing.js'
import { openRuntimeStorage } from './runtime-storage.js'
import { ConnectionSettings } from './connections.js'
import { PaperRepository } from './repository.js'
import { ReaderService } from './reader.js'
import { PulseService } from './pulse.js'
import { TopicService } from './topics.js'

const storage = await openRuntimeStorage()
try {
const { config, database, backend } = storage
new ConnectionSettings(config)
const repository = new PaperRepository(database)
const reader = new ReaderService(database, config.readerFallbackEnabled)
const entries = backend.identity.kind === 'standalone' || config.sync.localReads && database.getSyncValue('backfill_complete') === 'true' ? repository : backend
const pulse = new PulseService(database, async () => { throw new Error('Grouping runs in the Paper service') }, false)
const coverage = new TopicService(database, entries, () => pulse.list().collections)
const service = new BriefingService(config, database, entries, reader, coverage)
const kind = process.argv[2] === 'evening' ? 'evening' : 'morning'
const force = process.argv.includes('--force')
const result = await service.generate(kind, force)
console.log(JSON.stringify({ id: result.id, subject: result.subject, status: result.status, cutoff: result.cutoff }))

} finally { storage.close() }
