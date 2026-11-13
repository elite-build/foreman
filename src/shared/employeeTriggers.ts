// AI employees' triggers (docs/ai-employees.md §5.1, §8): the `[[triggers]]` of an employee's definition, which start its
// work on a schedule or on an event. Three timed kinds: `cron` (five fields and an IANA time zone), `interval` ("every
// 90m" from an anchor) and `schedule` (today's once, hourly, daily, weekly and monthly, as src/shared/schedule.ts works
// them out); and `event`: a pull request in one of the organization's repositories, its base branch moving, a
// memory change or a Linear assignment, with filters and a debounce. Each says what the run is asked, in which
// repository, and what happens to one that comes while the last is still going (a timed one also to a time Foreman
// missed). Triggers are part of the definition, so of its fingerprint: adding or changing one needs approving again.
//
// Also the per-computer firing state kept in state.json (§12): each trigger's next planned time, whether it is turned
// off here, and its last firings with what became of each. Pure; the service is src/main/employeeTriggers.ts.
import { cronMinGapMinutes, nextCron, parseCron, type CronSpec } from './cron'
import { createT, type TFunction } from './i18n'
import { nextRuns, parseDate, parseTime, specProblem, validTimezone, zonedTime, type ScheduleSpec } from './schedule'
import { globToRegExp } from './sensitive'

const enT = createT('en')

/** No trigger fires more often than this (§8). */
export const TRIGGER_FLOOR_MINUTES = 15
export const MAX_TRIGGERS = 10
export const MAX_TRIGGER_PROMPT = 2000
/** The longest interval: 30 days. */
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60

export type TriggerKind = 'cron' | 'interval' | 'schedule' | 'event'
export const TRIGGER_KINDS: readonly TriggerKind[] = ['cron', 'interval', 'schedule', 'event']
export type TimedKind = Exclude<TriggerKind, 'event'>

/** What an event trigger listens to (§8). */
export type EventSource = 'pull-request' | 'base-moved' | 'memory' | 'linear'
export const EVENT_SOURCES: readonly EventSource[] = ['pull-request', 'base-moved', 'memory', 'linear']

/** A pull request merged, its CI failed on a head, a review was requested, changes were requested, or it was approved. */
export type PullRequestEvent = 'merged' | 'ci-failed' | 'review-requested' | 'changes-requested' | 'approved'
export const PULL_REQUEST_EVENTS: readonly PullRequestEvent[] = ['merged', 'ci-failed', 'review-requested', 'changes-requested', 'approved']
/** An issue was assigned to the account of the repository's Linear connection. */
export type LinearEvent = 'assigned'
export const LINEAR_EVENTS: readonly LinearEvent[] = ['assigned']
const SOURCE_EVENTS: Partial<Record<EventSource, readonly string[]>> = { 'pull-request': PULL_REQUEST_EVENTS, linear: LINEAR_EVENTS }

/** Whose pull requests: anyone's, only those an employee of the organization made (its push or pull request), or people's. */
export type AuthoredBy = 'anyone' | 'employees' | 'people'
export const AUTHORED_BY: readonly AuthoredBy[] = ['anyone', 'employees', 'people']

/** Events within this many seconds of the first coalesce into one run (§8). */
export const DEFAULT_DEBOUNCE_SECONDS = 60
export const MAX_DEBOUNCE_SECONDS = 3600
export const MAX_EVENT_PATHS = 20
export const MAX_GLOB = 200
/** The sources that watch a repository, so name one. */
export const WATCHES_REPO: readonly EventSource[] = ['pull-request', 'base-moved']

/** A firing Foreman missed (it wasn't running, or the employee was paused): skipped, or collapsed into one run. */
export type TriggerMissed = 'skip' | 'run-once'
export const TRIGGER_MISSED: readonly TriggerMissed[] = ['skip', 'run-once']

/**
 * A firing while the trigger's last task is still open, running or waiting: skip it, queue one more behind it (at most
 * one waits), or coalesce (one waits, and each later firing replaces what it asks).
 */
export type TriggerOverlap = 'skip' | 'queue' | 'coalesce'
export const TRIGGER_OVERLAP: readonly TriggerOverlap[] = ['skip', 'queue', 'coalesce']

export type ScheduleRecurrence = ScheduleSpec['recurrence']
export const TRIGGER_RECURRENCES: readonly ScheduleRecurrence[] = ['once', 'hourly', 'daily', 'weekly', 'monthly']

interface TriggerBase {
  // Stable across edits when given (the Edit view gives each new trigger one); otherwise derived from what it says.
  id?: string
  // What the run is asked; absent: work through its responsibilities and report.
  prompt?: string
  // The repository (by name) it works in; absent: its first repository with Write access, else its first with Read. A
  // pull-request or base-moved event trigger watches this repository too, so it names one.
  repo?: string
  overlap: TriggerOverlap
  enabled: boolean
}

