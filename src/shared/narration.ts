// The narrator: state in, sentences out (accessibility plan, phase E1). Pure functions that take a translate function
// first, so the renderer passes `useT()`'s `t`, main passes `mainT(settings)` and the CLI passes the English catalogue
// (its output is an intentional English-only surface). Narration says what the screen says and no more: a turn's own
// change figure when there is one, else the workspace's, labelled as such; checks only as the checks service recorded
// them, with "stale" when the tree has moved since; never "tests passed".
import { AGENTS } from './agents'
import { isFailure } from './checks'
import type { TFunction } from './i18n'
import { parseHunkHeader } from './splitDiff'
import { toolSummary, type ToolRoot } from './toolSummary'
import type { ApprovalRequest, DiffFile, DiffLine, Session, TurnOutcome, Workspace, WorkspaceChecks } from './types'

/** A change figure. `files` is a count, or the list of files (a TurnDelta's). */
export interface NarratedDelta {
  additions: number
  deletions: number
  files?: number | readonly unknown[]
}

/** How a chat's agent is named in a sentence ("Claude Code", "Codex"). */
export type AgentLabel = (agent: string) => string

const defaultAgentLabel: AgentLabel = (agent) => (AGENTS as Record<string, { label: string } | undefined>)[agent]?.label ?? agent

const join = (t: TFunction, parts: readonly string[]): string => parts.reduce((a, b) => t('narration.join', { a, b }))

const filesIn = (delta: NarratedDelta): number | undefined => (delta.files === undefined ? undefined : typeof delta.files === 'number' ? delta.files : delta.files.length)

const changed = (delta: NarratedDelta | undefined): delta is NarratedDelta => Boolean(delta && (delta.additions || delta.deletions))

/** One line of text for speech: runs of whitespace (and line breaks) become one space; a very long one is cut with an ellipsis. */
export function oneLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

// ---- checks ----

/**
 * What the checks say, as words: "12 passed", "2 failed, 10 passed", "running", "3 passed, stale". Null when there is
 * nothing to say (never run, or no results). A stopped or timed-out run is "did not finish" or "failed", never passed.
 */
export function checksSummary(t: TFunction, checks: WorkspaceChecks | undefined): string | null {
  if (!checks) return null
  if (checks.running) return t('narration.checks.running')
  const { results } = checks
  if (!results.length) return null
  const failed = results.filter(isFailure).length
  const passed = results.filter((r) => r.status === 'passed').length
  const other = results.length - failed - passed
  const parts: string[] = []
  if (failed) parts.push(t('narration.checks.failed', { count: failed }))
  if (passed) parts.push(t('narration.checks.passed', { count: passed }))
  if (other) parts.push(t('narration.checks.incomplete', { count: other }))
  const summary = join(t, parts)
  return checks.stale ? t('narration.checks.stale', { summary }) : summary
}

// ---- a turn ended ----

const TURN_LEAD = {
  completed: 'narration.turn.completed',
  error: 'narration.turn.error',
  cancelled: 'narration.turn.cancelled',
  interrupted: 'narration.turn.interrupted'
} as const satisfies Record<TurnOutcome, string>

/** A turn that has not ended (a wait that gave up): "Claude is still working in api-fix." */
export function turnRunning(t: TFunction, input: { agent: string; workspace: string }): string {
  return t('narration.turn.sentence', { lead: t('narration.turn.running', input) })
}

export interface TurnEndedInput {
  agent: string
  workspace: string
  outcome: TurnOutcome
  // What this turn changed, when it was measured. Present, it is the only figure given (zero changes say nothing).
  delta?: NarratedDelta
  // The whole workspace's figure, used only when the turn has none.
  workspaceDelta?: NarratedDelta
  checks?: WorkspaceChecks
}

