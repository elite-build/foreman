// #11 Usage-limit resume: telling a plan-limit error apart from other failures, and reading when the
// limit resets from the error's own words. Pure; the clock and the local time zone are arguments.
// The time is read from the turn's result error only (never from what the agent wrote), and the
// words it came from are kept so the card can quote them. Anything not understood is "unknown".
import type { AgentKind, LimitResume, UsageLimit } from './types'
import { dateInZone, offsetMs, validTimezone } from './schedule'

/** What an armed resume sends (the mock's default). */
export const RESUME_TEXT = 'Continue where you left off.'
/** A resume goes this long after the stated reset time, so a clock a little behind the provider's doesn't hit the limit again. */
export const RESUME_BUFFER_MS = 60_000
/** Agents whose transport carries a reset time Foreman can read. Codex reports `turn.completed` usage only; others say nothing. */
export const READS_RESET_TIME: readonly AgentKind[] = ['claude']

const DAY_MS = 86_400_000
// A weekly limit resets within 7 days; anything much further out is a misreading, not a plan limit.
const MAX_AHEAD_MS = 31 * DAY_MS

// Limits that are about the account's plan or quota, as Claude Code, Codex and the API word them.
const LIMIT_WORDS =
  /usage limit|(?:5-hour|five-hour|session|weekly|daily|monthly|opus|sonnet|plan|spending)\s+limit|limit reached|hit your (?:[\w-]+ )?limit|reached your (?:[\w-]+ )?limit|rate[_ ]limit|spending cap|quota (?:exceeded|reached)|exceeded your (?:current )?quota|429 too many requests/i
// Other "limits" that a later turn won't get past by waiting.
const NOT_PLAN_LIMIT = /context (?:window|limit|length)|prompt is too long|max(?:imum)? (?:number of )?turns|max(?:imum)?[_ ]budget|max_output_tokens|output token/i

/** Whether an error says the account hit a usage, plan or rate limit. */
export function looksLikeUsageLimit(text: string | undefined): boolean {
  if (!text) return false
  return LIMIT_WORDS.test(text) && !NOT_PLAN_LIMIT.test(text)
}

/** A reset time read from an error: the instant, the words it came from, and the zone they named (none: this computer's). */
export interface ResetTime {
  at: number
  source: string
  timeZone?: string
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const WEEKDAY = '(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?'

// After "reset(s)": [today|tomorrow] [weekday] [month day | day month] [year] [at] time [am|pm] [(zone) | zone]
const PHRASE = new RegExp(
  '^(?:(today|tomorrow)[,\\s]+(?:at\\s+)?)?' +
    `(?:${WEEKDAY},?\\s+(?:at\\s+)?)?` +
    `(?:(?:${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH})(?:,?\\s+(\\d{4}))?,?\\s+(?:at\\s+)?)?` +
    '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?(?![\\w:])' +
    '(?:\\s*\\(([^)]{1,40})\\)|\\s+(UTC|GMT|[A-Za-z]+/[A-Za-z_+-]+(?:/[A-Za-z_+-]+)?))?',
  'i'
)
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|[+-]\d{2}:?\d{2})/i
// Claude Code's older form: "Claude AI usage limit reached|1760000000" (epoch seconds; or milliseconds).
const EPOCH = /usage limit reached\s*\|\s*(\d{10}|\d{13})\b/i

/** The instant a clock in `tz` reads y-m-d h:min. Read twice (clocks go back): the later one, so a resume never goes early. Never read (clocks go forward): just after the gap. */
function wallInstant(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const before = offsetMs(guess - DAY_MS, tz)
  const after = offsetMs(guess + DAY_MS, tz)
  const candidates = [...new Set([guess - before, guess - after])].filter((ms) => ms + offsetMs(ms, tz) === guess)
  return candidates.length ? Math.max(...candidates) : guess - before
}

/** The calendar date `days` after y-m-d. */
function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number; weekday: number } {
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), weekday: date.getUTCDay() }
}

function validDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d
}

function zoneOf(written: string | undefined): string | null | undefined {
  if (!written) return undefined
  const zone = written.trim()
  if (/^(?:utc|gmt|z)$/i.test(zone)) return 'UTC'
  return validTimezone(zone) ? zone : null
}

