// #2 Agent reports and "Teach agents Foreman". An agent says, in one line, that it
// needs input, is stuck, reached a checkpoint or is done (or asks for a review);
// Foreman keeps the words as the agent's, attributed to its tab and turn when the
// call proved which turn it came from. Pure: the rules here are shared by the main
// process (recording), the renderer (Home, chat, settings preview) and the tests.
// Nothing here writes into the repository: reports live in foreman.db, and the
// instructions go to the agent through its system prompt.
import type { AgentKind } from './agents'
import type { PromptTemplate } from './types'

export const REPORT_KINDS = ['needs-input', 'stuck', 'checkpoint', 'done'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value)
}

// Longest report text kept; an agent's one line, not a document.
export const MAX_REPORT_TEXT = 500
// Closed reports kept per workspace as history (open ones are always kept).
export const REPORT_HISTORY = 20

/** One report or review request, as Foreman stores it on the workspace. */
export interface AgentReport {
  id: string
  kind: ReportKind | 'review'
  // The agent's words, never Foreman's judgement.
  text: string
  // An http(s) link the agent gave with it.
  link?: string
  at: string
  workspaceId: string
  // The tab and turn it came from: a valid turn token, or Foreman's own tool in that turn. Absent: the workspace only.
  sessionId?: string
  turnId?: string
  // Foreman's MCP tool (Claude) or the `foreman` command.
  via: 'mcp' | 'cli'
  // The call carried a turn token Foreman didn't recognise, so it counts for the workspace only.
  badToken?: boolean
  // Sent after its turn had ended: history, labelled "from an earlier turn". It never opens or clears anything.
  late?: boolean
  // Why it stopped being open. Absent while a needs-input, stuck or review request is open.
  closed?: { how: 'replied' | 'dismissed' | 'superseded' | 'opened'; at: string }
}

/** What a report adds to the chat: a quiet marker, or (needs-input) a card while it stays open. Kept on a notice item. */
export type ReportMarker = Pick<AgentReport, 'id' | 'kind' | 'text' | 'link' | 'at' | 'via' | 'late'>

/** needs-input and stuck stay on Home until answered; checkpoint and done are only markers. */
export function isBlocker(kind: AgentReport['kind']): kind is 'needs-input' | 'stuck' {
  return kind === 'needs-input' || kind === 'stuck'
}

/** Open: a blocker or review request nobody has answered, dismissed or superseded. */
export function isOpen(report: AgentReport): boolean {
  return !report.closed && !report.late && (isBlocker(report.kind) || report.kind === 'review')
}

export function openReports(reports: AgentReport[] | undefined): AgentReport[] {
  return (reports ?? []).filter(isOpen)
}

/** One line of the agent's words: whitespace folded, capped. */
export function cleanReportText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_REPORT_TEXT ? `${flat.slice(0, MAX_REPORT_TEXT - 1)}…` : flat
}

