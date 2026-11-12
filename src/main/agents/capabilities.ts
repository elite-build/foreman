// The capability records as main publishes them (docs/agents.md, 2.1): each agent's static record with the features its
// registered driver implements put in, and what each agent has declared when it started. The records are shared data
// (shared/agentCatalog/); this is the part that needs the drivers.
import { acpPlanMode, staticCapabilities } from '../../shared/agentCatalog'
import { chatAgentKinds, type AgentKind } from '../../shared/agents'
import { DEFAULT_ACCOUNT, EVERY_ACCOUNT, resolveCapabilities, type AgentCapabilities, type AgentCapabilitiesView, type AgentFeatures, type DeclaredFacts, type DriverFeature } from '../../shared/agentCapabilities'
import type { ModelCatalogState } from '../../shared/types'
import { driverFor } from './registry'
import type { AgentDriver } from './types'

/**
 * The features that follow from what the driver implements: `oneShot` is chat titles, and `accepts` names the host tools
 * and the transcript mirror its turns use. The record's other features (assistant, unattended, cloud, keptRunning,
 * repoCommands) are decisions made outside the driver, so they stay static in the record.
 */
export function driverFeatures(driver: AgentDriver): Pick<AgentFeatures, DriverFeature> {
  return {
    titles: typeof driver.oneShot === 'function',
    diffTool: driver.accepts?.diffTool === true,
    followups: driver.accepts?.followups === true,
    reportTools: driver.accepts?.reportTools === true,
    transcriptMirror: driver.accepts?.transcriptMirror === true
  }
}

/** The agent's record with the features its driver implements; undefined for an agent that can't hold a chat. */
export function recordFor(agent: AgentKind, driver: AgentDriver = driverFor(agent)): AgentCapabilities | undefined {
  const base = staticCapabilities(agent)
  return base && { ...base, features: { ...base.features, ...driverFeatures(driver) } }
}

/** What the agent declared the last time it started, as far as its record says it declares anything. */
function declaredFacts(base: AgentCapabilities, entry: ModelCatalogState['agents'][AgentKind]): DeclaredFacts | undefined {
  const facts: DeclaredFacts = {}
  // An ACP agent's session modes (ModelCatalogEntry.modes): a plan mode among them turns the Plan chip on.
  if (base.declares.includes('planMode') && acpPlanMode(entry?.modes)) facts.planMode = true
  // What an account says about itself (OpenCode's version, Codex's Windows sandbox) is per account: capabilitiesOf and the view lay it on.
  return Object.keys(facts).length ? facts : undefined
}

/**
 * The record a decision in main reads: the static facts, the features the registered driver implements, and what the agent
 * declared at its last start (the model catalog keeps an ACP agent's session modes, so a plan mode among them turns Plan on).
 * Undefined for an agent that can't hold a chat. `instance` asks for one of the agent's accounts: what that account declared
 * (`declared`, as state.json keeps it) is laid over what holds for every account, so Codex on a Windows sandbox that isn't ready
 * for one account isn't offered read-only there (docs/agents.md 8).
 */
export function capabilitiesOf(agent: AgentKind, catalog?: ModelCatalogState['agents'], declared?: Record<string, Record<string, DeclaredFacts>>, instance?: string): AgentCapabilities | undefined {
  const base = recordFor(agent)
  if (!base) return undefined
  const byAccount = base.declares.length ? declared?.[agent] : undefined
  const facts = { ...declaredFacts(base, catalog?.[agent]), ...byAccount?.[EVERY_ACCOUNT], ...byAccount?.[instance ?? DEFAULT_ACCOUNT] }
  return resolveCapabilities(base, Object.keys(facts).length ? facts : undefined)
}

/** The agent that writes chat titles and answers one-shot questions: the first, in catalog order, whose driver can (`features.titles`). */
export function oneShotAgent(): AgentKind | undefined {
  return chatAgentKinds().find((a) => recordFor(a)?.features.titles)
}

/** The agents whose transcript Foreman mirrors, so a transfer or export can carry their conversations (`features.transcriptMirror`). */
export function mirroredAgents(): AgentKind[] {
  return chatAgentKinds().filter((a) => recordFor(a)?.features.transcriptMirror)
}

/**
 * The records for the snapshot: every agent that can hold a chat, and what each declared. The model catalog keeps the
 * session modes per agent, so they are stated for every account of it (EVERY_ACCOUNT).
 */
export function agentCapabilitiesView(catalog: ModelCatalogState['agents'], declared: Record<string, Record<string, DeclaredFacts>> = {}): AgentCapabilitiesView {
  const view: AgentCapabilitiesView = { agents: {}, declared: {} }
  for (const agent of chatAgentKinds()) {
    const record = recordFor(agent)
    if (!record) continue
    view.agents[agent] = record
    const facts = declaredFacts(record, catalog[agent])
    // What each account said about itself when it started (its version, its Windows sandbox), laid next to what holds for every account.
    const accounts = record.declares.length ? declared[agent] : undefined
    if (facts || accounts) view.declared[agent] = { ...(facts ? { [EVERY_ACCOUNT]: facts } : {}), ...accounts }
  }
  return view
}
