// Limits that recover (docs/agents.md section 7, #131): what each account of an agent reports about its usage
// windows, read from the agents' own events (Claude's rate_limit_event, Codex's account/rateLimits notifications),
// and the sentences the Usage page and the paused chat build from them. Pure: the clock is an argument.
// Nothing here calls an agent; an agent that reports nothing has no windows ("This agent doesn't report its limits").
import { staticCapabilities } from './agentCatalog'
import { accountMoveGuess, DEFAULT_MOVE_RULE, instancesFor, takesInstances, type AgentInstance, type MoveRule } from './agentInstances'
import type { AgentKind, UsageLimit } from './types'
import { looksLikeUsageLimit, usageLimitOf } from './usageLimit'

/** A window at or above this share of its limit is a warning (the Usage page's "Close to the limit"). */
export const WARN_PERCENT = 80

export type LimitWindowKind = 'session' | 'weekly' | 'model-weekly' | 'other'
export type LimitWindowState = 'ok' | 'warning' | 'blocked'

/** One usage window of one account. `label` names the model of a model-weekly window, or the other limit. */
export interface LimitWindow {
  kind: LimitWindowKind
  label?: string
  usedPercent?: number
  resetsAt?: string
  state: LimitWindowState
}

/** What one account (`instance` absent: the agent's default account) last reported. */
export interface AccountLimits {
  agent: AgentKind
  instance?: string
  windows: LimitWindow[]
  updatedAt: string
}

/** Whether the agent's record says it reports usage windows (`usage.limitWindows`). */
export function reportsLimitWindows(agent: string): boolean {
  return staticCapabilities(agent)?.usage.limitWindows === true
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, n))
const epochMs = (n: number) => (n < 1e12 ? n * 1000 : n)
const iso = (ms: number) => new Date(ms).toISOString()

/** Blocked at the limit (or when the agent says it refused), a warning from WARN_PERCENT up, else ok. */
export function windowState(usedPercent: number | undefined, refused = false): LimitWindowState {
  if (refused || (usedPercent !== undefined && usedPercent >= 100)) return 'blocked'
  return usedPercent !== undefined && usedPercent >= WARN_PERCENT ? 'warning' : 'ok'
}

// ---- Claude ----

/** The parts of the SDK's `rate_limit_event.rate_limit_info` the windows read. */
export interface ClaudeRateLimitInfo {
  status?: string
  resetsAt?: number
  rateLimitType?: string
  // The SDK doesn't say its unit. Recorded traffic (Claude Code 2.1.301) sends a fraction (0.02), so a value of 1 or
  // less is read as one and more as a percentage.
  utilization?: number
  // Not in the SDK's types, but Claude Code 2.1.301 sends it: every window the account has, by the same type names.
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>
}

/**
 * Every window one Claude `rate_limit_event` reports: the whole `unifiedWindows` map when the CLI sends it, else the
 * event's own window. The event's status (refused, warning) belongs to its own `rateLimitType` only.
 */
export function claudeWindows(info: ClaudeRateLimitInfo | undefined): LimitWindow[] {
  if (!info) return []
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? Object.entries(info.unifiedWindows) : []
  if (unified.length === 0) {
    const one = claudeWindow(info)
    return one ? [one] : []
  }
  const out: LimitWindow[] = []
  for (const [type, value] of unified) {
    if (!value) continue
    const own = type === info.rateLimitType
    const window = claudeWindow({ status: own ? info.status : 'allowed', rateLimitType: type, utilization: value.utilization, resetsAt: value.resetsAt ?? (own ? info.resetsAt : undefined) })
    if (window) out.push(window)
  }
  return out
}

const percentOf = (utilization: unknown): number | undefined => {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) return undefined
  return clampPercent(Math.round(utilization <= 1 ? utilization * 100 : utilization))
}

/**
 * The window one Claude `rate_limit_event` reports, by its `rateLimitType`: five_hour is the session, seven_day the
 * weekly window, seven_day_opus and seven_day_sonnet a weekly window of that model, overage the extra-usage pool.
 * Undefined for an event of a type this doesn't know (it still reaches `limitFromEvent`'s rejected path).
 */
export function claudeWindow(info: ClaudeRateLimitInfo | undefined): LimitWindow | undefined {
  if (!info) return undefined
  const refused = info.status === 'rejected'
  const used = percentOf(info.utilization) ?? (refused ? 100 : undefined)
  let shape: Pick<LimitWindow, 'kind' | 'label'>
  switch (info.rateLimitType) {
    case 'five_hour':
      shape = { kind: 'session' }
      break
    case 'seven_day':
    case 'seven_day_overage_included':
      shape = { kind: 'weekly' }
      break
    case 'seven_day_opus':
      shape = { kind: 'model-weekly', label: 'Opus' }
      break
    case 'seven_day_sonnet':
      shape = { kind: 'model-weekly', label: 'Sonnet' }
      break
    case 'overage':
      shape = { kind: 'other', label: 'overage' }
      break
    default:
      return undefined
  }
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? iso(epochMs(info.resetsAt)) : undefined
  // A warning status without a number is still a warning.
  const state = windowState(used, refused)
  return { ...shape, ...(used !== undefined ? { usedPercent: used } : {}), ...(resetsAt ? { resetsAt } : {}), state: state === 'ok' && info.status === 'allowed_warning' ? 'warning' : state }
}

