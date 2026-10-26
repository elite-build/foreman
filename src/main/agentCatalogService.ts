// #22: the main process side of the agent catalog: what's installed (checked,
// not assumed, and cached until "Check again"), each agent's own API key, and
// sign-in checks for the CLIs that can report it. Keys live in the vault per
// agent (secrets.ts) and reach only that agent's process (agents/env.ts).
import {
  AGENT_CATALOG,
  catalogAgent,
  type AgentCatalogView,
  type AgentDetection,
  type CatalogAgent
} from '../shared/agentCatalog'
import type { AgentKind } from '../shared/agents'
import { PROVIDER_KEYS } from '../shared/providers'
import { AGENT_KEYS, type AgentKeyName, type AgentStatus, type AppSnapshot, type Settings } from '../shared/types'
import { acpReported } from './agents/catalogDrivers'
import { detectAgent, realDetectDeps, runProgram, type DetectDeps } from './agents/catalogDetect'
import { hasSignInProbe, probeSignIn, realProbeDeps, type ProbeDeps } from './agents/signInProbes'
import type { SecretStore } from './secrets'

/** Where the old user-variable keys go: each one becomes its agent's own key. */
export const LEGACY_AGENT_KEYS: { agent: AgentKind; envVar: AgentKeyName }[] = [
  { agent: 'claude', envVar: 'ANTHROPIC_API_KEY' },
  { agent: 'codex', envVar: 'CODEX_API_KEY' },
  { agent: 'cursor', envVar: 'CURSOR_API_KEY' }
]

export interface AgentCatalogDeps {
  secrets: SecretStore
  settings(): Settings
  // The Full agents' own status checks (driver.status).
  fullStatus(agent: AgentKind): Promise<AgentStatus>
  // The environment an agent runs with, for its status command.
  agentEnv(agent: string): Record<string, string>
  executablePath(agent: string): string | undefined
  // The user's shell environment, for "Import from shell" (names are reported, values never leave main).
  shell(): Record<string, string | undefined>
  // A key changed: send a fresh snapshot, and let the agent list its models again.
  keysChanged(agent: string): void
  detectDeps?: () => DetectDeps
  // G1: what the credentials probes read (tests inject a fake home).
  probeDeps?: (agent: string) => ProbeDeps
}

function hintOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length >= 12 ? value.slice(-4) : ''
}

/** What a status command's output means. Only a clear answer counts; anything else is unknown. */
export function parseSignInOutput(agent: string, output: string, ok: boolean): { signedIn: boolean; account?: string } | null {
  const text = output.trim()
  if (agent === 'kiro' && ok) {
    try {
      const data = JSON.parse(text) as { email?: string; username?: string; accountType?: string }
      return { signedIn: true, account: data.email ?? data.username ?? data.accountType }
    } catch {
      return null
    }
  }
  if (/not (logged|signed) in|unauthenticated|no credentials|login required|please (log|sign) in/i.test(text)) return { signedIn: false }
  if (!ok) return null
  const account = /(?:logged in|signed in|authenticated)(?: as| to)?\s+([^\s,()]+@[^\s,()]+|[\w.-]+)/i.exec(text)?.[1]
  if (/logged in|signed in|authenticated|authentication verified/i.test(text)) return { signedIn: true, account }
  return null
}

export class AgentCatalogService {
  private detections: Record<string, AgentDetection> = {}
  private statuses: Record<string, AgentStatus> = {}
  private checkedAt?: string
  private checking: Promise<void> | null = null

  constructor(private deps: AgentCatalogDeps) {}

  /** Moves the Claude, Codex and Cursor keys from the user variables into their own (once). */
  migrateKeys(): boolean {
    return this.deps.secrets.migrateAgentKeys(LEGACY_AGENT_KEYS, ['ANTHROPIC_API_KEY'])
  }

  /** The snapshot's legacy Claude / Codex / Cursor key hints, now read from each agent's own key. */
  legacyKeyHints(): AppSnapshot['agentKeys'] {
    const out: AppSnapshot['agentKeys'] = {}
    for (const name of AGENT_KEYS) {
      const owner = LEGACY_AGENT_KEYS.find((k) => k.envVar === name)!.agent
      const hint = hintOf(this.deps.secrets.agentKey(owner, name))
      if (hint !== undefined) out[name] = hint
    }
    return out
  }

