// Cron expressions for AI employees' triggers (docs/ai-employees.md §5.1, §8): the five fields (minute, hour, day of
// month, month, day of week), each `*`, a number or a name, a range, a list or a step; the next time an expression fires
// after an instant, on the wall clock of an IANA time zone; and the shortest gap between two firings, for the 15-minute
// floor. Pure and without a dependency: the zone arithmetic is schedule.ts's.
//
// Daylight saving, on the zone's wall clock:
//  - a local time that doesn't exist (the clocks go forward over it) fires once, at the first minute after the gap.
//    Several skipped times collapse into that one firing;
//  - a local time that happens twice (the clocks go back over it) fires once, the first time.
//
// Day of month and day of week combine as classic cron's do: when both are restricted (neither starts with `*`), a day
// matching either fires; otherwise both must match. Day of week 7 is Sunday, as 0 is.
import { createT, type TFunction } from './i18n'
import { offsetMs, wall } from './schedule'

const enT = createT('en')

export type CronFieldName = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek'

interface FieldRule {
  name: CronFieldName
  min: number
  max: number
  // Names a value may be written as (jan, mon), lowercase; index 0 is `min`.
  names?: readonly string[]
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const RULES: readonly FieldRule[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'dayOfWeek', min: 0, max: 7, names: DAY_NAMES }
]

const FIELD_LABEL = {
  minute: 'cron.field.minute',
  hour: 'cron.field.hour',
  dayOfMonth: 'cron.field.dayOfMonth',
  month: 'cron.field.month',
  dayOfWeek: 'cron.field.dayOfWeek'
} as const

/** A parsed expression: each field's values, sorted, and whether its day fields were left open (`*`). */
export interface CronSpec {
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  // 0 (Sunday) to 6.
  weekdays: number[]
  // The day-of-month field starts with `*` (so only the day of week restricts the day), and likewise the day of week.
  anyDay: boolean
  anyWeekday: boolean
}

export type CronParse = { ok: true; spec: CronSpec } | { ok: false; problem: string }

/** One field's values, or a problem in words. */
function parseField(text: string, rule: FieldRule, t: TFunction): number[] | string {
  const field = t(FIELD_LABEL[rule.name])
  const bad = () => t('cron.problem.field', { field, value: text })
  const value = (word: string): number | undefined => {
    if (/^\d+$/.test(word)) return Number(word)
    const at = (rule.names as readonly string[] | undefined)?.indexOf(word.toLowerCase()) ?? -1
    return at >= 0 ? rule.min + at : undefined
  }
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part)
    if (!m) return bad()
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (!Number.isInteger(step) || step < 1) return bad()
    let from: number
    let to: number
    if (m[1] === '*') {
      from = rule.min
      to = rule.name === 'dayOfWeek' ? 6 : rule.max
    } else {
      const [a, b] = m[1].split('-')
      const first = value(a)
      const last = b === undefined ? undefined : value(b)
      if (first === undefined || (b !== undefined && last === undefined)) return bad()
      from = first
      // "5/15" is 5 to the end, every 15; "5" alone is just 5.
      to = last ?? (m[2] === undefined ? first : rule.name === 'dayOfWeek' ? 6 : rule.max)
    }
    for (const n of [from, to]) if (n < rule.min || n > rule.max) return t('cron.problem.range', { field, min: rule.min, max: rule.max, value: part })
    if (from > to) return bad()
    for (let n = from; n <= to; n += step) out.add(rule.name === 'dayOfWeek' && n === 7 ? 0 : n)
  }
  return [...out].sort((a, b) => a - b)
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** Read a five-field cron expression. Problems are in the person's words (`t`). */
export function parseCron(expression: string, t: TFunction = enT): CronParse {
  const text = expression.trim()
  if (!text) return { ok: false, problem: t('cron.problem.empty') }
  const fields = text.split(/\s+/)
  if (fields.length !== 5) return { ok: false, problem: t('cron.problem.fields', { count: fields.length }) }
  const values: number[][] = []
  for (const [i, rule] of RULES.entries()) {
    const parsed = parseField(fields[i], rule, t)
    if (typeof parsed === 'string') return { ok: false, problem: parsed }
    values.push(parsed)
  }
  const [minutes, hours, days, months, weekdays] = values
  const spec: CronSpec = { minutes, hours, days, months, weekdays, anyDay: fields[2].startsWith('*'), anyWeekday: fields[4].startsWith('*') }
  // A day of month no chosen month has ("31 in February") never fires, unless a day of week fires instead.
  if (spec.anyWeekday && !spec.anyDay && !months.some((m) => days.some((d) => d <= DAYS_IN_MONTH[m - 1]))) return { ok: false, problem: t('cron.problem.never') }
  return { ok: true, spec }
}

