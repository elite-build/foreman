// Catalog of coding agents and their models. Each agent reports its own model
// list at runtime (see main/models.ts); the static list below is only used
// until that first answer arrives, or when the agent can't be reached.

import { AGENT_CATALOG, FULL_AGENT_IDS, staticCapabilities, type ChatAgentId, type FullAgentId } from './agentCatalog'
import { createT, type PlainKey, type TFunction } from './i18n'

const enT = createT('en')

// #22: the four Full agents plus the Chat (ACP) agents from the catalog. Terminal agents never have chats.
export type AgentKind = FullAgentId | ChatAgentId

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface AgentInfo {
  kind: AgentKind
  label: string
  // What the effort axis is called for this agent, in English; effortAxisLabel(agent, t) for the UI language.
  effortLabel: string
  // Built-in slash commands the composer offers for this agent, described in English; builtinCommands(agent, t) for the UI language.
  builtinCommands: { name: string; description: string }[]
}

export interface ModelInfo {
  id: string
  agent: AgentKind
  label: string
  description?: string
  // Other ids that name the same model (e.g. an alias's resolved id).
  aliases?: string[]
  // The agent's own default.
  isDefault?: boolean
  // Empty when the model has no adjustable effort.
  efforts: EffortLevel[]
  defaultEffort?: EffortLevel
  supportsFast: boolean
  contextWindow: number
  // The agent gave contextWindow itself (Codex's working window), so it is a fact rather than a fallback.
  contextReported?: boolean
  hidden?: boolean
}

type CommandId = 'clear' | 'compact' | 'goal' | 'plan' | 'fastOpus' | 'fast' | 'mcpStatus' | 'repoMcpStatus'

const COMMANDS: Record<CommandId, { name: string; description: PlainKey }> = {
  clear: { name: 'clear', description: 'agents.command.clear' },
  compact: { name: 'compact', description: 'agents.command.compact' },
  goal: { name: 'goal', description: 'agents.command.goal' },
  plan: { name: 'plan', description: 'agents.command.plan' },
  fastOpus: { name: 'fast', description: 'agents.command.fastOpus' },
  fast: { name: 'fast', description: 'agents.command.fast' },
  mcpStatus: { name: 'mcp-status', description: 'agents.command.mcpStatus' },
  // G1: /mcp-status for agents that report no MCP status of their own: the repo's servers and whether Foreman passes them.
  repoMcpStatus: { name: 'mcp-status', description: 'agents.command.repoMcpStatus' }
}

const SHARED_COMMANDS: CommandId[] = ['clear', 'compact']

const COMMAND_IDS: Record<FullAgentId, CommandId[]> = {
  claude: [...SHARED_COMMANDS, 'plan', 'fastOpus', 'mcpStatus'],
  codex: [...SHARED_COMMANDS, 'plan', 'fast', 'repoMcpStatus'],
  cursor: ['clear', 'repoMcpStatus'],
  opencode: ['clear', 'repoMcpStatus']
}

// #22: every Chat agent has the same few.
const CHAT_COMMAND_IDS: CommandId[] = ['clear', 'repoMcpStatus']

/** The agent's built-in slash commands, described in t's language (English by default). */
export function builtinCommands(agent: AgentKind, t: TFunction = enT): { name: string; description: string }[] {
  const ids = COMMAND_IDS[agent as FullAgentId] ?? CHAT_COMMAND_IDS
  // `/goal` is offered to an agent whose record says it keeps goals (planning.goals), not by its name (docs/agents.md 3).
  const goals = staticCapabilities(agent)?.planning.goals.level === 'native' ? (['goal'] as CommandId[]) : []
  return [...ids, ...goals].map((id) => ({ name: COMMANDS[id].name, description: t(COMMANDS[id].description) }))
}

const EFFORT_AXIS: Partial<Record<AgentKind, PlainKey>> = { codex: 'agents.effortAxis.thinking' }

/** What the effort axis is called for this agent ("Effort", or "Thinking" for Codex), in t's language. */
export function effortAxisLabel(agent: AgentKind, t: TFunction = enT): string {
  return t(EFFORT_AXIS[agent] ?? 'agents.effortAxis.effort')
}

export const AGENTS: Record<AgentKind, AgentInfo> = {
  claude: {
    kind: 'claude',
    label: 'Claude Code',
    effortLabel: effortAxisLabel('claude'),
    builtinCommands: builtinCommands('claude')
  },
  codex: {
    kind: 'codex',
    label: 'Codex',
    effortLabel: effortAxisLabel('codex'),
    builtinCommands: builtinCommands('codex')
  },
  cursor: {
    kind: 'cursor',
    label: 'Cursor',
    effortLabel: effortAxisLabel('cursor'),
    builtinCommands: builtinCommands('cursor')
  },
  opencode: {
    kind: 'opencode',
    label: 'OpenCode',
    effortLabel: effortAxisLabel('opencode'),
    builtinCommands: builtinCommands('opencode')
  },
  // #22
  ...chatAgentInfos()
}

/** #22: Chat (ACP) agents run through the generic ACP adapter, whose capabilities are their records (agentCatalog/). */
function chatAgentInfos(): Record<ChatAgentId, AgentInfo> {
  const out = {} as Record<ChatAgentId, AgentInfo>
  for (const agent of AGENT_CATALOG) {
    if (agent.level !== 'chat') continue
    const kind = agent.id as ChatAgentId
    out[kind] = {
      kind,
      label: agent.name,
      effortLabel: effortAxisLabel(kind),
      builtinCommands: builtinCommands(kind)
    }
  }
  return out
}

export const AGENT_ORDER: AgentKind[] = [...FULL_AGENT_IDS]

