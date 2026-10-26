// O8: which models each agent shows in the model picker. Deliberately small: a
// set of hidden model ids per agent, and nothing else (no order, no names, no
// per-repo lists). Hidden only shortens the picker; loadouts, templates and
// chats that name a hidden model keep it. Models an agent adds later aren't in
// the set, so they start visible.
import { chatAgentKinds, isSameModel, MODELS, type AgentKind, type Loadout, type ModelInfo } from './agents'
import type { TemplateStartModel } from './types'

/** Settings → hiddenModels: agent → ids hidden from the picker. An agent with nothing hidden has no key. */
export type HiddenModels = Partial<Record<AgentKind, string[]>>

/** Saved or patched hiddenModels, checked: known agents, string ids, no duplicates or empty lists. */
export function parseHiddenModels(raw: unknown): HiddenModels {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: HiddenModels = {}
  // G1: the Chat agents' lists can be shortened too.
  for (const agent of chatAgentKinds()) {
    const ids = (raw as Record<string, unknown>)[agent]
    if (!Array.isArray(ids)) continue
    const clean = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))]
    if (clean.length) out[agent] = clean
  }
  return out
}

export function isModelHidden(hidden: HiddenModels, agent: AgentKind, id: string): boolean {
  return (hidden[agent] ?? []).some((h) => isSameModel(agent, h, id))
}

/** The setting after one eye toggle. */
export function setModelHidden(hidden: HiddenModels, agent: AgentKind, id: string, hide: boolean): HiddenModels {
  const rest = (hidden[agent] ?? []).filter((h) => !isSameModel(agent, h, id))
  return withAgent(hidden, agent, hide ? [...rest, id] : rest)
}

/** "Show all": the only reset. */
export function showAllModels(hidden: HiddenModels, agent: AgentKind): HiddenModels {
  return withAgent(hidden, agent, [])
}

function withAgent(hidden: HiddenModels, agent: AgentKind, ids: string[]): HiddenModels {
  const next = { ...hidden }
  if (ids.length) next[agent] = ids
  else delete next[agent]
  return next
}

export interface PickerModels {
  // In the agent's own order; includes the current model even when it's hidden.
  shown: ModelInfo[]
  // The rest, revealed by "N hidden · Show".
  hidden: ModelInfo[]
}

/** Splits an agent's list for the picker. The selected model always shows, hidden or not. */
export function pickerModels(models: ModelInfo[], hidden: HiddenModels, current?: { agent: AgentKind; model: string }): PickerModels {
  const shown: ModelInfo[] = []
  const rest: ModelInfo[] = []
  for (const m of models) {
    const selected = current !== undefined && current.agent === m.agent && isSameModel(m.agent, m.id, current.model)
    if (selected || !isModelHidden(hidden, m.agent, m.id)) shown.push(m)
    else rest.push(m)
  }
  return { shown, hidden: rest }
}

/** How many of the agent's listed models are hidden (the "4 shown · 3 hidden" count ignores stale ids). */
export function hiddenCount(models: ModelInfo[], hidden: HiddenModels): number {
  return models.filter((m) => isModelHidden(hidden, m.agent, m.id)).length
}

export interface ModelUses {
  // 1-based loadout numbers, as the picker shows them.
  loadouts: number[]
  template: boolean
}

/** What still uses a model, so a hidden one can say it isn't gone. */
export function modelUses(
  agent: AgentKind,
  id: string,
  loadouts: Loadout[],
  templates: { startModel?: TemplateStartModel }[]
): ModelUses {
  return {
    loadouts: loadouts.flatMap((l, n) => (l.agent === agent && isSameModel(agent, l.model, id) ? [n + 1] : [])),
    template: templates.some((t) => t.startModel?.agent === agent && isSameModel(agent, t.startModel.model, id))
  }
}

/**
 * The context window when someone actually knows it: Foreman's model table
 * (by id, or by the id Claude Code resolved an alias to), or Claude Code's own
 * "[1m]" marker. Otherwise undefined, shown as "context unknown"; ModelInfo's
 * contextWindow is a working fallback there, not a fact.
 */
export function knownContextWindow(model: ModelInfo): number | undefined {
  const resolved = model.aliases?.[0]
  const listed = MODELS.find((m) => m.agent === model.agent && (m.id === model.id || m.id === resolved))
  if (listed) return listed.contextWindow
  if (model.agent === 'claude' && model.id.includes('[1m]')) return 1_000_000
  return undefined
}

/** 1000000 → "1M", 200000 → "200k". */
export function contextSize(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}
