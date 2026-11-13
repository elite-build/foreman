// An AI employee's outward actions (docs/ai-employees.md §5.1 `access.actions`, §9 "Outward actions"): what one of
// Foreman's brokered routes (the bridged foreman-slack and foreman-linear tools, Foreman's own push and pull request) is
// asked to do by an employee's run, recorded before anything is sent and then sent at once, held for a person's Send or
// Skip, or refused, as the employee's approved definition says for that class. The records live in foreman.db
// (main/employeeActions.ts); this file holds their shapes, the policy rule, what a person may edit, and the words the
// model and the task's record read. Pure. Unbrokered routes (a shell, another MCP server, a browser) never come here:
// they can't be held, which the approval plan says.
import type { EmployeeActionPolicy, EmployeeDefinition } from './employees'

/**
 * The brokered outward routes (§9) a new employee lists, each held: bridged Slack and Linear, Foreman's push and pull
 * requests. Here, not in shared/employees.ts (which re-exports it), so code that reads only the actions' rules (the
 * agent drivers, which the cloud sandbox host bundles too) never pulls in the definition's TOML parser.
 */
export const EMPLOYEE_ACTIONS = ['slack-post', 'linear', 'push', 'pull-request'] as const

/** A brokered outward route (§9): bridged Slack and Linear, Foreman's push and pull requests. */
export type EmployeeActionKind = (typeof EMPLOYEE_ACTIONS)[number]

export const isActionKind = (kind: string): kind is EmployeeActionKind => (EMPLOYEE_ACTIONS as readonly string[]).includes(kind)

/**
 * held: recorded, waiting for a person's Send or Skip. approved: on its way (allowed by the definition, or a person
 * pressed Send); recorded before the service is asked, so a crash after this is uncertain, never a blind resend. sent:
 * the service confirmed it. skipped: a person skipped it (or its task was canceled first). failed: the service refused or
 * Foreman couldn't send it. refused: the definition never allows it, or its connection is missing. uncertain: Foreman
 * closed (or the service stopped answering) after asking: it may have gone, so a person checks first.
 */
export type EmployeeActionState = 'held' | 'approved' | 'sent' | 'skipped' | 'failed' | 'refused' | 'uncertain'
export const EMPLOYEE_ACTION_STATES: readonly EmployeeActionState[] = ['held', 'approved', 'sent', 'skipped', 'failed', 'refused', 'uncertain']

/** States a person acts on in Needs you: Send or Skip a held one, check an uncertain one, send a failed one again. */
export const ACTION_NEEDS_PERSON: readonly EmployeeActionState[] = ['held', 'uncertain', 'failed']
/** States that keep a push's or pull request's workspace from being archived: it may still be sent from there. */
export const ACTION_KEEPS_WORKSPACE: readonly EmployeeActionState[] = ['held', 'approved', 'uncertain', 'failed']

/** One commit ahead of the base, as a preview lists it. */
export interface ActionCommit {
  sha: string
  subject: string
}

/** What a diff against the base changes, as `git diff --shortstat` says it. */
export interface ActionDiffStat {
  files: number
  insertions: number
  deletions: number
}

interface ConnectionPart {
  // The repository's selected connection the action was recorded for (never another account), and its name then. No
  // token or key is ever kept: only the id the vault holds it under.
  connectionId?: string
  connection: string
}

export interface SlackPostPayload extends ConnectionPart {
  kind: 'slack-post'
  channel: string
  channelName?: string
  text: string
}

export interface LinearPayload extends ConnectionPart {
  kind: 'linear'
  // The Linear MCP tool and its arguments, as the run gave them.
  tool: string
  args: Record<string, unknown>
  // The issue it changes, when its arguments name one.
  issue?: string
}

export interface PushPayload extends ConnectionPart {
  kind: 'push'
  workspaceId: string
  branch: string
  base: string
  head: string
  ahead: number
  commits: ActionCommit[]
}

