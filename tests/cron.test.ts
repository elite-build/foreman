// Cron for AI employees' triggers (docs/ai-employees.md §8): the five fields with lists, ranges, steps and names; the
// next firing on the wall clock of an IANA time zone, across daylight saving (a skipped local time fires once at the
// first minute after the gap, a repeated one fires once, the first time); classic cron's day-of-month or day-of-week
// rule; and the shortest gap between firings for the 15-minute floor. Intervals and calendar triggers' next times too.
import { describe, expect, it } from 'vitest'
import { cronInstant, cronMinGapMinutes, nextCron, nextCrons, parseCron, type CronSpec } from '../src/shared/cron'
import { intervalMinutes, nextFire, nextFires, triggerTimingProblem, type CronTrigger, type EmployeeTrigger } from '../src/shared/employeeTriggers'

const spec = (expression: string): CronSpec => {
  const parsed = parseCron(expression)
  if (!parsed.ok) throw new Error(parsed.problem)
  return parsed.spec
}
const at = (iso: string) => Date.parse(iso)
const isoOf = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
const common = { missed: 'skip', overlap: 'skip', enabled: true } as const

describe('cron: reading an expression', () => {
  it('reads *, numbers, lists, ranges, steps and names, Sunday as 0 or 7', () => {
    expect(spec('0 9 * * 1')).toMatchObject({ minutes: [0], hours: [9], weekdays: [1], anyDay: true, anyWeekday: false })
    expect(spec('*/15 8-10 * * *').minutes).toEqual([0, 15, 30, 45])
    expect(spec('*/15 8-10 * * *').hours).toEqual([8, 9, 10])
    expect(spec('0 9 * * mon-fri').weekdays).toEqual([1, 2, 3, 4, 5])
    expect(spec('0 9 * * SUN,7').weekdays).toEqual([0])
    expect(spec('0 9 1,15 jan,Jul *')).toMatchObject({ days: [1, 15], months: [1, 7], anyDay: false })
    expect(spec('5/20 * * * *').minutes).toEqual([5, 25, 45])
    expect(spec('0 0-23/6 * * *').hours).toEqual([0, 6, 12, 18])
    expect(spec('0 9 * * *').days).toHaveLength(31)
  })

  it('says what is wrong, in words', () => {
    const problem = (e: string) => {
      const p = parseCron(e)
      return p.ok ? null : p.problem
    }
    expect(problem('')).toMatch(/^Write a cron expression/)
    expect(problem('0 9 * *')).toBe('A cron expression has five fields (minute, hour, day of month, month, day of week); this has 4.')
    expect(problem('60 * * * *')).toBe('The minute field goes from 0 to 59; “60” is outside that.')
    expect(problem('0 24 * * *')).toBe('The hour field goes from 0 to 23; “24” is outside that.')
    expect(problem('0 9 * * funday')).toMatch(/^The day of week field “funday” isn’t valid/)
    expect(problem('*/0 * * * *')).toMatch(/^The minute field “\*\/0” isn’t valid/)
    expect(problem('0 9 5-1 * *')).toMatch(/^The day of month field “5-1” isn’t valid/)
    expect(problem('0 0 31 2 *')).toBe('It never fires: none of its months has that day.')
    // With a day of week too, it fires on those weekdays, so it isn't "never".
    expect(problem('0 0 31 2 1')).toBeNull()
  })
})