/** The phrase right after one "reset(s)", as an instant, or null when it isn't a time this understands. */
function readPhrase(rest: string, now: number, localZone: string): { at: number; length: number; timeZone?: string } | null {
  const lead = /^(?:\s+(?:at|on|by))?\s*:?\s*/i.exec(rest)![0]
  const text = rest.slice(lead.length)
  const iso = ISO.exec(text)
  if (iso) {
    const [y, mo, d, h, mi, s] = iso.slice(1, 7).map((v) => Number(v ?? 0))
    if (!validDate(y, mo, d) || h > 23 || mi > 59) return null
    const zone = iso[7].toUpperCase()
    const offset = zone === 'Z' || zone === 'UTC' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) * 60_000
    return { at: Date.UTC(y, mo - 1, d, h, mi, s) - offset, length: lead.length + iso[0].length, timeZone: 'UTC' }
  }
  const p = PHRASE.exec(text)
  if (!p) return null
  const [, relDay, weekdayWord, monthA, dayA, dayB, monthB, yearWord, hourWord, minuteWord, ampmWord, zoneParen, zoneBare] = p
  // A bare number ("resets 3") is not a time: it needs am/pm or minutes.
  if (!ampmWord && minuteWord === undefined) return null
  let hour = Number(hourWord)
  const minute = Number(minuteWord ?? 0)
  if (minute > 59) return null
  if (ampmWord) {
    if (hour < 1 || hour > 12) return null
    const pm = ampmWord.toLowerCase().startsWith('p')
    hour = (hour % 12) + (pm ? 12 : 0)
  } else if (hour > 23) return null
  const named = zoneOf(zoneParen ?? zoneBare)
  // Words in brackets that aren't a zone ("(PDT)", "(see /usage)"): the time can't be placed honestly.
  if (named === null) return null
  const zone = named ?? localZone
  const [ty, tm, td] = dateInZone(now, zone).split('-').map(Number)
  let at: number
  const month = monthA ?? monthB
  if (month) {
    const m = MONTHS.indexOf(month.toLowerCase().slice(0, 3)) + 1
    const d = Number(dayA ?? dayB)
    let y = yearWord ? Number(yearWord) : ty
    if (!validDate(y, m, d)) return null
    at = wallInstant(y, m, d, hour, minute, zone)
    // "Jan 2" read in late December is next year's.
    if (!yearWord && at < now - DAY_MS) {
      y += 1
      if (!validDate(y, m, d)) return null
      at = wallInstant(y, m, d, hour, minute, zone)
    }
  } else if (weekdayWord && !relDay) {
    const wanted = WEEKDAYS.indexOf(weekdayWord.toLowerCase().slice(0, 3))
    at = NaN
    for (let i = 0; i <= 7; i++) {
      const day = addDays(ty, tm, td, i)
      if (day.weekday !== wanted) continue
      const candidate = wallInstant(day.y, day.m, day.d, hour, minute, zone)
      if (candidate > now) {
        at = candidate
        break
      }
    }
    if (Number.isNaN(at)) return null
  } else if (relDay) {
    const day = addDays(ty, tm, td, relDay.toLowerCase() === 'tomorrow' ? 1 : 0)
    at = wallInstant(day.y, day.m, day.d, hour, minute, zone)
  } else {
    // A time of day alone: its next occurrence, today or tomorrow on that zone's calendar.
    at = wallInstant(ty, tm, td, hour, minute, zone)
    if (at <= now) {
      const day = addDays(ty, tm, td, 1)
      at = wallInstant(day.y, day.m, day.d, hour, minute, zone)
    }
  }
  return { at, length: lead.length + p[0].length, timeZone: named }
}

/**
 * When the error says the limit resets, read relative to `now` (when the error arrived). `localZone` is
 * this computer's zone, used when the error names none (Claude Code runs here and writes local times).
 * Null when no reset time is stated, or it can't be read without guessing.
 */
export function parseResetTime(text: string | undefined, now: number, localZone: string): ResetTime | null {
  if (!text) return null
  const epoch = EPOCH.exec(text)
  if (epoch) {
    const n = Number(epoch[1])
    const at = epoch[1].length === 13 ? n : n * 1000
    return plausible(at, now) ? { at, source: epoch[0].trim(), timeZone: 'UTC' } : null
  }
  for (const anchor of text.matchAll(/\bresets?\b(?:\s+at\b)?/gi)) {
    const start = anchor.index!
    const rest = text.slice(start + anchor[0].length)
    const read = readPhrase(rest, now, localZone)
    if (!read) continue
    if (!plausible(read.at, now)) return null
    const source = text.slice(start, start + anchor[0].length + read.length).replace(/\s+/g, ' ').trim()
    return { at: read.at, source, ...(read.timeZone ? { timeZone: read.timeZone } : {}) }
  }
  return null
}

const plausible = (at: number, now: number) => Number.isFinite(at) && at > now - 60_000 && at - now <= MAX_AHEAD_MS

/**
 * What a failed turn's error says about a usage limit, or undefined when it isn't one. Only agents in
 * READS_RESET_TIME get a reset time; for the others (and for errors that don't state one) it is unknown.
 */