export interface PullRequestPayload extends ConnectionPart {
  kind: 'pull-request'
  workspaceId: string
  branch: string
  base: string
  head: string
  ahead: number
  commits: ActionCommit[]
  diffStat?: ActionDiffStat
  title: string
  body: string
}

export type EmployeeActionPayload = SlackPostPayload | LinearPayload | PushPayload | PullRequestPayload

/** What sending it came to: where it went (a message link, a pull request), what the service said, or why it failed. */
export interface EmployeeActionResult {
  link?: string
  detail?: string
  error?: string
}

export interface EmployeeAction {
  id: string
  orgId: string
  employeeId: string
  taskId: string
  runId: string
  repoId: string | null
  kind: EmployeeActionKind
  // Exactly what is (or would be) sent: the destination, the account, the words.
  payload: EmployeeActionPayload
  // The definition's rule for the class when it was recorded.
  policy: EmployeeActionPolicy
  state: EmployeeActionState
  // The run and the exact payload, hashed: asking twice in a run finds this action instead of making another.
  key: string
  // Who let it go: the definition (allowed) or a person (Send). Absent until it is sent.
  decidedBy?: 'definition' | 'person'
  // A person changed its words before sending (Edit then send).
  edited?: true
  // Refused or skipped: why, in words.
  reason?: string
  result?: EmployeeActionResult
  createdAt: string
  updatedAt: string
  // When it was sent, and when it reached an end (sent, skipped, failed, refused).
  sentAt?: string
  settledAt?: string
}

/** The outcome of an action an employee's task is told on its next continuation (§6.4, "the employee is told"). */
export interface EmployeeActionNews {
  actionId: string
  kind: EmployeeActionKind
  summary: string
  state: EmployeeActionState
  edited?: true
  link?: string
  detail?: string
  at: string
}

// ---- the rule ----

const STRICTNESS: Record<EmployeeActionPolicy, number> = { allowed: 0, held: 1, never: 2 }

/**
 * The definition's rule for a class (§9): what it lists, and held when it lists nothing for it (a new employee lists all
 * four held; an outward action not listed is never allowed without a person). Opening a pull request pushes its branch,
 * so a pull request is never looser than the definition's rule for pushes.
 */
export function actionPolicy(definition: Pick<EmployeeDefinition, 'access'>, kind: EmployeeActionKind): EmployeeActionPolicy {
  const own = definition.access.actions[kind] ?? 'held'
  if (kind !== 'pull-request') return own
  const push = definition.access.actions.push ?? 'held'
  return STRICTNESS[push] > STRICTNESS[own] ? push : own
}

/** A sent Slack message, a pushed branch and an opened pull request can't be taken back; a Linear change can be changed back in Linear. */
export const CANT_UNDO: Record<EmployeeActionKind, boolean> = { 'slack-post': true, linear: false, push: true, 'pull-request': true }

/** The payload's words a person may change before sending (Edit then send): text only, never where it goes or as whom. */
const LINEAR_TEXT = ['title', 'description', 'body'] as const

export function editableFields(payload: EmployeeActionPayload): string[] {
  switch (payload.kind) {
    case 'slack-post':
      return ['text']
    case 'pull-request':
      return ['title', 'body']
    case 'linear':
      return LINEAR_TEXT.filter((f) => typeof payload.args[f] === 'string')
    case 'push':
      return []
  }
}

export const MAX_ACTION_TEXT = { text: 4000, title: 256, description: 60_000, body: 60_000 } as const

/**
 * The payload with a person's edits laid over its text fields. A field that isn't editable for the kind (a channel, an
 * issue, a branch) is refused, as is an empty text or one past its length.
 */
