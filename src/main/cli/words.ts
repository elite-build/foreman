// `--words`: the text output of `status`, `wait`, `diff` and `attention` as the narrator's sentences (accessibility plan,
// phases E1 and H), for a reader that speaks a line as it arrives (Emacspeak, a screen reader in a terminal). The
// sentences are English like the rest of the command line's text. The JSON a script reads is never touched: the command
// only asks for words when it prints text, and the answer carries them beside the data.
import { ago, diffLines, diffSummary, needsYou, turnEnded, turnRunning, whatNeedsMe, workspaceSummary } from '../../shared/narration'
import { createT } from '../../shared/i18n'
import { AGENTS } from '../../shared/agents'
import type { AttentionEvent } from '../../shared/attention'
import type { StatusResult, WaitResult } from '../../cli/protocol'
import type { ApprovalRequest, DiffFile, Session, Workspace } from '../../shared/types'
import type { CliHost } from './host'

const t = createT('en')

const agentLabel = (session: Session | undefined): string => (session ? (AGENTS[session.agent]?.label ?? session.agent) : 'An agent')

/** Did the request ask for words? Only a literal true counts. */
export function wantsWords(params: unknown): boolean {
  return Boolean(params && typeof params === 'object' && (params as { words?: unknown }).words === true)
}

/** `status` with words: the rows as before, and the text to print instead of the table. */
export interface StatusWordsResult {
  rows: StatusResult
  text: string
}

/** A lead line (how many things need you), then one sentence per workspace. */
export async function statusWords(host: CliHost, rows: StatusResult, now?: number): Promise<StatusWordsResult> {
  if (!rows.length) return { rows, text: 'No workspaces.' }
  const state = host.state()
  const approvals = host.approvals()
  const lines = [whatNeedsMe(t, { sessions: state.sessions, approvals, workspaces: state.workspaces }).lead]
  for (const row of rows) {
    const workspace = state.workspaces.find((w) => w.id === row.id)
    if (!workspace) continue
    // The chat records lines for its last turn, not files; the turn's own record has them when it can be read.
    const turnFiles = row.turn && row.turn.outcome !== 'running' && row.turn.id ? await filesOfTurn(host, row.turn.id) : undefined
    lines.push(workspaceSummary(t, workspace, { sessions: state.sessions, approvals, turnFiles, attention: row.bucket === 'attention' ? row.label : undefined, now }))
  }
  return { rows, text: lines.join('\n') }
}

async function filesOfTurn(host: CliHost, turnId: string): Promise<number | undefined> {
  try {
    return (await host.turnStatus(turnId))?.delta?.files.length
  } catch {
    return undefined
  }
}

/** The sentence a finished wait prints; a wait that gave up says the turn is still going. */
export function waitWords(host: CliHost, result: WaitResult): string {
  const state = host.state()
  const workspace = state.workspaces.find((w) => w.id === result.workspace.id)
  const agent = agentLabel(state.sessions.find((s) => s.id === result.session))
  if (result.outcome === 'timeout') return turnRunning(t, { agent, workspace: result.workspace.name })
  const stat = workspace?.diffStat
  const lines = [
    turnEnded(t, {
      agent,
      workspace: result.workspace.name,
      outcome: result.outcome,
      delta: result.delta,
      workspaceDelta: stat ? { additions: stat.additions, deletions: stat.deletions, files: stat.files } : undefined,
      checks: workspace?.checks
    })
  ]
  if (result.error) lines.push(`Error: ${result.error}`)
  return lines.join('\n')
}

/** The pending request, if any, of the chat an attention event is about (the most informative one first). */
function pendingFor(approvals: readonly ApprovalRequest[], sessionId: string | undefined): ApprovalRequest | undefined {
  const mine = approvals.filter((a) => a.sessionId === sessionId)
  return mine.find((a) => a.kind === 'question') ?? mine.find((a) => a.kind === 'plan') ?? mine[0]
}

/**
 * Home's Recent history as sentences, newest first as given: a turn that ended says how, a request still waiting says
 * what it is, anything else keeps the label and detail it was recorded with. Each line starts with how long ago.
 */
export function attentionWords(host: CliHost, events: readonly AttentionEvent[], seenAt: string | undefined, now?: number): string {
  if (!events.length) return 'Nothing has needed your attention lately.'
  const state = host.state()
  const approvals = host.approvals()
  const workspaceName = (id: string): string => state.workspaces.find((w: Workspace) => w.id === id)?.name ?? id
  return events
    .map((e) => {
      const session = state.sessions.find((s) => s.id === e.sessionId)
      const workspace = workspaceName(e.workspaceId)
      let text: string
      const waiting = e.kind === 'reason' && e.reasonId === 'approvals' ? pendingFor(approvals, e.sessionId) : undefined
      if (e.kind === 'turn-ended' && e.outcome) text = turnEnded(t, { agent: agentLabel(session), workspace, outcome: e.outcome })
      else if (waiting) text = needsYou(t, waiting, { agent: agentLabel(session), workspace, root: state.workspaces.find((w) => w.id === e.workspaceId)?.path })
      else text = [workspace, [e.label, e.detail].filter(Boolean).join(': ')].filter(Boolean).join(', ')
      const repeats = e.count > 1 ? ` (${e.count} times)` : ''
      const fresh = !seenAt || e.at > seenAt ? ' (new)' : ''
      return `${ago(t, e.at, now)}: ${text}${repeats}${fresh}`
    })
    .join('\n')
}

/** `diff` with words, for a source that has the patch. Nothing to show keeps its reason (`fallback`). */
export function diffWords(files: readonly DiffFile[], options: { truncated?: boolean; fallback: string }): string {
  if (!files.length) return options.fallback
  const note = options.truncated ? '\n… the diff was cut at 4 MB; ask for one source or file at a time' : ''
  return diffLines(t, files).join('\n') + note
}

/** `diff --scope turn:<id>` with words: a turn is kept as counts per file, so the lead and a line per file. */
export function turnDiffWords(files: readonly { path: string; additions: number; deletions: number }[]): string {
  const { lead, files: perFile } = diffSummary(
    t,
    files.map((f) => ({ ...f, status: 'modified' as const }))
  )
  return [lead, ...perFile, '(Counts only: Foreman keeps what a turn changed per file, not the patch.)'].join('\n')
}