interface TriggerCommon extends TriggerBase {
  missed: TriggerMissed
}

export interface CronTrigger extends TriggerCommon {
  kind: 'cron'
  cron: string
  timezone: string
}

export interface IntervalTrigger extends TriggerCommon {
  kind: 'interval'
  // A whole number and a unit: "90m", "2h", "1d".
  every: string
  // The wall-clock time in `timezone` the intervals count from ("2026-11-16T09:00"); absent: 2000-01-01 00:00.
  anchor?: string
  // Absent: UTC.
  timezone?: string
}

export interface ScheduleTrigger extends TriggerCommon {
  kind: 'schedule'
  recurrence: ScheduleRecurrence
  start_date: string
  time: string
  timezone: string
  // weekly: 0 (Sunday) to 6.
  weekdays?: number[]
  // monthly.
  day_of_month?: number
}

/**
 * An event trigger. A source is watched only while an approved employee's enabled trigger needs it; what
 * happened while Foreman was closed fires only as far as the next look shows against the last (main/employeeEvents.ts),
 * and a burst within `debounce` seconds of its first event is one run. A firing Foreman missed doesn't apply, so there is
 * no `missed`.
 */
export interface EventTrigger extends TriggerBase {
  kind: 'event'
  source: EventSource
  // pull-request: which of its events; linear: ["assigned"].
  on?: string[]
  // pull-request: only pull requests whose head branch matches this glob.
  branch?: string
  // pull-request: whose (absent: anyone's).
  authored_by?: AuthoredBy
  // memory: globs inside the memory repository ("memory/org/docs/**").
  paths?: string[]
  // linear: only issues of this team (its key or name), or carrying this label.
  team?: string
  label?: string
  // Seconds: events within this long of the first become one run.
  debounce: number
}

export type TimedTrigger = CronTrigger | IntervalTrigger | ScheduleTrigger
export type EmployeeTrigger = TimedTrigger | EventTrigger

export const isEventTrigger = (trigger: EmployeeTrigger): trigger is EventTrigger => trigger.kind === 'event'
export const isTimedTrigger = (trigger: EmployeeTrigger): trigger is TimedTrigger => trigger.kind !== 'event'

const COMMON_FIELDS = ['kind', 'id', 'prompt', 'repo', 'missed', 'overlap', 'enabled']
const EVENT_FIELDS = ['kind', 'id', 'prompt', 'repo', 'overlap', 'enabled', 'source', 'debounce']
const SOURCE_FIELDS: Record<EventSource, string[]> = {
  'pull-request': ['on', 'branch', 'authored_by'],
  'base-moved': [],
  memory: ['paths'],
  linear: ['on', 'team', 'label']
}
const KIND_FIELDS: Record<TimedKind, string[]> = {
  cron: ['cron', 'timezone'],
  interval: ['every', 'anchor', 'timezone'],
  schedule: ['recurrence', 'start_date', 'time', 'timezone', 'weekdays', 'day_of_month']
}
const TRIGGER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const ANCHOR = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/

type Table = Record<string, unknown>
const isTable = (v: unknown): v is Table => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === null || proto === Object.prototype
}

/** "90m" → 90, "2h" → 120, "1d" → 1440; undefined for anything else. */
export function intervalMinutes(every: string): number | undefined {
  const m = /^(\d{1,6})\s*([mhd])$/.exec(every.trim())
  if (!m) return undefined
  const n = Number(m[1]) * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : 1440)
  return n > 0 ? n : undefined
}

/** A schedule trigger as schedule.ts's cadence. */
export function scheduleSpecOf(trigger: ScheduleTrigger): ScheduleSpec {
  return { recurrence: trigger.recurrence, startDate: trigger.start_date, time: trigger.time, timezone: trigger.timezone, weekdays: trigger.weekdays ?? [], ...(trigger.day_of_month !== undefined ? { dayOfMonth: trigger.day_of_month } : {}) }
}

/**
 * A glob an event trigger matches with (a branch, a memory path): relative, at most MAX_GLOB characters, no "..", no
 * backslash and nothing that isn't printable. Matched as gitignore-style globs are (shared/sensitive.ts), anchored.
 */
export function eventGlobOk(glob: string): boolean {
  const g = glob.trim()
  if (!g || g.length > MAX_GLOB || g.startsWith('/') || g.includes('\\') || /[\u0000-\u001f\u007f]/.test(g)) return false
  return !g.split('/').some((part) => part === '..' || part === '.')
}

/** Whether `value` matches an event glob, from the start: "release/*" is release/1 only, never x/release/1. */
export function eventGlobMatches(glob: string, value: string): boolean {
  return eventGlobOk(glob) && globToRegExp(`/${glob.trim()}`).test(value)
}