  /** Agent id → last four of its own saved key, for every agent with one. */
  keyHints(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const agent of AGENT_CATALOG) {
      const envVar = agent.auth.apiKey?.envVar
      const hint = envVar ? hintOf(this.deps.secrets.agentKey(agent.id, envVar)) : undefined
      if (hint !== undefined) out[agent.id] = hint
    }
    return out
  }

  private async check(): Promise<void> {
    const deps = this.deps.detectDeps?.() ?? realDetectDeps()
    const checked = await Promise.all(
      AGENT_CATALOG.map(async (agent): Promise<[string, AgentDetection, AgentStatus?]> => {
        if (agent.level === 'full') {
          const status = await this.deps.fullStatus(agent.id as AgentKind).catch((err: unknown): AgentStatus => ({ agent: agent.id as AgentKind, installed: false, ready: false, detail: String(err) }))
          return [agent.id, { id: agent.id, installed: status.installed, version: status.version, checkedAt: new Date().toISOString() }, status]
        }
        const forPlatform: CatalogAgent = deps.platform === 'win32' && agent.winBinaries ? { ...agent, binaries: agent.winBinaries } : agent
        return [agent.id, await detectAgent(forPlatform, deps, this.deps.executablePath(agent.id))]
      })
    )
    this.detections = Object.fromEntries(checked.map(([id, d]) => [id, d]))
    this.statuses = Object.fromEntries(checked.filter(([, , s]) => s).map(([id, , s]) => [id, s!]))
    this.checkedAt = new Date().toISOString()
  }

  /** The catalog view. The first call (and `refresh`) checks every agent; later calls reuse the answer. */
  async view(refresh = false): Promise<AgentCatalogView> {
    if (refresh || !this.checkedAt) {
      this.checking ??= this.check().finally(() => (this.checking = null))
      await this.checking
    }
    const shell = this.deps.shell()
    const saved = this.deps.secrets.providerKeys()
    const shellKeys: Record<string, string> = {}
    for (const agent of AGENT_CATALOG) {
      const envVar = agent.auth.confirmed ? agent.auth.apiKey?.envVar : undefined
      if (envVar && shell[envVar]) shellKeys[agent.id] = envVar
    }
    return {
      detections: this.detections,
      statuses: this.statuses,
      acp: acpReported(),
      shellKeys,
      shellProviderKeys: PROVIDER_KEYS.map((p) => p.envVar).filter((name) => shell[name]),
      savedProviderKeys: Object.keys(saved),
      providerKeyHints: Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, hintOf(v) ?? ''])),
      checkedAt: this.checkedAt
    }
  }

  private keyVar(agent: string): string {
    const info = catalogAgent(agent)
    const envVar = info?.auth.confirmed ? info.auth.apiKey?.envVar : undefined
    if (!envVar) throw new Error('This agent doesn’t take an API key')
    return envVar
  }

  setKey(agent: string, value: string | null): void {
    this.deps.secrets.setAgentKey(agent, this.keyVar(agent), value)
    this.deps.keysChanged(agent)
  }

  revealKey(agent: string): string | null {
    return this.deps.secrets.agentKey(agent, this.keyVar(agent)) ?? null
  }

  /** Copies the agent's key from the shell into its own store. Never replaces a saved key. */
  importKey(agent: string): boolean {
    const envVar = this.keyVar(agent)
    const shell = this.deps.shell()
    const value = shell[envVar] ?? (agent === 'codex' ? shell.OPENAI_API_KEY : undefined)
    if (!value?.trim() || this.deps.secrets.agentKey(agent, envVar)) return false
    this.deps.secrets.setAgentKey(agent, envVar, value)
    this.deps.keysChanged(agent)
    return true
  }

  /** G1: a saved provider key, for Reveal and Copy (main hands it to the window that asked, like an agent's own key). */
  revealProviderKey(envVar: string): string | null {
    return this.deps.secrets.providerKeys()[envVar] ?? null
  }

  /** Copies a provider key from the shell into the shared store, ticked for no agent. Never replaces a saved one. */
  importProviderKey(envVar: string): boolean {
    const value = this.deps.shell()[envVar]
    if (!value?.trim() || this.deps.secrets.providerKeys()[envVar]) return false
    this.deps.secrets.setProviderKey(envVar, value)
    this.deps.keysChanged('opencode')
    return true
  }

  /**
   * Runs the agent's own status command, for CLIs that have one; null when it has none or isn't installed.
   * G1: an agent without one may have a credentials probe (signInProbes.ts), which only ever reports what it found and where.
   */
  async signInStatus(agent: string): Promise<{ signedIn: boolean; account?: string; output: string; source?: string } | null> {
    const info = catalogAgent(agent)
    const statusArgs = info?.auth.login?.statusArgs
    if (!info || info.level === 'full' || !info.auth.confirmed) return null
    if (!statusArgs) {
      if (!hasSignInProbe(agent) || !this.detections[agent]?.installed) return null
      const found = await probeSignIn(agent, this.deps.probeDeps?.(agent) ?? realProbeDeps(this.deps.agentEnv(agent)))
      return found ? { signedIn: true, account: found.account, source: found.source, output: '' } : null
    }
    const path = this.detections[agent]?.path ?? this.deps.executablePath(agent)
    if (!path) return null
    let output = ''
    let ok = true
    try {
      output = await runProgram(path, statusArgs, this.deps.agentEnv(agent))
    } catch (err) {
      ok = false
      output = err instanceof Error ? err.message : String(err)
    }
    const parsed = parseSignInOutput(agent, output, ok)
    return parsed ? { ...parsed, output: output.slice(0, 2000) } : null
  }
}
