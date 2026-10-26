// Environment variables and API keys, encrypted at rest with the OS keychain
// (Electron safeStorage: Keychain on macOS, DPAPI on Windows). Every variable
// is treated as a secret; values only leave the main process when the user
// reveals or copies one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { EnvScope } from '../shared/types'

export interface Encryptor {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

interface Vault {
  version: 2
  // User-level variables, available to every repository.
  user: Record<string, string>
  // Repository id → variables that apply only there (override user ones).
  repos: Record<string, Record<string, string>>
  // OpenCode provider keys (env var name → key), kept apart so they reach only OpenCode.
  providers: Record<string, string>
  // The app's own credentials, e.g. a GitHub token.
  app: Record<string, string>
  // #22: agent id → its own API keys (env var → key), passed only to that agent and only in API-key mode.
  agents?: Record<string, Record<string, string>>
  // #22: set once the Claude, Codex and Cursor keys have moved out of the user variables.
  agentKeysMigrated?: boolean
}

// The first version stored four fixed keys at the top level.
const V1_KEYS: Record<string, { to: 'user' | 'providers'; name: string }> = {
  ANTHROPIC_API_KEY: { to: 'user', name: 'ANTHROPIC_API_KEY' },
  OPENAI_API_KEY: { to: 'user', name: 'CODEX_API_KEY' },
  CURSOR_API_KEY: { to: 'user', name: 'CURSOR_API_KEY' },
  OPENROUTER_API_KEY: { to: 'providers', name: 'OPENROUTER_API_KEY' }
}

function emptyVault(): Vault {
  return { version: 2, user: {}, repos: {}, providers: {}, app: {} }
}

function migrate(raw: Record<string, unknown>): Vault {
  if (raw.version === 2) {
    const v = raw as unknown as Vault
    return { ...v, version: 2, user: v.user ?? {}, repos: v.repos ?? {}, providers: v.providers ?? {}, app: v.app ?? {} }
  }
  const vault = emptyVault()
  for (const [key, value] of Object.entries(raw)) {
    const target = V1_KEYS[key]
    if (target && typeof value === 'string' && value) vault[target.to][target.name] = value
  }
  return vault
}

export class SecretStore {
  private vault: Vault = emptyVault()

  constructor(
    private file: string,
    private crypto: Encryptor
  ) {}

  load(): void {
    if (!existsSync(this.file) || !this.crypto.available()) return
    try {
      this.vault = migrate(JSON.parse(this.crypto.decrypt(readFileSync(this.file))))
    } catch {
      // Unreadable (e.g. copied from another machine); start empty.
      this.vault = emptyVault()
    }
  }

  private save(): void {
    if (!this.crypto.available()) throw new Error('Secure storage is not available on this system')
    writeFileSync(this.file, this.crypto.encrypt(JSON.stringify(this.vault)), { mode: 0o600 })
  }

  private table(scope: EnvScope, create = false): Record<string, string> | undefined {
    if (scope.kind === 'user') return this.vault.user
    if (!this.vault.repos[scope.repoId] && create) this.vault.repos[scope.repoId] = {}
    return this.vault.repos[scope.repoId]
  }

  /** Variables saved in one scope (not including env files). */
  vars(scope: EnvScope): Record<string, string> {
    return { ...this.table(scope) }
  }

  get(scope: EnvScope, key: string): string | undefined {
    return this.table(scope)?.[key]
  }

  /** Set (an empty string is a real value) or, with null, remove a variable. */
  set(scope: EnvScope, key: string, value: string | null): void {
    const table = this.table(scope, true)!
    if (value === null) delete table[key]
    else table[key] = value
    if (scope.kind === 'repo' && !Object.keys(table).length) delete this.vault.repos[scope.repoId]
    this.save()
  }

  /** Several changes in one write; renames pass the old key with null. */
  setMany(scope: EnvScope, changes: [string, string | null][]): void {
    const table = this.table(scope, true)!
    for (const [key, value] of changes) {
      if (value === null) delete table[key]
      else table[key] = value
    }
    this.save()
  }

  forgetRepo(repoId: string): void {
    if (!this.vault.repos[repoId]) return
    delete this.vault.repos[repoId]
    this.save()
  }

  providerKeys(): Record<string, string> {
    return { ...this.vault.providers }
  }

  appSecret(name: string): string | undefined {
    return this.vault.app[name] || undefined
  }

  setAppSecret(name: string, value: string | null): void {
    if (value === null || !value.trim()) delete this.vault.app[name]
    else this.vault.app[name] = value.trim()
    this.save()
  }

  setProviderKey(envVar: string, value: string | null): void {
    if (value === null || !value.trim()) delete this.vault.providers[envVar]
    else this.vault.providers[envVar] = value.trim()
    this.save()
  }

  // ---- #22: per-agent keys ----

  /** One agent's own keys (env var → key). */
  agentKeys(agent: string): Record<string, string> {
    return { ...this.vault.agents?.[agent] }
  }

  agentKey(agent: string, envVar: string): string | undefined {
    return this.vault.agents?.[agent]?.[envVar] || undefined
  }

  setAgentKey(agent: string, envVar: string, value: string | null): void {
    const agents = (this.vault.agents ??= {})
    const table = (agents[agent] ??= {})
    if (value === null || !value.trim()) delete table[envVar]
    else table[envVar] = value.trim()
    if (!Object.keys(table).length) delete agents[agent]
    this.save()
  }

  /**
   * Moves the Claude Code, Codex and Cursor keys out of the user variables, where every agent
   * saw them, into each agent's own keys. Runs once; a key the agent already has is kept, and
   * a key added to Settings → Environment afterwards stays there. OpenCode used to read the
   * Anthropic key from the user variables, so it's copied into the provider keys (where only
   * OpenCode gets it until other agents are ticked) unless one is saved there already.
   */
  migrateAgentKeys(moves: { agent: string; envVar: string }[], copyToProviders: string[] = []): boolean {
    if (this.vault.agentKeysMigrated) return false
    let moved = false
    for (const { agent, envVar } of moves) {
      const value = this.vault.user[envVar]
      if (value === undefined) continue
      const agents = (this.vault.agents ??= {})
      const table = (agents[agent] ??= {})
      if (!table[envVar] && value.trim()) table[envVar] = value.trim()
      if (copyToProviders.includes(envVar) && value.trim() && !this.vault.providers[envVar]) this.vault.providers[envVar] = value.trim()
      delete this.vault.user[envVar]
      moved = true
    }
    this.vault.agentKeysMigrated = true
    // Nothing stored yet (or no keychain): the flag is written with the first save.
    if (moved || existsSync(this.file)) {
      try {
        this.save()
      } catch {
        // No secure storage: nothing was readable to move.
      }
    }
    return moved
  }
}
