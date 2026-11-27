// ACP launch and sign-in portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's runtime and permission policies; see NOTICE and docs/licenses/acp-integration.txt.
// #22: drivers for the catalog's Chat agents, each the generic ACP adapter
// (acp/index.ts, the one OpenCode uses) with that agent's launch command. What an
// agent declares when it starts (capabilities, session modes) is remembered
// for the Agents catalog.
import type * as acp from '@agentclientprotocol/sdk/unstable'
import { methods as acpMethods } from '@agentclientprotocol/sdk/unstable'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binariesFor, catalogAgent, type AcpReported, type CatalogAgent } from '../../../shared/agentCatalog'
import { olderThan, parseVersion } from '../../../shared/agentVersions'
import type { AgentKind } from '../../../shared/agents'
import type { AgentInstance } from '../../../shared/agentInstances'
import type { Settings } from '../../../shared/types'
import { createAcpDriver, type AcpAgentConfig, type AcpCommand, type AcpConnector, type AcpLaunchContext } from './index'
import { shellQuote } from '../../platform'
import { acpProgramNames, findAcpProgram, findBinary, launchFor } from '../catalogDetect'
import type { AgentDriver } from '../types'

/**
 * The executable an agent runs with: the path set in Settings, else undefined (look on PATH).
 * #130: an account with a binary of its own runs that one; without, the default account's.
 */
export function executablePathFor(settings: Settings, agent: string, instance?: AgentInstance): string | undefined {
  if (instance?.path) return instance.path
  const legacy: Record<string, string | undefined> = {
    claude: settings.claudeExecutablePath,
    codex: settings.codexExecutablePath,
    opencode: settings.opencodeExecutablePath
  }
  return (agent in legacy ? legacy[agent] : settings.agentPrefs?.[agent]?.path) || undefined
}

export interface LaunchEnv {
  path: string
  platform: NodeJS.Platform
  pathExt?: string
  exists(file: string): boolean
}

function realLaunchEnv(): LaunchEnv {
  return { path: process.env.PATH ?? process.env.Path ?? '', platform: process.platform, pathExt: process.env.PATHEXT, exists: existsSync }
}

/**
 * How to start a Chat agent in ACP mode: the configured executable, else the
 * first of its ACP binaries found on PATH. Not found: its bare name, so the
 * spawn fails as "not installed" and the notice points at Settings.
 * G1: a separate ACP program (pi-acp) is looked for beside the agent's own CLI first
 * (the configured path, else the one on PATH). `prefix` goes before
 * the ACP arguments (Droid's `--settings <file>`).
 */
export function acpCommand(agent: CatalogAgent, executablePath: string | undefined, env: LaunchEnv = realLaunchEnv(), prefix: string[] = []): { file: string; args: string[] } {
  if (!agent.acp) throw new Error(`${agent.name} has no ACP mode`)
  const separate = acpProgramNames(agent, env.platform)
  let file: string
  if (separate.length) {
    file = findAcpProgram(agent, executablePath?.trim() || null, env) || separate[0]
  } else {
    const names = binariesFor(agent, env.platform)
    file = executablePath?.trim() || findBinary(names, env) || names[0]
  }
  return launchFor(file, [...prefix, ...agent.acp.args], env.platform)
}

// ---- G1: per-agent launch details ----

let runtimeDir = path.join(os.tmpdir(), 'foreman-agent-runtime')

/** Where per-turn launch files go (Droid's settings overlay): Foreman's own data folder, never the repo. */
export function setAgentRuntimeDir(dir: string): void {
  runtimeDir = dir
}

/**
 * Droid's autonomy for Foreman's approval setting. Asking for everything leaves Droid's
 * own setting alone (no override). Foreman still answers every permission request Droid raises by the same setting;
 * `--skip-permissions-unsafe` is never passed.
 */
const DROID_AUTONOMY: Partial<Record<AcpLaunchContext['approvals'], string>> = { 'ask-except-edits': 'low', auto: 'medium', 'never-ask': 'high' }

/**
 * Droid's `--settings` overlay for one turn: the chosen model and the autonomy level, or null when neither applies.
 * Droid applies it over the user's own ~/.factory/settings.json at org precedence, so nothing of theirs is replaced.
 */
