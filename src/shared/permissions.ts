// How tool approvals work for a chat, and the plain-language version of it that
// dialogs show before an agent is started.
import { AGENTS, type AgentKind } from './agents'
import { createT, type TFunction } from './i18n'
import { globToRegExp } from './sensitive'
import type { ReadOnlyEnforcement } from './types'

const enT = createT('en')

/**
 * #16: how Foreman holds a chat of this agent to read-only, or null where it can't
 * (Cursor, OpenCode), so the option is not offered there at all.
 */
export function readOnlyEnforcement(agent: AgentKind): ReadOnlyEnforcement | null {
  if (!AGENTS[agent].supportsReadOnly) return null
  return agent === 'claude' ? 'plan' : 'sandbox'
}

/** How tool approvals work for a turn. */
export type ApprovalPolicy = 'never-ask' | 'ask' | 'ask-except-edits' | 'auto'

export interface ApprovalSettings {
  requireToolApprovals: boolean
  codexApprovals: 'sandboxed' | 'always'
  autoPermissionMode: boolean
}

/** The policy a chat of this agent runs with. Codex can't ask mid-turn, so it is sandboxed or unrestricted. */
export function approvalPolicyFor(agent: AgentKind, settings: ApprovalSettings, autoAcceptEdits = false): ApprovalPolicy {
  if (agent === 'codex') return settings.codexApprovals === 'always' ? 'never-ask' : 'ask'
  if (!settings.requireToolApprovals) return 'never-ask'
  if (settings.autoPermissionMode) return 'auto'
  return autoAcceptEdits ? 'ask-except-edits' : 'ask'
}

/** What the target chat can do without asking, as the settings stand now. */
export function permissionNote(agent: AgentKind, settings: ApprovalSettings, t: TFunction = enT): string {
  if (agent === 'codex') {
    return settings.codexApprovals === 'always' ? t('permissions.codex.always') : t('permissions.codex.sandboxed')
  }
  switch (approvalPolicyFor(agent, settings)) {
    case 'never-ask':
      return t('permissions.neverAsk')
    case 'auto':
      return t('permissions.auto')
    case 'ask-except-edits':
      return t('permissions.askExceptEdits')
    default:
      return t('permissions.ask')
  }
}

// ---- scoped writes (a flow persona's `writes`) ----

/** The tools that write a file at a path the input names. */
export const SCOPED_FILE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] as const
/** Shells: a command can write anywhere, so a turn with scoped writes gets none. */
export const SCOPED_SHELL_TOOLS = ['Bash', 'PowerShell'] as const

/** What Foreman says about a tool call in a turn with scoped writes: allowed, refused with words for the agent, or none of its business. */
export type WriteScopeDecision = { allow: true } | { allow: false; message: string } | null

/**
 * A path as the workspace root sees it: forward slashes, relative, `.` and `..` resolved; null when it is outside the
 * root. Pure (no node:path) so main and tests share it; Windows paths compare without case.
 */
export function workspaceRelative(path: string, root: string): string | null {
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/')
  let p = slash(path.trim())
  const r = slash(root.trim()).replace(/\/+$/, '')
  const windows = /^[A-Za-z]:\//.test(r) || /^[A-Za-z]:\//.test(p)
  const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p)
  if (absolute) {
    const same = windows ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`) : p.startsWith(`${r}/`)
    if (!same) return null
    p = p.slice(r.length + 1)
  }
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(part)
  }
  return out.length ? out.join('/') : null
}

/**
 * Scoped writes, enforced by Foreman: a file tool inside one of `writes` (globs relative to `root`) is allowed, one
 * anywhere else is refused naming the allowed area, and a shell is refused. Neither refusal stops the turn: the agent
 * reads the message and carries on. Any other tool is left to the turn's approval policy (null).
 */
export function writeScopeDecision(toolName: string, input: unknown, writes: readonly string[], root: string): WriteScopeDecision {
  const area = writes.join(', ')
  if ((SCOPED_SHELL_TOOLS as readonly string[]).includes(toolName))
    return { allow: false, message: `This flow step may only write inside ${area}, so it has no shell: a command could write anywhere. Use Read, Grep and Glob to look around, and Edit or Write for files inside ${area}. Carry on without the shell.` }
  if (!(SCOPED_FILE_TOOLS as readonly string[]).includes(toolName)) return null
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const raw = [fields.file_path, fields.notebook_path, fields.path].find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const relative = raw ? workspaceRelative(raw, root) : null
  if (relative && writes.some((glob) => globToRegExp(glob).test(relative))) return { allow: true }
  const what = raw ? `“${relative ?? raw}”` : 'that file'
  return { allow: false, message: `Foreman refused writing ${what}: this flow step may only write inside ${area} (relative to the workspace root). Write there instead, or leave the change out and say so in your answer. Carry on.` }
}