/** What is wrong with an event trigger's own fields (its source's), or null. `n` counts from 1, for the person. */
export function eventTriggerProblem(trigger: EventTrigger, t: TFunction = enT, n = 1): string | null {
  const events = SOURCE_EVENTS[trigger.source]
  if (events && !(trigger.on ?? []).length) return t('employees.problem.triggerOn', { n, values: events.join(', ') })
  if (WATCHES_REPO.includes(trigger.source) && !trigger.repo?.trim()) return t('employees.problem.triggerWatchRepo', { n })
  if (trigger.source === 'memory' && !(trigger.paths ?? []).some((p) => p.trim())) return t('employees.problem.triggerPaths', { n })
  for (const glob of [...(trigger.branch !== undefined ? [trigger.branch] : []), ...(trigger.paths ?? [])]) if (!eventGlobOk(glob)) return t('employees.problem.triggerGlob', { n, glob, max: MAX_GLOB })
  if (!Number.isInteger(trigger.debounce) || trigger.debounce < 0 || trigger.debounce > MAX_DEBOUNCE_SECONDS) return t('employees.problem.whole', { field: `triggers[${n}].debounce`, min: 0, max: MAX_DEBOUNCE_SECONDS })
  return null
}

/**
 * What is wrong with one trigger's timing (its kind's fields), or null; an event trigger's fields (its source's), as the
 * Edit view's dialog checks them. `n` counts from 1, for the person.
 */
export function triggerTimingProblem(trigger: EmployeeTrigger, t: TFunction = enT, n = 1): string | null {
  if (trigger.kind === 'event') return eventTriggerProblem(trigger, t, n)
  if (trigger.kind === 'cron') {
    if (!validTimezone(trigger.timezone)) return t('employees.problem.triggerTimezone', { n, timezone: trigger.timezone })
    const parsed = parseCron(trigger.cron, t)
    if (!parsed.ok) return t('employees.problem.triggerCron', { n, problem: parsed.problem })
    const gap = cronMinGapMinutes(parsed.spec)
    if (gap < TRIGGER_FLOOR_MINUTES) return t('employees.problem.triggerFloor', { n, minutes: TRIGGER_FLOOR_MINUTES, gap })
    return null
  }
  if (trigger.kind === 'interval') {
    const minutes = intervalMinutes(trigger.every)
    if (minutes === undefined || minutes > MAX_INTERVAL_MINUTES) return t('employees.problem.triggerEvery', { n, every: trigger.every })
    if (minutes < TRIGGER_FLOOR_MINUTES) return t('employees.problem.triggerFloor', { n, minutes: TRIGGER_FLOOR_MINUTES, gap: minutes })
    if (trigger.timezone !== undefined && !validTimezone(trigger.timezone)) return t('employees.problem.triggerTimezone', { n, timezone: trigger.timezone })
    if (trigger.anchor !== undefined) {
      const m = ANCHOR.exec(trigger.anchor)
      if (!m || !parseDate(m[1]) || !parseTime(m[2])) return t('employees.problem.triggerAnchor', { n, anchor: trigger.anchor })
    }
    return null
  }
  const problem = specProblem(scheduleSpecOf(trigger), t)
  return problem ? t('employees.problem.triggerSchedule', { n, problem }) : null
}

/**
 * Read `[[triggers]]` (absent: none), checked strictly as the rest of the definition is: an unknown field, a wrong type,
 * a value outside its choices, a timing that doesn't parse, one under the 15-minute floor, a repository the employee
 * can't work in (`repos`: its access by repository name) or two triggers with one id each make a problem.
 */
