// The catalog's shared vocabulary: the types an entry is written in, the ids of each integration level, and how a catalog
// row's chips are read from a capability record. Each agent's own file (claude.ts, acpAgents.ts, ...) imports from here and
// never from index.ts, so the dependency runs one way: index.ts -> agent files -> catalog.ts.
import { offers, type AgentCapabilities } from '../agentCapabilities'
import type { VersionTable } from '../agentVersions'
import type { ModelInfo } from '../agents'
import type { PlainKey } from '../i18n'

export type IntegrationLevel = 'full' | 'chat' | 'terminal'

export const LEVELS: IntegrationLevel[] = ['full', 'chat', 'terminal']

/** What Foreman can do with an agent. Chips on the catalog; unsupported ones are struck through and their controls hidden. */
export type Capability = 'approvals' | 'plan' | 'steer' | 'rewind' | 'mcp' | 'cost'

export const CAPABILITIES: Capability[] = ['approvals', 'plan', 'steer', 'rewind', 'mcp', 'cost']

export interface LoginMethod {
  // Arguments after the binary, e.g. ['login']; [] runs the agent itself, whose first run signs in.
  args: string[]
  // What to do once it's running, when that isn't obvious (e.g. "type /login"); a message key, shown through t().
  hint?: PlainKey
  // A command that reports whether it's signed in; absent: "Unknown: this CLI can't report it".
  statusArgs?: string[]
  // What that command prints when it isn't prose: `json-account` is a JSON object that names the account (email, username).
  statusFormat?: 'json-account'
}

export interface ApiKeyMethod {
  // The variable the saved key is passed as.
  envVar: string
  // Variables Login mode removes too, so a stray key never switches the agent to API billing.
  alsoStrip?: string[]
  keyUrl?: string
  // Whose key it is, as the key field's label says it ("Anthropic"): a provider's name, never translated.
  provider?: string
  // Other variables in the user's shell that "Import from shell" accepts for this key, after `envVar`.
  importEnv?: string[]
}

export interface AuthSpec {
  login?: LoginMethod
  apiKey?: ApiKeyMethod
  // Takes provider keys (OPENAI_API_KEY, …) from Settings → Provider keys, only the ones ticked for it.
  sharedKeys?: boolean
  // With `sharedKeys`: it always gets every provider key, and can't be unticked (OpenCode reads whichever its model needs).
  allProviderKeys?: boolean
  // What the Login and API key cards on its settings page say (message keys), for an agent with both.
  cards?: { login: PlainKey; apiKey: PlainKey }
  // false: nobody has confirmed how it signs in. "Check docs", and Foreman passes it no keys.
  confirmed: boolean
}

/** How a Chat agent starts in ACP mode. */
export interface AcpSpec {
  args: string[]
  // A separate ACP program: looked for beside the agent's own CLI first, then on PATH.
  binaries?: string[]
  winBinaries?: string[]
  // How to get that program, for "not installed" and the catalog row. Foreman never installs it.
  install?: string
  // The same as a sentence to translate, when `install` is prose rather than a command; the renderer shows this instead.
  installHint?: PlainKey
  // Expected `initialize` name (agentInfo.name) and minimum version from the external integration reference.
  // A different program or an older version gets a notice; the turn still runs (Foreman hasn't verified any version itself).
  expect?: { name: string; minVersion: string }
  source: 'reference' | 'docs'
}

/**
 * The settings fields (persisted shapes, never renamed) that belong to one agent. A feature that needs "this agent's sign-in
 * mode" or "its executable path" reads the field's name here instead of comparing the agent's id.
 */
export interface AgentSettingsKeys {
  // Login or API key, for an agent with both.
  auth?: 'claudeAuth' | 'codexAuth'
  executablePath?: 'claudeExecutablePath' | 'codexExecutablePath' | 'opencodeExecutablePath'
  // The models the user ticked to show (a chosen subset of what the agent lists).
  models?: 'opencodeModels'
  // The agent's own approval setting, in place of the app-wide "require tool approvals": `always` lifts the sandbox. The
  // plain-language note for each value is a message key, translated by the feature.
  approvals?: { field: 'codexApprovals'; notes: { always: PlainKey; sandboxed: PlainKey } }
}

/**
 * What a Full agent's readiness is judged by, for the picker and the sign-in notices (shared/agentReadiness.ts):
 * `status` its own status check, `key` a key saved in Foreman (never tested), `installed` that its program is found.
 */
export type ReadinessEvidence = 'status' | 'key' | 'installed'

/**
 * What Foreman knows about one of an agent's models, written once here (docs/agents.md, 4.3): the list shown before the agent
 * has answered, and what modelsFor() lays under the agent's own report. The agent's own facts win over it.
 */
export type CatalogModel = Pick<ModelInfo, 'id' | 'label' | 'efforts' | 'defaultEffort' | 'supportsFast' | 'contextWindow'>

