// Compare models: one prompt, run in the source workspace and in sibling
// workspaces made from a fresh checkpoint of it, each with a different model.
// The rules here are pure so the dialog, the sidebar, Home and the tests agree.
// Nothing here picks a winner: it only reports how each run ended.
import { createT, type TFunction } from './i18n'
import type { Session, TurnOutcome, Workspace } from './types'

const enT = createT('en')

export const COMPARE_MAX_EXTRA = 2

/** "Roughly 3× the cost" for N runs (the source's included). */
export function costNote(runs: number, t: TFunction = enT): string {
  return t('compare.costNote', { runs })
}

/** Why a comparison can't start from this workspace now, or null. Every open tab has to be idle. */
export function compareBlock(ws: Pick<Workspace, 'state' | 'path'>, sessions: Pick<Session, 'id' | 'status' | 'queue' | 'closedAt' | 'importedMode' | 'title'>[], t: TFunction = enT): string | null {
  if (ws.state === 'history' || !ws.path) return t('compare.block.history')
  if (ws.state !== 'ready') return t('compare.block.notReady')
  const open = sessions.filter((s) => !s.closedAt)
  const busy = open.findIndex((s) => s.status !== 'idle' || s.queue.length > 0)
  if (busy >= 0) {
    const tab = open[busy]
    return t('compare.block.busy', { tab: tab.title || t('compare.tabN', { n: busy + 1 }) })
  }
  return null
}

/**
 * compareBlock for one workspace out of every session. Returns a string or null, so a store selector can
 * call it on each read and stay referentially stable (a filtered array would be new every time and loop React).
 */
export function compareBlockFor(ws: Pick<Workspace, 'id' | 'state' | 'path'>, sessions: (Pick<Session, 'id' | 'status' | 'queue' | 'closedAt' | 'importedMode' | 'title'> & { workspaceId: string })[], t: TFunction = enT): string | null {
  return compareBlock(ws, sessions.filter((s) => s.workspaceId === ws.id), t)
}

export interface CompareMemberState {
  ws: Workspace
  session?: Session
  label: string
  // Not finished until its first turn ended (or the workspace never became usable).
  finished: boolean
  outcome?: TurnOutcome | 'setup-failed' | 'failed'
  additions?: number
  deletions?: number
}

export interface CompareGroup {
  id: string
  prompt: string
  members: CompareMemberState[]
}

/** The state of one workspace in a comparison, from the numbers Foreman already keeps (F-1 outcome, F-2 turn delta). */
export function memberState(ws: Workspace, sessions: Session[]): CompareMemberState {
  const session = sessions.find((s) => s.id === ws.compare?.sessionId) ?? sessions.find((s) => !s.closedAt)
  const label = ws.compare?.label ?? ws.name
  if (ws.state === 'error') return { ws, session, label, finished: true, outcome: 'failed' }
  if (ws.state === 'setup-failed') return { ws, session, label, finished: true, outcome: 'setup-failed' }
  const last = session?.lastTurn
  if (!session || session.status !== 'idle' || !last) return { ws, session, label, finished: false }
  return { ws, session, label, finished: true, outcome: last.outcome, additions: last.additions, deletions: last.deletions }
}

/** Live comparisons, in the order their first workspace was created. A group of one isn't a comparison. */
export function compareGroups(workspaces: Workspace[], sessions: Session[]): CompareGroup[] {
  const groups = new Map<string, CompareGroup>()
  for (const ws of workspaces) {
    if (!ws.compareId || ws.state === 'archived') continue
    const group = groups.get(ws.compareId) ?? { id: ws.compareId, prompt: ws.compare?.prompt ?? '', members: [] }
    group.members.push(memberState(ws, sessions.filter((s) => s.workspaceId === ws.id)))
    groups.set(ws.compareId, group)
  }
  return [...groups.values()].filter((g) => g.members.length > 1)
}

/** The prompt, shortened for a heading. */
export function promptTitle(prompt: string, max = 40): string {
  const line = prompt.trim().split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** What one member contributes to the Home line: "+120 −8", "error", "stopped", or "…" while it runs. */
export function memberFigure(m: CompareMemberState, t: TFunction = enT): string {
  if (!m.finished) return '…'
  switch (m.outcome) {
    case 'completed':
      return m.additions !== undefined && m.deletions !== undefined ? `+${m.additions} −${m.deletions}` : t('compare.figure.completed')
    case 'cancelled':
      return t('compare.figure.stopped')
    case 'interrupted':
      return t('compare.figure.interrupted')
    default:
      return t('compare.figure.error')
  }
}

/** "Compare · 3 of 3 finished · +120 −8 / +95 −3 / error". Finished is not good: an error counts as finished. */
export function compareSummary(group: CompareGroup, t: TFunction = enT): string {
  const done = group.members.filter((m) => m.finished).length
  return t('compare.summary', { done, total: group.members.length, figures: group.members.map((m) => memberFigure(m, t)).join(' / ') })
}