// ---- Codex ----

/** `RateLimitWindow` of the app-server's protocol (v2). */
export interface CodexRateWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

/** `RateLimitSnapshot`: the fields the windows read. */
export interface CodexRateSnapshot {
  limitId?: string | null
  limitName?: string | null
  primary?: CodexRateWindow | null
  secondary?: CodexRateWindow | null
  rateLimitReachedType?: string | null
}

// A window of up to six hours is a session window; one of six days or more is weekly; anything else is named by its length.
const SESSION_MAX_MINS = 6 * 60
const WEEKLY_MIN_MINS = 6 * 24 * 60

function codexWindow(w: CodexRateWindow | null | undefined, extra: { model?: string; refused: boolean }): LimitWindow | undefined {
  if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return undefined
  const used = clampPercent(Math.round(w.usedPercent))
  const mins = w.windowDurationMins
  const weekly = typeof mins === 'number' && mins >= WEEKLY_MIN_MINS
  const session = typeof mins === 'number' && mins > 0 && mins <= SESSION_MAX_MINS
  // A bucket of one model (limitName) is that model's own limit; its weekly window is a model-weekly one.
  const shape: Pick<LimitWindow, 'kind' | 'label'> = extra.model
    ? { kind: weekly ? 'model-weekly' : 'other', label: extra.model }
    : weekly
      ? { kind: 'weekly' }
      : session
        ? { kind: 'session' }
        : { kind: 'other', label: typeof mins === 'number' && mins > 0 ? `${mins} min` : undefined }
  const resetsAt = typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? iso(epochMs(w.resetsAt)) : undefined
  return { ...shape, usedPercent: used, ...(resetsAt ? { resetsAt } : {}), state: windowState(used, extra.refused && used >= 100) }
}

/**
 * The windows of a Codex rate-limit snapshot: its primary and secondary windows, by duration (a 5-hour window is the
 * session, a weekly one weekly). `model` names the bucket when it is one model's own limit.
 */
export function codexWindows(snapshot: CodexRateSnapshot | null | undefined, model?: string): LimitWindow[] {
  if (!snapshot) return []
  const refused = Boolean(snapshot.rateLimitReachedType)
  const named = model ?? undefined
  return [codexWindow(snapshot.primary, { model: named, refused }), codexWindow(snapshot.secondary, { model: named, refused })].filter((w): w is LimitWindow => Boolean(w))
}

/** What `account/rateLimits/read` answers (the fields the windows read). */
export interface CodexRateLimitsRead {
  rateLimits?: CodexRateSnapshot | null
  rateLimitsByLimitId?: Record<string, CodexRateSnapshot | undefined> | null
}

/** Every window of an `account/rateLimits/read` answer: the main snapshot, then each other bucket that names a model. */
export function codexWindowsFromRead(read: CodexRateLimitsRead | null | undefined): LimitWindow[] {
  if (!read) return []
  const main = read.rateLimits ?? undefined
  const out = codexWindows(main)
  for (const [id, snapshot] of Object.entries(read.rateLimitsByLimitId ?? {})) {
    if (!snapshot || (main?.limitId && id === main.limitId)) continue
    if (snapshot.limitName) out.push(...codexWindows(snapshot, snapshot.limitName))
  }
  return out
}

// ---- keeping them ----

const keyOf = (w: Pick<LimitWindow, 'kind' | 'label'>) => `${w.kind}:${w.label ?? ''}`

/** `incoming` over what was known: a window replaces the one of its kind and label; the others stay. */
export function mergeWindows(known: LimitWindow[], incoming: LimitWindow[]): LimitWindow[] {
  const merged = new Map(known.map((w) => [keyOf(w), w]))
  for (const w of incoming) merged.set(keyOf(w), w)
  return [...merged.values()]
}

/** A window whose reset time has passed no longer says anything about now: it is ok, with no figure, until the agent reports again. */
export function settleWindow(w: LimitWindow, now: number): LimitWindow {
  if (!w.resetsAt || Date.parse(w.resetsAt) > now) return w
  return { kind: w.kind, ...(w.label ? { label: w.label } : {}), state: 'ok' }
}

const RANK: Record<LimitWindowState, number> = { blocked: 2, warning: 1, ok: 0 }

