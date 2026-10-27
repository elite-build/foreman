// ACP launch and sign-in portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's runtime and permission policies; see NOTICE and docs/licenses/acp-integration.txt.
// #22: drivers for the catalog's Chat agents, each the generic ACP adapter
// (acp.ts, the one OpenCode uses) with that agent's launch command. What an
// agent declares when it starts (capabilities, session modes) is remembered
// for the Agents catalog.
import { methods as acpMethods } from '@agentclientprotocol/sdk/unstable'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binariesFor, catalogAgent, type AcpReported, type CatalogAgent } from '../../shared/agentCatalog'
import type { AgentKind } from '../../shared/agents'
import type { Settings } from '../../shared/types'
import { createAcpDriver, type AcpAgentConfig, type AcpCommand, type AcpConnector, type AcpLaunchContext } from './acp'
import { shellQuote } from '../platform'
import { acpProgramNames, findAcpProgram, findBinary, launchFor } from './catalogDetect'
import type { AgentDriver } from './types'

/** The executable an agent runs with: the path set in Settings, else undefined (look on PATH). */
export function executablePathFor(settings: Settings, agent: string): string | undefined {
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
 * G1: a separate ACP program (pi-acp, agy_acp_server) is looked for beside the agent's own CLI first
 * (the configured path, else the one on PATH). `prefix` goes before
 * the ACP arguments (Droid's `--settings <file>`).
 */
export function acpCommand(agent: CatalogAgent, executablePath: string | undefined, env: LaunchEnv = realLaunchEnv(), prefix: string[] = []): { file: string; args: string[] } {
  if (!agent.acp) throw new Error(`${agent.name} has no ACP mode`)
  const separate = acpProgramNames(agent, env.platform)
  let file: string
  if (separate.length) {
    const search = { ...env, path: [env.path, ...(EXTRA_DIRS[agent.id]?.(env.platform) ?? [])].filter(Boolean).join(env.platform === 'win32' ? ';' : ':') }
    file = findAcpProgram(agent, executablePath?.trim() || null, search) || separate[0]
  } else {
    const names = binariesFor(agent, env.platform)
    file = executablePath?.trim() || findBinary(names, env) || names[0]
  }
  return launchFor(file, [...prefix, ...agent.acp.args, ...(PLATFORM_ARGS[agent.id]?.(env.platform) ?? [])], env.platform)
}

// G1: additional installation directories for Antigravity's ACP server outside PATH.
const EXTRA_DIRS: Record<string, (platform: NodeJS.Platform) => string[]> = {
  antigravity: (platform) => (platform === 'win32' ? [] : ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')])
}

// G1: the ACP registry's per-platform arguments: Antigravity's Linux build needs an explicit empty --uid.
const PLATFORM_ARGS: Record<string, (platform: NodeJS.Platform) => string[]> = {
  antigravity: (platform) => (platform === 'linux' ? ['--uid='] : [])
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
 * Antigravity's server finds its localharness_external helper beside its real location (a symlinked server too).
 * Foreman does not set AGY_ACP_DISABLE_WORKSPACE_TRUST: a repository's hooks stay
 * behind Antigravity's own workspace trust.
 */
export function antigravityEnv(server: string, env: Record<string, string>, platform: NodeJS.Platform = process.platform, exists: (f: string) => boolean = existsSync): Record<string, string> | undefined {
  if (env.ANTIGRAVITY_HARNESS_PATH) return undefined
  let real = server
  try {
    real = realpathSync(server)
  } catch {
    // Not found: the spawn reports it.
  }
  const p = platform === 'win32' ? path.win32 : path.posix
  const helper = p.join(p.dirname(real), platform === 'win32' ? 'localharness_external.exe' : 'localharness_external')
  return p.isAbsolute(real) && exists(helper) ? { ANTIGRAVITY_HARNESS_PATH: helper } : undefined
}

/** GEMINI_HOME, where Antigravity keeps its sign-in: the agent's env, else Foreman's, else ~/.gemini. */
export function geminiHome(env: Record<string, string | undefined>, home = os.homedir()): string {
  return env.GEMINI_HOME?.trim() || process.env.GEMINI_HOME?.trim() || path.join(home, '.gemini')
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Whether to select Antigravity's "Log in with Google" for its ACP server: only when the server offers it, the
 * user is already signed in with Google (google_accounts.json names an active account) and the server has no sign-in
 * method of its own yet. Then it reuses that sign-in; it never starts a browser sign-in on its own.
 */
export function agyShouldAuthenticate(init: { authMethods?: unknown[] | null }, home: string): boolean {
  const offered = (init.authMethods ?? []).some((m) => (m as { id?: unknown } | null)?.id === 'oauth-personal')
  if (!offered) return false
  const auth = readJson(path.join(home, 'antigravity-acp', 'settings.json'))?.auth as { type?: unknown } | undefined
  const configured = typeof auth?.type === 'string' && auth.type.trim() !== ''
  const active = readJson(path.join(home, 'google_accounts.json'))?.active
  return !configured && typeof active === 'string' && active.trim() !== ''
}

const AGY_AUTH_TIMEOUT_MS = 20_000

/** A note when the initialized program differs from the catalog's expected name or minimum version. */
export function expectedAgentNote(agent: CatalogAgent, info: { name: string; version: string } | undefined | null): string | undefined {
  const expect = agent.acp?.expect
  if (!expect || !info) return undefined
  if (info.name !== expect.name) {
    return `${agent.name}: Foreman expected the ${expect.name} program here, but this one says it is ${info.name || 'unnamed'}. It may not behave as expected.`
  }
  if (olderThan(info.version, expect.minVersion)) {
    return `${agent.name}: ${expect.name} ${info.version} is older than ${expect.minVersion}, the configured minimum version. If something fails, update it.`
  }
  return undefined
}

function olderThan(version: string, minimum: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number)
  const a = parse(version)
  const b = parse(minimum)
  if (!a || !b) return true
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
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

export function acpConfigFor(agent: CatalogAgent, options: { connect?: AcpConnector; launchEnv?: LaunchEnv; runtimeDir?: string; home?: string } = {}): AcpAgentConfig {
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
    ...(LAUNCH_EXTRAS[agent.id]?.(options) ?? {})
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
  if (agent.id === 'antigravity') {
    // The server itself, also when it runs through cmd.exe.
    const server = command.args[0] === '/d' ? command.args[2] : command.file
    return { ...command, env: antigravityEnv(server, launch?.env ?? {}, options.launchEnv?.platform) }
  }
  return command
}

/** G1: per-agent startup, sign-in and instruction handling. */
const LAUNCH_EXTRAS: Record<string, (options: { home?: string }) => Partial<AcpAgentConfig>> = {
  // pi-acp can exit during its first handshake while its daemon starts.
  pi: () => ({ retryStartupExit: true }),
  antigravity: (options) => ({
    // Reuses an existing Google sign-in (never starts a browser sign-in), bounded so a hanging server can't hold the turn.
    afterInitialize: async (agent, init, env) => {
      if (!agyShouldAuthenticate(init, geminiHome(env, options.home))) return
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('Antigravity didn’t finish signing in with your Google account in time.')), AGY_AUTH_TIMEOUT_MS)))
      try {
        await Promise.race([agent.request(acpMethods.agent.authenticate, { methodId: 'oauth-personal' }), timeout])
      } finally {
        clearTimeout(timer)
      }
    },
    // It follows plain text and treats an embedded resource as something to look up, so the instructions go as text.
    instructions: (text) => [
      { type: 'text', text: `Standing instructions from Foreman. Follow them for this whole session:\n<foreman_standing_instructions>\n${text.trim()}\n</foreman_standing_instructions>` }
    ]
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