/** "Claude finished in api-fix: this turn 3 files, +120 -14. Checks: 12 passed." Failed and stopped turns say so the same way. */
export function turnEnded(t: TFunction, input: TurnEndedInput): string {
  const lead = t(TURN_LEAD[input.outcome], { agent: input.agent, workspace: input.workspace })
  let changes: string | undefined
  if (input.delta) {
    if (changed(input.delta)) {
      const files = filesIn(input.delta)
      const { additions, deletions } = input.delta
      changes = files === undefined ? t('narration.changes.turnLines', { additions, deletions }) : t('narration.changes.turn', { files: t('narration.files', { count: files }), additions, deletions })
    }
  } else if (changed(input.workspaceDelta)) {
    const files = filesIn(input.workspaceDelta)
    const { additions, deletions } = input.workspaceDelta
    changes = files === undefined ? t('narration.changes.workspaceLines', { additions, deletions }) : t('narration.changes.workspace', { files: t('narration.files', { count: files }), additions, deletions })
  }
  const sentence = changes ? t('narration.turn.sentenceChanges', { lead, changes }) : t('narration.turn.sentence', { lead })
  const checks = checksSummary(t, input.checks)
  return checks ? `${sentence} ${t('narration.checks.sentence', { summary: checks })}` : sentence
}

// ---- something needs you ----

type Kind = ApprovalRequest['kind']

/** A question outranks a plan outranks a tool approval: the one that says the most about what is wanted. */
const RANK: Record<Kind, number> = { question: 0, plan: 1, tool: 2 }

/** MCP tools are named `mcp__server__tool`; say the tool. */
const toolLabel = (name: string): string => name.replace(/^mcp__[^_]+__/, '')

/** How many steps a plan lists: its numbered items, else its bullets, at the outermost indent (code blocks ignored). */
export function planSteps(plan: string): number {
  const lines = plan.replace(/```[\s\S]*?(```|$)/g, '').split('\n')
  const count = (marker: RegExp): number => {
    const items = lines.map((line) => marker.exec(line)).filter((m): m is RegExpExecArray => m !== null)
    if (!items.length) return 0
    const indents = items.map((m) => m[1].replace(/\t/g, '    ').length)
    const outer = Math.min(...indents)
    return indents.filter((n) => n === outer).length
  }
  return count(/^(\s*)\d+[.)]\s+\S/) || count(/^(\s*)[-*+]\s+\S/)
}

export interface NeedsYouContext {
  agent: string
  workspace: string
  // The workspace folder, so a file path reads relative to it.
  root?: ToolRoot
}

/** The words for one request: "Claude in api-fix wants to run Bash: npm test", "... has a question: ...", "... has a plan, 6 steps". */
export function needsYou(t: TFunction, approval: ApprovalRequest, context: NeedsYouContext): string {
  const { agent, workspace } = context
  switch (approval.kind) {
    case 'tool': {
      const tool = toolLabel(approval.toolName)
      const summary = oneLine(toolSummary(approval.toolName, approval.input, context.root ?? '', t))
      if (!summary) return t('narration.needs.useBare', { agent, workspace, tool })
      return t(approval.toolName === 'Bash' ? 'narration.needs.run' : 'narration.needs.use', { agent, workspace, tool, summary })
    }
    case 'question': {
      const question = oneLine(approval.questions[0]?.question ?? '')
      if (!question) return t('narration.needs.questionBare', { agent, workspace })
      return approval.questions.length > 1
        ? t('narration.needs.questions', { agent, workspace, count: approval.questions.length, question })
        : t('narration.needs.question', { agent, workspace, question })
    }
    case 'plan': {
      const steps = planSteps(approval.plan)
      return steps ? t('narration.needs.plan', { agent, workspace, count: steps }) : t('narration.needs.planBare', { agent, workspace })
    }
  }
}

export interface WhatNeedsMeInput {
  sessions: readonly Session[]
  approvals: readonly ApprovalRequest[]
  workspaces: readonly Workspace[]
  agentLabel?: AgentLabel
}

