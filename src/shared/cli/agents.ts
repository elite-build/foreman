// Parameters and results of the loadout, review model, model and agent methods.
// Each result has a `text` the command prints unless --json is given; the rows are the contract for scripts.
import type { EffortLevel } from '../agents'
import type { IntegrationLevel } from '../agentCatalog'

/** The effort levels any model may offer; a model's own list is checked when Foreman has it. */
export const EFFORT_LEVELS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** Settings → Default models holds this many slots; the first is the default for new chats. */
export const MAX_LOADOUT_SLOTS = 5

export interface LoadoutRow {
  // From 1, as the picker numbers them.
  slot: number
  agent: string
  agentName: string
  model: string
  // The model's name as the picker shows it (the id when Foreman has no list for the agent yet).
  modelLabel: string
  effort?: EffortLevel
  fast: boolean
}

export interface LoadoutsResult {
  loadouts: LoadoutRow[]
  // What was checked or assumed while saving ("the model name wasn't checked …").
  note?: string
  text: string
}

export interface LoadoutParams {
  agent: string
  model: string
  effort?: EffortLevel
  fast?: boolean
}

export interface LoadoutsSetParams extends LoadoutParams {
  slot: number
}

export type LoadoutsAddParams = LoadoutParams

export interface LoadoutsRemoveParams {
  slot: number
}

export interface LoadoutsMoveParams {
  from: number
  to: number
}

export interface ReviewModelResult {
  reviewModel: Omit<LoadoutRow, 'slot'>
  note?: string
  text: string
}

export type ReviewModelSetParams = LoadoutParams

export interface ModelsListParams {
  agent?: string
  // Include the models hidden from the picker (marked), with their context sizes.
  all?: boolean
}

export interface ModelRow {
  id: string
  label: string
  contextWindow: number
  efforts: EffortLevel[]
  supportsFast: boolean
  isDefault: boolean
  // In Settings → Agents → Hidden models.
  hidden: boolean
  // What the picker offers: not hidden, and (OpenCode) chosen on the Agents page.
  inPicker: boolean
}

export interface AgentModels {
  agent: string
  agentName: string
  models: ModelRow[]
  // How many the list leaves out without `--all`.
  omitted: number
  fetchedAt?: string
  error?: string
  loading?: boolean
}

export interface ModelsListResult {
  agents: AgentModels[]
  text: string
}

export interface ModelsVisibilityParams {
  agent: string
  models: string[]
}

export interface ModelsVisibilityResult {
  agent: string
  // The agent's hidden ids after the change.
  hidden: string[]
  // Models that stay in a loadout or a template's start model although hidden ("loadout 2").
  stillUsed: string[]
  text: string
}

export interface ModelsRefreshParams {
  agent?: string
}

export interface ModelsRefreshResult {
  agents: { agent: string; models: number; error?: string }[]
  text: string
}

export interface AgentsListParams {
  // Look at the computer again (which agents are installed) instead of using the last check.
  refresh?: boolean
}

export interface AgentRow {
  id: string
  name: string
  level: IntegrationLevel
  enabled: boolean
  installed: boolean
  version?: string
  path?: string
  // How it signs in now: Login, or its API key. Absent for an agent whose sign-in is unconfirmed.
  auth?: 'login' | 'api-key'
  // Full agents only: what Foreman's own status check said.
  ready?: boolean
  method?: string
  account?: string
}

export interface AgentsListResult {
  agents: AgentRow[]
  text: string
}

export interface AgentIdParams {
  id: string
}

export interface AgentEnabledResult {
  id: string
  enabled: boolean
  text: string
}

export interface AgentsAuthParams {
  id: string
  mode: 'login' | 'api-key'
}

export interface AgentsAuthResult {
  id: string
  auth: 'login' | 'api-key'
  text: string
}

export interface AgentsPathParams {
  id: string
  // A command name or a path (relative paths are made absolute from `cwd`). Give this or `clear`.
  path?: string
  clear?: boolean
  cwd?: string
}

export interface AgentsPathResult {
  id: string
  // Empty: the one found on PATH.
  path: string
  text: string
}

export interface AgentsStatusResult {
  id: string
  name: string
  level: IntegrationLevel
  // Foreman's own check (full agents).
  status?: { installed: boolean; ready: boolean; version?: string; method?: string; account?: string; detail?: string }
  // The agent's own sign-in answer, when it has one.
  signIn?: { signedIn: boolean; account?: string; source?: string; output: string }
  text: string
}
