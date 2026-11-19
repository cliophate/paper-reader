import { aiEnabled } from './ai-provider.js'
import type { BriefingService } from './briefing.js'
import { BriefingClock, shiftDate } from './briefing-schedule.js'
import type { Config } from './config.js'
import type { PaperDatabase } from './db.js'
import { checkSmtp, sendSmtp, SmtpError } from './smtp.js'
import { acquireStateLock, StateLockError } from './state-lock.js'

const CURSOR = 'briefing_delivery_cursor'
const CADENCE_MS = 15_000
const RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000]
const UNCONFIRMED = 'SMTP acceptance could not be confirmed. Check the relay logs or recipient inbox.'
type Job = ReturnType<PaperDatabase['briefingDelivery']['due']>[number]

class DeliverySkipped extends SmtpError {}

// Spam filters score Message-IDs whose domain doesn't match the sender.
export function senderDomain(from: string): string {
  return /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/.exec(from.trim())?.[1].toLowerCase() || 'paper.invalid'
}

export class BriefingDelivery {
  private readonly clock: BriefingClock
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private generating?: AbortController
  private stopped = false

  constructor(private readonly config: Config, private readonly db: PaperDatabase,
    private readonly briefings: Pick<BriefingService, 'generateScheduled'>, private readonly now = Date.now) {
    this.clock = new BriefingClock(config.timeZone)
  }

  start() {
    this.settingsChanged()
    this.timer = setInterval(() => this.settingsChanged(), CADENCE_MS)
    this.timer.unref()
  }