/** Whether the expression fires on this local date (month 1–12, weekday 0–6). */
function dayMatches(spec: CronSpec, month: number, day: number, weekday: number): boolean {
  if (!spec.months.includes(month)) return false
  const byDay = spec.days.includes(day)
  const byWeekday = spec.weekdays.includes(weekday)
  if (!spec.anyDay && !spec.anyWeekday) return byDay || byWeekday
  return byDay && byWeekday
}

/**
 * The instant a clock in `tz` reads y-m-d h:min, for a cron firing: a time that happens twice is its first instant; one
 * that doesn't exist is the first minute after the gap (the instant the clocks went forward).
 */
export function cronInstant(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const before = offsetMs(guess - 86_400_000, tz)
  const after = offsetMs(guess + 86_400_000, tz)
  const reads = (ms: number) => {
    const w = wall(ms, tz)
    return w.y === y && w.m === m && w.d === d && w.h === h && w.min === min
  }
  const candidates = [...new Set([guess - before, guess - after])].filter(reads)
  if (candidates.length) return Math.min(...candidates)
  // In a gap: the clocks went forward between `guess - after` (still the old offset) and `guess - before` (the new one).
  let lo = guess - after
  let hi = guess - before
  if (hi <= lo) return guess - before
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000
    if (offsetMs(mid, tz) === after) hi = mid
    else lo = mid
  }
  return hi
}

// Search at most this many days ahead: the 29th of February comes round within eight years.
const SEARCH_DAYS = 366 * 8 + 2

/** The first instant after `after` the expression fires at, on the wall clock of `tz`; undefined if none within eight years. */
export function nextCron(spec: CronSpec, after: number, tz: string): number | undefined {
  const start = wall(after, tz)
  let day = Date.UTC(start.y, start.m - 1, start.d)
  for (let i = 0; i < SEARCH_DAYS; i++, day += 86_400_000) {
    const date = new Date(day)
    const y = date.getUTCFullYear()
    const m = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    if (!dayMatches(spec, m, d, date.getUTCDay())) continue
    for (const h of spec.hours) {
      if (i === 0 && h < start.h) continue
      for (const min of spec.minutes) {
        // Only local times after the clock's reading now: a repeated hour isn't fired again on its second pass.
        if (i === 0 && h === start.h && min <= start.min) continue
        const at = cronInstant(y, m, d, h, min, tz)
        if (at > after) return at
      }
    }
  }
  return undefined
}

/** The next `count` firings after `after`, each after the one before. */
export function nextCrons(spec: CronSpec, after: number, tz: string, count: number): number[] {
  const out: number[] = []
  let from = after
  while (out.length < count) {
    const next = nextCron(spec, from, tz)
    if (next === undefined) break
    out.push(next)
    from = next
  }
  return out
}

/**
 * The shortest time between two firings on the wall clock, in minutes: within a day, and from a day's last firing to the
 * next day's first (as if every day fired, which only ever makes it shorter). For the 15-minute floor.
 */
export function cronMinGapMinutes(spec: CronSpec): number {
  const times = spec.hours.flatMap((h) => spec.minutes.map((m) => h * 60 + m)).sort((a, b) => a - b)
  let gap = times[0] + 24 * 60 - times[times.length - 1]
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1])
  return gap
}
