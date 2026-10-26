// Environment variables from Settings → Environment, layered (later wins):
//   user env files → user variables → repo's settings.toml env files →
//   its [environment_variables] → this Mac's repo env files → repo variables.
// Agents and scripts both get the result; each agent then filters credentials.
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind } from '../shared/agents'
import { parseDotenv } from '../shared/envfile'
import type { EnvFileInfo, EnvScope, EnvVarRow, EnvView, Repo, Settings } from '../shared/types'
import { agentEnv } from './agents/env'
import { githubEnvOrNone } from './github'
import { readSharedLayer } from './repoSettings'
import type { SecretStore } from './secrets'

type FileVars = { info: EnvFileInfo; vars: Record<string, string> }

const fileCache = new Map<string, { mtimeMs: number; vars: Record<string, string> }>()

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Where an env file path points: absolute, ~, else relative to the layer's folder. */
export function resolveEnvFile(entry: string, base: string): string {
  const expanded = expandHome(entry.trim())
  if (path.isAbsolute(expanded)) return expanded
  // Relative paths are tried in the settings folder first (.foreman, or .switchyard from before the rename).
  for (const folder of ['.foreman', '.switchyard']) {
    const inConfig = path.join(base, folder, expanded)
    try {
      statSync(inConfig)
      return inConfig
    } catch {
      // Not there; try the next place.
    }
  }
  return path.join(base, expanded)
}

function readEnvFile(entry: string, base: string): FileVars {
  const resolved = resolveEnvFile(entry, base)
  try {
    const { mtimeMs } = statSync(resolved)
    const hit = fileCache.get(resolved)
    const vars =
      hit && hit.mtimeMs === mtimeMs ? hit.vars : Object.fromEntries(parseDotenv(readFileSync(resolved, 'utf8')).pairs.map((p) => [p.key, p.value]))
    fileCache.set(resolved, { mtimeMs, vars })
    return { info: { path: entry, resolved, count: Object.keys(vars).length }, vars }
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return { info: { path: entry, resolved, count: 0, error: missing ? 'File not found' : 'Could not read the file' }, vars: {} }
  }
}

function fileLayer(entries: string[], base: string): FileVars[] {
  return entries.map((entry) => readEnvFile(entry, base))
}

/** Later files win; remembers which file each key came from. */
function flatten(files: FileVars[]): Map<string, { value: string; file: string }> {
  const out = new Map<string, { value: string; file: string }>()
  for (const f of files) for (const [key, value] of Object.entries(f.vars)) out.set(key, { value, file: f.info.path })
  return out
}

function keyHint(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length >= 12 ? value.slice(-4) : ''
}

export class Environment {
  /** The GitHub identity key a repository runs as (Integrations.githubKey); set once Integrations exist. */
  githubKey: (repoId: string) => string | undefined = () => undefined

  constructor(
    private secrets: SecretStore,
    private settings: () => Settings,
    private repo: (id: string) => Repo
  ) {}

  private userFiles(): FileVars[] {
    return fileLayer(this.settings().envFiles, os.homedir())
  }

  private repoLayers(repoId: string) {
    const repo = this.repo(repoId)
    const shared = readSharedLayer(repo.rootPath)
    const sharedFiles = fileLayer(shared.values.envFiles ?? [], repo.rootPath)
    const localFiles = fileLayer(repo.local.envFiles ?? [], repo.rootPath)
    return { repo, shared, sharedFiles, localFiles, saved: this.secrets.vars({ kind: 'repo', repoId }) }
  }

  /**
   * An agent's environment for a repository (or outside one). GitHub access runs as the repository's
   * connection (Integrations); a repository's own GH_TOKEN wins when it chose no connection, and a
   * chosen connection that can't be used gives no GitHub credentials at all.
   */
  forAgent(agent: AgentKind, repoId?: string, extra: Record<string, string> = {}): Record<string, string> {
    return this.forCatalogAgent(agent, repoId, extra)
  }

  /** #22: the same for any catalog agent, including a Terminal agent's terminal tab. Its own key goes only to it. */
  forCatalogAgent(agent: string, repoId?: string, extra: Record<string, string> = {}): Record<string, string> {
    const vars = this.vars(repoId)
    const key = repoId ? this.githubKey(repoId) : undefined
    const github = githubEnvOrNone(key)
    // The repository's own GH_TOKEN is already among its variables.
    if (key?.startsWith('env:')) delete github.GH_TOKEN
    return agentEnv(agent, this.settings(), vars, this.secrets.providerKeys(), { ...github, ...extra }, this.secrets.agentKeys(agent))
  }

  /** Every variable for a repository (or the user level alone), in layer order. */
  vars(repoId?: string): Record<string, string> {
    return this.layered(repoId, true, true)
  }

