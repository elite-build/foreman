// ACP catalogue reference portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's TypeScript catalogue; see NOTICE and docs/licenses/acp-integration.txt.
// #22: every coding agent Foreman can run, and how well. Three integration levels:
//   full     — Foreman's own adapters (Claude Code, Codex, Cursor, OpenCode).
//   chat     — a structured chat over the Agent Client Protocol (main/agents/acp.ts);
//              approvals work, other controls depend on the agent.
//   terminal — the agent's own CLI in a terminal tab in the worktree; Foreman sees the
//              files and the process, not the conversation.
// Launch commands and sign-in methods come from agent docs and external
// integration references; `acp.source` distinguishes those sources,
// and agents whose sign-in nobody has confirmed are marked `auth.confirmed: false`
// ("Check docs") and get no keys. Data only, plus pure helpers both processes use.
import type { PlainKey } from './i18n'
import type { AgentAuthMode, AgentStatus } from './types'

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
}

export interface ApiKeyMethod {
  // The variable the saved key is passed as.
  envVar: string
  // Variables Login mode removes too, so a stray key never switches the agent to API billing.
  alsoStrip?: string[]
  keyUrl?: string
}

export interface AuthSpec {
  login?: LoginMethod
  apiKey?: ApiKeyMethod
  // Takes provider keys (OPENAI_API_KEY, …) from Settings → Provider keys, only the ones ticked for it.
  sharedKeys?: boolean
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
  // Only the four Full agents start enabled.
  defaultEnabled?: boolean
}

const FULL_CAPS = (c: Partial<Record<Capability, boolean>>): Record<Capability, boolean> => ({
  approvals: true,
  plan: false,
  steer: false,
  rewind: true,
  mcp: true,
  cost: true,
  ...c
})

// Chat agents: tool approvals arrive as ACP permission requests, and a turn's cost shows
// when the agent reports one. Plan is off here because it isn't known until the agent
// says so: G1 turns it on for an agent that declares a plan session mode (acpPlanMode).
// Foreman can't steer a running ACP prompt and can't fork an ACP conversation (rewind).
// #20: the repo's approved MCP servers go in the ACP session, as for OpenCode.
const CHAT_CAPS: Record<Capability, boolean> = { approvals: true, plan: false, steer: false, rewind: false, mcp: true, cost: false }

// Terminal agents: Foreman sees the files and the process, nothing else.
const TERMINAL_CAPS: Record<Capability, boolean> = { approvals: false, plan: false, steer: false, rewind: false, mcp: false, cost: false }

const UNCONFIRMED: AuthSpec = { confirmed: false }

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