/**
 * Everything waiting on you: questions first, then plans, then tool approvals (each group in the order asked), and a
 * lead line to say first: "2 things need you" or "Nothing needs you".
 */
export function whatNeedsMe(t: TFunction, input: WhatNeedsMeInput): { lead: string; items: string[] } {
  const label = input.agentLabel ?? defaultAgentLabel
  const items = [...input.approvals]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])
    .flatMap((approval) => {
      const session = input.sessions.find((s) => s.id === approval.sessionId)
      if (!session || session.closedAt) return []
      const workspace = input.workspaces.find((w) => w.id === session.workspaceId)
      return [needsYou(t, approval, { agent: label(session.agent), workspace: workspace?.name ?? session.workspaceId, root: workspace?.path })]
    })
  return { lead: t('narration.needs.lead', { count: items.length }), items }
}

// ---- one workspace ----

const ENDED = {
  completed: 'narration.summary.completed',
  error: 'narration.summary.error',
  cancelled: 'narration.summary.cancelled',
  interrupted: 'narration.summary.interrupted'
} as const satisfies Record<TurnOutcome, string>

/** "just now", "2 minutes ago", "3 hours ago", "4 days ago". */
export function ago(t: TFunction, at: string | number | Date, now: number = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(at).getTime()) / 1000)
  if (!(seconds >= 60)) return t('narration.ago.justNow')
  if (seconds < 3600) return t('narration.ago.minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('narration.ago.hours', { count: Math.floor(seconds / 3600) })
  return t('narration.ago.days', { count: Math.floor(seconds / 86400) })
}

export interface PullRequestFact {
  number: number
  // 'OPEN', 'CLOSED' or 'MERGED' (any case); absent when only the number is known.
  state?: string
}

function pullRequestPhrase(t: TFunction, pr: PullRequestFact): string {
  switch (pr.state?.toUpperCase()) {
    case 'OPEN':
      return t('narration.pr.open', { number: pr.number })
    case 'CLOSED':
      return t('narration.pr.closed', { number: pr.number })
    case 'MERGED':
      return t('narration.pr.merged', { number: pr.number })
    default:
      return t('narration.pr', { number: pr.number })
  }
}

export interface WorkspaceSummaryInput {
  sessions: readonly Session[]
  approvals: readonly ApprovalRequest[]
  // The pull request, when the caller knows more than the workspace record does.
  pr?: PullRequestFact
  // Files the latest turn changed (the chat's last turn records lines only).
  turnFiles?: number
  // Why the workspace says it needs you when no request is waiting ("Checks failed"), in the caller's language.
  attention?: string
  now?: number
  agentLabel?: AgentLabel
}

/** One line: "api-fix: Claude finished 2 minutes ago, this turn 3 files +120 -14, checks 12 passed, PR #51 open." */
export function workspaceSummary(t: TFunction, workspace: Workspace, input: WorkspaceSummaryInput): string {
  const label = input.agentLabel ?? defaultAgentLabel
  const open = input.sessions.filter((s) => s.workspaceId === workspace.id && !s.closedAt)
  const waiting = input.approvals.filter((a) => open.some((s) => s.id === a.sessionId)).sort((a, b) => RANK[a.kind] - RANK[b.kind])[0]
  const parts: string[] = []
  if (waiting) {
    const agent = label(open.find((s) => s.id === waiting.sessionId)!.agent)
    parts.push(waitingPhrase(t, waiting, agent, workspace.path))
  } else {
    const running = open.find((s) => s.status === 'running')
    const latest = open.filter((s) => s.lastTurn).sort((a, b) => b.lastTurn!.endedAt.localeCompare(a.lastTurn!.endedAt))[0]
    if (running) parts.push(t('narration.summary.working', { agent: label(running.agent) }))
    else if (latest) {
      const last = latest.lastTurn!
      parts.push(t(ENDED[last.outcome], { agent: label(latest.agent), ago: ago(t, last.endedAt, input.now) }))
      const additions = last.additions ?? 0
      const deletions = last.deletions ?? 0
      if (additions || deletions) {
        parts.push(
          input.turnFiles === undefined
            ? t('narration.changes.turnLines', { additions, deletions })
            : t('narration.changes.turnCompact', { files: t('narration.files', { count: input.turnFiles }), additions, deletions })
        )
      }
    } else parts.push(t('narration.summary.idle'))
    if (input.attention) parts.push(t('narration.summary.attention', { label: input.attention }))
  }
  const checks = checksSummary(t, workspace.checks)
  if (checks) parts.push(t('narration.checks.phrase', { summary: checks }))
  const pr = input.pr ?? (workspace.prInfo ? { number: workspace.prInfo.number, state: workspace.prInfo.state } : workspace.pullRequest ? { number: workspace.pullRequest.number } : undefined)
  if (pr) parts.push(pullRequestPhrase(t, pr))
  const sentence = t('narration.summary.sentence', { workspace: workspace.name, text: join(t, parts) })
  // A line that ends on a question (or any mark of its own) keeps it instead of gaining a full stop.
  return /[.?!…。？！]$/.test(sentence) ? sentence : t('narration.summary.end', { sentence })
}

