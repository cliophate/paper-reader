import { tokenUsage, type TokenUsage, type AiAttempt } from './ai-usage.js'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import type { ActivityFeature, AiActivityItem, AiActivityView, AiOutcome, AiPolicy, AiTrigger } from '../shared/ai-activity.js'
import { AiError } from './ai-errors.js'
import { retryBusy, transaction } from './transaction.js'
import { configuredTimeZone } from './config.js'
import { abortable } from './abort.js'
import { BriefingClock, shiftDate } from './briefing-schedule.js'
import type { NavigationPayload } from './types.js'

export const AI_ACTIVITY_VERSION = 28
export const MAX_ACTIVITY_ROWS = 2000
export const ACTIVITY_MAX_AGE = 30 * 86_400_000
const processId = randomUUID()
// The longest provider deadline is 620 seconds, including the Codex queue.
const MAX_RUNNING_AGE = 12 * 60_000

function processExited(pid: number) {
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

const features: AiActivityView['features'] = {
  headlines: { label: 'Headline cleanup', sends: 'Original titles, article IDs, full article text and proposed headlines.', background: true },
  grouping: { label: 'Pulse grouping', sends: 'Titles, excerpts, links, publication names and dates, collection descriptions and recent titles.', background: true },
  catchUp: { label: 'Pulse catch-ups', sends: 'Collection titles and descriptions, article titles, excerpts, publishers, dates and which articles are new.', background: true },
  briefing: { label: 'Briefings', sends: 'Article titles, links, authors, dates, image URLs, excerpts and selected full text. Includes your editorial profile, prior coverage and briefing feedback.', background: true },
  discussion: { label: 'Article discussions', sends: 'The article title, author, URL, article text, selected passages and conversation history.', background: false },
  questions: { label: 'Collection answers', sends: 'Your question, previous answer, article titles, publications and excerpts.', background: false },
  suggestions: { label: 'Suggested questions', sends: 'Article titles, publications, excerpts and previous suggestions.', background: true },
  connection: { label: 'Connection test', sends: 'A short test message using the discussion model.', background: false },
}

export function migrateAiActivity(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_activity (
        id INTEGER PRIMARY KEY, feature TEXT NOT NULL, trigger TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, started INTEGER NOT NULL, duration INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT,
        inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER, estimatedUsd REAL
      );
      CREATE INDEX IF NOT EXISTS ai_activity_started ON ai_activity(started DESC, id DESC);
      CREATE TABLE IF NOT EXISTS ai_daily_usage (day TEXT NOT NULL, feature TEXT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(day, feature));
    `)
    if (!db.prepare("SELECT 1 FROM pragma_table_info('ai_activity') WHERE name='ownerPid'").get()) {
      db.exec('ALTER TABLE ai_activity ADD COLUMN ownerPid INTEGER; ALTER TABLE ai_activity ADD COLUMN ownerId TEXT')
    }
    db.exec('PRAGMA user_version = ' + AI_ACTIVITY_VERSION)
  })
}

const defaultPolicy = (): AiPolicy => ({ daily: null, featureLimits: {}, feeds: [], folders: [], prices: [] })
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const rate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1_000_000
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10000 && v.every(s => typeof s === 'string' && s.length > 0 && s.length <= 2048)

export class AiPolicyError extends Error {}
export class AiLimitError extends Error {
  constructor(message = 'Daily background AI limit reached.') { super(message) }
}

export function interruptedAiWork(error: unknown) {
  return error instanceof AiLimitError || error instanceof AiError && error.category === 'cancelled'
}

function validatePolicy(value: AiPolicy) {
  if (!value || !(value.daily === null || count(value.daily)) || !ids(value.feeds) || !ids(value.folders)
    || !value.featureLimits || typeof value.featureLimits !== 'object' || Array.isArray(value.featureLimits)
    || !Array.isArray(value.prices) || value.prices.length > 200) throw new AiPolicyError('Invalid AI controls.')
  for (const [key, limit] of Object.entries(value.featureLimits)) {
    if (!Object.hasOwn(features, key) || !features[key as ActivityFeature].background || !count(limit)) throw new AiPolicyError('Enter a whole number for each background limit.')
  }
  const prices = value.prices.map(p => {
    if (!p || typeof p.model !== 'string' || !p.model.trim() || p.model.length > 200 || !rate(p.input) || !rate(p.output)) throw new AiPolicyError('Each model needs an input and output price in USD per million tokens.')
    return { model: p.model.trim(), input: p.input, output: p.output }
  })
  if (new Set(prices.map(p => p.model)).size !== prices.length) throw new AiPolicyError('Enter each model price once.')
  const folderNames = Object.fromEntries(value.folders.flatMap(id => {
    const name = value.folderNames?.[id]
    return typeof name === 'string' && name.trim() ? [[id, name.slice(0, 2048)]] : []
  }))
  return { ...(Object.keys(folderNames).length ? { folderNames } : {}), daily: value.daily, featureLimits: value.featureLimits, feeds: [...new Set(value.feeds)], folders: [...new Set(value.folders)], prices }
}

export class AiActivityStore {
  private scope = new AsyncLocalStorage<{
    trigger: AiTrigger; excluded: Set<string>; firstStage?: { feature: ActivityFeature; minimum: number }
  }>()
  private pending = new Set<Promise<unknown>>()
  private blockedDay = new Map<ActivityFeature, { day: string; minimum: number }>()
  private timeZone: string
  private clock: BriefingClock
  navigation?: (signal?: AbortSignal) => Promise<NavigationPayload>

  constructor(private db: DatabaseSync, private now = Date.now, readOnly = false) {
    const saved = () => this.db.prepare("SELECT value FROM sync_state WHERE key='ai_quota_timezone'").get()?.value
    if (!readOnly && !saved()) {
      this.db.prepare("INSERT OR IGNORE INTO sync_state(key,value) VALUES('ai_quota_timezone',?)").run(configuredTimeZone())
    }
    this.timeZone = String(saved() ?? configuredTimeZone())
    this.clock = new BriefingClock(this.timeZone)
  }

  policy(): AiPolicy {
    const row = this.db.prepare("SELECT value FROM sync_state WHERE key = 'ai_policy'").get()
    return row ? JSON.parse(String(row.value)) : defaultPolicy()
  }

  savePolicy(policy: AiPolicy) {
    const checked = validatePolicy(policy)
    this.db.prepare("INSERT OR REPLACE INTO sync_state(key,value) VALUES('ai_policy',?)").run(JSON.stringify(checked))
  }

  private resolveFeeds({ feeds, folders }: AiPolicy, navigation?: NavigationPayload) {
    const excluded = new Set(feeds)
    if (!folders.length) return excluded
    if (navigation) {
      for (const folder of navigation.folders) {
        if (folders.includes(folder.id)) for (const feed of folder.feeds) excluded.add(feed.id)
      }
    } else {
      for (const row of this.db.prepare('SELECT DISTINCT feed_id FROM feed_folders WHERE folder_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(folders))) excluded.add(String(row.feed_id))
    }
    return excluded
  }

  excludedFeeds() { return this.scope.getStore()?.excluded ?? this.resolveFeeds(this.policy()) }
  get exclusionKey() {
    const feeds = this.excludedFeeds()
    return feeds.size ? createHash('sha256').update(JSON.stringify([...feeds].sort())).digest('hex') : ''
  }

  private async currentNavigation(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(15_000)
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const navigation = await abortable(() => this.navigation!(deadline), deadline)
      const known = new Set(navigation.folders.map(folder => folder.id))
      const policy = this.policy()
      const missing = policy.folders.find(id => !known.has(id))
      if (missing) throw new AiLimitError(`excluded folder not found: ${policy.folderNames?.[missing] ?? missing}`)
      return navigation
    } catch (error) {
      if (error instanceof AiLimitError) throw error
      if (signal?.aborted) throw new AiError('cancelled')
      throw new AiLimitError('Background AI skipped: exclusions unresolved.')
    }
  }

  async withTrigger<T>(trigger: AiTrigger, action: () => Promise<T>, feature: ActivityFeature = 'briefing', signal?: AbortSignal) {
    let excluded = new Set<string>()
    if (trigger !== 'manual') {
      try {
        const navigation = this.policy().folders.length && this.navigation ? await this.currentNavigation(signal) : undefined
        excluded = this.resolveFeeds(this.policy(), navigation)
      } catch (error) {
        if (error instanceof AiLimitError) await this.skipped(feature, trigger, error.message)
        throw error
      }
    }
    return this.scope.run({ trigger, excluded }, action)
  }

  get trigger() { return this.scope.getStore()?.trigger ?? 'manual' }

  remaining(feature: ActivityFeature, day = this.clock.date(this.now())) {
    const policy = this.policy(), used = this.usage(day)
    return Math.max(0, Math.min((policy.featureLimits[feature] ?? Infinity) - (used[feature] ?? 0),
      (policy.daily ?? Infinity) - Object.values(used).reduce((a, b) => a + b, 0)))
  }

  private async writeActivity(write: () => void) {
    try { await retryBusy(write) }
    catch { console.warn('Could not write the AI activity log.') }
  }

  private skipped(feature: ActivityFeature, trigger: AiTrigger, reason: string) {
    return this.writeActivity(() => this.db.prepare("INSERT INTO ai_activity(feature,trigger,provider,model,started,duration,outcome,reason) VALUES(?,?,'none','',?,0,'limited',?)")
      .run(feature, trigger, this.now(), reason))
  }

  async recoverInterrupted() {
    await this.writeActivity(() => transaction(this.db, () => {
      const previous = this.db.prepare("SELECT value FROM sync_state WHERE key='ai_server_process'").get()?.value
      const cutoff = this.now() - MAX_RUNNING_AGE
      const interrupt = this.db.prepare("UPDATE ai_activity SET outcome='interrupted' WHERE id=?")
      for (const row of this.db.prepare("SELECT id,started,ownerPid,ownerId FROM ai_activity WHERE outcome='running'").all()) {
        if (Number(row.started) < cutoff || (previous && previous !== processId && row.ownerId === previous)
          || (row.ownerPid && processExited(Number(row.ownerPid)))) interrupt.run(row.id)
      }
      this.db.prepare("INSERT OR REPLACE INTO sync_state(key,value) VALUES('ai_server_process',?)").run(processId)
    }))
  }

  async requireAllowance(feature: ActivityFeature, minimum: number) {
    const scope = this.scope.getStore()
    if (!scope || scope.trigger === 'manual') return
    const day = this.clock.date(this.now())
    if (this.remaining(feature, day) < minimum) {
      this.blockedDay.set(feature, { day, minimum })
      const error = new AiLimitError()
      await this.skipped(feature, scope.trigger, error.message)
      throw error
    }
    scope.firstStage = { feature, minimum }
  }

  paused(feature: ActivityFeature) {
    const day = this.clock.date(this.now())
    const blocked = this.blockedDay.get(feature)
    return blocked?.day === day && this.remaining(feature, day) < blocked.minimum
  }

  private usage(day: string): AiActivityView['used'] {
    return Object.fromEntries(this.db.prepare('SELECT feature,requests FROM ai_daily_usage WHERE day=? AND requests>0').all(day).map(row => [row.feature, row.requests]))
  }

  pruneActivity() { return this.writeActivity(() => this.prune()) }

  private prune(now = this.now()) {
    this.db.prepare('DELETE FROM ai_activity WHERE started < ?').run(now - ACTIVITY_MAX_AGE)
    this.db.prepare("DELETE FROM ai_activity WHERE id IN (SELECT id FROM ai_activity WHERE outcome != 'running' ORDER BY started DESC,id DESC LIMIT -1 OFFSET ?)").run(MAX_ACTIVITY_ROWS)
  }

  attempt(feature: ActivityFeature, provider: AiActivityItem['provider'], model: string, signal?: AbortSignal): AiAttempt {
    const run: AiAttempt = async (action, deferAdmission) => {
      const start = this.now(), trigger = this.trigger
      const scope = this.scope.getStore()
      let id: number | bigint | undefined
      let reason: string | null = null
      let usage: TokenUsage | undefined
      let price: AiPolicy['prices'][number] | undefined
      let outcome: AiOutcome = 'ok'
      const insert = (status: AiOutcome) => this.db.prepare('INSERT INTO ai_activity(feature,trigger,provider,model,started,duration,outcome,ownerPid,ownerId) VALUES(?,?,?,?,?,0,?,?,?)')
        .run(feature, trigger, provider, model, start, status, process.pid, processId).lastInsertRowid
      const admit = async (dispatchSignal = signal, confirmSlot?: () => Promise<void>) => {
        await this.writeActivity(() => {
          price = provider === 'openai' ? this.policy().prices.find(p => p.model === model) : undefined
          id = insert('running')
        })
        dispatchSignal?.throwIfAborted()
        if (scope && trigger !== 'manual') {
          await retryBusy(async () => {
            const navigation = this.navigation && this.policy().folders.length ? await this.currentNavigation(dispatchSignal) : undefined
            await confirmSlot?.()
            transaction(this.db, () => {
              dispatchSignal?.throwIfAborted()
              const policy = this.policy()
              if (policy.folders.length && this.navigation && policy.folders.some(id => !navigation?.folders.some(folder => folder.id === id))
                || [...this.resolveFeeds(policy, navigation)].some(feed => !scope.excluded.has(feed))) throw new AiError('cancelled')
              const day = this.clock.date(this.now())
              const minimum = scope.firstStage?.feature === feature ? scope.firstStage.minimum : 1
              if (this.remaining(feature, day) < minimum) {
                this.blockedDay.set(feature, { day, minimum })
                throw new AiLimitError()
              }
              this.db.prepare('DELETE FROM ai_daily_usage WHERE day < ?').run(shiftDate(day, -2))
              this.db.prepare('INSERT INTO ai_daily_usage VALUES(?,?,1) ON CONFLICT(day,feature) DO UPDATE SET requests=requests+1').run(day, feature)
            })
          })
          scope.firstStage = undefined
        }
      }
      try {
        if (!deferAdmission) await admit()
        return await action(value => { usage = tokenUsage(value.input, value.output, value.total) }, admit)
      } catch (error) {
        if (error instanceof AiLimitError) reason = error.message
        outcome = error instanceof AiLimitError ? 'limited' : signal?.aborted || error instanceof AiError && error.category === 'cancelled' ? 'cancelled'
          : error instanceof AiError && error.category === 'busy' ? 'busy' : 'error'
        throw error
      } finally {
        const end = this.now()
        const priced = usage?.input !== undefined && usage.output !== undefined && price
          && (usage.total === undefined || usage.total === usage.input + usage.output)
          ? (usage.input * price.input + usage.output * price.output) / 1_000_000 : null
        await this.writeActivity(() => transaction(this.db, () => {
          const row = id ?? insert(outcome)
          this.db.prepare('UPDATE ai_activity SET duration=?,outcome=?,reason=?,inputTokens=?,outputTokens=?,totalTokens=?,estimatedUsd=? WHERE id=?')
            .run(Math.max(0, end - start), outcome, reason, usage?.input ?? null, usage?.output ?? null, usage?.total ?? null, priced, row)
          this.prune(end)
        }))
      }
    }
    return (action, deferAdmission) => {
      const request = run(action, deferAdmission)
      this.pending.add(request)
      return request.finally(() => this.pending.delete(request))
    }
  }

  async finishPendingAttempts() { await Promise.allSettled(this.pending) }

  view(feature = '', outcome = ''): AiActivityView {
    const now = this.now()
    const items = this.db.prepare(`SELECT id,feature,trigger,provider,model,started,duration,outcome,reason,inputTokens,outputTokens,totalTokens,estimatedUsd FROM ai_activity WHERE started >= ? AND (?='' OR feature=?) AND (?='' OR outcome=?)
      ORDER BY started DESC,id DESC LIMIT 100`).all(now - ACTIVITY_MAX_AGE, feature, feature, outcome, outcome) as unknown as AiActivityItem[]
    return { features, items, policy: this.policy(), used: this.usage(this.clock.date(now)), timeZone: this.timeZone }
  }
}
