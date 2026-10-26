// Keep agents running (O10): the parts of the background agent host that are pure.
// Which agents it can keep, the menu-bar/tray view while Foreman is closed, Home's
// "Reconnected to …" line and the chat's "Foreman was closed 12:10–12:52" line.
// The host itself is src/main/agentHost; nothing here starts or stops a turn.
import { AGENTS, type AgentKind } from './agents'
import { createT, type TFunction } from './i18n'
import type { KeepRunningPlan } from './stopSafely'
import type { ChatItem } from './types'

const enT = createT('en')

/**
 * Agents whose turns can run in the background host. Claude Code (the Agent SDK) and Codex (the codex CLI
 * through its SDK) run one turn per call with no state kept between turns in Foreman's process, so the
 * host can run them as they are. G1: Cursor (its SDK's local agent) and OpenCode (`opencode acp`, started per
 * turn) work the same way, so the host owns their turns too: the Cursor agent and the OpenCode process live in
 * the host, not the app. What stays in the app: OpenCode's running cost per session (a kept turn's cost starts
 * from unknown) and Cursor's model list cache. Untested end to end (no Cursor key or OpenCode here).
 * The Chat agents still stop at Quit.
 */
export const KEPT_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'cursor', 'opencode']

export function keptRunning(agent: AgentKind): boolean {
  return KEPT_AGENTS.includes(agent)
}

/** A turn the app handed to the host, remembered across a restart so it can be adopted again. */
export interface HostedTurnRecord {
  sessionId: string
  turnId: string
  agent: AgentKind
  startedAt: string
  // The last logged event the app applied; a reconnect replays only what came after.
  seq: number
  // Cloud workspaces: the turn runs in the host inside the workspace's sandbox (cloud/turnHost.ts), not the local one.
  cloud?: true
  // Cloud: the chat ended the turn when the connection was lost, but the agent may still run in the sandbox; kept to adopt it again.
  detached?: true
}

/** What the host knows about one turn, as it tells the app on connect. */
export interface HostTurnInfo {
  turnId: string
  sessionId: string
  agent: AgentKind
  startedAt: string
  lastSeq: number
  ended: boolean
  // Approvals or questions waiting for an answer.
  waiting: number
}

/** What a waiting turn is blocked on, for the tray and the notification. */
export interface HostWaiting {
  kind: 'tool' | 'plan' | 'question'
  tool?: string
}

/** One row of the tray menu. */
export interface HostViewTurn {
  turnId: string
  workspace: string
  title?: string
  startedAt: string
  waiting?: HostWaiting
}

/** The menu-bar extra (tray on Windows) while Foreman is closed. Hidden while the app is attached. */
export interface HostView {
  visible: boolean
  count: number
  running: HostViewTurn[]
  waiting: HostViewTurn[]
}

/** The host's turns as the tray shows them: only while Foreman is closed and a turn is still going. */
export function hostView(attached: boolean, turns: (HostViewTurn & { ended: boolean })[]): HostView {
  const live = turns.filter((t) => !t.ended)
  const strip = ({ ended: _e, ...t }: HostViewTurn & { ended: boolean }): HostViewTurn => t
  return {
    visible: !attached && live.length > 0,
    count: live.length,
    running: live.filter((t) => !t.waiting).map(strip),
    waiting: live.filter((t) => t.waiting).map(strip)
  }
}

/** "3m", "48s", "2h": how long a tray row has been going. */
export function shortAge(startedAt: string, now: number, t: TFunction = enT): string {
  const s = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000))
  if (s < 60) return t('agentHost.age.seconds', { count: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('agentHost.age.minutes', { count: m })
  return t('agentHost.age.hours', { count: Math.floor(m / 60) })
}

/** After a relaunch, what Foreman reattached to. Shown on Home once, until dismissed. */
export interface ReconnectRecord {
  // When Foreman reconnected, and when it was closed (unknown after a crash).
  at: string
  closedAt?: string
  running: number
  finished: number
  // G3: the chats whose kept turn finished while Foreman was closed.
  sessions?: string[]
}

/** Count what the adoption found: turns still going, and turns that ended while Foreman was closed. */
export function reconnectRecord(at: string, closedAt: string | undefined, adopted: { ended: boolean; sessionId?: string }[]): ReconnectRecord | undefined {
  if (!adopted.length) return undefined
  // G3: the chats whose turn finished while closed, so their Home rows can say so.
  const sessions = adopted.filter((a) => a.ended && a.sessionId).map((a) => a.sessionId!)
  return { at, closedAt, running: adopted.filter((a) => !a.ended).length, finished: adopted.filter((a) => a.ended).length, ...(sessions.length ? { sessions } : {}) }
}

/**
 * G3 · O10: when a workspace's kept turn finished while Foreman was closed (the latest, if several), for its Home row:
 * "finished at 12:14 while Foreman was closed". Undefined when none did, or the record has been dismissed.
 */
export function finishedWhileClosed(
  record: ReconnectRecord | undefined,
  sessions: { id: string; workspaceId: string; lastTurn?: { endedAt?: string } }[],
  workspaceId: string
): string | undefined {
  if (!record?.sessions?.length) return undefined
  const ends = sessions
    .filter((s) => s.workspaceId === workspaceId && record.sessions!.includes(s.id))
    .map((s) => s.lastTurn?.endedAt)
    .filter((at): at is string => Boolean(at) && Date.parse(at!) <= Date.parse(record.at) && (!record.closedAt || Date.parse(at!) >= Date.parse(record.closedAt)))
  return ends.sort().at(-1)
}

/** How many steps (tool calls) the agent took in the events replayed after a gap. */
export function stepsIn(items: ChatItem[], known: ReadonlySet<string> = new Set()): number {
  const ids = new Set<string>()
  for (const item of items) if (item.kind === 'tool' && !known.has(item.id)) ids.add(item.id)
  return ids.size
}

/** The chat's divider for the gap: when Foreman was closed (if known) and how much happened meanwhile. */
export interface ClosedGap {
  from?: string
  to: string
  steps: number
  // The turn had already ended when Foreman reopened.
  ended?: boolean
}

/** "12:10–12:52" (or just "12:52" when the start isn't known), in the given locale. */
export function gapRange(gap: Pick<ClosedGap, 'from' | 'to'>, locale?: string): string {
  const fmt = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    } catch {
      return new Date(iso).toLocaleTimeString()
    }
  }
  return gap.from ? `${fmt(gap.from)}–${fmt(gap.to)}` : fmt(gap.to)
}

/** A running turn as the Quit sheet's keep-running choice sees it. */
export interface KeepCandidate {
  sessionId: string
  workspace: string
  agent: AgentKind
  waiting: boolean
}

/** What "Keep agents running in the background" would keep, and what stops anyway. Undefined with nothing running. */
export function keepRunningPlan(turns: KeepCandidate[], hosted: (sessionId: string) => boolean, enabled: boolean): KeepRunningPlan | undefined {
  if (!turns.length) return undefined
  const kept = turns.filter((t) => hosted(t.sessionId))
  return {
    enabled,
    turns: kept.length,
    waiting: [...new Set(kept.filter((t) => t.waiting).map((t) => t.workspace))],
    notKept: turns
      .filter((t) => !hosted(t.sessionId))
      .map((t) => ({ workspace: t.workspace, agent: AGENTS[t.agent].label, reason: keptRunning(t.agent) ? ('started-before' as const) : ('agent' as const) }))
  }
}
