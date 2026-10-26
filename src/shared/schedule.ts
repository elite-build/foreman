// Scheduled templates (R-5): wall-clock times in an IANA time zone, worked out without a
// library. Everything here is pure; the clock is always an argument.
import { createT, type Locale, type TFunction } from './i18n'
import type { Schedule } from './types'

const enT = createT('en')

export const MAX_DURATION_CHOICES = [15, 30, 60, 120, 240] as const
export const DEFAULT_MAX_MINUTES = 30
/** A run later than this after its planned time is "missed" and skipped, never replayed. */
export const MISSED_GRACE_MS = 5 * 60_000
/** At most this many scheduled runs at once across all schedules. */
export const GLOBAL_ACTIVE_CAP = 2
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export interface ScheduleSpec {
  recurrence: Schedule['recurrence']
  startDate: string
  weekdays: number[]
  dayOfMonth?: number
  time: string
  timezone: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function parts(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(tz, f)
  }
  return f
}

interface Wall {
  y: number
  m: number
  d: number
  h: number
  min: number
  s: number
}

/** The wall-clock reading in `tz` at this instant. */
function wall(ms: number, tz: string): Wall {
  const out: Record<string, number> = {}
  for (const p of parts(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value)
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, min: out.minute, s: out.second }
}

/** Calendar date at an instant in the selected time zone. */
export function dateInZone(ms: number, tz: string): string {
  const { y, m, d } = wall(ms, tz)
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** How far `tz` is ahead of UTC at this instant, in ms. */
export function offsetMs(ms: number, tz: string): number {
  const w = wall(ms, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant at which a clock in `tz` reads y-m-d h:min. A time that happens twice (clocks go back) takes the
 * first; one that doesn't exist (clocks go forward) runs as if the clock had already moved, so it lands just after the gap.
 */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const before = offsetMs(guess - 86_400_000, tz)
  const after = offsetMs(guess + 86_400_000, tz)
  const reads = (ms: number) => {
    const w = wall(ms, tz)
    return w.y === y && w.m === m && w.d === d && w.h === h && w.min === min
  }
  const candidates = [...new Set([guess - before, guess - after])].filter(reads)
  if (candidates.length) return Math.min(...candidates)
  return guess - before
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return /\//.test(tz) || tz === 'UTC'
  } catch {
    return false
  }
}

export const parseTime = (time: string): { h: number; min: number } | null => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  return m ? { h: Number(m[1]), min: Number(m[2]) } : null
}

export const parseDate = (date: string): { y: number; m: number; d: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const [y, m, d] = match.slice(1).map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() + 1 === m && parsed.getUTCDate() === d ? { y, m, d } : null
}