export function parseTriggers(raw: unknown, repos: Record<string, string>, t: TFunction = enT): { triggers: EmployeeTrigger[]; problems: string[] } {
  const problems: string[] = []
  if (raw === undefined) return { triggers: [], problems }
  if (!Array.isArray(raw) || raw.some((x) => !isTable(x))) return { triggers: [], problems: [t('employees.problem.triggers')] }
  if (raw.length > MAX_TRIGGERS) problems.push(t('employees.problem.many', { field: 'triggers', max: MAX_TRIGGERS }))
  const triggers: EmployeeTrigger[] = []
  for (const [i, table] of (raw as Table[]).entries()) {
    const n = i + 1
    const at = (field: string) => `triggers[${n}].${field}`
    const kind = table.kind
    if (typeof kind !== 'string' || !(TRIGGER_KINDS as readonly string[]).includes(kind)) {
      problems.push(kind === undefined ? t('employees.problem.missing', { field: at('kind') }) : t('employees.problem.oneOf', { field: at('kind'), values: TRIGGER_KINDS.join(', ') }))
      continue
    }
    const k = kind as TriggerKind
    const source = k === 'event' && typeof table.source === 'string' && (EVENT_SOURCES as readonly string[]).includes(table.source) ? (table.source as EventSource) : undefined
    const allowed = k === 'event' ? [...EVENT_FIELDS, ...(source ? SOURCE_FIELDS[source] : [])] : [...COMMON_FIELDS, ...KIND_FIELDS[k]]
    for (const key of Object.keys(table)) if (!allowed.includes(key)) problems.push(t('employees.problem.unknown', { field: at(key) }))
    const text = (field: string, required: boolean, max = 200): string | undefined => {
      const value = table[field]
      if (value === undefined) {
        if (required) problems.push(t('employees.problem.missing', { field: at(field) }))
        return undefined
      }
      if (typeof value !== 'string') {
        problems.push(t('employees.problem.text', { field: at(field) }))
        return undefined
      }
      if (value.length > max) problems.push(t('employees.problem.long', { field: at(field), max }))
      return value
    }
    const oneOf = <T extends string>(field: string, values: readonly T[], fallback: T): T => {
      const value = table[field]
      if (value === undefined) return fallback
      if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T
      problems.push(t('employees.problem.oneOf', { field: at(field), values: values.join(', ') }))
      return fallback
    }
    const id = text('id', false, 40)
    if (id !== undefined && !TRIGGER_ID.test(id)) problems.push(t('employees.problem.triggerId', { n }))
    const prompt = text('prompt', false, MAX_TRIGGER_PROMPT)
    const repo = text('repo', false, 200)
    if (repo !== undefined && repo.trim() && (repos[repo.trim()] ?? 'none') === 'none') problems.push(t('employees.problem.triggerRepo', { n, repo: repo.trim() }))
    let enabled = true
    if (table.enabled !== undefined) {
      if (typeof table.enabled === 'boolean') enabled = table.enabled
      else problems.push(t('employees.problem.boolean', { field: at('enabled') }))
    }
    const base = {
      ...(id ? { id } : {}),
      ...(prompt?.trim() ? { prompt } : {}),
      ...(repo?.trim() ? { repo } : {}),
      overlap: oneOf('overlap', TRIGGER_OVERLAP, 'skip'),
      enabled
    }
    if (k === 'event') {
      if (table.source === undefined) problems.push(t('employees.problem.missing', { field: at('source') }))
      else if (!source) problems.push(t('employees.problem.oneOf', { field: at('source'), values: EVENT_SOURCES.join(', ') }))
      let debounce = DEFAULT_DEBOUNCE_SECONDS
      if (table.debounce !== undefined) {
        if (typeof table.debounce === 'number' && Number.isInteger(table.debounce) && table.debounce >= 0 && table.debounce <= MAX_DEBOUNCE_SECONDS) debounce = table.debounce
        else problems.push(t('employees.problem.whole', { field: at('debounce'), min: 0, max: MAX_DEBOUNCE_SECONDS }))
      }
      const list = (field: string, values?: readonly string[]): string[] | undefined => {
        const value = table[field]
        if (value === undefined) return undefined
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          problems.push(t('employees.problem.list', { field: at(field) }))
          return undefined
        }
        const items = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))]
        if (values) for (const v of items) if (!values.includes(v)) problems.push(t('employees.problem.oneOf', { field: at(field), values: values.join(', ') }))
        return items
      }
      if (!source) continue
      const events = SOURCE_EVENTS[source]
      // Linear has one event: absent, it is that one.
      const on = events ? (list('on', events) ?? (source === 'linear' ? ['assigned'] : undefined)) : undefined
      const branch = source === 'pull-request' ? text('branch', false, MAX_GLOB) : undefined
      const authored = source === 'pull-request' && table.authored_by !== undefined ? oneOf('authored_by', AUTHORED_BY, 'anyone') : undefined
      const paths = source === 'memory' ? list('paths') : undefined
      if (paths && paths.length > MAX_EVENT_PATHS) problems.push(t('employees.problem.many', { field: at('paths'), max: MAX_EVENT_PATHS }))
      const team = source === 'linear' ? text('team', false, 100) : undefined
      const label = source === 'linear' ? text('label', false, 100) : undefined
      const trigger: EventTrigger = {
        kind: 'event',
        source,
        ...(on ? { on } : {}),
        ...(branch?.trim() ? { branch: branch.trim() } : {}),
        ...(authored ? { authored_by: authored } : {}),
        ...(paths ? { paths } : {}),
        ...(team?.trim() ? { team: team.trim() } : {}),
        ...(label?.trim() ? { label: label.trim() } : {}),
        debounce,
        ...base
      }
      const problem = eventTriggerProblem(trigger, t, n)
      if (problem) problems.push(problem)
      triggers.push(trigger)
      continue
    }
    const common = { ...base, missed: oneOf('missed', TRIGGER_MISSED, 'skip') }
    let trigger: EmployeeTrigger | undefined
    if (k === 'cron') {
      const cron = text('cron', true)
      const timezone = text('timezone', true, 64)
      if (cron !== undefined && timezone !== undefined) trigger = { kind: 'cron', cron, timezone, ...common }
    } else if (k === 'interval') {
      const every = text('every', true, 20)
      const anchor = text('anchor', false, 20)
      const timezone = text('timezone', false, 64)
      if (every !== undefined) trigger = { kind: 'interval', every, ...(anchor !== undefined ? { anchor } : {}), ...(timezone !== undefined ? { timezone } : {}), ...common }
    } else {
      const recurrence = table.recurrence === undefined ? undefined : oneOf('recurrence', TRIGGER_RECURRENCES, 'daily')
      if (recurrence === undefined) problems.push(t('employees.problem.missing', { field: at('recurrence') }))
      const startDate = text('start_date', true, 10)
      const time = text('time', true, 5)
      const timezone = text('timezone', true, 64)
      let weekdays: number[] | undefined
      if (table.weekdays !== undefined) {
        if (!Array.isArray(table.weekdays) || table.weekdays.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6)) problems.push(t('employees.problem.triggerWeekdays', { n }))
        else weekdays = table.weekdays as number[]
      }
      let dayOfMonth: number | undefined
      if (table.day_of_month !== undefined) {
        if (typeof table.day_of_month !== 'number' || !Number.isInteger(table.day_of_month)) problems.push(t('employees.problem.whole', { field: at('day_of_month'), min: 1, max: 31 }))
        else dayOfMonth = table.day_of_month
      }
      if (recurrence && startDate !== undefined && time !== undefined && timezone !== undefined)
        trigger = { kind: 'schedule', recurrence, start_date: startDate, time, timezone, ...(weekdays ? { weekdays } : {}), ...(dayOfMonth !== undefined ? { day_of_month: dayOfMonth } : {}), ...common }
    }
    if (!trigger || trigger.kind === 'event') continue
    const timing = triggerTimingProblem(trigger, t, n)
    if (timing) problems.push(timing)
    triggers.push(trigger)
  }
  const ids = triggers.map(triggerKey)
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(t('employees.problem.triggerDuplicate', { id }))
  return { triggers, problems }
}

