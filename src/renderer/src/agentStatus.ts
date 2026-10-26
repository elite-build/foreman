// What a screen-reader user is told about agents (phase 4). Pure: the Announcer component feeds it snapshots and
// speaks the result.
import { AGENTS } from '../../shared/agents'
import type { TFunction } from '../../shared/i18n'
import { needsYou, turnEnded, whatNeedsMe } from '../../shared/narration'
import type { ApprovalRequest, NotifyKind, Session, Settings, TurnOutcome, Workspace } from '../../shared/types'

export type Needs = 'approval' | 'question' | 'plan'

/** What one chat looked like at one moment. */
export interface SessionStatus {
  running: boolean
  needs: Needs | null
}

export type StatusKind = 'started' | 'needs-approval' | 'needs-question' | 'needs-plan' | 'finished' | 'failed' | 'stopped'

export interface StatusEvent {
  sessionId: string
  kind: StatusKind
}

export type StatusMap = ReadonlyMap<string, SessionStatus>

const NEEDS: Record<ApprovalRequest['kind'], Needs> = { tool: 'approval', question: 'question', plan: 'plan' }

export function sessionStatuses(sessions: readonly Session[], approvals: readonly ApprovalRequest[]): Map<string, SessionStatus> {
  const out = new Map<string, SessionStatus>()
  for (const session of sessions) {
    if (session.closedAt) continue
    // A question outranks a plan outranks a tool approval: the one that says the most about what is wanted.
    const pending = approvals.filter((a) => a.sessionId === session.id)
    const needs = pending.find((a) => a.kind === 'question') ?? pending.find((a) => a.kind === 'plan') ?? pending[0]
    out.set(session.id, { running: session.status === 'running', needs: needs ? NEEDS[needs.kind] : null })
  }
  return out
}

const NEEDS_KIND: Record<Needs, StatusKind> = { approval: 'needs-approval', question: 'needs-question', plan: 'needs-plan' }

/**
 * What changed between two moments that is worth saying.
 *  - A chat that now needs you is always said, in any chat.
 *  - Started, finished, failed and stopped are said only for the chat the user has open (`isOpen`); pass `() => true` for
 *    every chat and let `filterEvents` apply the user's announcement policy.
 * `prev` is null for the first look, which says nothing: a window that opens onto running chats is not news.
 */
export function statusEvents(
  prev: StatusMap | null,
  next: StatusMap,
  sessions: readonly Session[],
  isOpen: (sessionId: string) => boolean
): StatusEvent[] {
  if (!prev) return []
  const events: StatusEvent[] = []
  for (const [id, now] of next) {
    const before = prev.get(id) ?? { running: false, needs: null }
    if (now.needs && now.needs !== before.needs) events.push({ sessionId: id, kind: NEEDS_KIND[now.needs] })
    if (!isOpen(id)) continue
    if (!before.running && now.running) events.push({ sessionId: id, kind: 'started' })
    if (before.running && !now.running) {
      const outcome = sessions.find((s) => s.id === id)?.lastTurn?.outcome
      events.push({ sessionId: id, kind: outcome === 'error' || outcome === 'interrupted' ? 'failed' : outcome === 'cancelled' ? 'stopped' : 'finished' })
    }
  }
  return events
}

export type AnnouncePolicy = Settings['announce']

const isNeeds = (kind: StatusKind): boolean => kind === 'needs-approval' || kind === 'needs-question' || kind === 'needs-plan'

/** A saved value this version doesn't know (a newer build wrote it) reads as the default. */
export const announcePolicy = (value: unknown): AnnouncePolicy => (value === 'needs-me' || value === 'all' ? value : 'my-chat')

/**
 * Which events the live region says (accessibility plan E2). Anything that needs you is said in every policy and every
 * chat. `needs-me` says nothing else; `my-chat` adds started, finished, failed and stopped for the open chat (the rule
 * before there was a setting); `all` adds them for the other chats too.
 */
export function filterEvents(events: readonly StatusEvent[], policy: AnnouncePolicy, isOpen: (sessionId: string) => boolean): StatusEvent[] {
  return events.filter((e) => isNeeds(e.kind) || (policy === 'all' ? true : policy === 'my-chat' && isOpen(e.sessionId)))
}

export type Earcon = 'started' | 'needs-me' | 'finished' | 'failed'

const EARCON: Record<StatusKind, Earcon | undefined> = {
  started: 'started',
  'needs-approval': 'needs-me',
  'needs-question': 'needs-me',
  'needs-plan': 'needs-me',
  finished: 'finished',
  failed: 'failed',
  // The user did it themselves.
  stopped: undefined
}

/**
 * The cue for each event that gets one, in order. It follows the announcement policy, except that a turn ending is cued
 * in any chat: the completion sound it replaces played for every chat. Stopping a turn has no cue.
 */
