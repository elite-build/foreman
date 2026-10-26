// Stop safely (#1): one sheet for three moments. What Quit waits for and what it
// stops, what archiving a workspace with running tabs keeps and deletes, and the
// turns a quit or a crash stopped, kept for review after the restart. Nothing here
// starts or replays anything; Retry is always the user's click on one tab.
import { modelInfo } from './agents'
import type { ApprovalRequest, ChatItem, CheckStatus, Session, TurnDelta, Workspace } from './types'

/** What a turn was blocked on: a tool approval, a plan review or a question. */
export interface WaitingOn {
  kind: ApprovalRequest['kind']
  // Tool approvals: the tool and its input ("Bash", { command: 'npm run db:migrate' }).
  tool?: string
  input?: unknown
}

/** A running turn, as the Quit sheet lists it. */
export interface QuitTurn {
  kind: 'turn'
  workspaceId: string
  workspace: string
  sessionId: string
  turnId?: string
  title?: string
  model: string
  startedAt?: string
  // Set when the turn is blocked on the user; it won't finish on its own.
  waiting?: WaitingOn
}

/** A check run in progress: the commands that finished and the ones still going. */
export interface QuitChecks {
  kind: 'checks'
  workspaceId: string
  workspace: string
  done: string[]
  running: string[]
  startedAt?: string
}

/** A run script, dev server or terminal snippet: never finishes on its own, so it is stopped either way. */
export interface QuitScript {
  workspaceId: string
  workspace: string
  command?: string
  startedAt?: string
}

/** A terminal process as the main process knows it. */
export interface TerminalInfo {
  workspaceId: string
  kind: 'shell' | 'script' | 'snippet'
  command?: string
  startedAt?: string
}

export interface QuitPlan {
  // Finite work: turns and check runs that end by themselves.
  finishing: (QuitTurn | QuitChecks)[]
  // Turns waiting on an approval or a question: they hold "Quit when turns finish" until answered.
  waiting: QuitTurn[]
  // Processes that will be stopped whichever button is chosen.
  scripts: QuitScript[]
  terminals: { count: number; workspaces: string[] }
  // "Quit when turns finish" was chosen: new work is held back and Foreman quits once the finite work ends.
  draining?: boolean
  // O10: what "Keep agents running in the background" would keep. Absent when no turn is running.
  keep?: KeepRunningPlan
  // Cloud workspaces' turns: they run in their sandboxes, need no host here and go on after Quit whatever is
  // chosen, so they are never waited for or stopped. Absent when there are none.
  cloud?: QuitTurn[]
}

/** O10: the Quit sheet's keep-running choice: the turns the background host would keep, and what still stops. */
export interface KeepRunningPlan {
  // Settings → Advanced → Keep agents running is on.
  enabled: boolean
  // Turns running in the background host (they keep going).
  turns: number
  // Workspaces of kept turns waiting on an approval or a question.
  waiting: string[]
  // Running turns that stop anyway: an agent that can't be kept, or a turn started before the setting was on.
  notKept: { workspace: string; agent: string; reason: 'agent' | 'started-before' }[]
}

export interface QuitPlanInput {
  workspaces: Workspace[]
  sessions: Session[]
  approvals: ApprovalRequest[]
  terminals: TerminalInfo[]
}

export function waitingOn(approval: ApprovalRequest): WaitingOn {
  return approval.kind === 'tool' ? { kind: 'tool', tool: approval.toolName, input: approval.input } : { kind: approval.kind }
}

/** A tab has a turn starting or running. */
export function turnRunning(s: Session): boolean {
  return !s.closedAt && (s.status === 'running' || Boolean(s.turnId))
}