/** Tightest first: blocked, then warning, then by how full, then session before weekly. */
export function tightestFirst(windows: LimitWindow[]): LimitWindow[] {
  const order: Record<LimitWindowKind, number> = { session: 0, weekly: 1, 'model-weekly': 2, other: 3 }
  return [...windows].sort((a, b) => RANK[b.state] - RANK[a.state] || (b.usedPercent ?? -1) - (a.usedPercent ?? -1) || order[a.kind] - order[b.kind])
}

/** The account's tightest window state, after settling windows whose time passed. */
export function accountState(account: Pick<AccountLimits, 'windows'>, now: number): LimitWindowState {
  return account.windows.map((w) => settleWindow(w, now).state).reduce<LimitWindowState>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok')
}

/** When a blocked account can work again: the latest reset among its blocked windows (all of them have to reset), or undefined when none says. */
export function blockedUntil(account: Pick<AccountLimits, 'windows'>, now: number): number | undefined {
  const times = account.windows.filter((w) => settleWindow(w, now).state === 'blocked').map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN))
  if (!times.length || times.some(Number.isNaN)) return undefined
  return Math.max(...times)
}

/** The account's entry in the list, or undefined. */
export function limitsOf(limits: AccountLimits[] | undefined, agent: AgentKind, instance: string | undefined): AccountLimits | undefined {
  return limits?.find((l) => l.agent === agent && (l.instance ?? '') === (instance ?? ''))
}

/** `limits` with this account's windows merged in (and its time stamped), as a new list; unchanged when nothing differs. */
export function withWindows(limits: AccountLimits[], agent: AgentKind, instance: string | undefined, windows: LimitWindow[], now: number, replace = false): AccountLimits[] {
  const known = limitsOf(limits, agent, instance)
  const next = replace ? windows : mergeWindows(known?.windows ?? [], windows)
  if (known && JSON.stringify(known.windows) === JSON.stringify(next)) return limits
  const entry: AccountLimits = { agent, ...(instance ? { instance } : {}), windows: next, updatedAt: iso(now) }
  return known ? limits.map((l) => (l === known ? entry : l)) : [...limits, entry]
}

/** A limit read from windows the account reported: the blocked window that resets last, as the paused chat's reset time. Undefined when none is blocked or none says when. */
export function limitFromWindows(windows: LimitWindow[], now: number): UsageLimit | undefined {
  const blocked = windows.filter((w) => w.state === 'blocked' && w.resetsAt && Date.parse(w.resetsAt) > now - 60_000)
  if (!blocked.length) return undefined
  const last = blocked.reduce((a, b) => (Date.parse(b.resetsAt!) > Date.parse(a.resetsAt!) ? b : a))
  // The same words the card knows for a rate-limit event's type.
  const source = last.kind === 'session' ? 'five_hour' : last.kind === 'other' ? 'rate_limit_event' : 'seven_day'
  return { resetAt: last.resetsAt!, source, timeZone: 'UTC', from: 'event' }
}

// ---- the pooled sentence ----

export interface PooledAccount {
  // The account's label ("Work"), or the agent's default account's.
  label: string
  instance?: string
  state: LimitWindowState | 'unknown'
  // When it can work again, for a blocked one that said.
  until?: number
}

export interface PooledView {
  accounts: PooledAccount[]
  tone: 'ok' | 'warn' | 'error' | 'off'
  blocked: number
}

/** One agent's accounts pooled, tightest first: the Usage page says it as a sentence with a status (percentages of two accounts don't add up). */
export function pooled(accounts: { label: string; instance?: string; limits?: AccountLimits }[], now: number): PooledView {
  const rows: PooledAccount[] = accounts.map((a) => {
    if (!a.limits || !a.limits.windows.length) return { label: a.label, ...(a.instance ? { instance: a.instance } : {}), state: 'unknown' }
    const until = blockedUntil(a.limits, now)
    return { label: a.label, ...(a.instance ? { instance: a.instance } : {}), state: accountState(a.limits, now), ...(until !== undefined ? { until } : {}) }
  })
  const rank = (s: PooledAccount['state']) => (s === 'unknown' ? -1 : RANK[s])
  rows.sort((a, b) => rank(b.state) - rank(a.state))
  const blocked = rows.filter((r) => r.state === 'blocked').length
  const tone = blocked ? 'error' : rows.some((r) => r.state === 'warning') ? 'warn' : rows.every((r) => r.state === 'unknown') ? 'off' : 'ok'
  return { accounts: rows, tone, blocked }
}

// ---- continue on another account ----

/**
 * The accounts a paused chat could continue on (docs/agents.md 7.2): another account of the same agent whose windows
 * show none blocked, that the agent's move rule allows. An account that never reported isn't offered: nothing says it has room.
 * `allowed` is the move rule's own answer (`accountMoveGuess` in the window, the session service's in main).
 */
