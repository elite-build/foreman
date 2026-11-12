// The permission mode a turn really runs in (docs/agents.md 3, "Permission modes"): the one the person stored, if the agent's record
// says it honours it, else the mode it does run in, and who holds that. Pure: main (the turn), the dialogs that describe a chat
// before it starts, and the tests share it.
import type { TurnCap } from './agentAccess'
import type { AgentCapabilities } from './agentCapabilities'
import type { ApprovalPolicy } from './permissions'

// From the most restrictive to the most permissive (agentAccess.POLICY_ORDER, kept here so permissions.ts can read this without a cycle).
const ORDER: readonly ApprovalPolicy[] = ['ask', 'ask-except-edits', 'auto', 'never-ask']
const rank = (mode: ApprovalPolicy) => ORDER.indexOf(mode)

export type EffectivePolicy =
  // Under a #170 cap, an agent that can't be held to the ceiling doesn't run (ceilingRefusal in agentAccess.ts says why).
  | { refused: true }
  // `changed`: the mode isn't the stored one (outside a cap), and who holds the one it runs in.
  | { refused: false; policy: ApprovalPolicy; changed?: { stored: ApprovalPolicy; by: AgentCapabilities['enforcement']['by'] } }

/**
 * The policy a turn runs with.
 *
 * - With a cap (docs/agent-access.md §3): unchanged. The lower of the stored mode and the ceiling, or a refusal for an agent whose
 *   record can't hold that ceiling.
 * - Without one: the stored mode where the agent's record lists it. Else the most restrictive mode it lists that is below the stored
 *   one (an agent that has no Auto runs Auto as Ask), else the agent's own mode (Cursor never asks, so that is what it runs in).
 *   It is never a refusal outside a cap: the person's chat still runs, and `changed` says what it runs as and who holds it.
 */
export function effectivePolicy(record: Pick<AgentCapabilities, 'enforcement'>, stored: ApprovalPolicy, cap?: TurnCap): EffectivePolicy {
  const { ceilings, permissionModes, by } = record.enforcement
  if (cap) {
    if (!ceilings.includes(cap.ceiling)) return { refused: true }
    return { refused: false, policy: rank(stored) <= rank(cap.ceiling) ? stored : cap.ceiling }
  }
  if (permissionModes.includes(stored)) return { refused: false, policy: stored }
  const sorted = [...permissionModes].sort((a, b) => rank(a) - rank(b))
  const below = sorted.filter((mode) => rank(mode) < rank(stored))
  // No mode listed at all can't happen for an agent with a record; the stored one stands rather than refusing.
  const policy = below[0] ?? sorted[0] ?? stored
  return { refused: false, policy, changed: { stored, by } }
}

/** The modes a picker offers for this agent: the ones its record lists, from the most restrictive to the most permissive. */
export function offeredModes(record: Pick<AgentCapabilities, 'enforcement'> | undefined): ApprovalPolicy[] {
  return [...(record?.enforcement.permissionModes ?? ORDER)].sort((a, b) => rank(a) - rank(b))
}