/** Sorts what's running into the Quit sheet's three groups. */
export function quitPlan(input: QuitPlanInput): QuitPlan {
  const live = input.workspaces.filter((w) => w.state !== 'archived')
  const byId = new Map(live.map((w) => [w.id, w]))
  const order = (id: string) => live.findIndex((w) => w.id === id)
  const finishing: QuitPlan['finishing'] = []
  const waiting: QuitTurn[] = []
  const cloud: QuitTurn[] = []
  for (const s of input.sessions) {
    const ws = byId.get(s.workspaceId)
    if (!ws || !turnRunning(s)) continue
    const approval = input.approvals.find((a) => a.sessionId === s.id)
    const row: QuitTurn = {
      kind: 'turn',
      workspaceId: ws.id,
      workspace: ws.name,
      sessionId: s.id,
      turnId: s.turnId,
      title: s.title,
      model: modelInfo(s.agent, s.model).label,
      startedAt: s.turnStartedAt,
      waiting: approval ? waitingOn(approval) : undefined
    }
    ;(ws.cloud ? cloud : approval ? waiting : finishing).push(row)
  }
  for (const ws of live) {
    if (!ws.checks?.running) continue
    const done = ws.checks.results.filter((r) => r.status !== 'running')
    const running = ws.checks.results.filter((r) => r.status === 'running')
    finishing.push({
      kind: 'checks',
      workspaceId: ws.id,
      workspace: ws.name,
      done: done.map((r) => r.name),
      running: running.map((r) => r.name),
      startedAt: ws.checks.results.map((r) => r.startedAt).sort()[0]
    })
  }
  const scripts: QuitScript[] = []
  const shells = new Set<string>()
  let count = 0
  for (const t of input.terminals) {
    const ws = byId.get(t.workspaceId)
    if (!ws) continue
    if (t.kind === 'shell') {
      count++
      shells.add(ws.id)
    } else scripts.push({ workspaceId: ws.id, workspace: ws.name, command: t.command, startedAt: t.startedAt })
  }
  const byWorkspace = <T extends { workspaceId: string }>(rows: T[]) => rows.slice().sort((a, b) => order(a.workspaceId) - order(b.workspaceId))
  return {
    finishing: byWorkspace(finishing),
    waiting: byWorkspace(waiting),
    scripts: byWorkspace(scripts),
    terminals: { count, workspaces: live.filter((w) => shells.has(w.id)).map((w) => w.name) },
    ...(cloud.length ? { cloud: byWorkspace(cloud) } : {})
  }
}

/** Quit asks first only when something is running; idle terminals alone don't count, so quit stays instant. */
export function quitNeedsAsking(plan: QuitPlan): boolean {
  return plan.finishing.length + plan.waiting.length + plan.scripts.length > 0
}

/** "Quit when turns finish" can go: no turn, check run or waiting turn is left. */
export function finiteWorkDone(plan: QuitPlan): boolean {
  return plan.finishing.length === 0 && plan.waiting.length === 0
}

// ---- after a restart ----

export type StopCause = 'quit' | 'crash'

/** A turn that was running when Foreman quit or crashed. */
export interface StoppedTurn {
  turnId: string
  sessionId: string
  workspaceId: string
  cause: StopCause
  // When it was stopped (for a crash, the tab's last activity, as near as we know).
  at: string
  startedAt?: string
  waiting?: WaitingOn
}

/** A check run that was in progress: recorded as interrupted, never as failed. */
export interface StoppedChecks {
  workspaceId: string
  cause: StopCause
  at: string
}

/** What waits on Home for review until each entry is retried or dismissed. */
export interface StopRecord {
  turns: StoppedTurn[]
  checks: StoppedChecks[]
}

export const checksKey = (workspaceId: string) => `checks:${workspaceId}`

/** Add newly stopped work; an entry already recorded keeps its first cause. Undefined when nothing is left. */
export function addStops(record: StopRecord | undefined, turns: StoppedTurn[], checks: StoppedChecks[]): StopRecord | undefined {
  const next: StopRecord = { turns: [...(record?.turns ?? [])], checks: [...(record?.checks ?? [])] }
  for (const t of turns) if (!next.turns.some((x) => x.turnId === t.turnId)) next.turns.push(t)
  for (const c of checks) if (!next.checks.some((x) => x.workspaceId === c.workspaceId)) next.checks.push(c)
  return next.turns.length || next.checks.length ? next : undefined
}

