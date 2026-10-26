// How tool approvals work for a chat, and the plain-language version of it that
// dialogs show before an agent is started.
import { AGENTS, type AgentKind } from './agents'
import { createT, type TFunction } from './i18n'
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