/** A trigger as it is saved: texts trimmed, the prompt with plain line ends, weekdays sorted without repeats. */
export function normalizeTrigger(trigger: EmployeeTrigger): EmployeeTrigger {
  const prompt = trigger.prompt?.replace(/\r\n?/g, '\n').trim()
  const repo = trigger.repo?.trim()
  const base = {
    ...(trigger.id?.trim() ? { id: trigger.id.trim() } : {}),
    ...(prompt ? { prompt } : {}),
    ...(repo ? { repo } : {}),
    overlap: trigger.overlap,
    enabled: trigger.enabled
  }
  if (trigger.kind === 'event') {
    const on = trigger.on ? [...new Set(trigger.on.map((x) => x.trim()).filter(Boolean))] : undefined
    const order = SOURCE_EVENTS[trigger.source]
    if (on && order) on.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const paths = trigger.paths ? [...new Set(trigger.paths.map((x) => x.trim()).filter(Boolean))] : undefined
    return {
      kind: 'event',
      source: trigger.source,
      ...(on && SOURCE_EVENTS[trigger.source] ? { on } : {}),
      ...(trigger.source === 'pull-request' && trigger.branch?.trim() ? { branch: trigger.branch.trim() } : {}),
      ...(trigger.source === 'pull-request' && trigger.authored_by ? { authored_by: trigger.authored_by } : {}),
      ...(trigger.source === 'memory' && paths ? { paths } : {}),
      ...(trigger.source === 'linear' && trigger.team?.trim() ? { team: trigger.team.trim() } : {}),
      ...(trigger.source === 'linear' && trigger.label?.trim() ? { label: trigger.label.trim() } : {}),
      debounce: trigger.debounce,
      ...base
    }
  }
  const common = { ...base, missed: trigger.missed }
  if (trigger.kind === 'cron') return { kind: 'cron', cron: trigger.cron.trim().split(/\s+/).join(' '), timezone: trigger.timezone.trim(), ...common }
  if (trigger.kind === 'interval')
    return {
      kind: 'interval',
      every: trigger.every.replace(/\s+/g, ''),
      ...(trigger.anchor?.trim() ? { anchor: trigger.anchor.trim() } : {}),
      ...(trigger.timezone?.trim() ? { timezone: trigger.timezone.trim() } : {}),
      ...common
    }
  return {
    kind: 'schedule',
    recurrence: trigger.recurrence,
    start_date: trigger.start_date.trim(),
    time: trigger.time.trim(),
    timezone: trigger.timezone.trim(),
    ...(trigger.recurrence === 'weekly' && trigger.weekdays ? { weekdays: [...new Set(trigger.weekdays)].sort((a, b) => a - b) } : {}),
    ...(trigger.recurrence === 'monthly' && trigger.day_of_month !== undefined ? { day_of_month: trigger.day_of_month } : {}),
    ...common
  }
}