export function droidSettings(model: string, approvals: AcpLaunchContext['approvals']): Record<string, unknown> | null {
  const level = DROID_AUTONOMY[approvals]
  const out: Record<string, unknown> = {}
  if (level) out.sessionDefaultSettings = { autonomyLevel: level }
  if (model.trim()) out.model = model.trim()
  return Object.keys(out).length ? out : null
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '-') || 'turn'
}

/** Writes the turn's Droid settings file and returns the arguments that pass it, and how to remove it again. */
export function droidLaunch(launch: AcpLaunchContext | undefined, dir = runtimeDir): { prefix: string[]; cleanup?: () => void } {
  const settings = launch && droidSettings(launch.model, launch.approvals)
  if (!launch || !settings) return { prefix: [] }
  const file = path.join(dir, 'droid', `foreman-droid-${safeName(launch.turnId)}-settings.json`)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(settings)}\n`, { mode: 0o600 })
  return { prefix: ['--settings', file], cleanup: () => rmSync(file, { force: true }) }
}

/**
 * pi-acp keeps a daemon; its socket folder is per workspace, so one project's first-start environment (its
 * PI_CODING_AGENT_DIR, provider keys) never serves another.
 */
export function piEnv(launch: { cwd: string } | undefined): Record<string, string> | undefined {
  if (!launch) return undefined
  const id = createHash('sha256').update(path.resolve(launch.cwd)).digest('hex').slice(0, 12)
  return { PI_ACP_SOCKET_DIR: path.join(os.tmpdir(), 'foreman-pi-acp', id) }
}

/**
 * Whether to select Antigravity's Gemini API key method: only in API-key mode (Foreman leaves GEMINI_API_KEY in the
 * environment then, and strips it for Login) and when `agy acp` offers it. Without this agy keeps its saved Google sign-in
 * even with a key set; selecting it lasts for that process only and changes nothing in agy's own settings.
 */
export function agyUsesApiKey(init: { authMethods?: unknown[] | null }, env: Record<string, string | undefined>): boolean {
  if (!env.GEMINI_API_KEY?.trim()) return false
  return (init.authMethods ?? []).some((m) => (m as { id?: unknown } | null)?.id === 'gemini-api-key')
}

/**
 * Grok Build's sign-in method for `authenticate`, chosen as xAI's own ACP example chooses it: `xai.api_key` in API-key mode
 * (Foreman leaves XAI_API_KEY in the environment then, and strips it for Login) when grok offers it, else its saved
 * `grok login` (`cached_token`). Undefined when it offers neither: the turn goes on, and grok's own error says what's missing.
 */
export function grokAuthMethod(init: { authMethods?: unknown[] | null }, env: Record<string, string | undefined>): string | undefined {
  const offered = new Set((init.authMethods ?? []).map((m) => (m as { id?: unknown } | null)?.id))
  if (env.XAI_API_KEY?.trim() && offered.has('xai.api_key')) return 'xai.api_key'
  return offered.has('cached_token') ? 'cached_token' : undefined
}

const AUTH_TIMEOUT_MS = 20_000

/** `authenticate`, bounded so a server that never answers can't hold the turn. */
async function authenticateWithin(agent: acp.ClientContext, params: acp.AuthenticateRequest, failure: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(failure)), AUTH_TIMEOUT_MS)))
  try {
    await Promise.race([agent.request(acpMethods.agent.authenticate, params), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** A note when the initialized program differs from the catalog's expected name or minimum version. */
export function expectedAgentNote(agent: CatalogAgent, info: { name: string; version: string } | undefined | null): string | undefined {
  const expect = agent.acp?.expect
  if (!expect || !info) return undefined
  if (info.name !== expect.name) {
    return `${agent.name}: Foreman expected the ${expect.name} program here, but this one says it is ${info.name || 'unnamed'}. It may not behave as expected.`
  }
  // A version that can't be read counts as older: the check has always asked for a plain x.y.z.
  if (!parseVersion(info.version) || olderThan(info.version, expect.minVersion)) {
    return `${agent.name}: ${expect.name} ${info.version} is older than ${expect.minVersion}, the configured minimum version. If something fails, update it.`
  }
  return undefined
}

/**
 * The command line a catalog agent's Login runs in the sign-in terminal: its binary (the configured
 * path, else the one on PATH) and its login arguments, for the terminal's shell. Only agents
 * whose sign-in is confirmed have one.
 */
export function catalogLoginCommand(id: string, executablePath: string | undefined, env: LaunchEnv = realLaunchEnv()): string {
  const agent = catalogAgent(id)
  const login = agent?.auth.confirmed ? agent.auth.login : undefined
  if (!agent || agent.level === 'full' || !login) throw new Error('Unknown command')
  const names = binariesFor(agent, env.platform)
  const file = executablePath?.trim() || findBinary(names, env) || names[0]
  // Quoted like Claude's and Codex's sign-in commands: the binary, then its plain-word arguments.
  return [shellQuote(file), ...login.args].join(' ')
}

const reported = new Map<string, AcpReported>()

/** What each Chat agent declared the last time it started in this run of Foreman. */
export function acpReported(): Record<string, AcpReported> {
  return Object.fromEntries(reported)
}

export function acpConfigFor(agent: CatalogAgent, options: { connect?: AcpConnector; launchEnv?: LaunchEnv; runtimeDir?: string } = {}): AcpAgentConfig {
  const install = agent.acp?.install
  return {
    kind: agent.id as AgentKind,
    label: agent.name,
    command: (exe, launch) => commandFor(agent, exe, launch, options),
    installHint: install
      ? `${agent.name} runs through a separate ACP program: ${install}. See ${agent.docsUrl}.`
      : `See ${agent.docsUrl} for how to install it, or set its path in Settings → Agents.`,
    connect: options.connect,
    reported: ({ capabilities, modes, agentInfo }) =>
      reported.set(agent.id, {
        loadSession: Boolean(capabilities?.loadSession),
        resume: Boolean(capabilities?.sessionCapabilities?.resume),
        images: Boolean(capabilities?.promptCapabilities?.image),
        modes,
        agentInfo,
        at: new Date().toISOString()
      }),
    checkAgent: agent.acp?.expect ? (init) => expectedAgentNote(agent, init.agentInfo) : undefined,
    ...(LAUNCH_EXTRAS[agent.id]?.() ?? {})
  }
}

/** The command for one launch, including per-agent settings and environment. */
function commandFor(agent: CatalogAgent, exe: string | undefined, launch: AcpLaunchContext | undefined, options: { launchEnv?: LaunchEnv; runtimeDir?: string }): AcpCommand {
  if (agent.id === 'droid') {
    const { prefix, cleanup } = droidLaunch(launch, options.runtimeDir)
    return { ...acpCommand(agent, exe, options.launchEnv, prefix), cleanup }
  }
  const command: AcpCommand = acpCommand(agent, exe, options.launchEnv)
  if (agent.id === 'pi') return { ...command, env: piEnv(launch) }
  return command
}

/** G1: per-agent startup, sign-in and instruction handling. */
const LAUNCH_EXTRAS: Record<string, () => Partial<AcpAgentConfig>> = {
  // pi-acp can exit during its first handshake while its daemon starts.
  pi: () => ({ retryStartupExit: true }),
  antigravity: () => ({
    // Login needs nothing: agy reuses its saved Google sign-in. API-key mode selects the key, bounded so a hanging server can't hold the turn.
    afterInitialize: async (agent, init, env) => {
      if (!agyUsesApiKey(init, env)) return
      await authenticateWithin(agent, { methodId: 'gemini-api-key' }, 'Antigravity didn’t accept your Gemini API key in time.')
    },
    // It follows plain text and treats an embedded resource as something to look up, so the instructions go as text.
    instructions: (text) => [
      { type: 'text', text: `Standing instructions from Foreman. Follow them for this whole session:\n<foreman_standing_instructions>\n${text.trim()}\n</foreman_standing_instructions>` }
    ]
  }),
  // Grok Build's own ACP example calls `authenticate` before a session, with the method the client chose, marked `headless` so it
  // never opens a browser from a turn (signing in is Login's job, in the sign-in terminal). Bounded like Antigravity's.
  grok: () => ({
    afterInitialize: async (agent, init, env) => {
      const methodId = grokAuthMethod(init, env)
      if (!methodId) return
      await authenticateWithin(agent, { methodId, _meta: { headless: true } }, 'Grok Build didn’t finish signing in in time.')
    }
  })
}

const drivers = new Map<string, AgentDriver>()

/** The ACP driver for a Chat agent, or undefined for any other id. */
export function catalogDriver(id: string): AgentDriver | undefined {
  const agent = catalogAgent(id)
  if (agent?.level !== 'chat') return undefined
  let driver = drivers.get(id)
  if (!driver) {
    driver = createAcpDriver(acpConfigFor(agent))
    drivers.set(id, driver)
  }
  return driver
}