/**
 * The models Foreman knows by name: each agent's table in its catalog file (agentCatalog/<id>.ts), in catalog order. This is the
 * list shown before an agent has answered `model/list`, and what modelsFor() lays under the agent's own report. It is not typed here.
 */
export const MODELS: ModelInfo[] = AGENT_CATALOG.flatMap((a) => (a.models?.table ?? []).map((m): ModelInfo => ({ ...m, agent: a.id as AgentKind })))

export const DEFAULT_MODEL: Record<AgentKind, string> = {
  claude: 'claude-opus-5-5[1m]',
  codex: 'gpt-6.1-sol',
  cursor: 'auto',
  opencode: '',
  // #22: a chat agent's own default until it lists its models.
  ...(Object.fromEntries(AGENT_CATALOG.filter((a) => a.level === 'chat').map((a) => [a.id, ''])) as Record<ChatAgentId, string>)
}

const EFFORT_LABELS: Record<EffortLevel, PlainKey> = {
  none: 'agents.effort.none',
  low: 'agents.effort.low',
  medium: 'agents.effort.medium',
  high: 'agents.effort.high',
  xhigh: 'agents.effort.xhigh',
  max: 'agents.effort.max',
  ultra: 'agents.effort.ultra'
}

export function effortLabel(level: EffortLevel | undefined, t: TFunction = enT): string {
  return level ? t(EFFORT_LABELS[level]) : ''
}

export type ModelCatalog = Partial<Record<AgentKind, ModelInfo[]>>

// What each agent last reported. Each process sets its own copy: the main
// process when it fetches, the renderer from the app snapshot.
let live: ModelCatalog = {}

export function setModelCatalog(catalog: ModelCatalog): void {
  live = catalog
}

function sameModel(m: ModelInfo, id: string): boolean {
  return m.id === id || Boolean(m.aliases?.includes(id))
}

/**
 * The agent's own report laid over what the catalog knows of the model (docs/agents.md, 4.3). What the agent states wins; the
 * catalog supplies what it doesn't: a name, a default effort, and the context window unless the agent reported one itself
 * (`contextReported`; a window a driver worked out from an id is not the agent's word). Matched by id alone: an alias that
 * resolves to a table entry is not the same window (Claude's "opus" is not the `[1m]` one).
 */
export function overlayModel(reported: ModelInfo): ModelInfo {
  const known = MODELS.find((m) => m.agent === reported.agent && m.id === reported.id)
  if (!known) return reported
  return {
    ...reported,
    label: reported.label || known.label,
    defaultEffort: reported.defaultEffort ?? (reported.efforts.length ? known.defaultEffort : undefined),
    contextWindow: reported.contextReported ? reported.contextWindow : known.contextWindow
  }
}

/** Model lookup. Ids the agent no longer lists get a generic entry rather than failing. */
export function modelInfo(agent: AgentKind, id: string, t: TFunction = enT): ModelInfo {
  const found = live[agent]?.find((m) => sameModel(m, id))
  return (
    (found && overlayModel(found)) ??
    MODELS.find((m) => m.agent === agent && m.id === id) ?? {
      id,
      agent,
      label: id || t('common.default'),
      efforts: [],
      supportsFast: false,
      contextWindow: 200_000
    }
  )
}

/** Whether two ids name the same model (e.g. a saved full id and the alias the agent lists). */
export function isSameModel(agent: AgentKind, a: string, b: string): boolean {
  if (a === b) return true
  const left = modelInfo(agent, a)
  const right = modelInfo(agent, b)
  return left.id === right.id || Boolean(left.aliases?.includes(b)) || Boolean(right.aliases?.includes(a))
}

/** The models the agent offers, in its own order. */
export function modelsFor(agent: AgentKind): ModelInfo[] {
  const reported = live[agent]
  if (reported?.length) return reported.filter((m) => !m.hidden).map(overlayModel)
  return MODELS.filter((m) => m.agent === agent && !m.hidden)
}

/** Every agent that can hold a chat: the Full agents, then the Chat (ACP) agents in catalog order. */
export function chatAgentKinds(): AgentKind[] {
  return Object.keys(AGENTS) as AgentKind[]
}

/** Every listed model across agents, for search. G1: the Chat agents' models too (callers keep only enabled agents). */
export function allModels(): ModelInfo[] {
  return chatAgentKinds().flatMap(modelsFor)
}

/** The agent's own default model, else the first it lists. */
export function defaultModel(agent: AgentKind): string {
  const models = modelsFor(agent)
  return (models.find((m) => m.isDefault) ?? models[0])?.id ?? DEFAULT_MODEL[agent]
}

/** Next effort level for ⌘⇧/, wrapping around. */
export function nextEffort(model: ModelInfo, current: EffortLevel | undefined): EffortLevel | undefined {
  if (model.efforts.length === 0) return undefined
  const index = current ? model.efforts.indexOf(current) : -1
  return model.efforts[(index + 1) % model.efforts.length]
}

export interface Loadout {
  agent: AgentKind
  model: string
  effort?: EffortLevel
  fast: boolean
  // #130: the agent's account (shared/agentInstances.ts) by id; absent: its default account.
  instance?: string
}

/**
 * "Use for new workspaces": moves the agent's first loadout to the top (new workspaces start from loadout 1).
 * Returns the same array when the agent has none or its loadout is already first.
 */
export function preferAgentLoadout(loadouts: Loadout[], agent: AgentKind): Loadout[] {
  const index = loadouts.findIndex((l) => l.agent === agent)
  if (index <= 0) return loadouts
  return [loadouts[index], ...loadouts.slice(0, index), ...loadouts.slice(index + 1)]
}

export const DEFAULT_LOADOUTS: Loadout[] = [
  { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high', fast: false },
  { agent: 'claude', model: 'claude-fable-5-1', effort: 'high', fast: false },
  { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: false }
]