/** What an event trigger listens to, as one text (its source and filters). */
export function eventListenKey(trigger: EventTrigger): string {
  return JSON.stringify(['event', trigger.source, [...(trigger.on ?? [])].sort(), trigger.repo?.trim() ?? '', trigger.branch ?? '', trigger.authored_by ?? 'anyone', [...(trigger.paths ?? [])].sort(), trigger.team ?? '', trigger.label ?? '', trigger.debounce])
}

/** The fields that say when a trigger fires, as one text: when it changes, the next planned time is worked out again. */
export function triggerTimingKey(trigger: EmployeeTrigger): string {
  if (trigger.kind === 'event') return eventListenKey(trigger)
  if (trigger.kind === 'cron') return JSON.stringify(['cron', trigger.cron.trim().split(/\s+/).join(' '), trigger.timezone])
  if (trigger.kind === 'interval') return JSON.stringify(['interval', trigger.every.replace(/\s+/g, ''), trigger.anchor ?? '', trigger.timezone ?? 'UTC'])
  return JSON.stringify(['schedule', trigger.recurrence, trigger.start_date, trigger.time, trigger.timezone, trigger.weekdays ?? [], trigger.day_of_month ?? null])
}

/** FNV-1a, 32 bits, as hex: a short stable name for a trigger written without an id. */
function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** A trigger's id: its own, or one derived from its timing, prompt and repository (an edit then makes it a new trigger). */
export function triggerKey(trigger: EmployeeTrigger): string {
  if (trigger.id) return trigger.id
  return `h-${fnv(JSON.stringify([triggerTimingKey(trigger), trigger.prompt?.trim() ?? '', trigger.repo?.trim() ?? '']))}`
}

/** A new trigger id, `t-` and four characters, not in `taken`. */
export function newTriggerId(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken)
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  for (let length = 4; ; length++) {
    for (let attempt = 0; attempt < 32; attempt++) {
      let id = 't-'
      for (let i = 0; i < length; i++) id += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
      if (!used.has(id)) return id
    }
  }
}

const cronCache = new Map<string, CronSpec | null>()
function cronSpec(expression: string): CronSpec | null {
  let spec = cronCache.get(expression)
  if (spec === undefined) {
    const parsed = parseCron(expression)
    spec = parsed.ok ? parsed.spec : null
    if (cronCache.size > 200) cronCache.clear()
    cronCache.set(expression, spec)
  }
  return spec
}

/** The instant an interval counts from: its anchor on the wall clock of its zone, or 2000-01-01 00:00 there. */
function anchorOf(trigger: IntervalTrigger): number {
  const tz = trigger.timezone ?? 'UTC'
  const m = trigger.anchor ? ANCHOR.exec(trigger.anchor) : null
  const date = m ? parseDate(m[1]) : null
  const time = m ? parseTime(m[2]) : null
  return date && time ? zonedTime(date.y, date.m, date.d, time.h, time.min, tz) : zonedTime(2000, 1, 1, 0, 0, tz)
}

/** The first planned time after `after`; undefined when the trigger is invalid, an event trigger, or never fires again (a once that has passed). */
export function nextFire(trigger: EmployeeTrigger, after: number): number | undefined {
  if (trigger.kind === 'event' || triggerTimingProblem(trigger)) return undefined
  if (trigger.kind === 'cron') {
    const spec = cronSpec(trigger.cron)
    return spec ? nextCron(spec, after, trigger.timezone) : undefined
  }
  if (trigger.kind === 'interval') {
    const step = intervalMinutes(trigger.every)! * 60_000
    const anchor = anchorOf(trigger)
    if (after < anchor) return anchor
    return anchor + (Math.floor((after - anchor) / step) + 1) * step
  }
  return nextRuns(scheduleSpecOf(trigger), after, 1)[0]
}

/** The next `count` planned times after `after`. */
export function nextFires(trigger: EmployeeTrigger, after: number, count: number): number[] {
  const out: number[] = []
  let from = after
  while (out.length < count) {
    const next = nextFire(trigger, from)
    if (next === undefined) break
    out.push(next)
    from = next
  }
  return out
}