/** An http(s) URL, or undefined (anything else isn't kept). */
export function cleanLink(link: string | undefined): string | undefined {
  if (!link?.trim()) return undefined
  try {
    const url = new URL(link.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** The same tab (or, for unattributed reports, the workspace itself). */
const sameSource = (a: AgentReport, b: AgentReport) => a.workspaceId === b.workspaceId && (a.sessionId ?? null) === (b.sessionId ?? null)

function trimHistory(list: AgentReport[]): AgentReport[] {
  const closed = list.filter((r) => !isOpen(r))
  if (closed.length <= REPORT_HISTORY) return list
  const drop = new Set(closed.slice(0, closed.length - REPORT_HISTORY))
  return list.filter((r) => !drop.has(r))
}

export interface Recorded {
  list: AgentReport[]
  // false: the same words from the same turn again, so nothing changed (and no new marker).
  added: boolean
}

/**
 * Add a report to a workspace's list. The rules:
 * - the same kind and words again from the same turn is a duplicate (a chatty agent can't flood Home);
 * - a later needs-input, stuck or done from the same tab supersedes its open blocker (one per tab);
 *   a checkpoint never clears one;
 * - a review request replaces the tab's earlier open one;
 * - a late report (its turn had ended) is history: it neither opens nor clears anything.
 */
export function recordReport(list: AgentReport[] | undefined, report: AgentReport): Recorded {
  const current = list ?? []
  const duplicate = current.some((r) => r.kind === report.kind && r.text === report.text && sameSource(r, report) && (r.turnId ?? null) === (report.turnId ?? null) && Boolean(r.late) === Boolean(report.late))
  if (duplicate) return { list: current, added: false }
  const closes = (r: AgentReport) => {
    if (report.late || !isOpen(r) || !sameSource(r, report)) return false
    if (report.kind === 'review') return r.kind === 'review'
    return isBlocker(r.kind) && report.kind !== 'checkpoint'
  }
  const next = current.map((r) => (closes(r) ? { ...r, closed: { how: 'superseded' as const, at: report.at } } : r))
  return { list: trimHistory([...next, report]), added: true }
}

/**
 * The user replied in a tab: its open blockers are answered. A reply in any tab also
 * answers blockers that came without a tab (sent with no turn token).
 */
export function answerReports(list: AgentReport[] | undefined, sessionId: string, at: string): { list: AgentReport[]; changed: boolean } {
  let changed = false
  const next = (list ?? []).map((r) => {
    if (!isOpen(r) || !isBlocker(r.kind) || (r.sessionId !== undefined && r.sessionId !== sessionId)) return r
    changed = true
    return { ...r, closed: { how: 'replied' as const, at } }
  })
  return { list: changed ? trimHistory(next) : list ?? [], changed }
}

/** Dismiss (or, for a review request, "opened": the review was started from it). It goes to history, not away. */
export function closeReport(list: AgentReport[] | undefined, id: string, how: 'dismissed' | 'opened', at: string): { list: AgentReport[]; changed: boolean } {
  let changed = false
  const next = (list ?? []).map((r) => {
    if (r.id !== id || !isOpen(r)) return r
    changed = true
    return { ...r, closed: { how, at } }
  })
  return { list: changed ? trimHistory(next) : list ?? [], changed }
}

/** The chat line for a report: "agent says: checkpoint — migrated 3 of 5 tables". */
export function reportLine(report: Pick<AgentReport, 'kind' | 'text' | 'late'>): string {
  const kind = report.kind === 'review' ? 'asks for a review' : report.kind.replace('-', ' ')
  return `agent says: ${kind}${report.text ? ` — ${report.text}` : ''}${report.late ? ' (from an earlier turn)' : ''}`
}

/** The Code review dialog's message, filled in from a worker's `foreman review` (the agent's words, quoted as such). */
export function withReviewRequest(message: string, request: string | undefined): string {
  const what = request?.trim()
  if (!what) return message
  return `${message.trimEnd()}\n\nThe agent that did this work asked for a review and says to check: ${what}`
}

/** A finished tool call that only made a report: the chat folds it into the report's own marker. */
export function isReportCall(item: { name: string; input: unknown; status: string }): boolean {
  if (item.status !== 'done') return false
  if (item.name === 'mcp__foreman__report' || item.name === 'mcp__foreman__request_review') return true
  // G1: Cursor's calls to its SDK custom tools (the "custom-user-tools" server).
  if (item.name === 'mcp__custom-user-tools__report' || item.name === 'mcp__custom-user-tools__request_review') return true
  const command = (item.input as { command?: unknown } | null)?.command
  return (item.name === 'Bash' || item.name === 'shell' || item.name === 'command') && typeof command === 'string' && /^\s*foreman\s+(report|review)\b[^;&|\n]*$/.test(command)
}

// ---- turn identity ----

/** The variables every agent turn gets, so `foreman report` can say which tab and turn it came from. */
export const TURN_ENV = { session: 'FOREMAN_SESSION_ID', turn: 'FOREMAN_TURN_ID', token: 'FOREMAN_TURN_TOKEN' } as const

/** Who a `foreman` call says it is, read from those variables. Attribution only: an agent can leave them out. */
export interface TurnCaller {
  sessionId?: string
  turnId?: string
  token?: string
}

/** The caller from an environment, or undefined when it carries no token. */
export function callerFromEnv(env: Record<string, string | undefined>): TurnCaller | undefined {
  const token = env[TURN_ENV.token]?.trim()
  if (!token) return undefined
  return { sessionId: env[TURN_ENV.session]?.trim() || undefined, turnId: env[TURN_ENV.turn]?.trim() || undefined, token }
}

/** Remove turn identity inherited from a parent process (Foreman started from an agent's shell): only agent turns carry it. */
export function withoutTurnIdentity<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env }
  for (const name of Object.values(TURN_ENV)) delete out[name]
  return out
}

// ---- "Teach agents Foreman" ----

export interface TeachCapabilities {
  agent: AgentKind
  // The `foreman` command is installed (on the user's PATH).
  cli: boolean
  // The repo opted in to "Let agents start workspaces and queue messages".
  mayStart: boolean
  // The repo runs its checks after a completed turn.
  checksAfterTurn: boolean
}

export interface TeachText {
  // Empty when this agent can use nothing (no Foreman tools, no command).
  text: string
  // What it lists, for the receipt: report, review, run, send.
  commands: string[]
  // Through Foreman's MCP tools (Claude) or the `foreman` command.
  via: 'tools' | 'cli' | 'none'
}

/**
 * Claude Code gets reports and review requests as tools on Foreman's in-process MCP server. G1: Cursor gets the same
 * two as the Cursor SDK's in-process `customTools` (untested without a Cursor key), so its reports land on the tab too.
 */
export function hasReportTools(agent: AgentKind): boolean {
  return agent === 'claude' || agent === 'cursor'
}

/**
 * The instructions "Teach agents Foreman" adds to an agent's system prompt, filtered to
 * what this agent can really use: only commands that work are listed, and commands it
 * may not use are left out rather than marked "not allowed".
 */
export function teachText(caps: TeachCapabilities): TeachText {
  const tools = hasReportTools(caps.agent)
  if (!tools && !caps.cli) return { text: '', commands: [], via: 'none' }
  const lines = ['# Working in Foreman', 'You are one of several agents the user runs in parallel. Foreman shows them', 'what needs their attention.']
  if (tools) {
    lines.push(
      'Tell it when something changes, with Foreman\'s `report` tool (one line each):',
      '',
      '  report needs-input   you can\'t continue without the user',
      '  report stuck         you tried, and you\'re blocked',
      '  report checkpoint    after a meaningful step',
      '  report done          the task is finished',
      '',
      'To ask for a second look, call `request_review` with what to check.'
    )
  } else {
    lines.push(
      'Tell it when something changes, in one line:',
      '',
      '  foreman report needs-input "<question>"   can\'t continue without the user',
      '  foreman report stuck "<why>"              tried, and blocked',
      '  foreman report checkpoint "<progress>"   after a meaningful step',
      '  foreman report done "<summary>"         the task is finished',
      '',
      'To ask for a second look: foreman review "<what to check>"'
    )
  }
  lines.push('It doesn\'t start a reviewer. The user decides.', 'Reports are shown as "agent says". Don\'t use them for routine progress.')
  const commands = ['report', 'review']
  if (caps.cli) {
    lines.push(
      '',
      caps.checksAfterTurn
        ? 'Foreman runs this repository\'s checks after your turn ends. Don\'t run `foreman checks` during your turn: it answers "busy" while you work.'
        : 'Don\'t run `foreman checks` during your turn: it answers "busy" while you work.'
    )
  }
  if (caps.cli && caps.mayStart) {
    lines.push(
      '',
      'Only when the user asks you to:',
      '  foreman run <template> "<task>" --base <branch>   start a new workspace',
      '  foreman send <workspace> --tab <n> "<message>"    queue a message in another tab'
    )
    commands.push('run', 'send')
  }
  return { text: lines.join('\n'), commands, via: tools ? 'tools' : 'cli' }
}

/** Bytes of UTF-8, for "1.1 KB" in the receipt and the settings preview. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// ---- "Plan the work" ----

export const PLAN_TEMPLATE_ID = 'default-plan-the-work'
export const PLAN_STEP_TEMPLATE_ID = 'default-work-on-a-task'
export const PLAN_STEP_SLUG = 'work-on-a-task'

/** The step each proposal starts: the task itself, in a workspace of its own. */
export const PLAN_STEP_TEMPLATE: PromptTemplate = {
  id: PLAN_STEP_TEMPLATE_ID,
  name: 'Work on a task',
  body: '{{task}}\n\nKeep the change to this task. Run the relevant tests before you finish.'
}

/**
 * A lead chat that splits a goal into workspaces. Its answer ends with one runnable
 * `foreman run … --base …` line per piece, so the user starts each by clicking Run in
 * the chat (the snippet runner carries no turn token: that's the user's call).
 */
export const PLAN_TEMPLATE: PromptTemplate = {
  id: PLAN_TEMPLATE_ID,
  name: 'Plan the work',
  body: [
    'Plan the work for: {{goal}}',
    '',
    'Read the code you need to understand it, but don\'t change any files. Split the work into a few independent pieces that can each go in their own workspace and branch without stepping on each other. For each piece, say what it changes, which files it likely touches, and what it depends on.',
    '',
    'End your answer with one shell code block, one line per piece, so I can start each one by clicking Run:',
    '',
    '```sh',
    `foreman run ${PLAN_STEP_SLUG} "<what this piece should do, in one paragraph>" --base <this workspace's base branch>`,
    '```',
    '',
    'Don\'t run these commands yourself. I decide which ones to start.'
  ].join('\n')
}

/** The templates "Add to Automations" adds: the ones not there yet (matched by id). */
export function missingPlanTemplates(templates: PromptTemplate[]): PromptTemplate[] {
  return [PLAN_TEMPLATE, PLAN_STEP_TEMPLATE].filter((t) => !templates.some((have) => have.id === t.id))
}