/** What is wrong with this cadence, or null. */
export function specProblem(spec: ScheduleSpec, t: TFunction = enT): string | null {
  if (!['once', 'hourly', 'daily', 'weekly', 'monthly'].includes(spec.recurrence)) return t('schedule.problem.recurrence')
  if (!parseDate(spec.startDate)) return t('schedule.problem.startDate')
  if (spec.recurrence === 'weekly' && (!spec.weekdays.length || spec.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) return t('schedule.problem.weekday')
  if (spec.recurrence === 'monthly' && (!Number.isInteger(spec.dayOfMonth) || spec.dayOfMonth! < 1 || spec.dayOfMonth! > 31)) return t('schedule.problem.dayOfMonth')
  if (!parseTime(spec.time)) return t('schedule.problem.time')
  if (!validTimezone(spec.timezone)) return t('schedule.problem.timezone', { timezone: spec.timezone })
  return null
}

/** The next `count` run times after `after`; hourly uses elapsed time, other repeats use the local wall clock. */
export function nextRuns(spec: ScheduleSpec, after: number, count: number): number[] {
  if (specProblem(spec) || count <= 0) return []
  const { h, min } = parseTime(spec.time)!
  const date = parseDate(spec.startDate)!
  const first = zonedTime(date.y, date.m, date.d, h, min, spec.timezone)
  if (spec.recurrence === 'once') return first > after ? [first] : []
  if (spec.recurrence === 'hourly') {
    const hour = 60 * 60_000
    const index = Math.max(0, Math.floor((after - first) / hour) + 1)
    return Array.from({ length: count }, (_, i) => first + (index + i) * hour)
  }

  const out: number[] = []
  const afterWall = wall(after, spec.timezone)
  if (spec.recurrence === 'monthly') {
    const startMonth = Math.max(date.y * 12 + date.m - 1, afterWall.y * 12 + afterWall.m - 1)
    for (let i = 0; out.length < count && i < count + 2; i++) {
      const month = startMonth + i
      const y = Math.floor(month / 12)
      const m = month % 12 + 1
      const d = Math.min(spec.dayOfMonth!, new Date(Date.UTC(y, m, 0)).getUTCDate())
      const at = zonedTime(y, m, d, h, min, spec.timezone)
      if (at >= first && at > after) out.push(at)
    }
    return out
  }

  const startDay = Math.max(Date.UTC(date.y, date.m - 1, date.d), Date.UTC(afterWall.y, afterWall.m - 1, afterWall.d))
  for (let i = 0; out.length < count && i <= 7 * (count + 1); i++) {
    const day = new Date(startDay + i * 86_400_000)
    if (spec.recurrence === 'weekly' && !spec.weekdays.includes(day.getUTCDay())) continue
    const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, min, spec.timezone)
    if (at >= first && at > after) out.push(at)
  }
  return out
}

/** "Mon 26 Oct · 09:00 PDT"; other languages get their own date form, in the same zone. */
export function formatRun(ms: number, tz: string, locale: Locale = 'en'): string {
  if (locale !== 'en') return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(new Date(ms))
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.weekday} ${p.day} ${p.month} · ${p.hour}:${p.minute} ${p.timeZoneName}`
}

/** "Mon 09:00 PDT": the pill on Home. */
export function formatShort(ms: number, tz: string): string {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.weekday} ${p.hour}:${p.minute} ${p.timeZoneName}`
}

export interface RunPreview {
  at: number
  label: string
  // Set when the clock's offset from UTC differs from the run before it.
  note?: string
}

/** The next runs for the dialog, with a note where daylight saving changes the offset. */
export function previewRuns(spec: ScheduleSpec, after: number, count = 3, t: TFunction = enT, locale: Locale = 'en'): RunPreview[] {
  let previous: number | undefined
  return nextRuns(spec, after, count).map((at) => {
    const offset = offsetMs(at, spec.timezone)
    const note = previous !== undefined && previous !== offset ? t('schedule.preview.afterDst') : undefined
    previous = offset
    return { at, label: formatRun(at, spec.timezone, locale), note }
  })
}

export type DueAction = 'wait' | 'run' | 'missed'

/** A planned run that is not due yet, due now (still on time), or too late to run. */
export function dueAction(plannedAt: number, now: number, graceMs = MISSED_GRACE_MS): DueAction {
  if (now < plannedAt) return 'wait'
  return now - plannedAt <= graceMs ? 'run' : 'missed'
}

export const specOf = (s: Schedule): ScheduleSpec => ({ recurrence: s.recurrence, startDate: s.startDate, weekdays: s.weekdays, dayOfMonth: s.dayOfMonth, time: s.time, timezone: s.timezone })

/** A weekday's short name (0 is Sunday): "Mon" in English, the language's own otherwise. */
export function weekdayShort(day: number, locale: Locale = 'en'): string {
  if (locale === 'en') return WEEKDAY_NAMES[day].slice(0, 3)
  // 1 January 2023 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + day)))
}

export function weekdaysText(days: number[], t: TFunction = enT, locale: Locale = 'en'): string {
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  if (sorted.length === 7) return t('schedule.weekdays.everyDay')
  if (sorted.length === 5 && sorted.every((d) => d >= 1 && d <= 5)) return t('schedule.weekdays.weekdays')
  return sorted.map((d) => weekdayShort(d, locale)).join(', ')
}