export const AGENT_CATALOG: CatalogAgent[] = [
  // ---- Full ----
  {
    id: 'claude', name: 'Claude Code', monogram: 'Cc', level: 'full', binaries: ['claude'], versionArgs: ['--version'],
    auth: { login: { args: ['auth', 'login'], statusArgs: ['auth', 'status'] }, apiKey: { envVar: 'ANTHROPIC_API_KEY', alsoStrip: ['ANTHROPIC_AUTH_TOKEN'], keyUrl: 'https://console.anthropic.com/settings/keys' }, confirmed: true },
    capabilities: FULL_CAPS({ plan: true, steer: true }), docsUrl: 'https://code.claude.com/docs/en/installation', defaultEnabled: true
  },
  {
    id: 'codex', name: 'Codex', monogram: 'Cx', level: 'full', binaries: ['codex'], versionArgs: ['--version'],
    auth: { login: { args: ['login'] }, apiKey: { envVar: 'CODEX_API_KEY', alsoStrip: ['AI_GATEWAY_API_KEY', 'OPENAI_BASE_URL'], keyUrl: 'https://platform.openai.com/api-keys' }, confirmed: true },
    capabilities: FULL_CAPS({}), docsUrl: 'https://github.com/openai/codex', defaultEnabled: true
  },
  {
    id: 'cursor', name: 'Cursor', monogram: 'Cu', level: 'full', binaries: ['cursor-agent'], versionArgs: ['--version'],
    auth: { apiKey: { envVar: 'CURSOR_API_KEY', keyUrl: 'https://cursor.com/dashboard/api?section=user-keys#user-api-keys' }, confirmed: true },
    capabilities: FULL_CAPS({}), docsUrl: 'https://docs.cursor.com/en/cli/installation', defaultEnabled: true
  },
  {
    id: 'opencode', name: 'OpenCode', monogram: 'Oc', level: 'full', binaries: ['opencode'], versionArgs: ['--version'],
    auth: { sharedKeys: true, confirmed: true },
    capabilities: FULL_CAPS({}), docsUrl: 'https://opencode.ai/docs', defaultEnabled: true
  },

  // ---- Chat (ACP) ----
  {
    // The flag is from Gemini CLI's docs (newer builds also take --acp).
    id: 'gemini', name: 'Gemini CLI', monogram: 'Ge', level: 'chat', binaries: ['gemini'], versionArgs: ['--version'],
    acp: { args: ['--experimental-acp'], source: 'docs' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.google' }, apiKey: { envVar: 'GEMINI_API_KEY', alsoStrip: ['GOOGLE_API_KEY'], keyUrl: 'https://aistudio.google.com/apikey' }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://geminicli.com/docs/get-started/installation/', scratch: ['.gemini/']
  },
  {
    id: 'qwen', name: 'Qwen Code', monogram: 'Qw', level: 'chat', binaries: ['qwen'], versionArgs: ['--version'],
    acp: { args: ['--acp'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.qwen' }, sharedKeys: true, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/', scratch: ['.qwen/']
  },
  {
    id: 'kimi', name: 'Kimi CLI', monogram: 'Ki', level: 'chat', binaries: ['kimi'], versionArgs: ['--version'],
    acp: { args: ['acp'], source: 'reference' },
    auth: { login: { args: ['login'] }, apiKey: { envVar: 'KIMI_API_KEY', alsoStrip: ['MOONSHOT_API_KEY', 'KIMI_CODE_API_KEY'] }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://moonshotai.github.io/kimi-code/en/', scratch: ['.kimi/']
  },
  {
    // G1: each turn gets a `--settings` overlay (model and autonomy) that Foreman
    // writes in its own data folder, never in the repo (main/agents/catalogDrivers.ts).
    id: 'droid', name: 'Factory Droid', monogram: 'Fd', level: 'chat', binaries: ['droid'], versionArgs: ['--version'],
    acp: { args: ['exec', '--output-format', 'acp-daemon'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, apiKey: { envVar: 'FACTORY_API_KEY', keyUrl: 'https://app.factory.ai/settings/api-keys' }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://docs.factory.ai/droid-cli/cli-reference', scratch: ['.factory/']
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', monogram: 'Gh', level: 'chat', binaries: ['copilot'], versionArgs: ['--version'],
    acp: { args: ['--acp', '--no-auto-update'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, apiKey: { envVar: 'COPILOT_GITHUB_TOKEN', keyUrl: 'https://github.com/settings/personal-access-tokens/new' }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli'
  },
  {
    // `goose acp` is from Goose's docs.
    id: 'goose', name: 'Goose', monogram: 'Go', level: 'chat', binaries: ['goose'], versionArgs: ['--version'],
    acp: { args: ['acp'], source: 'docs' },
    auth: { login: { args: ['configure'] }, sharedKeys: true, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://goose-docs.ai/docs/getting-started/installation/'
  },
  {
    id: 'deepseek', name: 'DeepSeek', monogram: 'Ds', level: 'chat', binaries: ['dsh'], versionArgs: ['--version'],
    acp: { args: ['--profile', 'acp'], source: 'reference' },
    auth: { apiKey: { envVar: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys' }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://github.com/deepseek-ai/deepseek-harness'
  },
  {
    // ACP runs through the separate pi-acp adapter (npm i -g @victor-software-house/pi-acp).
    id: 'pi', name: 'Pi', monogram: 'Pi', level: 'chat', binaries: ['pi'], versionArgs: ['--version'],
    acp: { args: [], binaries: ['pi-acp'], install: 'npm i -g @victor-software-house/pi-acp', expect: { name: '@victor-software-house/pi-acp', minVersion: '0.17.1' }, source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, sharedKeys: true, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://github.com/earendil-works/pi', scratch: ['.pi/']
  },
  {
    id: 'commandcode', name: 'Command Code', monogram: 'Cm', level: 'chat', binaries: ['cmd', 'command-code'], winBinaries: ['cmdc', 'command-code'], versionArgs: ['--version'],
    acp: { args: ['acp', '--skip-onboarding', '--no-auto-update', '--trust'], source: 'reference' },
    auth: { login: { args: ['login'], statusArgs: ['status'] }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://commandcode.ai/docs/quickstart', scratch: ['.commandcode/']
  },
  {
    id: 'omp', name: 'OMP', monogram: 'Om', level: 'chat', binaries: ['omp'], versionArgs: ['--version'],
    acp: { args: ['acp'], source: 'reference' },
    auth: { login: { args: [], hint: 'agentCatalog.hint.login' }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://github.com/can1357/oh-my-pi', scratch: ['.omp/']
  },
  {
    // ACP is the separate agy_acp_server program (the ACP registry's "antigravity-acp"), installed next to agy.
    id: 'antigravity', name: 'Antigravity', monogram: 'Ag', level: 'chat', binaries: ['agy'], versionArgs: ['--version'],
    acp: {
      args: [], binaries: ['agy_acp_server', 'agy_acp_server.par'], winBinaries: ['agy_acp_server.exe', 'agy_acp_server'],
      install: 'Install Google’s “antigravity-acp” server (from the ACP registry) next to agy', installHint: 'agentCatalog.install.antigravity', expect: { name: 'antigravity-acp', minVersion: '1.3.0' }, source: 'reference'
    },
    auth: { login: { args: [], hint: 'agentCatalog.hint.browser' }, confirmed: true },
    capabilities: CHAT_CAPS, docsUrl: 'https://github.com/google-antigravity/antigravity-cli', scratch: ['.agents/']
  },

  // ---- Terminal ----
  {
    id: 'aider', name: 'Aider', monogram: 'Ai', level: 'terminal', binaries: ['aider'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://aider.chat/docs/install.html', scratch: ['.aider*']
  },
  {
    id: 'amp', name: 'Amp', monogram: 'Am', level: 'terminal', binaries: ['amp'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, apiKey: { envVar: 'AMP_API_KEY', keyUrl: 'https://ampcode.com/settings' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://ampcode.com/manual'
  },
  {
    id: 'crush', name: 'Crush', monogram: 'Cr', level: 'terminal', binaries: ['crush'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/charmbracelet/crush', scratch: ['.crush/']
  },
  {
    id: 'cline', name: 'Cline', monogram: 'Cl', level: 'terminal', binaries: ['cline'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['auth'] }, apiKey: { envVar: 'CLINE_API_KEY' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/cline/cline'
  },
  {
    id: 'kiro', name: 'Kiro', monogram: 'Kr', level: 'terminal', binaries: ['kiro-cli'], versionArgs: ['--version'], terminal: { args: ['chat'] },
    auth: { login: { args: ['login'], statusArgs: ['whoami', '--format', 'json'] }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://kiro.dev/docs/getting-started/installation/'
  },
  {
    id: 'kilocode', name: 'Kilo Code', monogram: 'Kc', level: 'terminal', binaries: ['kilo', 'kilocode'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['auth', 'login'] }, sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli'
  },
  {
    id: 'continue', name: 'Continue', monogram: 'Co', level: 'terminal', binaries: ['cn'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.continue.dev/cli/quickstart'
  },
  {
    id: 'devin', name: 'Devin', monogram: 'Dv', level: 'terminal', binaries: ['devin'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['auth', 'login'], statusArgs: ['auth', 'status'] }, apiKey: { envVar: 'DEVIN_API_KEY' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.devin.ai/get-started/devin-intro'
  },
  {
    id: 'openhands', name: 'OpenHands', monogram: 'Oh', level: 'terminal', binaries: ['openhands'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { sharedKeys: true, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.openhands.dev/openhands/usage/cli/installation', scratch: ['.openhands/']
  },
  {
    id: 'auggie', name: 'Auggie', monogram: 'Au', level: 'terminal', binaries: ['auggie'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['login'] }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.augmentcode.com/cli/overview'
  },
  {
    id: 'grok', name: 'Grok CLI', monogram: 'Gr', level: 'terminal', binaries: ['grok'], versionArgs: ['--version'], terminal: { args: ['--no-auto-update'] },
    auth: { login: { args: ['login'] }, apiKey: { envVar: 'XAI_API_KEY', keyUrl: 'https://console.x.ai' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.x.ai/build/overview'
  },
  {
    id: 'vibe', name: 'Mistral Vibe', monogram: 'Mv', level: 'terminal', binaries: ['vibe'], versionArgs: ['--version'], terminal: { args: [] },
    auth: { login: { args: ['--setup'] }, apiKey: { envVar: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys' }, confirmed: true },
    capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/mistralai/mistral-vibe', scratch: ['.vibe/']
  },
  { id: 'kimchi', name: 'Kimchi', monogram: 'Kh', level: 'terminal', binaries: ['kimchi'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.kimchi.dev/docs/coding-getting-started' },
  { id: 'muse', name: 'Muse', monogram: 'Mu', level: 'terminal', binaries: ['muse'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://ai.meta.com/llama/' },
  { id: 'mimo', name: 'Mimo Code', monogram: 'Mi', level: 'terminal', binaries: ['mimo'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/XiaomiMiMo/MiMo-Code' },
  { id: 'autohand', name: 'Autohand', monogram: 'Ah', level: 'terminal', binaries: ['autohand'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://docs.autohand.ai/working-with-autohand-code/cli' },
  { id: 'codewhale', name: 'Codewhale', monogram: 'Cw', level: 'terminal', binaries: ['codewhale', 'codew'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/Hmbown/Codewhale' },
  { id: 'primeagent', name: 'Prime Agent', monogram: 'Pa', level: 'terminal', binaries: ['prime-agent'], versionArgs: ['--version'], terminal: { args: [] }, auth: UNCONFIRMED, capabilities: TERMINAL_CAPS, docsUrl: 'https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md' }
]

const BY_ID = new Map(AGENT_CATALOG.map((a) => [a.id, a]))

export function catalogAgent(id: string): CatalogAgent | undefined {
  return BY_ID.get(id)
}

export function isChatAgent(id: string): id is ChatAgentId {
  return BY_ID.get(id)?.level === 'chat'
}

export function isTerminalAgent(id: string): id is TerminalAgentId {
  return BY_ID.get(id)?.level === 'terminal'
}

export function agentLevel(id: string): IntegrationLevel {
  return BY_ID.get(id)?.level ?? 'full'
}

/** The binary names to look for on this platform. */
export function binariesFor(agent: CatalogAgent, platform: string): string[] {
  return platform === 'win32' && agent.winBinaries ? agent.winBinaries : agent.binaries
}

// ---- per-agent preferences (Settings.agentPrefs) ----

export interface AgentPref {
  enabled?: boolean
  // Agents with both methods: Login ('cli') or API key. Claude and Codex keep claudeAuth / codexAuth.
  auth?: AgentAuthMode
  // A custom executable; empty: the one on PATH.
  path?: string
}

export type AgentPrefs = Record<string, AgentPref>

export function isAgentEnabled(id: string, prefs: AgentPrefs | undefined): boolean {
  return prefs?.[id]?.enabled ?? Boolean(BY_ID.get(id)?.defaultEnabled)
}

export function enabledAgentIds(prefs: AgentPrefs | undefined, level?: IntegrationLevel): string[] {
  return AGENT_CATALOG.filter((a) => (!level || a.level === level) && isAgentEnabled(a.id, prefs)).map((a) => a.id)
}

/** Settings fields the sign-in helpers read. */
export interface AuthSettings {
  claudeAuth: AgentAuthMode
  codexAuth: AgentAuthMode
  agentPrefs?: AgentPrefs
}

/** The sign-in methods an agent offers, in the order shown. */
export type SignInMethod = 'login' | 'apiKey' | 'shared'

export function signInMethods(agent: CatalogAgent): SignInMethod[] {
  if (!agent.auth.confirmed) return []
  const out: SignInMethod[] = []
  if (agent.auth.login) out.push('login')
  if (agent.auth.apiKey) out.push('apiKey')
  if (agent.auth.sharedKeys) out.push('shared')
  return out
}

/** Login ('cli') or API key for an agent with both; with one method, that one. */
export function agentAuthMode(id: string, settings: AuthSettings): AgentAuthMode {
  if (id === 'claude') return settings.claudeAuth
  if (id === 'codex') return settings.codexAuth
  const agent = BY_ID.get(id)
  if (!agent?.auth.apiKey) return 'cli'
  if (!agent.auth.login) return 'apiKey'
  return settings.agentPrefs?.[id]?.auth ?? 'cli'
}

/** Whether the agent runs with its own saved API key now (and Login's variables are stripped otherwise). */
export function usesOwnApiKey(id: string, settings: AuthSettings): boolean {
  const agent = BY_ID.get(id)
  if (!agent?.auth.confirmed || !agent.auth.apiKey) return false
  return agentAuthMode(id, settings) === 'apiKey'
}

/** Variables an agent's Login mode must not see. */
export function loginStripVars(agent: CatalogAgent): string[] {
  return agent.auth.apiKey ? [agent.auth.apiKey.envVar, ...(agent.auth.apiKey.alsoStrip ?? [])] : []
}

// ---- shared provider keys ----

/** Provider key (env var) → agent ids ticked for it. OpenCode isn't listed: it always gets every key. */
export type ProviderKeyAgents = Record<string, string[]>

/** Whether an agent can be ticked for provider keys at all. OpenCode is always on and can't be unticked. */
export function takesSharedKeys(id: string): boolean {
  const agent = BY_ID.get(id)
  return Boolean(agent?.auth.confirmed && agent.auth.sharedKeys)
}

/** The provider keys an agent gets: all of them for OpenCode, the ticked ones for agents that take shared keys, none otherwise. */
export function allowedProviderKeys(id: string, keys: Record<string, string>, allow: ProviderKeyAgents | undefined): Record<string, string> {
  if (id === 'opencode') return { ...keys }
  if (!takesSharedKeys(id)) return {}
  return Object.fromEntries(Object.entries(keys).filter(([envVar]) => allow?.[envVar]?.includes(id)))
}

/** The ids ticked for one provider key, with OpenCode first (locked on). */
export function keyAgents(envVar: string, allow: ProviderKeyAgents | undefined): string[] {
  return ['opencode', ...(allow?.[envVar] ?? []).filter((id) => id !== 'opencode' && takesSharedKeys(id))]
}

/** Ticks or unticks an agent for a key; OpenCode can't be changed. */
export function toggleKeyAgent(allow: ProviderKeyAgents | undefined, envVar: string, id: string, on: boolean): ProviderKeyAgents {
  const next = { ...(allow ?? {}) }
  if (id === 'opencode' || !takesSharedKeys(id)) return next
  const current = new Set(next[envVar] ?? [])
  if (on) current.add(id)
  else current.delete(id)
  if (current.size) next[envVar] = [...current].sort()
  else delete next[envVar]
  return next
}

/** Drops unknown agents, non-strings and empty lists from a saved allow-list. */
export function parseProviderKeyAgents(value: unknown): ProviderKeyAgents {
  if (!value || typeof value !== 'object') return {}
  const out: ProviderKeyAgents = {}
  for (const [envVar, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar) || !Array.isArray(ids)) continue
    const kept = [...new Set(ids.filter((id): id is string => typeof id === 'string' && takesSharedKeys(id)))].sort()
    if (kept.length) out[envVar] = kept
  }
  return out
}

/** Keeps only known agents and the fields AgentPref has. */
export function parseAgentPrefs(value: unknown): AgentPrefs {
  if (!value || typeof value !== 'object') return {}
  const out: AgentPrefs = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!BY_ID.has(id) || !raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const pref: AgentPref = {}
    if (typeof r.enabled === 'boolean') pref.enabled = r.enabled
    if (r.auth === 'cli' || r.auth === 'apiKey') pref.auth = r.auth
    if (typeof r.path === 'string' && r.path.trim()) pref.path = r.path.trim()
    if (Object.keys(pref).length) out[id] = pref
  }
  return out
}

// ---- capabilities ----

/** An ACP session mode as the agent declared it (session/new's `modes`, or a config option of category "mode"). */
export interface AcpMode {
  id: string
  name: string
}

const PLAN_MODE = /^(plan|planning|plan[-_ ]mode)$/i

/**
 * G1: the agent's plan mode, if it declared one: a mode whose id or name is "plan" (OpenCode's `plan` agent, Gemini's
 * and Claude's ACP `plan`). Only what the agent itself offered; Foreman never guesses a mode from its description.
 */
export function acpPlanMode(modes: AcpMode[] | undefined): AcpMode | undefined {
  return modes?.find((m) => PLAN_MODE.test(m.id.trim())) ?? modes?.find((m) => PLAN_MODE.test(m.name.trim()))
}

/** Whether an ACP agent (OpenCode or a Chat agent) can do plan mode, by what it declared at its last start. */
export function declaresPlanMode(id: string, modes: AcpMode[] | undefined): boolean {
  const level = BY_ID.get(id)?.level
  return (id === 'opencode' || level === 'chat') && Boolean(acpPlanMode(modes))
}

/** Capabilities Foreman can't offer for this agent, in chip order. G1: `modes` (what it declared) turns plan on where it offers a plan mode. */
export function missingCapabilities(id: string, modes?: AcpMode[]): Capability[] {
  const agent = BY_ID.get(id)
  if (!agent) return []
  return CAPABILITIES.filter((c) => !agent.capabilities[c] && !(c === 'plan' && declaresPlanMode(id, modes)))
}

/** Which composer and chat controls to show for an agent's chat. Unsupported ones are hidden, not greyed out. Steering stays off for ACP agents. */
export function agentControls(id: string, modes?: AcpMode[]): { plan: boolean; steer: boolean; restore: boolean } {
  const agent = BY_ID.get(id)
  if (!agent) return { plan: false, steer: false, restore: true }
  return { plan: agent.capabilities.plan || declaresPlanMode(id, modes), steer: agent.capabilities.steer, restore: agent.capabilities.rewind }
}

// ---- #20: repo MCP servers ----

/**
 * How an agent gets the MCP servers a repo proposes and this Mac approved, or why it doesn't.
 * `sdk`: Claude's Agent SDK `mcpServers`. `config`: Codex's per-process `--config mcp_servers.…`.
 * `acp`: the `mcpServers` of the ACP session (OpenCode and the Chat agents; ACP requires stdio servers).
 * `cursor` (G1): the Cursor SDK's `mcpServers` for its local agent. On per the owner's call, but no Cursor launch and
 * tool call with them has been run here (no Cursor key), which the UI says. Terminal agents read only their own
 * config files, which Foreman doesn't write. (`reason: 'cursor'` is no longer returned; kept for saved receipts.)
 */
export type RepoMcpSupport = { supported: true; via: 'sdk' | 'config' | 'acp' | 'cursor' } | { supported: false; reason: 'cursor' | 'terminal' | 'unknown' }

export function repoMcpSupport(id: string): RepoMcpSupport {
  if (id === 'claude') return { supported: true, via: 'sdk' }
  if (id === 'codex') return { supported: true, via: 'config' }
  if (id === 'cursor') return { supported: true, via: 'cursor' }
  const level = BY_ID.get(id)?.level
  if (id === 'opencode' || level === 'chat') return { supported: true, via: 'acp' }
  return { supported: false, reason: level === 'terminal' ? 'terminal' : 'unknown' }
}

export interface RepoMcpReachRow {
  id: string
  name: string
  support: RepoMcpSupport
}

/**
 * The agents an approved repo server reaches, as the consent dialog, the MCP section and the agent pages list
 * them: the Full agents and any enabled Chat agent, those that get it first and the rest (Cursor) after.
 */
export function repoMcpReach(prefs: AgentPrefs | undefined): RepoMcpReachRow[] {
  const rows = AGENT_CATALOG.filter((a) => a.level === 'full' || (a.level === 'chat' && isAgentEnabled(a.id, prefs))).map((a) => ({ id: a.id, name: a.name, support: repoMcpSupport(a.id) }))
  return [...rows.filter((r) => r.support.supported), ...rows.filter((r) => !r.support.supported)]
}

// ---- detection (main → renderer) ----

export interface AgentDetection {
  id: string
  installed: boolean
  // Where it was found, and what --version said.
  path?: string
  version?: string
  // Found, but its version check failed: the command and what it printed.
  error?: { command: string; output: string }
  // G1: an agent whose ACP mode is a separate program (Pi's pi-acp, Antigravity's agy_acp_server): where it was found, if it was.
  acpProgram?: { name: string; path?: string; install?: string }
  checkedAt: string
}

/** What the agent itself reported when it last started over ACP (initialize, session/new). */
export interface AcpReported {
  loadSession: boolean
  resume: boolean
  images: boolean
  // Session modes it offered, e.g. ["default", "plan"]. G1: a plan mode is what the Plan chip switches to.
  modes: string[]
  // What it said it is (initialize's agentInfo), when it said.
  agentInfo?: { name: string; version: string }
  at: string
}

export interface AgentCatalogView {
  detections: Record<string, AgentDetection>
  // The Full agents' own status checks (version, sign-in), as their settings pages show them.
  statuses: Record<string, AgentStatus>
  acp: Record<string, AcpReported>
  // Agent id → env var names found in the user's shell that "Import from shell" could copy (names only, never values).
  shellKeys: Record<string, string>
  // Provider env vars set in the user's shell (names only).
  shellProviderKeys: string[]
  // Provider env vars saved in Foreman's store.
  savedProviderKeys: string[]
  // G1: their last four characters ('' when too short to show), for the masked value.
  providerKeyHints?: Record<string, string>
  checkedAt?: string
}

// ---- the catalog page ----

export type CatalogFilter = 'all' | 'enabled' | 'installed' | 'chat' | 'terminal'

export function filterCatalog(
  agents: CatalogAgent[],
  filter: CatalogFilter,
  query: string,
  state: { enabled: (id: string) => boolean; installed: (id: string) => boolean }
): CatalogAgent[] {
  const q = query.trim().toLowerCase()
  return agents.filter((a) => {
    if (q && !a.name.toLowerCase().includes(q) && !a.id.includes(q)) return false
    switch (filter) {
      case 'enabled':
        return state.enabled(a.id)
      case 'installed':
        return state.installed(a.id)
      case 'chat':
        return a.level === 'chat'
      case 'terminal':
        return a.level === 'terminal'
      default:
        return true
    }
  })
}

// ---- sign-in overview ----

export type SignInState =
  // G1: `source` when it came from a credentials probe (a file or command), not the agent's own answer.
  | { kind: 'signed-in'; account?: string; source?: string }
  | { kind: 'api-key'; hint: string }
  | { kind: 'not-signed-in' }
  | { kind: 'no-key' }
  | { kind: 'provider-keys'; count: number }
  | { kind: 'no-provider-keys' }
  | { kind: 'unknown' }
  | { kind: 'check-docs' }

/**
 * G1: agents whose sign-in Foreman looks for on disk (main/agents/signInProbes.ts), from where their docs say they
 * keep it. Found: "Credentials found", with the file; not found: Unknown, never "not signed in".
 */
export const CREDENTIAL_PROBES = ['gemini', 'antigravity', 'qwen', 'copilot', 'amp', 'droid', 'kimi', 'goose', 'pi', 'omp', 'cline', 'kilocode', 'auggie', 'grok', 'vibe'] as const

/** Whether Foreman can ask about this agent's sign-in at all: its own status command, or a credentials probe. */
export function canCheckSignIn(agent: CatalogAgent): boolean {
  return agent.level !== 'full' && agent.auth.confirmed && Boolean(agent.auth.login?.statusArgs || (CREDENTIAL_PROBES as readonly string[]).includes(agent.id))
}

/**
 * What the Sign-in page says for an agent. Only what something actually reported:
 * a saved key's last four characters, the count of ticked provider keys, or the
 * agent's own status answer; otherwise Unknown.
 */
export function signInState(
  agent: CatalogAgent,
  input: {
    mode: AgentAuthMode
    // Last four of the agent's own saved key (undefined: none saved).
    keyHint?: string
    // Provider keys this agent gets.
    providerKeys: number
    // What the agent's status command said, if it has one and it ran (G1: or what its credentials probe found, with `source`).
    reported?: { signedIn: boolean; account?: string; source?: string }
  }
): SignInState {
  if (!agent.auth.confirmed) return { kind: 'check-docs' }
  const methods = signInMethods(agent)
  if (methods.includes('apiKey') && (input.mode === 'apiKey' || !methods.includes('login'))) {
    return input.keyHint !== undefined ? { kind: 'api-key', hint: input.keyHint } : { kind: 'no-key' }
  }
  if (methods.includes('login')) {
    const r = input.reported
    if (r) return r.signedIn ? { kind: 'signed-in', account: r.account, ...(r.source ? { source: r.source } : {}) } : { kind: 'not-signed-in' }
    return { kind: 'unknown' }
  }
  if (methods.includes('shared')) return input.providerKeys > 0 ? { kind: 'provider-keys', count: input.providerKeys } : { kind: 'no-provider-keys' }
  return { kind: 'unknown' }
}

// ---- terminal agents ----

/** After this long without output a running terminal agent reads "quiet". */
export const TERMINAL_QUIET_MS = 60_000

export interface TerminalAgentRun {
  ptyId: string
  workspaceId: string
  agent: string
  startedAt: number
  lastOutputAt: number
  // Set once the process has exited.
  exitCode?: number
}

export type TerminalActivity = { kind: 'running'; secondsAgo: number } | { kind: 'quiet' } | { kind: 'exited'; code: number }

/** The sidebar's view of a terminal agent, from process and output activity only. It never claims the agent needs you. */
export function terminalActivity(run: Pick<TerminalAgentRun, 'lastOutputAt' | 'exitCode'>, now: number): TerminalActivity {
  if (run.exitCode !== undefined) return { kind: 'exited', code: run.exitCode }
  const idle = Math.max(0, now - run.lastOutputAt)
  if (idle >= TERMINAL_QUIET_MS) return { kind: 'quiet' }
  return { kind: 'running', secondsAgo: Math.floor(idle / 1000) }
}

/** Lines to add to a worktree's .git/info/exclude for an agent's scratch files: only the ones not there yet. */
export function excludeAdditions(existing: string, patterns: string[]): string[] {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()))
  return patterns.filter((p) => !have.has(p))
}

/** The terminal command line shown on the tab (e.g. "aider"). */
export function terminalCommandText(agent: CatalogAgent, binary?: string): string {
  return [binary ?? binariesFor(agent, '')[0], ...(agent.terminal?.args ?? [])].join(' ')
}
