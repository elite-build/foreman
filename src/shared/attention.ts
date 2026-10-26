// #3 Attention history, tray and row glyphs. Pure, so the rules can be tested without a clock,
// a database or Electron:
//  - REASONS (triage.ts) stay the live set. This file only keeps a bounded history of transitions
//    beside them (500 events or 30 days), with repeats folded into one event that keeps its first
//    and last occurrence ("CI failed ×3 since 13:10"). Marking history seen never touches a reason.
//  - The tray's count and jump list come from the same triage as Home's "need you".
//  - A row's lead glyph is attention first; the PR glyph sits apart and comes from `prInfo` only.
import { REASONS, triageAll, type ReasonContext, type Triage, type TriageInput } from './triage'
import type { Session, TurnOutcome, Workspace } from './types'

export const LOG_MAX_EVENTS = 500
export const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60_000
/** Open pull requests are looked at this often (through the shared PR cache, so its back-off holds). */
export const PR_POLL_MS = 60_000

// ---- the event log ----

export type AttentionEventKind =
  // A reason (triage.ts) started to apply, or stopped applying.
  | 'reason'
  | 'reason-cleared'
  | 'turn-ended'
  | 'pr-merged'
  // From the pull request as last read: a check is failing, or every counted check passes again.
  | 'ci-failed'
  | 'ci-passed'
  | 'approval-answered'
  // An agent's own `foreman report` (its words, never Foreman's).
  | 'agent-report'

export interface AttentionEvent {
  id: string
  kind: AttentionEventKind
  workspaceId: string
  sessionId?: string
  // Repeats fold together: the latest event of a workspace's topic absorbs a new one with the same key.
  topic: string
  key: string
  firstAt: string
  at: string
  count: number
  // What the row says. `label` is a reason's own label, a report's kind or a tool's name.
  reasonId?: string
  label?: string
  detail?: string
  outcome?: TurnOutcome
  pr?: number
  sha?: string
  tab?: number
  allowed?: boolean
  // G2: the pull request is a GitLab merge request ("MR !12").
  gitlab?: boolean
  // G2: where an approval was answered. Absent in events from before it was kept.
  via?: 'window' | 'phone'
}

/** A transition before it is in the log (no id, times or count yet). */
export type EventDraft = Omit<AttentionEvent, 'id' | 'firstAt' | 'at' | 'count'>

export interface AppendResult {
  log: AttentionEvent[]
  // The event written (new, or the one a repeat folded into).
  written: AttentionEvent
  // Events dropped by the bound.
  dropped: AttentionEvent[]
}

/** Drop what is older than 30 days, then all but the newest 500. The log is kept oldest first. */
export function boundLog(log: AttentionEvent[], now: number): { log: AttentionEvent[]; dropped: AttentionEvent[] } {
  const cutoff = now - LOG_MAX_AGE_MS
  const fresh = log.filter((e) => Date.parse(e.at) >= cutoff)
  const kept = fresh.slice(Math.max(0, fresh.length - LOG_MAX_EVENTS))
  const keep = new Set(kept)
  return { log: kept, dropped: log.filter((e) => !keep.has(e)) }
}

/**
 * Add one transition. When the newest event on the same workspace and topic has the same key, it is a
 * repeat: that event's count goes up and it moves to now, keeping its first occurrence. Then the bound.
 */
export function appendEvent(log: AttentionEvent[], draft: EventDraft, now: number, newId: () => string): AppendResult {
  const at = new Date(now).toISOString()
  let index = -1
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].workspaceId === draft.workspaceId && log[i].topic === draft.topic) {
      index = i
      break
    }
  }
  const previous = index >= 0 ? log[index] : undefined
  const written: AttentionEvent =
    previous && previous.key === draft.key
      ? { ...previous, ...draft, id: previous.id, firstAt: previous.firstAt, at, count: previous.count + 1 }
      : { ...draft, id: newId(), firstAt: at, at, count: 1 }
  const rest = written.id === previous?.id ? log.filter((_, i) => i !== index) : log
  const bounded = boundLog([...rest, written], now)
  return { log: bounded.log, written, dropped: bounded.dropped }
}

/** Events since the user last marked history seen. Seeing them changes nothing else. */
export function unseenCount(log: AttentionEvent[], seenAt: string | undefined): number {
  return seenAt ? log.filter((e) => e.at > seenAt).length : log.length
}

// ---- transitions, from one look at the state to the next ----

/** What the log compares between two looks at one workspace. */
export interface WorkspaceLook {
  reasons: { id: string; label: string; detail?: string; sessionId?: string }[]
  // Per open or closed tab: its last turn's id (or end time) and outcome.
  turns: Record<string, { mark: string; outcome: TurnOutcome; tab: number; title?: string }>
  pr?: { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; checks?: 'passed' | 'failing' | 'pending' | 'none'; failing?: number; gitlab?: boolean }
  reports: { id: string; kind: string; text: string; sessionId?: string }[]
}

