// ACP catalogue reference portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's TypeScript catalogue; see NOTICE and docs/licenses/acp-integration.txt.
// #22: every coding agent Foreman can run, and how well. Three integration levels:
//   full     — Foreman's own adapters (Claude Code, Codex, Cursor, OpenCode).
//   chat     — a structured chat over the Agent Client Protocol (main/agents/acp);
//              approvals work, other controls depend on the agent.
//   terminal — the agent's own CLI in a terminal tab in the worktree; Foreman sees the
//              files and the process, not the conversation.
// Launch commands and sign-in methods come from agent docs and external
// integration references; `acp.source` distinguishes those sources,
// and agents whose sign-in nobody has confirmed are marked `auth.confirmed: false`
// ("Check docs") and get no keys. Data only, plus pure helpers both processes use.
import type { AgentCapabilities, AgentCapabilitiesView } from '../agentCapabilities'
import type { AgentAuthMode, AgentStatus } from '../types'
import { ACP_CHAT_AGENTS, CHAT_AGENT_RECORDS } from './acpAgents'
import { CAPABILITIES, FULL_AGENT_IDS, type Capability, type CatalogAgent, type ChatAgentId, type FullAgentId, type IntegrationLevel, type TerminalAgentId } from './catalog'
import { CLAUDE_AGENT, CLAUDE_RECORD } from './claude'
import { CODEX_AGENT, CODEX_RECORD } from './codex'
import { CURSOR_AGENT, CURSOR_RECORD } from './cursor'
import { OPENCODE_AGENT, OPENCODE_RECORD } from './opencode'
import { TERMINAL_AGENTS } from './terminalAgents'

// Everything agentCatalog.ts exported before it became this folder, so `import … from '…/agentCatalog'` is unchanged.
// A new agent adds its file and one line to each list below.
export type { AcpSpec, AgentSettingsKeys, ApiKeyMethod, AuthSpec, CatalogAgent, CatalogAgentId, Capability, ChatAgentId, FullAgentId, IntegrationLevel, LoginMethod, ReadinessEvidence, TerminalAgentId } from './catalog'
export { capsOf, CAPABILITIES, CHAT_AGENT_IDS, DEFAULT_AGENT, FULL_AGENT_IDS, LEVELS, TERMINAL_AGENT_IDS } from './catalog'

const FULL_AGENT_RECORDS: Record<FullAgentId, AgentCapabilities> = { claude: CLAUDE_RECORD, codex: CODEX_RECORD, cursor: CURSOR_RECORD, opencode: OPENCODE_RECORD }

export const AGENT_CATALOG: CatalogAgent[] = [CLAUDE_AGENT, CODEX_AGENT, CURSOR_AGENT, OPENCODE_AGENT, ...ACP_CHAT_AGENTS, ...TERMINAL_AGENTS]

const BY_ID = new Map(AGENT_CATALOG.map((a) => [a.id, a]))

/** The agent whose own subagent files (.claude/agents) Foreman reads as personas. */
export const PERSONA_FILE_AGENT: FullAgentId = AGENT_CATALOG.find((a) => a.personaFiles)!.id as FullAgentId

/** Words the settings search matches on the Agents pages: the Full agents' ids, and some of the catalog's. */
export const AGENT_SEARCH_WORDS = { full: [...FULL_AGENT_IDS] as string[], catalog: ['gemini', 'qwen', 'kimi', 'droid', 'copilot', 'goose', 'aider', 'amp', 'crush', 'cline'] }

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

// ---- capability records (agentCapabilities.ts, and each agent's file in this folder) ----

/** The static capability record of an agent that can hold a chat (Full and Chat agents), or undefined for any other id. */
export function staticCapabilities(id: string): AgentCapabilities | undefined {
  const level = BY_ID.get(id)?.level
  if (level === 'full') return FULL_AGENT_RECORDS[id as FullAgentId]
  if (level === 'chat') return CHAT_AGENT_RECORDS[id as ChatAgentId]
  return undefined
}

/** Whether the agent can run with nobody there to answer an approval (`features.unattended`): scheduled runs and flow turns. */
export function canRunUnattended(id: string): boolean {
  return staticCapabilities(id)?.features.unattended === true
}

let staticView: AgentCapabilitiesView | undefined

/** Every static record with no declarations: what a process that has no snapshot yet (or a test's stub of one) reads. */
export function staticCapabilitiesView(): AgentCapabilitiesView {
  staticView ??= { agents: Object.fromEntries(AGENT_CATALOG.flatMap((a) => (a.level === 'terminal' ? [] : [[a.id, staticCapabilities(a.id)!]]))), declared: {} }
  return staticView
}

/** Whether the agent's model labels read "provider/model", shown as two lines (`models.twoLineNames`). */
export function hasTwoLineNames(id: string): boolean {
  return BY_ID.get(id)?.models?.twoLineNames === true
}

/** The settings that hold an agent's chosen subset of models (`settings.models` names the field). */
export interface ChosenModelSettings {
  opencodeModels: string[]
}

/**
 * The models the user ticked for an agent that lists a chosen subset (it can offer hundreds), or undefined for an agent whose
 * every model is listed.
 */
export function chosenModels(id: string, settings: ChosenModelSettings): string[] | undefined {
  const field = BY_ID.get(id)?.settings?.models
  return field ? settings[field] : undefined
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
  // #130: whether a chat may move to another of this agent's accounts (absent: never).
  moveChats?: import('../agentInstances').MoveRule
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
  const agent = BY_ID.get(id)
  const own = agent?.settings?.auth
  if (own) return settings[own]
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

/** The command that signs the agent in, as the terminal shows it ("claude auth login"); undefined for an agent with no Login. */
export function loginCommandLabel(agent: CatalogAgent): string | undefined {
  return agent.auth.login ? [agent.binaries[0], ...agent.auth.login.args].join(' ') : undefined
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
    if (r.moveChats === 'never' || r.moveChats === 'as-text') pref.moveChats = r.moveChats
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