/** The zone a trigger's times are shown in (an event trigger's: UTC, though it has no times of its own). */
export const triggerZone = (trigger: EmployeeTrigger): string => (trigger.kind === 'event' ? 'UTC' : trigger.kind === 'interval' ? (trigger.timezone ?? 'UTC') : trigger.timezone)

/** An event firing's request id: the employee, the trigger and the identity of the first event it stands for. */
export function eventRequestId(employeeId: string, triggerId: string, eventKey: string): string {
  return `event:${employeeId}:${triggerId}:${eventKey}`.slice(0, 400)
}

/** The task's request id for one firing: the employee, the trigger and the planned minute, so a firing after a crash dedupes. */
export function triggerRequestId(employeeId: string, triggerId: string, plannedAt: number): string {
  return `trigger:${employeeId}:${triggerId}:${new Date(plannedAt).toISOString().slice(0, 16)}`
}

// ---- firing state, per computer (state.json) ----

/** fired: a task was made (or it already existed, after a crash); coalesced: merged into the one waiting; skipped: why below. */
export type TriggerOutcome = 'fired' | 'coalesced' | 'skipped'

/**
 * Why a firing was skipped. missed: Foreman wasn't running (or AI employees were off) at the planned time; draft, changed,
 * retired, invalid: the employee can't run (not approved here, changed since approval, retired, its file has problems);
 * paused: the employee was paused and the trigger skips missed firings (an event's always); overlap: its last task wasn't
 * done; no-repo: there is no repository it may work in; error: something else, in `detail`. An event trigger's too
 *: self, the event was this employee's own work; chain, the chain guard (at most CHAIN_LIMIT event runs per
 * item in CHAIN_WINDOW_MS); no-connection, its repository's Linear connection is missing or can't be used (`detail`).
 */
export type TriggerSkip = 'missed' | 'draft' | 'changed' | 'retired' | 'invalid' | 'paused' | 'overlap' | 'no-repo' | 'error' | 'self' | 'chain' | 'no-connection'
export const TRIGGER_SKIPS: readonly TriggerSkip[] = ['missed', 'draft', 'changed', 'retired', 'invalid', 'paused', 'overlap', 'no-repo', 'error', 'self', 'chain', 'no-connection']

/** One fact of an event, as the task shows it (as data, never instructions). */
export interface EventFact {
  label: string
  value: string
}

/**
 * One event an event trigger heard (main/employeeEvents.ts), kept while it waits out its trigger's debounce. `key` is
 * its identity (a pull request's number, head and event; a base tip; a memory commit; a Linear issue and its state);
 * `items` are what the chain guard counts it against; `byEmployee` names the employee whose work caused it, when known.
 */
export interface EmployeeEvent {
  source: EventSource
  // pull-request: its event; linear: 'assigned'.
  name?: string
  key: string
  // A short name: "#42", "ENG-12", a short commit.
  subject: string
  at: string
  repoId?: string
  orgId?: string
  connectionId?: string
  items: string[]
  branch?: string
  byEmployee?: { employeeId: string; taskId?: string }
  // memory: the paths the commit changed.
  paths?: string[]
  // linear: the issue's team (key and name) and labels.
  team?: string[]
  labels?: string[]
  facts: EventFact[]
}

/** Events waiting out a trigger's debounce: one run for them all once `dueAt` comes. */
export interface EventBatch {
  since: string
  dueAt: string
  events: EmployeeEvent[]
  // More events than a batch keeps came: counted, not listed.
  more?: number
}

/** One firing: when it was planned for, when it was looked at, and what became of it. */
export interface TriggerFiring {
  plannedAt: string
  at: string
  outcome: TriggerOutcome
  skip?: TriggerSkip
  taskId?: string
  // run-once: how many planned times this one run stood for (more than 1 when it collapsed missed ones).
  collapsed?: number
  detail?: string
  // An event firing: what it was for ("#42", "ENG-12"), the first events' names.
  subject?: string
}

/** A trigger's state on this computer. */
export interface EmployeeTriggerState {
  orgId: string
  employeeId: string
  triggerId: string
  // triggerTimingKey when `nextAt` was worked out; '' while it is off.
  timing: string
  // The next planned time (ISO); absent while off, and once a one-time trigger has fired.
  nextAt?: string
  // Turned off on this computer (from the Triggers tab): narrowing only, so turning it on again needs no approval.
  off?: true
  // The last firings, newest last.
  firings: TriggerFiring[]
  // An event trigger's events waiting out its debounce, and the identities of the last events it took (so one event is
  // one firing, whatever looks at it again).
  pending?: EventBatch
  seen?: string[]
}

export const KEEP_FIRINGS = 10
export const KEEP_SEEN = 200
export const MAX_BATCH_EVENTS = 20

const iso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))