/** A waiting request as the workspace line says it (the workspace is already named at the start of the line). */
function waitingPhrase(t: TFunction, approval: ApprovalRequest, agent: string, root: ToolRoot | undefined): string {
  switch (approval.kind) {
    case 'tool': {
      const tool = toolLabel(approval.toolName)
      const summary = oneLine(toolSummary(approval.toolName, approval.input, root ?? '', t))
      if (!summary) return t('narration.summary.useBare', { agent, tool })
      return t(approval.toolName === 'Bash' ? 'narration.summary.run' : 'narration.summary.use', { agent, tool, summary })
    }
    case 'question': {
      const question = oneLine(approval.questions[0]?.question ?? '')
      if (!question) return t('narration.summary.questionBare', { agent })
      return approval.questions.length > 1 ? t('narration.summary.questions', { agent, count: approval.questions.length, question }) : t('narration.summary.question', { agent, question })
    }
    case 'plan': {
      const steps = planSteps(approval.plan)
      return steps ? t('narration.summary.plan', { agent, count: steps }) : t('narration.summary.planBare', { agent })
    }
  }
}

// ---- a diff ----

export interface NarratedFile {
  path: string
  status: DiffFile['status']
  additions: number
  deletions: number
  binary?: boolean
  oldPath?: string
}

const FILE_STATUS = {
  added: 'narration.file.status.added',
  deleted: 'narration.file.status.deleted',
  modified: 'narration.file.status.modified',
  renamed: 'narration.file.status.renamed'
} as const satisfies Record<DiffFile['status'], string>

/** "src/foo.ts, modified, 12 added, 3 removed": the same words the diff's file caption carries. */
export function fileSummary(t: TFunction, file: NarratedFile): string {
  const status = t(FILE_STATUS[file.status])
  if (file.binary) return t('narration.file.binary', { path: file.path, status })
  if (file.status === 'renamed' && file.oldPath) return t('narration.file.renamed', { path: file.path, oldPath: file.oldPath, added: file.additions, removed: file.deletions })
  return t('narration.file.counts', { path: file.path, status, added: file.additions, removed: file.deletions })
}

/** The whole diff: a lead ("3 files changed, +120 -14") and one line per file. */
export function diffSummary(t: TFunction, files: readonly NarratedFile[]): { lead: string; files: string[] } {
  const additions = files.reduce((n, f) => n + f.additions, 0)
  const deletions = files.reduce((n, f) => n + f.deletions, 0)
  return {
    lead: files.length ? t('narration.diff.lead', { count: files.length, additions, deletions }) : t('narration.diff.none'),
    files: files.map((f) => fileSummary(t, f))
  }
}

