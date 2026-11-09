import { BriefingService } from './briefing.js'
import { loadConfig } from './config.js'
import { PaperDatabase } from './db.js'
import { FreshRssClient } from './freshrss.js'
import { PaperRepository } from './repository.js'
import { ReaderService } from './reader.js'
import { PulseService } from './pulse.js'
import { TopicService } from './topics.js'

const config = loadConfig()
const database = new PaperDatabase(config.databasePath)
const freshRss = new FreshRssClient(config.freshRss, config.trustedFeedOrigins)
const repository = new PaperRepository(database)
const reader = new ReaderService(database, config.readerFallbackEnabled)
const entries = config.sync.localReads && database.getSyncValue('backfill_complete') === 'true' ? repository : freshRss
const pulse = new PulseService(database, async () => { throw new Error('Grouping runs in the Paper service') }, false)
const coverage = new TopicService(database, entries, () => pulse.list().collections)
const service = new BriefingService(config, database, entries, reader, coverage)
const kind = process.argv[2] === 'evening' ? 'evening' : 'morning'
const force = process.argv.includes('--force')
const result = await service.generate(kind, force)
console.log(JSON.stringify({ id: result.id, subject: result.subject, status: result.status, cutoff: result.cutoff }))