/** The states in state.json, checked entry by entry: anything malformed is dropped. */
export function parseTriggerStates(value: unknown): EmployeeTriggerState[] {
  if (!Array.isArray(value)) return []
  const out: EmployeeTriggerState[] = []
  for (const entry of value as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') continue
    const { orgId, employeeId, triggerId, timing, nextAt, off, firings } = entry
    if (typeof orgId !== 'string' || typeof employeeId !== 'string' || typeof triggerId !== 'string' || !orgId || !employeeId || !triggerId) continue
    if (out.some((s) => s.orgId === orgId && s.employeeId === employeeId && s.triggerId === triggerId)) continue
    const kept: TriggerFiring[] = []
    for (const f of Array.isArray(firings) ? (firings as Record<string, unknown>[]) : []) {
      if (!f || typeof f !== 'object' || !iso(f.plannedAt) || !iso(f.at) || !['fired', 'coalesced', 'skipped'].includes(f.outcome as string)) continue
      kept.push({
        plannedAt: f.plannedAt,
        at: f.at,
        outcome: f.outcome as TriggerOutcome,
        ...(typeof f.skip === 'string' && (TRIGGER_SKIPS as readonly string[]).includes(f.skip) ? { skip: f.skip as TriggerSkip } : {}),
        ...(typeof f.taskId === 'string' ? { taskId: f.taskId } : {}),
        ...(typeof f.collapsed === 'number' && Number.isInteger(f.collapsed) && f.collapsed > 1 ? { collapsed: f.collapsed } : {}),
        ...(typeof f.detail === 'string' ? { detail: f.detail } : {}),
        ...(typeof f.subject === 'string' ? { subject: f.subject } : {})
      })
    }
    const pending = parseBatch(entry.pending)
    const seen = Array.isArray(entry.seen) ? (entry.seen as unknown[]).filter((x): x is string => typeof x === 'string').slice(-KEEP_SEEN) : []
    out.push({
      orgId,
      employeeId,
      triggerId,
      timing: typeof timing === 'string' ? timing : '',
      ...(iso(nextAt) ? { nextAt } : {}),
      ...(off === true ? { off: true as const } : {}),
      firings: kept.slice(-KEEP_FIRINGS),
      ...(pending ? { pending } : {}),
      ...(seen.length ? { seen } : {})
    })
  }
  return out
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined)

/** A kept event, checked: anything malformed is dropped. */
export function parseEvent(value: unknown): EmployeeEvent | undefined {
  if (!value || typeof value !== 'object') return undefined
  const e = value as Record<string, unknown>
  if (!(EVENT_SOURCES as readonly unknown[]).includes(e.source) || typeof e.key !== 'string' || typeof e.subject !== 'string' || !iso(e.at)) return undefined
  const facts = Array.isArray(e.facts) ? (e.facts as Record<string, unknown>[]).filter((f) => f && typeof f.label === 'string' && typeof f.value === 'string').map((f) => ({ label: f.label as string, value: f.value as string })) : []
  const by = e.byEmployee as Record<string, unknown> | undefined
  return {
    source: e.source as EventSource,
    ...(typeof e.name === 'string' ? { name: e.name } : {}),
    key: e.key,
    subject: e.subject,
    at: e.at,
    ...(typeof e.repoId === 'string' ? { repoId: e.repoId } : {}),
    ...(typeof e.orgId === 'string' ? { orgId: e.orgId } : {}),
    ...(typeof e.connectionId === 'string' ? { connectionId: e.connectionId } : {}),
    items: strings(e.items) ?? [],
    ...(typeof e.branch === 'string' ? { branch: e.branch } : {}),
    ...(by && typeof by.employeeId === 'string' ? { byEmployee: { employeeId: by.employeeId, ...(typeof by.taskId === 'string' ? { taskId: by.taskId } : {}) } } : {}),
    ...(strings(e.paths) ? { paths: strings(e.paths) } : {}),
    ...(strings(e.team) ? { team: strings(e.team) } : {}),
    ...(strings(e.labels) ? { labels: strings(e.labels) } : {}),
    facts
  }
}

function parseBatch(value: unknown): EventBatch | undefined {
  if (!value || typeof value !== 'object') return undefined
  const b = value as Record<string, unknown>
  if (!iso(b.since) || !iso(b.dueAt) || !Array.isArray(b.events)) return undefined
  const events = (b.events as unknown[]).map(parseEvent).filter((e): e is EmployeeEvent => Boolean(e)).slice(0, MAX_BATCH_EVENTS)
  if (!events.length) return undefined
  return { since: b.since, dueAt: b.dueAt, events, ...(typeof b.more === 'number' && Number.isInteger(b.more) && b.more > 0 ? { more: b.more } : {}) }
}
