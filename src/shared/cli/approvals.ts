// Parameters and results of the approvals and stopped-turns methods. Each result has
// a `text` the command prints unless --json is given.
import type { ApprovalRequest } from '../types'

export interface ApprovalRow {
  id: string
  workspace: string
  workspaceId?: string
  // The open tab's position from 1, or its title when it is closed.
  tab?: number
  tabTitle?: string
  kind: ApprovalRequest['kind']
  // What is being asked, in a line: the tool and its input, the plan's first line, or the question.
  ask: string
  // Tool requests: what the "always" and "edits" answers mean for this tool, when they mean anything.
  alternate?: 'edits-for-session' | 'always-allow'
}

export interface ApprovalsResult {
  approvals: ApprovalRow[]
  text: string
}

export interface ApproveParams {
  // The request's id, or the start of it (four characters or more).
  id: string
  // Tool requests: allow this tool from now on (when the tool offers it).
  always?: boolean
  // Tool requests: allow edits for the rest of the session (when the tool offers it).
  edits?: boolean
  // Tool requests: a note to the agent with the answer.
  message?: string
  // Plan requests: the command's --plan (checked against the request's kind).
  plan?: boolean
  feedback?: string
  // Question requests: the question (its text, header or position from 1) → the chosen option's label, or your own words.
  answers?: Record<string, string>
}

export interface DenyParams {
  id: string
  message?: string
}

export interface ApprovalAnswerResult {
  id: string
  workspace: string
  kind: ApprovalRequest['kind']
  // allow / deny (tool), approved / revised (plan), answered / skipped (question).
  answer: string
  text: string
}

export type StoppedVerb = 'list' | 'retry' | 'dismiss'

export interface StoppedParams {
  verb: StoppedVerb
  // retry and dismiss: a turn id (or the start of it), or `checks:<workspace id>`.
  key?: string
  // dismiss: everything.
  all?: boolean
}

export interface StoppedRow {
  key: string
  kind: 'turn' | 'checks'
  workspace: string
  cause: 'quit' | 'crash'
  at: string
  title?: string
  message?: string
  closed?: boolean
}

export interface StoppedResult {
  verb: StoppedVerb
  rows: StoppedRow[]
  text: string
}