export function applyEdits(payload: EmployeeActionPayload, edits: Record<string, string>): EmployeeActionPayload {
  const allowed = editableFields(payload)
  for (const [field, value] of Object.entries(edits)) {
    if (!allowed.includes(field)) throw new Error(`“${field}” can’t be edited: only the words are, never where it goes.`)
    if (typeof value !== 'string') throw new Error(`“${field}” must be text.`)
    const max = MAX_ACTION_TEXT[field as keyof typeof MAX_ACTION_TEXT] ?? 4000
    if (value.length > max) throw new Error(`Keep “${field}” under ${max} characters.`)
    if (field !== 'body' && field !== 'description' && !value.trim()) throw new Error(`“${field}” can’t be empty.`)
  }
  if (!Object.keys(edits).length) return payload
  if (payload.kind === 'linear') return { ...payload, args: { ...payload.args, ...edits } }
  return { ...payload, ...edits } as EmployeeActionPayload
}

/** The issue a Linear tool's arguments name, if any. */
export function linearIssue(args: Record<string, unknown>): string | undefined {
  for (const key of ['identifier', 'issueId', 'issue', 'id']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80)
  }
  return undefined
}

/** The exact payload as one stable text (keys sorted), for the action's key: the same request twice is the same action. */
export function canonicalPayload(payload: EmployeeActionPayload): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v
  return JSON.stringify(sort(payload))
}

// ---- words (English: the model, the task's record and the main process's reasons read them) ----

const oneLine = (s: string, max = 80) => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** "a Slack post to #launches", "the Linear change save_comment on ENG-12", "a push of feature/x (3 commits)". */
export function actionSummary(payload: EmployeeActionPayload): string {
  switch (payload.kind) {
    case 'slack-post':
      return `a Slack post to ${payload.channelName ? `#${payload.channelName}` : payload.channel}: “${oneLine(payload.text, 60)}”`
    case 'linear':
      return `the Linear change ${payload.tool}${payload.issue ? ` on ${payload.issue}` : ''}`
    case 'push':
      return `a push of ${payload.branch} (${payload.ahead} ${payload.ahead === 1 ? 'commit' : 'commits'} ahead of ${payload.base})`
    case 'pull-request':
      return `the pull request “${oneLine(payload.title, 60)}” (${payload.base} ← ${payload.branch})`
  }
}

export const ACTION_KIND_WORDS: Record<EmployeeActionKind, string> = {
  'slack-post': 'Slack messages',
  linear: 'Linear changes',
  push: 'pushes',
  'pull-request': 'pull requests'
}

/** What the model reads when its action is held (§9): it goes only if a person approves it, and not another way. */
export function heldText(action: Pick<EmployeeAction, 'id' | 'payload'>): string {
  return `Held for the person: ${actionSummary(action.payload)} is recorded (action ${action.id}) and will be sent only if they approve it in Foreman’s Needs you. Nothing was sent yet. Don’t send it another way (a shell, another server); carry on, and say in your result that it waits for their approval.`
}

/** What the model reads when its definition never allows the class. */
export function neverText(kind: EmployeeActionKind): string {
  return `Refused: your definition never allows ${ACTION_KIND_WORDS[kind]}, so Foreman sent nothing and recorded the refusal. Don’t try another way; say in your result what you would have sent.`
}

/** The outcome as the employee's next continuation reads it. */
export function newsLine(n: EmployeeActionNews): string {
  const what = n.summary.charAt(0).toUpperCase() + n.summary.slice(1)
  switch (n.state) {
    case 'sent':
      return `- ${what}: sent${n.edited ? ', after the person edited its words' : ''}${n.link ? ` (${n.link})` : ''}.`
    case 'skipped':
      return `- ${what}: skipped by the person, so it was not sent. Don’t send it another way.`
    case 'failed':
      return `- ${what}: not sent, it failed${n.detail ? ` (${n.detail})` : ''}.`
    case 'uncertain':
      return `- ${what}: it may or may not have arrived; the person checks before anything is sent again.`
    default:
      return `- ${what}: ${n.state}.`
  }
}

/** The part of a continuation that says what became of the outward actions it waited on. Empty when there is nothing. */
export function newsText(news: readonly EmployeeActionNews[]): string {
  if (!news.length) return ''
  return `Outward actions you asked for, decided while your task waited:\n${news.map(newsLine).join('\n')}`
}