export interface NarratedHunk {
  // Counting from 1, and how many the file has.
  index: number
  count: number
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  // What follows the second `@@` in the header: arbitrary text git guessed at (often a function line), so it is only ever "near".
  context?: string
}

/** A hunk's numbers from its `@@ -a,b +c,d @@ context` header; null when the header isn't one. */
export function hunkFromHeader(header: string, index: number, count: number): NarratedHunk | null {
  const range = parseHunkHeader(header)
  if (!range) return null
  const context = header.replace(/^@@[^@]*@@/, '').trim()
  return { index, count, oldStart: range.oldStart, oldLines: range.oldCount, newStart: range.newStart, newLines: range.newCount, ...(context ? { context } : {}) }
}

/**
 * "Hunk 2 of 4, lines 40 to 58, near: handleLogin(". Lines are the new file's; a hunk that only removes says which old
 * lines went. With `path`, the file leads: "api.ts, hunk 2 of 4, lines 40 to 58".
 */
export function hunkSummary(t: TFunction, hunk: NarratedHunk, options: { path?: string } = {}): string {
  const { index, count } = hunk
  const parts = [options.path === undefined ? t('narration.hunk.title', { index, count }) : t('narration.hunk.inFile', { path: options.path, index, count })]
  if (hunk.newLines > 0) {
    parts.push(hunk.newLines === 1 ? t('narration.hunk.line', { line: hunk.newStart }) : t('narration.hunk.lines', { from: hunk.newStart, to: hunk.newStart + hunk.newLines - 1 }))
  } else if (hunk.oldLines > 0) {
    parts.push(hunk.oldLines === 1 ? t('narration.hunk.removedLine', { line: hunk.oldStart }) : t('narration.hunk.removedLines', { from: hunk.oldStart, to: hunk.oldStart + hunk.oldLines - 1 }))
  }
  const context = oneLine(hunk.context ?? '')
  if (context) parts.push(t('narration.hunk.near', { context }))
  return join(t, parts)
}

/** "added: const bp = 640; removed: const bp = 768": the hunk's changed lines as text, long groups cut short. */
export function hunkChanges(t: TFunction, lines: readonly Pick<DiffLine, 'type' | 'text'>[], maxLines = 6): string {
  const group = (type: 'add' | 'del', key: 'narration.hunk.added' | 'narration.hunk.removed'): string | null => {
    const picked = lines.filter((l) => l.type === type)
    if (!picked.length) return null
    const shown = picked.slice(0, maxLines).map((l) => oneLine(l.text, 200) || t('narration.hunk.blank'))
    if (picked.length > maxLines) shown.push(t('narration.hunk.more', { count: picked.length - maxLines }))
    return t(key, { text: shown.reduce((a, b) => t('narration.hunk.lineJoin', { a, b })) })
  }
  const added = group('add', 'narration.hunk.added')
  const removed = group('del', 'narration.hunk.removed')
  return added && removed ? t('narration.hunk.groups', { added, removed }) : (added ?? removed ?? '')
}

/**
 * `foreman diff --words`: the lead, then for each file its line, then for each hunk
 * "api.ts, hunk 2 of 4, lines 40 to 58: added: ...; removed: ...". One line each, for a reader that speaks lines as they arrive.
 */
export function diffLines(t: TFunction, files: readonly DiffFile[]): string[] {
  const { lead, files: perFile } = diffSummary(t, files)
  const out = [lead]
  files.forEach((file, i) => {
    out.push(perFile[i])
    file.hunks.forEach((hunk, h) => {
      const info = hunkFromHeader(hunk.header, h + 1, file.hunks.length) ?? { index: h + 1, count: file.hunks.length, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 }
      const summary = hunkSummary(t, info, { path: file.path })
      const changes = hunkChanges(t, hunk.lines)
      out.push(changes ? t('narration.hunk.sentence', { summary, changes }) : summary)
    })
  })
  return out
}
