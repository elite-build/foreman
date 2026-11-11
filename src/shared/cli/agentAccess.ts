// Parameters and results of the `foreman agent-access` methods (src/main/cli/agentAccess.ts). Each result has a `text`
// the command prints unless --json is given. Nothing here holds a sign-in's code: only its browser page shows that.
import type { AgentAccessLevel } from '../agentAccess'

export interface AgentAccessPendingRow {
  id: string
  // What it calls itself.
  name: string
  // Where it returns once approved: "127.0.0.1:53682".
  redirect: string
  expiresAt: number
}

export interface AgentAccessGrantRow {
  id: string
  name: string
  level: AgentAccessLevel
  redirect: string
  grantedAt: string
  lastSeen?: string
}

export interface AgentAccessStatusResult {
  enabled: boolean
  port: number
  url: string
  setup: { claude: string; codex: string }
  pending: AgentAccessPendingRow[]
  grants: AgentAccessGrantRow[]
  error?: string
  text: string
}

export interface AgentAccessPendingResult {
  pending: AgentAccessPendingRow[]
  text: string
}

export interface AgentAccessApproveParams {
  // Its id or the start of one, or what it calls itself when only one waiting sign-in has that name. Absent: the one
  // waiting, when only one is.
  id?: string
  // Typed at the terminal by the person approving; spaces are ignored.
  code: string
  // Absent: ask.
  level?: AgentAccessLevel
}

export interface AgentAccessApproveResult {
  approved: AgentAccessPendingRow
  level: AgentAccessLevel
  text: string
}

export interface AgentAccessDenyParams {
  id?: string
}

export interface AgentAccessDenyResult {
  denied: AgentAccessPendingRow
  text: string
}

export interface AgentAccessRevokeParams {
  // A signed-in agent's id, the start of one, or a name only one of them has.
  grant: string
}

export interface AgentAccessRevokeResult {
  revoked: AgentAccessGrantRow
  text: string
}