export interface CatalogAgent {
  id: string
  name: string
  // Two letters for the row's badge.
  monogram: string
  level: IntegrationLevel
  // Names looked up on PATH, first match wins (Windows also tries .exe/.cmd).
  binaries: string[]
  // Overrides on Windows, where a name differs (Command Code's `cmd` is Windows' own shell).
  winBinaries?: string[]
  versionArgs: string[]
  // Chat agents: how to start ACP mode. `binaries` overrides when ACP is a separate program.
  // source: 'reference' = external integration reference; 'docs' = agent docs only. Neither implies local end-to-end validation.
  acp?: AcpSpec
  // Terminal agents: the interactive command (arguments after the binary).
  terminal?: { args: string[] }
  auth: AuthSpec
  capabilities: Record<Capability, boolean>
  // Install and sign-in docs. Foreman never installs anything; it links here.
  docsUrl: string
  // Scratch files the agent leaves in the worktree, kept out of git through .git/info/exclude.
  scratch?: string[]
  // Its version table (docs/agents.md, 4.1): tested versions, the minimum, known breakages, per-model minimums and its own
  // update command. Read through shared/agentVersions.ts. `acp.expect.minVersion` is a different program's minimum (the ACP
  // server's, as it reports itself on connecting) and stays with the ACP spec.
  versions?: VersionTable
  // Only the four Full agents start enabled.
  defaultEnabled?: boolean
  // Full agents: how its readiness is judged (see ReadinessEvidence).
  readiness?: ReadinessEvidence
  settings?: AgentSettingsKeys
  // How its model ids and names read (docs/agents.md 2.4: what the pickers used to ask the id).
  models?: {
    // Its models as Foreman knows them (display name, effort levels, context window): the list before the first report, and the overlay under later ones.
    table?: CatalogModel[]
    // An id that holds this marker has a million-token window ("[1m]"), a fact the agent doesn't report itself.
    millionMarker?: string
    // A model's label reads "provider/model": the tab and the hand-off line show the part after the slash.
    twoLineNames?: boolean
  }
  // Its own subagent files (.claude/agents) are read as personas for its steps.
  personaFiles?: boolean
  // A caveat shown with the instructions Foreman teaches this agent (Settings → Repository → Foreman for agents): a message key.
  reportToolsNote?: PlainKey
  // Why it can't run in a cloud workspace, as a clause ("its SDK runs the agent on this computer"); only where `features.cloud` is false.
  notInCloud?: string
}

/**
 * A catalog row's chips, read from the agent's capability record, so a chip and the record can't
 * disagree. Chat agents: Plan is off until the agent declares a plan session mode (acpPlanMode), and Foreman can't steer a
 * running ACP prompt or rewind its conversation. `approvals` is on where the record lists more than one permission mode: Cursor's
 * SDK asks nothing, so it runs in its one mode and has no approvals chip.
 */
export function capsOf(record: AgentCapabilities): Record<Capability, boolean> {
  return {
    // An agent that lists more than one permission mode asks (or can be told to); Cursor's one mode is never asking.
    approvals: record.enforcement.permissionModes.length > 1,
    plan: offers(record.planning.planMode),
    steer: record.turns.steer.level === 'native',
    rewind: record.checkpointing.restoreFiles,
    mcp: offers(record.tools.mcp),
    cost: record.usage.cost
  }
}


// Terminal agents: Foreman sees the files and the process, nothing else.
export const TERMINAL_CAPS: Record<Capability, boolean> = { approvals: false, plan: false, steer: false, rewind: false, mcp: false, cost: false }

export const UNCONFIRMED: AuthSpec = { confirmed: false }

export const FULL_AGENT_IDS = ['claude', 'codex', 'cursor', 'opencode'] as const
export const CHAT_AGENT_IDS = ['gemini', 'qwen', 'kimi', 'droid', 'copilot', 'goose', 'deepseek', 'pi', 'commandcode', 'omp', 'antigravity'] as const
export const TERMINAL_AGENT_IDS = [
  'aider', 'amp', 'crush', 'cline', 'kiro', 'kilocode', 'continue', 'devin', 'openhands', 'auggie', 'grok', 'vibe',
  'kimchi', 'muse', 'mimo', 'autohand', 'codewhale', 'primeagent'
] as const

export type FullAgentId = (typeof FULL_AGENT_IDS)[number]
export type ChatAgentId = (typeof CHAT_AGENT_IDS)[number]
export type TerminalAgentId = (typeof TERMINAL_AGENT_IDS)[number]
export type CatalogAgentId = FullAgentId | ChatAgentId | TerminalAgentId

/** The agent a new chat, loadout or schedule starts on when nothing says otherwise. */
export const DEFAULT_AGENT: FullAgentId = 'claude'