// Reasons whose own events say more: an approval is logged when answered, a turn when it ends, CI from the
// PR as read, and an agent's needs-input / stuck / review request when it is filed.
const NO_APPEAR = new Set(['ci-failed', 'turn-outcome', 'agent-report', 'review-request'])
// A CI failure acknowledged with Fix CI is dealt with, not resolved; a cancelled approval was never answered.
const NO_CLEAR = new Set(['ci-failed', 'approvals'])

/** One workspace as the log sees it now. Archived workspaces aren't looked at (their reasons went with them). */
export function lookAt(ws: Workspace, sessions: Session[], input: TriageInput): WorkspaceLook {
  const title = (id: string | undefined) => sessions.find((s) => s.id === id)?.title
  const ctx: ReasonContext = { ws, sessions, input, title }
  const reasons = REASONS.flatMap((r) => {
    const hit = r.find(ctx)
    return hit ? [{ id: r.id, label: hit.label, detail: hit.detail, sessionId: hit.sessionId }] : []
  })
  const open = sessions.filter((s) => !s.closedAt)
  const turns: WorkspaceLook['turns'] = {}
  for (const s of sessions) {
    if (!s.lastTurn) continue
    turns[s.id] = { mark: s.lastTurn.turnId ?? s.lastTurn.endedAt, outcome: s.lastTurn.outcome, tab: open.indexOf(s) + 1, title: s.title }
  }
  const info = ws.prInfo
  const facts = info?.facts
  // A failed read keeps what was known; it says nothing new about CI.
  const pr = info
    ? { number: info.number, state: info.state, ...(facts && !facts.unreadable ? { checks: facts.checks, failing: facts.checksFailing } : {}), ...(facts?.provider === 'gitlab' || ws.pullRequest?.gitlabHost ? { gitlab: true } : {}) }
    : undefined
  const reports = (ws.agentReports ?? []).map((r) => ({ id: r.id, kind: r.kind, text: r.text, sessionId: r.sessionId }))
  return { reasons, turns, pr, reports }
}

/** The transitions between two looks at one workspace. No earlier look: this one is the baseline, so nothing. */
export function transitions(workspaceId: string, prev: WorkspaceLook | undefined, next: WorkspaceLook): EventDraft[] {
  if (!prev) return []
  const out: EventDraft[] = []
  const before = new Map(prev.reasons.map((r) => [r.id, r]))
  const after = new Map(next.reasons.map((r) => [r.id, r]))
  for (const r of next.reasons) {
    if (before.has(r.id) || NO_APPEAR.has(r.id)) continue
    out.push({ kind: 'reason', workspaceId, sessionId: r.sessionId, topic: `reason:${r.id}`, key: `on:${r.label}`, reasonId: r.id, label: r.label, detail: r.detail })
  }
  for (const r of prev.reasons) {
    if (after.has(r.id) || NO_CLEAR.has(r.id)) continue
    out.push({ kind: 'reason-cleared', workspaceId, sessionId: r.sessionId, topic: `reason:${r.id}`, key: 'off', reasonId: r.id, label: r.label })
  }
  for (const [sessionId, turn] of Object.entries(next.turns)) {
    if (prev.turns[sessionId]?.mark === turn.mark) continue
    out.push({ kind: 'turn-ended', workspaceId, sessionId, topic: `turn:${sessionId}`, key: turn.outcome, outcome: turn.outcome, tab: turn.tab || undefined, detail: turn.title })
  }
  const was = prev.pr?.number === next.pr?.number ? prev.pr : undefined
  const gitlab = next.pr?.gitlab ? { gitlab: true } : {}
  if (next.pr?.state === 'MERGED' && was?.state !== 'MERGED') out.push({ kind: 'pr-merged', workspaceId, topic: 'pr', key: `merged:${next.pr.number}`, pr: next.pr.number, ...gitlab })
  if (next.pr?.state === 'OPEN' && next.pr.checks) {
    const checks = next.pr.checks
    const prior = was?.checks
    if (checks === 'failing' && prior !== 'failing') {
      out.push({ kind: 'ci-failed', workspaceId, topic: 'ci', key: `failed:${next.pr.number}`, pr: next.pr.number, ...gitlab, ...(next.pr.failing ? { detail: String(next.pr.failing) } : {}) })
    }
    // Only a failure that is now all green; pending says nothing yet.
    if (checks === 'passed' && prior === 'failing') out.push({ kind: 'ci-passed', workspaceId, topic: 'ci', key: `passed:${next.pr.number}`, pr: next.pr.number, ...gitlab })
  }
  const known = new Set(prev.reports.map((r) => r.id))
  for (const r of next.reports) {
    if (known.has(r.id)) continue
    out.push({ kind: 'agent-report', workspaceId, sessionId: r.sessionId, topic: `report:${r.sessionId ?? ''}`, key: r.kind, label: r.kind, detail: r.text || undefined })
  }
  return out
}