describe('cron: the next firing', () => {
  it('finds the next time in the zone, strictly after the instant', () => {
    const mondays = spec('0 9 * * 1')
    // Friday 13 November 2026, London is on GMT: the next Monday 09:00 is 16 November, 09:00 UTC.
    expect(isoOf(nextCron(mondays, at('2026-11-13T10:00:00Z'), 'Europe/London'))).toBe('2026-11-16T09:00:00.000Z')
    expect(isoOf(nextCron(mondays, at('2026-11-16T09:00:00Z'), 'Europe/London'))).toBe('2026-11-23T09:00:00.000Z')
    // In summer, London is an hour ahead of UTC.
    expect(isoOf(nextCron(mondays, at('2026-07-01T00:00:00Z'), 'Europe/London'))).toBe('2026-07-06T08:00:00.000Z')
    expect(isoOf(nextCron(spec('30 18 * * *'), at('2026-11-13T10:00:00Z'), 'America/Los_Angeles'))).toBe('2026-11-14T02:30:00.000Z')
    expect(nextCrons(spec('0 */6 * * *'), at('2026-11-13T10:00:00Z'), 'UTC', 3).map(isoOf)).toEqual(['2026-11-13T12:00:00.000Z', '2026-11-13T18:00:00.000Z', '2026-11-14T00:00:00.000Z'])
  })

  it('fires on a day of month or a day of week when both are given, and on both when one is *', () => {
    // 13th of the month or any Friday: Friday 6 November 2026 comes first.
    expect(isoOf(nextCron(spec('0 9 13 * 5'), at('2026-11-01T00:00:00Z'), 'UTC'))).toBe('2026-11-06T09:00:00.000Z')
    // Every second day that is a Monday: */2 starts with *, so both must match (odd days, Mondays): 2026-11-09 is a Monday, the 9th.
    expect(isoOf(nextCron(spec('0 9 */2 * 1'), at('2026-11-01T00:00:00Z'), 'UTC'))).toBe('2026-11-09T09:00:00.000Z')
    // The 29th of February comes round in a leap year.
    expect(isoOf(nextCron(spec('0 0 29 2 *'), at('2026-11-13T00:00:00Z'), 'UTC'))).toBe('2028-02-29T00:00:00.000Z')
  })

  it('fires a local time the clocks skip once, at the first minute after the gap (London, 29 March 2026)', () => {
    // 01:00 GMT becomes 02:00 BST at 01:00 UTC: 01:30 doesn't exist that day.
    expect(isoOf(cronInstant(2026, 3, 29, 1, 30, 'Europe/London'))).toBe('2026-03-29T01:00:00.000Z')
    expect(isoOf(nextCron(spec('30 1 * * *'), at('2026-03-28T12:00:00Z'), 'Europe/London'))).toBe('2026-03-29T01:00:00.000Z')
    expect(isoOf(nextCron(spec('30 1 * * *'), at('2026-03-29T01:00:00Z'), 'Europe/London'))).toBe('2026-03-30T00:30:00.000Z')
    // Every quarter of the hour from 01:00: all four times fall in the gap and fire once, together.
    const quarter = spec('*/15 1 * * *')
    expect(nextCrons(quarter, at('2026-03-28T12:00:00Z'), 'Europe/London', 3).map(isoOf)).toEqual(['2026-03-29T01:00:00.000Z', '2026-03-30T00:00:00.000Z', '2026-03-30T00:15:00.000Z'])
    // New York skips 02:00–03:00 on 8 March 2026 (07:00 UTC).
    expect(isoOf(nextCron(spec('30 2 * * *'), at('2026-03-07T12:00:00Z'), 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z')
  })

  it('fires a local time the clocks repeat once, the first time (London, 25 October 2026)', () => {
    // 02:00 BST becomes 01:00 GMT at 01:00 UTC: 01:30 happens at 00:30 and again at 01:30 UTC.
    const once = spec('30 1 * * *')
    expect(nextCrons(once, at('2026-10-24T12:00:00Z'), 'Europe/London', 2).map(isoOf)).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z'])
    // Looked at again during the repeated hour (01:10 GMT, the second pass), it doesn't fire again.
    expect(isoOf(nextCron(once, at('2026-10-25T01:10:00Z'), 'Europe/London'))).toBe('2026-10-26T01:30:00.000Z')
    const quarter = spec('*/15 1 * * *')
    expect(nextCrons(quarter, at('2026-10-24T12:00:00Z'), 'Europe/London', 5).map(isoOf)).toEqual([
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T00:15:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T00:45:00.000Z',
      '2026-10-26T01:00:00.000Z'
    ])
  })
})

describe('cron and intervals: the 15-minute floor', () => {
  it('measures the shortest gap on the wall clock, from a day’s last firing to the next day’s first too', () => {
    expect(cronMinGapMinutes(spec('*/15 * * * *'))).toBe(15)
    expect(cronMinGapMinutes(spec('*/10 * * * *'))).toBe(10)
    expect(cronMinGapMinutes(spec('0,5 9 * * *'))).toBe(5)
    expect(cronMinGapMinutes(spec('0 9 * * 1'))).toBe(24 * 60)
    expect(cronMinGapMinutes(spec('55 0,23 * * *'))).toBe(60)
    expect(cronMinGapMinutes(spec('50 23 * * *'))).toBe(24 * 60)
    expect(cronMinGapMinutes(spec('0,50 0,23 * * *'))).toBe(10)
  })

  it('refuses a cron trigger or an interval under the floor, and an interval it can’t read', () => {
    const cron = (expression: string): CronTrigger => ({ kind: 'cron', cron: expression, timezone: 'Europe/London', ...common })
    const every = (e: string): EmployeeTrigger => ({ kind: 'interval', every: e, ...common })
    expect(triggerTimingProblem(cron('*/15 * * * *'))).toBeNull()
    expect(triggerTimingProblem(cron('*/10 * * * *'))).toBe('Trigger 1 would run 10 minutes apart; triggers run at most every 15 minutes.')
    expect(triggerTimingProblem(cron('0 9 * * 1'), undefined, 3)).toBeNull()
    expect(triggerTimingProblem({ ...cron('0 9 * * 1'), timezone: 'Mars/Olympus' })).toMatch(/“Mars\/Olympus” isn’t a time zone name/)
    expect(triggerTimingProblem(every('15m'))).toBeNull()
    expect(triggerTimingProblem(every('10m'))).toBe('Trigger 1 would run 10 minutes apart; triggers run at most every 15 minutes.')
    expect(triggerTimingProblem(every('31d'))).toMatch(/isn’t an interval like 90m/)
    expect(triggerTimingProblem(every('soon'))).toMatch(/“soon” isn’t an interval/)
    expect([intervalMinutes('90m'), intervalMinutes('2h'), intervalMinutes('1d'), intervalMinutes('0m'), intervalMinutes('2 weeks')]).toEqual([90, 120, 1440, undefined, undefined])
  })
})

describe('triggers: the next planned times', () => {
  it('counts an interval from its anchor in its zone, or from 2000-01-01 00:00', () => {
    const t: EmployeeTrigger = { kind: 'interval', every: '90m', anchor: '2026-11-13T09:00', timezone: 'UTC', ...common }
    expect(isoOf(nextFire(t, at('2026-11-13T08:00:00Z')))).toBe('2026-11-13T09:00:00.000Z')
    expect(nextFires(t, at('2026-11-13T10:00:00Z'), 2).map(isoOf)).toEqual(['2026-11-13T10:30:00.000Z', '2026-11-13T12:00:00.000Z'])
    // Every two hours from midnight 2000 UTC: on the even hours.
    expect(isoOf(nextFire({ kind: 'interval', every: '2h', ...common }, at('2026-11-13T10:00:00Z')))).toBe('2026-11-13T12:00:00.000Z')
  })

  it('works out a calendar trigger as today’s schedules do, and stops after a once', () => {
    const weekly: EmployeeTrigger = { kind: 'schedule', recurrence: 'weekly', start_date: '2026-11-14', time: '09:00', timezone: 'Europe/London', weekdays: [1], ...common }
    expect(isoOf(nextFire(weekly, at('2026-11-13T10:00:00Z')))).toBe('2026-11-16T09:00:00.000Z')
    const once: EmployeeTrigger = { kind: 'schedule', recurrence: 'once', start_date: '2026-11-14', time: '09:00', timezone: 'UTC', ...common }
    expect(isoOf(nextFire(once, at('2026-11-13T10:00:00Z')))).toBe('2026-11-14T09:00:00.000Z')
    expect(nextFire(once, at('2026-11-14T09:00:00Z'))).toBeUndefined()
    // An invalid trigger has no next time.
    expect(nextFire({ kind: 'cron', cron: '*/5 * * * *', timezone: 'UTC', ...common }, at('2026-11-13T10:00:00Z'))).toBeUndefined()
  })
})