export function earconsFor(events: readonly StatusEvent[], policy: AnnouncePolicy, isOpen: (sessionId: string) => boolean): Earcon[] {
  const said = new Set(filterEvents(events, policy, isOpen))
  return events.flatMap((e) => {
    const cue = EARCON[e.kind]
    return cue && (said.has(e) || cue === 'finished' || cue === 'failed') ? [cue] : []
  })
}

/** How a chat's agent reads in a sentence. */
const agentLabel = (agent: string): string => AGENTS[agent as keyof typeof AGENTS]?.label ?? agent

/**
 * The end-of-turn sentence for a chat whose turn just ended, from what the snapshot knows: the turn's own line counts
 * (the chat records lines, not files) and the workspace's checks with their freshness. Null when the chat has no
 * recorded turn, or its last turn ended some other way than `outcome` says (the snapshot has not caught up).
 */
export function turnEndedSentence(t: TFunction, session: Session, workspace: Workspace | undefined, outcome?: 'finished' | 'failed' | 'stopped'): string | null {
  const last = session.lastTurn
  if (!last) return null
  if (outcome === 'finished' && last.outcome !== 'completed') return null
  if (outcome === 'stopped' && last.outcome !== 'cancelled') return null
  if (outcome === 'failed' && last.outcome !== 'error' && last.outcome !== 'interrupted') return null
  return turnEnded(t, {
    agent: agentLabel(session.agent),
    workspace: workspace?.name ?? session.workspaceId,
    outcome: last.outcome,
    delta: last.additions !== undefined || last.deletions !== undefined ? { additions: last.additions ?? 0, deletions: last.deletions ?? 0 } : undefined,
    checks: workspace?.checks
  })
}

/** What a pending request says, for a chat: the first one asked (a question outranks a plan outranks a tool call, as everywhere). */
export function needsYouSentence(t: TFunction, session: Session, workspace: Workspace | undefined, approvals: readonly ApprovalRequest[]): string | null {
  const pending = approvals.filter((a) => a.sessionId === session.id)
  const request = pending.find((a) => a.kind === 'question') ?? pending.find((a) => a.kind === 'plan') ?? pending[0]
  if (!request) return null
  return needsYou(t, request, { agent: agentLabel(session.agent), workspace: workspace?.name ?? session.workspaceId, root: workspace?.path })
}

/**
 * What a Home row says in words, for its accessible description (E4): the first request waiting in the workspace
 * (needs you), else how the workspace's latest finished turn ended. Null while an agent is working, or when nothing has run.
 */
export function workspaceNarration(t: TFunction, workspace: Workspace, sessions: readonly Session[], approvals: readonly ApprovalRequest[]): string | null {
  const waiting = whatNeedsMe(t, { sessions: sessions.filter((s) => s.workspaceId === workspace.id), approvals, workspaces: [workspace] }).items
  if (waiting.length) return waiting[0]
  const open = sessions.filter((s) => s.workspaceId === workspace.id && !s.closedAt)
  if (open.some((s) => s.status === 'running')) return null
  const latest = open.filter((s) => s.lastTurn).sort((a, b) => b.lastTurn!.endedAt.localeCompare(a.lastTurn!.endedAt))[0]
  return latest ? turnEndedSentence(t, latest, workspace) : null
}

/** An attention-history "turn ended" event as a sentence. The log keeps no counts or checks, so it says only how the turn ended. */
export function turnEndedEventSentence(t: TFunction, input: { session?: Session; workspace: Workspace; outcome?: TurnOutcome }): string | null {
  if (!input.session) return null
  return turnEnded(t, { agent: agentLabel(input.session.agent), workspace: input.workspace.name, outcome: input.outcome ?? 'completed' })
}

/**
 * The OS notification for a chat's notice (accessibility plan E2): the workspace's name as the title and the narrator's
 * sentence as the body, for a turn that finished or failed and for a request that needs the user. Any other notice, or one
 * the snapshot cannot narrate yet, keeps main's own text.
 */
export function narratedNotice<N extends { kind?: NotifyKind; sessionId: string; title: string; body: string }>(
  t: TFunction,
  notice: N,
  sessions: readonly Session[],
  workspaces: readonly Workspace[],
  approvals: readonly ApprovalRequest[]
): { title: string; body: string } {
  const session = notice.sessionId ? sessions.find((s) => s.id === notice.sessionId) : undefined
  const plain = { title: notice.title, body: notice.body }
  if (!session) return plain
  const workspace = workspaces.find((w) => w.id === session.workspaceId)
  const sentence =
    notice.kind === 'finished'
      ? turnEndedSentence(t, session, workspace, 'finished')
      : notice.kind === 'attention'
        ? (needsYouSentence(t, session, workspace, approvals) ?? turnEndedSentence(t, session, workspace, 'failed'))
        : null
  return sentence ? { title: workspace?.name ?? notice.title, body: sentence } : plain
}

/**
 * The start of an answer as plain words for speech: no code blocks, no Markdown marks, links as their text, cut at a word.
 * A long answer is read in the chat; this is only what the announcer says when the answer lands.
 */
export function spokenSnippet(markdown: string, max = 300): string {
  const plain = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[`*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}