/** Every live workspace looked at, keyed by id. */
export function lookAll(input: TriageInput): Map<string, WorkspaceLook> {
  const sessions = new Map<string, Session[]>()
  for (const s of input.snapshot.sessions) sessions.set(s.workspaceId, [...(sessions.get(s.workspaceId) ?? []), s])
  const looks = new Map<string, WorkspaceLook>()
  for (const ws of input.snapshot.workspaces) {
    if (ws.state === 'archived' || ws.state === 'history') continue
    looks.set(ws.id, lookAt(ws, sessions.get(ws.id) ?? [], input))
  }
  return looks
}

// ---- the tray / menu-bar extra ----

export interface TrayRow {
  workspaceId: string
  sessionId?: string
  name: string
  label: string
  repo?: string
  since: string
}

export interface TrayView {
  // Workspaces with an outstanding reason: the same number as Home's "need you" and the rail.
  count: number
  oldestSince?: string
  attention: TrayRow[]
  working: TrayRow[]
}

const row = (t: Triage, repos: Map<string, string>): TrayRow => ({
  workspaceId: t.ws.id,
  sessionId: t.sessionId,
  name: t.ws.name,
  label: t.label ?? '',
  repo: repos.get(t.ws.repoId),
  since: t.since
})

/** What the tray shows, from the same triage as Home: oldest first, then what is working. */
export function trayView(input: TriageInput): TrayView {
  const items = triageAll(input, null)
  const repos = new Map(input.snapshot.repos.map((r) => [r.id, r.name]))
  const attention = items.filter((t) => t.bucket === 'attention').sort((a, b) => a.since.localeCompare(b.since))
  const working = items.filter((t) => t.bucket === 'working')
  return { count: attention.length, oldestSince: attention[0]?.since, attention: attention.map((t) => row(t, repos)), working: working.map((t) => row(t, repos)) }
}

/** What a tray entry does: only ever navigation, showing the window, or quitting. Never an answer or a send. */
export type TrayAction = { kind: 'open'; workspaceId: string; sessionId?: string } | { kind: 'next' } | { kind: 'home' } | { kind: 'show' } | { kind: 'quit' }

export type TrayItem = { kind: 'label'; text: string } | { kind: 'item'; text: string; action: TrayAction } | { kind: 'separator' }

export interface TrayWords {
  header(count: number, oldest: string | undefined): string
  working: string
  next: string
  home: string
  show: string
  quit: string
  // The phone section, when phone access keeps the tray up.
  phone?: string
}

/** The tray's menu, top to bottom: the count, who needs you, what is working, then navigation. */
export function trayMenu(view: TrayView, words: TrayWords, age: (since: string) => string): TrayItem[] {
  const line = (r: TrayRow) => `${r.name} · ${r.label}${r.repo ? ` · ${r.repo}` : ''}   ${age(r.since)}`
  const items: TrayItem[] = [{ kind: 'label', text: words.header(view.count, view.oldestSince && age(view.oldestSince)) }]
  for (const r of view.attention) items.push({ kind: 'item', text: line(r), action: { kind: 'open', workspaceId: r.workspaceId, sessionId: r.sessionId } })
  if (view.working.length) {
    items.push({ kind: 'label', text: words.working })
    for (const r of view.working) items.push({ kind: 'item', text: line(r), action: { kind: 'open', workspaceId: r.workspaceId, sessionId: r.sessionId } })
  }
  items.push({ kind: 'separator' })
  if (view.count) items.push({ kind: 'item', text: words.next, action: { kind: 'next' } })
  items.push({ kind: 'item', text: words.home, action: { kind: 'home' } }, { kind: 'item', text: words.show, action: { kind: 'show' } })
  if (words.phone) items.push({ kind: 'separator' }, { kind: 'label', text: words.phone })
  items.push({ kind: 'separator' }, { kind: 'item', text: words.quit, action: { kind: 'quit' } })
  return items
}

// ---- row glyphs ----

export type LeadGlyph = 'attention' | 'spinner' | 'pinned' | 'direct' | 'adopted' | 'branch'

/** The glyph a row leads with: what needs you first, always. The PR glyph never takes this place. */
export function leadGlyph(t: Pick<Triage, 'bucket' | 'spinning' | 'ws'>): LeadGlyph {
  if (t.bucket === 'attention') return 'attention'
  if (t.spinning) return 'spinner'
  if (t.ws.pinned) return 'pinned'
  if (t.ws.direct) return 'direct'
  if (t.ws.adopted) return 'adopted'
  return 'branch'
}