/** Clear one entry (a turn id, or `checks:<workspace id>`), or everything without a key. */
export function dismissStop(record: StopRecord | undefined, key?: string): StopRecord | undefined {
  if (!record || key === undefined) return undefined
  const next = { turns: record.turns.filter((t) => t.turnId !== key), checks: record.checks.filter((c) => checksKey(c.workspaceId) !== key) }
  return next.turns.length || next.checks.length ? next : undefined
}

/** Drop entries whose workspace is gone or archived; they can't be opened or retried. */
export function liveStops(record: StopRecord | undefined, workspaces: Workspace[]): StopRecord | undefined {
  if (!record) return undefined
  const live = (id: string) => workspaces.some((w) => w.id === id && w.state !== 'archived')
  return addStops(undefined, record.turns.filter((t) => live(t.workspaceId)), record.checks.filter((c) => live(c.workspaceId)))
}

/** Home's one line: how many turns and check runs, why, and when (the latest). */
export function stopSummary(record: StopRecord | undefined): { turns: number; checks: number; cause: StopCause | 'mixed'; at: string } | null {
  if (!record || (!record.turns.length && !record.checks.length)) return null
  const all = [...record.turns, ...record.checks]
  const causes = new Set(all.map((x) => x.cause))
  return {
    turns: record.turns.length,
    checks: record.checks.length,
    cause: causes.size > 1 ? 'mixed' : [...causes][0],
    at: all.map((x) => x.at).sort().at(-1)!
  }
}

/** The stopped turns of one workspace (the sidebar says "Stopped when Foreman quit · 2 tabs"). */
export function stoppedIn(record: StopRecord | undefined, workspaceId: string): StoppedTurn[] {
  return record?.turns.filter((t) => t.workspaceId === workspaceId) ?? []
}

export interface StopReviewTurn {
  kind: 'turn'
  key: string
  workspaceId: string
  workspace: string
  sessionId: string
  title?: string
  model: string
  cause: StopCause
  at: string
  // The message the turn was carrying, word for word (what Retry sends again).
  message?: string
  attachments: number
  // The last tool the agent used, for "last step: Edit src/main/intake.ts".
  lastStep?: { name: string; input: unknown }
  durationMs?: number
  // Changes between the turn's start and end checkpoints; undefined when unknown (a crash saves no end checkpoint).
  delta?: TurnDelta
  waiting?: WaitingOn
  // The tab was closed since; Retry reopens it.
  closed?: boolean
}

export interface StopReviewChecks {
  kind: 'checks'
  key: string
  workspaceId: string
  workspace: string
  cause: StopCause
  at: string
  results: { name: string; status: CheckStatus }[]
}

export type StopReviewRow = StopReviewTurn | StopReviewChecks

/** What a stopped turn's chat says about it: its message, last step, time and partial changes. */
export function reviewFromChat(turnId: string, items: ChatItem[]): Pick<StopReviewTurn, 'message' | 'attachments' | 'lastStep' | 'durationMs' | 'delta'> {
  const user = items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === turnId && !i.steered)
  const tools = items.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool' && i.turnId === turnId)
  const end = items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end' && i.turnId === turnId)
  const last = tools.at(-1)
  return {
    message: user?.text,
    attachments: user?.attachments?.length ?? 0,
    lastStep: last ? { name: last.name, input: last.input } : undefined,
    durationMs: end?.durationMs,
    delta: end?.delta
  }
}

/**
 * G3 · #1: whether Esc cancels "Quit when turns finish". The composer's Esc stops its running turn (and closes its
 * menu), and then the event arrives already handled. So an Esc that reaches here unhandled from the composer means no
 * turn runs in that composer: it cancels the wait. Other text fields, terminals and open dialogs keep their Esc.
 */
export function quitWaitEscape(e: { defaultPrevented: boolean; inComposer: boolean; inOtherField: boolean; dialogOpen: boolean }): boolean {
  if (e.defaultPrevented || e.dialogOpen) return false
  return e.inComposer || !e.inOtherField
}