  /** The repository's own GH_TOKEN, from its env layers (not the user's), and where it's set. */
  repoGithubToken(repoId: string): { value: string; from: string } | undefined {
    const { sharedFiles, shared, localFiles, saved } = this.repoLayers(repoId)
    if (saved.GH_TOKEN) return { value: saved.GH_TOKEN, from: 'Repository settings → Environment' }
    const local = flatten(localFiles).get('GH_TOKEN')
    if (local) return { value: local.value, from: local.file }
    if (typeof shared.env.GH_TOKEN === 'string' && shared.env.GH_TOKEN) return { value: shared.env.GH_TOKEN, from: shared.file ?? '.foreman/settings.toml' }
    const sharedFile = flatten(sharedFiles).get('GH_TOKEN')
    if (sharedFile && shared.env.GH_TOKEN !== null) return { value: sharedFile.value, from: sharedFile.file }
    return undefined
  }

  /** Only what the allowed vault scopes hold: a repo's MCP server gets no more than its scopes say. */
  scopedVars(repoId: string, scopes: ('user' | 'repo')[]): Record<string, string> {
    return this.layered(repoId, scopes.includes('user'), scopes.includes('repo'))
  }

  private layered(repoId: string | undefined, user: boolean, repo: boolean): Record<string, string> {
    const env: Record<string, string> = {}
    const apply = (vars: Record<string, string | null>) => {
      for (const [key, value] of Object.entries(vars)) {
        if (value === null) delete env[key]
        else env[key] = value
      }
    }
    if (user) for (const f of this.userFiles()) apply(f.vars)
    if (user) apply(this.secrets.vars({ kind: 'user' }))
    if (repoId && repo) {
      const { sharedFiles, shared, localFiles, saved } = this.repoLayers(repoId)
      for (const f of sharedFiles) apply(f.vars)
      apply(shared.env)
      for (const f of localFiles) apply(f.vars)
      apply(saved)
    }
    return env
  }

  view(scope: EnvScope): EnvView {
    if (scope.kind === 'user') {
      const files = this.userFiles()
      const saved = this.secrets.vars(scope)
      const fromFiles = flatten(files)
      const vars: EnvVarRow[] = Object.keys(saved).map((key) => ({ key, origin: 'saved' }))
      for (const [key, { file }] of fromFiles) if (!(key in saved)) vars.push({ key, origin: 'file', file })
      return { vars, files: files.map((f) => f.info) }
    }
    const { shared, sharedFiles, localFiles, saved } = this.repoLayers(scope.repoId)
    const localFromFiles = flatten(localFiles)
    const vars: EnvVarRow[] = Object.keys(saved).map((key) => ({ key, origin: 'saved' }))
    for (const [key, { file }] of localFromFiles) if (!(key in saved)) vars.push({ key, origin: 'file', file })

    const sharedRows: EnvVarRow[] = []
    const sharedFileVars = flatten(sharedFiles)
    const sharedKeys = new Set<string>()
    for (const [key, value] of Object.entries(shared.env)) {
      if (value === null) continue
      sharedKeys.add(key)
      sharedRows.push({ key, origin: 'shared', file: shared.file, overridden: key in saved || localFromFiles.has(key) })
    }
    for (const [key, { file }] of sharedFileVars) {
      if (sharedKeys.has(key) || shared.env[key] === null) continue
      sharedKeys.add(key)
      sharedRows.push({ key, origin: 'file', file, overridden: key in saved || localFromFiles.has(key) })
    }

    const repoKeys = new Set([...Object.keys(saved), ...localFromFiles.keys(), ...sharedKeys, ...Object.keys(shared.env)])
    const userSaved = this.secrets.vars({ kind: 'user' })
    const inherited: EnvVarRow[] = Object.keys(userSaved).map((key) => ({ key, origin: 'saved', overridden: repoKeys.has(key) }))
    for (const [key, { file }] of flatten(this.userFiles())) {
      if (!(key in userSaved)) inherited.push({ key, origin: 'file', file, overridden: repoKeys.has(key) })
    }
    return { vars, files: localFiles.map((f) => f.info), shared: sharedRows, inherited }
  }

  /** One value, for reveal and copy. `layer` picks an inherited row on repo pages. */
  reveal(scope: EnvScope, key: string, layer: 'own' | 'shared' | 'inherited' = 'own'): string | undefined {
    if (layer === 'inherited' || scope.kind === 'user') {
      const saved = this.secrets.get({ kind: 'user' }, key)
      return saved ?? flatten(this.userFiles()).get(key)?.value
    }
    const { shared, sharedFiles, localFiles, saved } = this.repoLayers(scope.repoId)
    if (layer === 'shared') return shared.env[key] ?? flatten(sharedFiles).get(key)?.value ?? undefined
    return saved[key] ?? flatten(localFiles).get(key)?.value
  }

  /** Last four characters of a saved user key, for "••••••••abcd". */
  hint(key: string): string | undefined {
    return keyHint(this.secrets.get({ kind: 'user' }, key))
  }

  /** #22: the same for an agent's own key. */
  agentKeyHint(agent: string, envVar: string): string | undefined {
    return keyHint(this.secrets.agentKey(agent, envVar))
  }
}