export type PrGlyphState = 'merged' | 'ci-failing' | 'draft' | 'open'

export interface PrGlyph {
  state: PrGlyphState
  number: number
  provider: 'github' | 'gitlab'
  // How many counted checks were failing, when the read said.
  failing?: number
  // When the facts were read ("as of 14:02"); absent for a read from before facts were kept.
  readAt?: string
  // The latest look failed: these are from an earlier one.
  stale?: boolean
  review?: 'approved' | 'changes-requested' | 'required' | 'unknown'
  checks?: 'passed' | 'failing' | 'pending' | 'none'
}

/** The PR glyph, from the pull request as last read. None for no PR, a closed one, or one never read. */
export function prGlyph(ws: Pick<Workspace, 'prInfo'> & Partial<Pick<Workspace, 'pullRequest'>>): PrGlyph | null {
  const info = ws.prInfo
  if (!info || info.state === 'CLOSED') return null
  const facts = info.facts
  const state: PrGlyphState = info.state === 'MERGED' ? 'merged' : facts?.checks === 'failing' ? 'ci-failing' : facts?.draft ? 'draft' : 'open'
  return {
    state,
    number: info.number,
    // G2: a checked-out GitLab MR is GitLab before any read says so.
    provider: facts?.provider ?? (ws.pullRequest?.gitlabHost ? 'gitlab' : 'github'),
    ...(facts?.checksFailing !== undefined ? { failing: facts.checksFailing } : {}),
    ...(facts ? { readAt: facts.readAt, review: facts.review, checks: facts.checks } : {}),
    ...(facts?.unreadable ? { stale: true } : {})
  }
}

/** Workspaces whose open pull request the 60-second poll looks at. It never opts anything into CI notifications. */
export function pollTargets(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((w) => w.state === 'ready' && w.branch !== w.baseBranch && (w.prInfo ? w.prInfo.state === 'OPEN' : Boolean(w.pullRequest)))
}

// ---- G2: the phone's Recent list ----

export interface PhoneEvent {
  id: string
  at: string
  workspaceId: string
  sessionId?: string
  name: string
  kind: AttentionEventKind
  text: string
  count: number
  firstAt: string
}

/** One event in plain English for the phone (which has no translations): "CI failed · PR #42 · 2 failing". */
export function describeEvent(e: AttentionEvent): string {
  const ref = e.pr !== undefined ? (e.gitlab ? `MR !${e.pr}` : `PR #${e.pr}`) : ''
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ')
  switch (e.kind) {
    case 'reason':
      return join(e.label, e.detail)
    case 'reason-cleared':
      return `No longer: ${e.label ?? ''}`
    case 'turn-ended': {
      const verb = { completed: 'Turn completed', error: 'Turn failed', cancelled: 'Turn stopped', interrupted: 'Turn interrupted' }[e.outcome ?? 'completed']
      return join(verb, e.tab ? `Tab ${e.tab}` : undefined, e.detail)
    }
    case 'pr-merged':
      return `${ref} merged`
    case 'ci-failed':
      return join('CI failed', ref, e.detail ? `${e.detail} failing` : undefined)
    case 'ci-passed':
      return join('CI passing again', ref)
    case 'approval-answered': {
      const what = e.label === 'plan' ? 'Plan' : e.label === 'question' ? 'Question' : (e.label ?? 'Request')
      const answer = e.label === 'question' ? (e.allowed ? 'answered' : 'skipped') : e.label === 'plan' ? (e.allowed ? 'approved' : 'rejected') : e.allowed ? 'allowed' : 'denied'
      return join(`${what} ${answer}`, e.via === 'phone' ? 'on your phone' : e.via === 'window' ? 'in the window' : undefined)
    }
    case 'agent-report':
      return join(`Agent report: ${e.label ?? ''}`, e.detail ? `“${e.detail}”` : undefined)
  }
}

/** The phone's Recent list: newest first, only workspaces that still exist, at most `limit`. */
export function phoneRecent(events: AttentionEvent[], workspaces: Pick<Workspace, 'id' | 'name'>[], limit = 40): PhoneEvent[] {
  const names = new Map(workspaces.map((w) => [w.id, w.name]))
  return events
    .filter((e) => names.has(e.workspaceId))
    .slice(0, limit)
    .map((e) => ({ id: e.id, at: e.at, firstAt: e.firstAt, count: e.count, workspaceId: e.workspaceId, sessionId: e.sessionId, name: names.get(e.workspaceId)!, kind: e.kind, text: describeEvent(e) }))
}