export function continueAccounts(
  accounts: { label: string; instance?: string }[],
  current: string | undefined,
  limits: AccountLimits[] | undefined,
  agent: AgentKind,
  now: number,
  allowed: (to: string | undefined) => boolean
): { label: string; instance?: string }[] {
  return accounts.filter((a) => {
    if ((a.instance ?? '') === (current ?? '')) return false
    const known = limitsOf(limits, agent, a.instance)
    if (!known?.windows.length || accountState(known, now) === 'blocked') return false
    return allowed(a.instance)
  })
}

// ---- reading what state.json kept ----

const KINDS: readonly LimitWindowKind[] = ['session', 'weekly', 'model-weekly', 'other']
const STATES: readonly LimitWindowState[] = ['ok', 'warning', 'blocked']
// Windows an account can report: a handful. Anything past this is a corrupt file.
const MAX_WINDOWS = 12

function parseWindow(value: unknown): LimitWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const w = value as Record<string, unknown>
  if (!KINDS.includes(w.kind as LimitWindowKind) || !STATES.includes(w.state as LimitWindowState)) return undefined
  const used = typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? clampPercent(w.usedPercent) : undefined
  const resetsAt = typeof w.resetsAt === 'string' && Number.isFinite(Date.parse(w.resetsAt)) ? w.resetsAt : undefined
  const label = typeof w.label === 'string' && w.label.trim() ? w.label.slice(0, 60) : undefined
  return { kind: w.kind as LimitWindowKind, ...(label ? { label } : {}), ...(used !== undefined ? { usedPercent: used } : {}), ...(resetsAt ? { resetsAt } : {}), state: w.state as LimitWindowState }
}

/** `state.json`'s `limits`, checked entry by entry: what a hand edit or an older version left malformed is dropped. */
export function parseAccountLimits(value: unknown): AccountLimits[] {
  if (!Array.isArray(value)) return []
  const out: AccountLimits[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e.agent !== 'string' || !Array.isArray(e.windows) || typeof e.updatedAt !== 'string' || !Number.isFinite(Date.parse(e.updatedAt))) continue
    const windows = e.windows.slice(0, MAX_WINDOWS).map(parseWindow).filter((w): w is LimitWindow => Boolean(w))
    const instance = typeof e.instance === 'string' && e.instance ? e.instance : undefined
    out.push({ agent: e.agent as AgentKind, ...(instance ? { instance } : {}), windows, updatedAt: e.updatedAt })
  }
  return out
}

// ---- a Codex turn that failed at a limit ----

/**
 * A failed Codex turn's usage limit, or undefined when it isn't one. The error's own words win when they state a time;
 * otherwise the blocked window the turn's rate-limit notifications reported says when it resets. Words that say limit with
 * no time anywhere are a limit with an unknown reset (the card then offers a time and sends nothing by itself).
 */
export function codexLimit(errorText: string | undefined, windows: LimitWindow[], now: number, localZone: string): UsageLimit | undefined {
  const fromWindows = limitFromWindows(windows, now)
  if (!fromWindows && !looksLikeUsageLimit(errorText)) return undefined
  const fromError = usageLimitOf('codex', errorText, now, localZone, true) ?? {}
  return fromError.resetAt ? fromError : (fromWindows ?? fromError)
}

/** What the window and the phone offer on a paused chat: the other accounts it could continue on, labelled (docs/agents.md 7.2). */
export function continueOptions(
  session: { agent: AgentKind; instanceId?: string; agentSessionId?: string },
  settings: { agentInstances?: AgentInstance[]; agentPrefs?: Partial<Record<string, { moveChats?: MoveRule }>> },
  limits: AccountLimits[] | undefined,
  now: number,
  defaultLabel: string
): { instance?: string; label: string }[] {
  if (!takesInstances(session.agent)) return []
  const instances = instancesFor(settings.agentInstances, session.agent)
  if (!instances.length) return []
  const rule = settings.agentPrefs?.[session.agent]?.moveChats ?? DEFAULT_MOVE_RULE
  const accounts = [{ label: defaultLabel }, ...instances.map((i) => ({ instance: i.id, label: i.label }))]
  return continueAccounts(accounts, session.instanceId, limits, session.agent, now, (to) => accountMoveGuess(settings.agentInstances, session.agent, session.instanceId, to, rule, Boolean(session.agentSessionId)) !== 'blocked')
}

/** A tab paused at a usage limit with its resume armed: waiting for the clock, needing nothing from the person (docs/agents.md 7.2). */
export function waitingOnLimit(session: { lastTurn?: { outcome: string }; limitResume?: { missed?: true } }): boolean {
  return session.lastTurn?.outcome === 'limit' && Boolean(session.limitResume) && !session.limitResume?.missed
}
