// What Foreman can say about an agent's sign-in, worded by its evidence. Status is evidence, not proof:
// Claude counts `auth status`, a provider or a key; Codex counts a saved login file or a key; Cursor's key is
// saved but never tested; OpenCode is only known to be installed. Pure, so the picker, New workspace, the
// in-chat sign-in card and the first-run page all say the same thing.
import type { AgentStatus } from './types'

export type AgentEvidenceKey =
  | 'agentReadiness.accountFound'
  | 'agentReadiness.apiKeySaved'
  | 'agentReadiness.notSignedIn'
  | 'agentReadiness.keySavedUntested'
  | 'agentReadiness.installed'
  | 'agentReadiness.notInstalled'
  | 'agentReadiness.noKey'
  | 'agentReadiness.checking'

export interface AgentReadiness {
  // The evidence says it can run a turn (not proof: Cursor's key is untested, OpenCode may have no provider).
  ready: boolean
  // The message that says what the evidence is.
  evidenceKey: AgentEvidenceKey
  // The evidence says to sign in: a signed-out Claude or Codex. The agent stays selectable; the UI offers sign-in.
  needsSignIn: boolean
  // The evidence is worth showing as visible text rather than only a hint (anything but a plain "found").
  attention: boolean
}

export interface ReadinessInput {
  // The agent's own status, once asked; null or undefined while unknown.
  status?: AgentStatus | null
  // A Foreman-saved key for it (Cursor's only evidence).
  keySaved?: boolean
  // OpenCode only: installed, when the status isn't loaded.
  installed?: boolean
}

function result(ready: boolean, evidenceKey: AgentEvidenceKey, needsSignIn = false): AgentReadiness {
  return { ready, evidenceKey, needsSignIn, attention: needsSignIn || evidenceKey === 'agentReadiness.keySavedUntested' || evidenceKey === 'agentReadiness.notInstalled' || evidenceKey === 'agentReadiness.noKey' }
}

/** Whether the agent looks signed in, and the words for what that is based on. */
export function agentReadiness(agent: string, input: ReadinessInput): AgentReadiness {
  const { status, keySaved, installed } = input
  switch (agent) {
    case 'claude':
    case 'codex': {
      if (!status) return { ready: false, evidenceKey: 'agentReadiness.checking', needsSignIn: false, attention: false }
      if (!status.installed) return result(false, 'agentReadiness.notInstalled')
      if (!status.ready) return result(false, 'agentReadiness.notSignedIn', true)
      return result(true, status.method === 'API key' ? 'agentReadiness.apiKeySaved' : 'agentReadiness.accountFound')
    }
    case 'cursor':
      return keySaved ? result(true, 'agentReadiness.keySavedUntested') : result(false, 'agentReadiness.noKey')
    case 'opencode': {
      const found = status ? status.installed : Boolean(installed)
      return found ? result(true, 'agentReadiness.installed') : result(false, 'agentReadiness.notInstalled')
    }
    default:
      return { ready: true, evidenceKey: 'agentReadiness.installed', needsSignIn: false, attention: false }
  }
}
