const DAY = 86_400_000
const HOUR = 3_600_000

export class BriefingClock {
  private readonly formatter: Intl.DateTimeFormat

  constructor(timeZone: string) {
    this.formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  }

  private local(instant: number): string {
    return this.formatter.format(instant).replace(' ', 'T')
  }

  date(instant: number): string { return this.local(instant).slice(0, 10) }

  at(date: string, time: string): number {
    const wall = Date.parse(`${date}T${time}:00Z`)
    const offset = (instant: number) => Date.parse(this.local(instant) + 'Z') - instant
    // On a fold choose the earlier matching instant. In a gap use the old
    // offset, moving the requested wall time forward by the size of the gap.
    const before = wall - offset(wall - 36 * HOUR)
    const after = wall - offset(wall + 36 * HOUR)
    const matches = [before, after].filter(instant => this.local(instant) === `${date}T${time}:00`)
    return matches.length ? Math.min(...matches) : before
  }
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
}
