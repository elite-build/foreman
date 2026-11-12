// #22: which agents the composer's picker offers, grouped Full / Chat / Terminal.
// Only enabled agents appear. A Full agent that's enabled but not set up yet
// (Cursor without a key, OpenCode not installed) is listed as not ready, and
// picking it opens its settings, as the old "+ Cursor" shortcut did.
import { AGENT_CATALOG, CAPABILITIES, catalogAgent, isAgentEnabled, LEVELS, type AgentPrefs, type Capability, type IntegrationLevel } from './agentCatalog'
import type { AgentKind } from './agents'
import { agentReadiness, type AgentReadiness } from './agentReadiness'
import type { AgentStatus } from './types'

export interface PickerAgent {
  id: string
  level: IntegrationLevel
  // false: enabled but not set up; picking it opens its settings.
  ready: boolean
  // Capabilities it lacks, for the hover note on Chat agents.
  missing: Capability[]
  // Full agents: what the evidence says (signed in, key saved, installed). Claude and Codex stay selectable when signed out.
  readiness?: AgentReadiness
}

/** Readiness the picker can't tell from settings alone. */
export interface PickerReadiness {
  cursor: boolean
  opencode: boolean
  // Each Full agent's own status, once asked; Claude and Codex are worded "Checking" until it arrives.
  statuses?: Partial<Record<string, AgentStatus>>
}

/** The evidence for a Full agent (those whose catalog entry says how it is judged); undefined for every other agent. */
export function pickerEvidence(id: string, readiness: PickerReadiness): AgentReadiness | undefined {
  if (!catalogAgent(id)?.readiness) return undefined
  return agentReadiness(id, { status: readiness.statuses?.[id], keySaved: readiness.cursor, installed: readiness.opencode })
}

// An agent judged by its own status check (Claude, Codex) is always selectable: a signed-out one is labelled and offers sign-in
// (see pickerEvidence), never blocked. One judged by a saved key (`readiness.cursor`) or by being installed (`readiness.opencode`)
// is ready only when that is so.
function ready(id: string, readiness: PickerReadiness): boolean {
  const evidence = catalogAgent(id)?.readiness
  if (evidence === 'key') return readiness.cursor
  if (evidence === 'installed') return readiness.opencode
  return true
}

/** Agent → can it take a chat from the picker now (enabled and set up). Terminal agents aren't chat agents and aren't listed. */
export function pickerAgents(prefs: AgentPrefs | undefined, readiness: PickerReadiness): Record<AgentKind, boolean> {
  const out = {} as Record<AgentKind, boolean>
  for (const agent of AGENT_CATALOG) {
    if (agent.level === 'terminal') continue
    out[agent.id as AgentKind] = isAgentEnabled(agent.id, prefs) && ready(agent.id, readiness)
  }
  return out
}

/** The enabled agents by level, in catalog order. */
export function pickerGroups(prefs: AgentPrefs | undefined, readiness: PickerReadiness): { level: IntegrationLevel; agents: PickerAgent[] }[] {
  return LEVELS.map((level) => ({
    level,
    agents: AGENT_CATALOG.filter((a) => a.level === level && isAgentEnabled(a.id, prefs)).map((a) => ({
      id: a.id,
      level,
      ready: level === 'terminal' || ready(a.id, readiness),
      missing: CAPABILITIES.filter((c) => !a.capabilities[c]),
      readiness: pickerEvidence(a.id, readiness)
    }))
  })).filter((g) => g.agents.length > 0)
}

/** "8 of 33 enabled" for Manage agents…. */
export function enabledCount(prefs: AgentPrefs | undefined): { enabled: number; total: number } {
  return { enabled: AGENT_CATALOG.filter((a) => isAgentEnabled(a.id, prefs)).length, total: AGENT_CATALOG.length }
}

// Missing capabilities worth a hover note (approvals and cost aren't controls in the composer).
const NOTE_CAPS: Capability[] = ['plan', 'rewind', 'steer']

/** The capabilities a Chat agent's hover note names, e.g. plan and rewind for "Gemini CLI: no plan mode, no rewind". */
export function noteCapabilities(agent: PickerAgent): Capability[] {
  if (agent.level !== 'chat') return []
  return NOTE_CAPS.filter((c) => agent.missing.includes(c))
}