export function usageLimitOf(agent: AgentKind, error: string | undefined, now: number, localZone: string, detected = false): UsageLimit | undefined {
  if (!detected && !looksLikeUsageLimit(error)) return undefined
  if (!READS_RESET_TIME.includes(agent)) return {}
  const reset = parseResetTime(error, now, localZone)
  return reset ? { resetAt: new Date(reset.at).toISOString(), source: reset.source, ...(reset.timeZone ? { timeZone: reset.timeZone } : {}) } : {}
}

// ---- G4: the SDK's rate_limit_event as a second, labelled source ----

/** The parts of the Claude Agent SDK's `rate_limit_event.rate_limit_info` Foreman reads. */
export interface RateLimitEventInfo {
  status?: string
  // Epoch seconds (milliseconds accepted too).
  resetsAt?: number
  rateLimitType?: string
}

/**
 * A rejected rate-limit event's reset time, or undefined. Only `rejected` (the request was refused at the
 * limit); a warning isn't a limit. `source` is the limit's type ("five_hour"), shown as "from Claude's
 * rate-limit event", never as the error's words.
 */
export function limitFromEvent(info: RateLimitEventInfo | undefined, now: number): UsageLimit | undefined {
  if (!info || info.status !== 'rejected' || typeof info.resetsAt !== 'number' || !Number.isFinite(info.resetsAt)) return undefined
  const at = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt
  if (!plausible(at, now)) return undefined
  return { resetAt: new Date(at).toISOString(), source: info.rateLimitType || 'rate_limit_event', timeZone: 'UTC', from: 'event' }
}

/**
 * A failed Claude turn's limit, from its error and the last rate-limit event. The error's own words win;
 * the event fills in the time only when they state none. A rejected event alone marks a failure as a limit.
 */
export function claudeLimit(errorText: string, status: number | null | undefined, event: RateLimitEventInfo | undefined, now: number, localZone: string): UsageLimit | undefined {
  const fromEvent = limitFromEvent(event, now)
  const detected = status === 429 || looksLikeUsageLimit(errorText) || event?.status === 'rejected'
  if (!detected) return undefined
  const fromError = usageLimitOf('claude', errorText, now, localZone, true) ?? {}
  return fromError.resetAt ? fromError : (fromEvent ?? fromError)
}

/** What the limit part of a failed turn's card shows. */
export type LimitCardView =
  | { kind: 'none' }
  // No time: the agent's transport doesn't carry one (`stated` false), or this error didn't state one.
  | { kind: 'unknown'; stated: boolean }
  // The checkbox: unticked, or ticked when armed.
  | { kind: 'offer'; resetAt: number; source: string; armed: boolean; from?: 'event' }
  // The time and its source, with nothing to tick (an older turn, the chat moved on, or the time has passed).
  | { kind: 'source'; resetAt: number; source: string; passed: boolean; from?: 'event' }
  // Its time came while Foreman was closed or the computer asleep, or the send failed: it asks.
  | { kind: 'missed'; resume: LimitResume }

/** Which limit card a turn-end gets. `canAct`: it's the latest turn of an idle chat that can send. */
export function limitCardView(
  turn: { turnId: string; limit?: UsageLimit },
  session: { agent: AgentKind; limitResume?: LimitResume },
  canAct: boolean,
  now: number
): LimitCardView {
  const limit = turn.limit
  if (!limit) return { kind: 'none' }
  const resume = session.limitResume?.turnId === turn.turnId ? session.limitResume : undefined
  if (resume?.missed) return { kind: 'missed', resume }
  if (!READS_RESET_TIME.includes(session.agent)) return { kind: 'unknown', stated: false }
  if (!limit.resetAt || !limit.source) return { kind: 'unknown', stated: true }
  const resetAt = Date.parse(limit.resetAt)
  // G4: a time from the rate-limit event says so instead of quoting the error.
  const from = limit.from ? { from: limit.from } : {}
  if (resume) return { kind: 'offer', resetAt, source: limit.source, armed: true, ...from }
  const passed = resetAt <= now
  return canAct && !passed ? { kind: 'offer', resetAt, source: limit.source, armed: false, ...from } : { kind: 'source', resetAt, source: limit.source, passed, ...from }
}

/** "14:30", on a 24-hour clock in this computer's zone (as the mock shows). */
export function clockTime(ms: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(ms))
}

/** Which local day `ms` falls on, from `now`: today, tomorrow, or a short date ("Thu 23 Oct"). */
export function dayOf(ms: number, now: number, locale?: string, timeZone?: string): 'today' | 'tomorrow' | string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  const target = dateInZone(ms, zone)
  const today = dateInZone(now, zone)
  if (target === today) return 'today'
  const [y, m, d] = today.split('-').map(Number)
  const next = addDays(y, m, d, 1)
  if (target === `${next.y}-${String(next.m).padStart(2, '0')}-${String(next.d).padStart(2, '0')}`) return 'tomorrow'
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone }).format(new Date(ms))
}
