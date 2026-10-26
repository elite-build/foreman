// What `foreman status` reports for each workspace: the same triage bucket the
// sidebar uses, plus the facts a script wants (last turn, checks, delta, PR).
import { isFailure } from './checks'
import { triageAll, type Bucket, type TriageInput } from './triage'
import type { AppSnapshot, PullRequestInfo, Session, TurnOutcome, Workspace } from './types'

export type ChecksState = 'passed' | 'failed' | 'stale' | 'running' | 'incomplete' | 'none'

export interface StatusRow {
  workspace: string
  id: string
  repo: string
  branch: string
  bucket: Bucket
  // What the row says it needs ("Checks failed", "Working"), when it says anything.
  label?: string
  // The newest turn across the workspace's open chats. 'running' while one is in flight.
  turn?: { id?: string; tab: number; outcome: TurnOutcome | 'running'; endedAt?: string }
  checks: ChecksState
  // What the latest turn changed, when it was measured.
  delta?: { additions: number; deletions: number }
  pr?: { number: number; state?: PullRequestInfo['state']; url?: string }
}

/** passed / failed / stale / running / none. Stopped runs read "incomplete", never "passed". */
export function checksState(checks: Workspace['checks']): ChecksState {
  if (!checks) return 'none'
  if (checks.running) return 'running'
  if (!checks.results.length) return 'none'
  if (checks.stale) return 'stale'
  if (checks.results.some(isFailure)) return 'failed'
  if (checks.results.some((r) => r.status !== 'passed')) return 'incomplete'
  return 'passed'
}

export function pullRequestUrl(ws: Workspace): string | undefined {
  if (ws.prInfo?.url) return ws.prInfo.url
  if (ws.pullRequest && (!ws.prInfo || ws.prInfo.number === ws.pullRequest.number)) return `https://github.com/${ws.pullRequest.repo}/pull/${ws.pullRequest.number}`
  return undefined
}

/** One row per live workspace, in triage order (needs you first). */
export function statusRows(input: Omit<TriageInput, 'snapshot'> & { snapshot: { workspaces: Workspace[]; sessions: Session[] } }, repoNames: Record<string, string>): StatusRow[] {
  const order: Bucket[] = ['attention', 'working', 'idle', 'finished']
  // Triage reads only workspaces and chats from the snapshot.
  return triageAll({ ...input, snapshot: input.snapshot as AppSnapshot }, null)
    .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || a.since.localeCompare(b.since))
    .map((t): StatusRow => {
      const { ws } = t
      const open = input.snapshot.sessions.filter((s) => s.workspaceId === ws.id && !s.closedAt)
      const running = open.find((s) => s.status === 'running')
      const latest = open.filter((s) => s.lastTurn).sort((a, b) => b.lastTurn!.endedAt.localeCompare(a.lastTurn!.endedAt))[0]
      const subject = running ?? latest
      const row: StatusRow = {
        workspace: ws.name,
        id: ws.id,
        repo: repoNames[ws.repoId] ?? ws.repoId,
        branch: ws.branch,
        bucket: t.bucket,
        label: t.label,
        checks: checksState(ws.checks)
      }
      if (subject) {
        const tab = open.indexOf(subject) + 1
        row.turn = running
          ? { id: running.turnId, tab, outcome: 'running' }
          : { id: latest.lastTurn!.turnId, tab, outcome: latest.lastTurn!.outcome, endedAt: latest.lastTurn!.endedAt }
        const last = running ? undefined : latest.lastTurn!
        if (last?.additions !== undefined && last.deletions !== undefined) row.delta = { additions: last.additions, deletions: last.deletions }
      }
      const number = input.prs?.[ws.id] ?? ws.prInfo?.number ?? ws.pullRequest?.number
      if (number !== undefined) row.pr = { number, state: ws.prInfo?.number === number ? ws.prInfo.state : undefined, url: pullRequestUrl(ws) }
      return row
    })
}

const OUTCOME_TEXT: Record<TurnOutcome | 'running', string> = {
  running: 'running',
  completed: 'completed',
  error: 'failed',
  cancelled: 'stopped',
  interrupted: 'interrupted'
}

/** The human table for a terminal. */
export function statusTable(rows: StatusRow[]): string {
  if (!rows.length) return 'No workspaces.'
  const cells = rows.map((r) => [
    r.workspace,
    r.bucket === 'attention' ? `needs you${r.label ? `: ${r.label}` : ''}` : r.bucket === 'working' ? 'working' : r.bucket,
    r.turn ? `tab ${r.turn.tab} ${OUTCOME_TEXT[r.turn.outcome]}` : '-',
    r.checks,
    r.delta ? `+${r.delta.additions} -${r.delta.deletions}` : '-',
    r.pr ? `#${r.pr.number}${r.pr.state ? ` ${r.pr.state.toLowerCase()}` : ''}` : '-'
  ])
  const head = ['WORKSPACE', 'STATE', 'LAST TURN', 'CHECKS', 'DELTA', 'PR']
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)))
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd()
  return [line(head), ...cells.map(line)].join('\n')
}