  settingsChanged() {
    if (this.skipReason()) this.generating?.abort()
    void this.tick().catch(() => console.error('Could not update briefing delivery. Check database access.'))
  }

  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    this.generating?.abort()
    await this.running
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.running ??= this.run().finally(() => { this.running = undefined })
    return this.running
  }

  private skipReason(): string | undefined {
    if (!this.config.briefingSchedule.enabled) return 'Scheduled delivery is off. Enable it in Settings.'
    if (!aiEnabled(this.config)) return 'AI is off. Enable AI and select a provider in Settings.'
    if (!this.config.ai.briefingsEnabled) return 'Briefing generation is off. Enable it in Settings.'
  }

  private async run() {
    if (!this.config.briefingSchedule.enabled && !this.db.getSyncValue(CURSOR) && !this.db.briefingDelivery.hasPending()) return
    // Hold a separate process lock across network work. SQLite releases it on
    // process exit, so a restart can recover without guessing at lease expiry.
    let lock
    try { lock = acquireStateLock(this.config.stateDir, 'exclusive', 'briefing-delivery') }
    catch (error) {
      if (error instanceof StateLockError && error.busy) return
      throw error
    }
    try {
      const now = this.now()
      this.recordSlots(now)
      for (const job of this.db.briefingDelivery.due(now, Boolean(this.skipReason()))) {
        if (this.stopped) break
        await this.process(job)
      }
    } finally { lock.release() }
  }

  private recordSlots(now: number) {
    const { enabled, morning, evening } = this.config.briefingSchedule
    const cursor = this.db.getSyncValue(CURSOR)
    if (!enabled) {
      if (cursor) this.db.setSyncValue(CURSOR, '')
      return
    }
    const schedule = JSON.stringify([this.config.timeZone, morning, evening])
    const previous = cursor?.startsWith(schedule + ':') ? Number(cursor.slice(schedule.length + 1)) : undefined
    // Minute precision is enough for new slots. Retry polling still uses the
    // original clock so a missed tick does not move a retry deadline.
    const through = Math.floor(now / 60_000) * 60_000
    if (previous !== undefined && previous >= through) return
    const today = this.clock.date(now)
    const yesterday = shiftDate(today, -1)
    // Check the day before the cursor too, for a gap near midnight.
    const first = previous === undefined ? yesterday : shiftDate(this.clock.date(previous), -1)
    this.db.transaction(() => {
      for (let date = first; date <= today; date = shiftDate(date, 1)) {
        const editionStart = this.clock.at(date, '00:00')
        const editionEnd = this.clock.at(shiftDate(date, 1), '00:00')
        for (const [kind, time] of [['morning', morning], ['evening', evening]] as const) {
          const scheduledAt = this.clock.at(date, time)
          if (scheduledAt > through || (previous !== undefined && scheduledAt <= previous)) continue
          const missed = now - scheduledAt > this.config.briefingGraceMs
          if (previous === undefined && date < today && missed) continue
          this.db.briefingDelivery.enqueue({ kind, date, scheduledAt, editionStart, editionEnd }, now, missed)
        }
      }
      this.db.setSyncValue(CURSOR, schedule + ':' + through)
    })
  }

  private async process(job: Job) {
    const store = this.db.briefingDelivery
    const state = (value: Job['state'], error?: string) => store.state(job.id, value, this.now(), error)
    const delivered = (id: string | null) => Boolean((id && this.db.getBriefing(id)?.deliveredAt) || store.edition(job, true))
    let briefingId = job.briefingId
    if (delivered(briefingId)) return state('skipped', 'This edition was already delivered.')
    if (job.state === 'sending' && job.dataStartedAt !== null) return state('unconfirmed', UNCONFIRMED)
    const skipped = this.skipReason()
    if (skipped) return state('skipped', skipped)
    if (job.state === 'pending' && this.now() - job.scheduledAt > this.config.briefingGraceMs) {
      return state('missed', 'Paper could not start delivery within the grace window.')
    }
    try { checkSmtp(this.config.smtp) }
    catch (error) { return state('failed', (error as SmtpError).message) }

    if (!briefingId) {
      briefingId = store.edition(job) ?? null
      if (briefingId) store.attach(job.id, briefingId, this.now())
    }
    if (!briefingId) {
      state('generating')
      const controller = new AbortController()
      this.generating = controller
      let attached = false
      try {
        const record = await this.briefings.generateScheduled(job.kind, controller.signal, record => {
          store.attach(job.id, record.id, this.now())
          attached = true
        })
        briefingId = record.id
      } catch {
        if (this.stopped) return
        const reason = this.skipReason()
        if (reason) return state('skipped', reason)
        return state('failed', 'Paper could not generate the briefing. Check AI settings and the server logs.')
      } finally { this.generating = undefined }
      // A shared request can return an edition that was already stored.
      if (!attached) store.attach(job.id, briefingId, this.now())
    }

    if (this.stopped) return
    const reason = this.skipReason()
    if (reason) return state('skipped', reason)
    const briefing = this.db.getBriefing(briefingId)
    if (delivered(briefingId)) return state('skipped', 'This edition was already delivered.')
    if (!briefing) return state('failed', 'The saved briefing is missing. Check the Paper database.')
    store.startAttempt(job.id, this.now())
    try {
      await sendSmtp(this.config.smtp, {
        subject: briefing.subject, text: briefing.text, html: briefing.html,
        messageId: `<${job.id}@${senderDomain(this.config.smtp.from)}>`,
      }, () => {
        const disabled = this.skipReason()
        if (disabled) throw new DeliverySkipped(disabled)
        if (delivered(briefingId)) throw new DeliverySkipped('This edition was already delivered.')
        store.startData(job.id, this.now())
      })
    } catch (error) {
      if (error instanceof DeliverySkipped) return state('skipped', error.message)
      if (!(error instanceof SmtpError)) return state('failed', 'Paper could not send the briefing. Check the SMTP settings.')
      const delay = RETRY_DELAYS[job.attempts]
      if (error.retryable && delay) return store.state(job.id, 'retrying', this.now(), error.message, this.now() + delay)
      return state(error.unconfirmed ? 'unconfirmed' : 'failed', error.message)
    }
    this.db.transaction(() => {
      this.db.markDelivered(briefing.id)
      state('delivered')
    })
  }
}
