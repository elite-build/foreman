// Layered repository settings. Each value comes from the first layer that
// sets it: this Mac's settings for the repo (state.json), the repo's committed
// .foreman/settings.toml (read-only in the app, shared with the team), the
// user's settings, then the default. The app's earlier .switchyard/settings.toml
// remains a fallback when there is no Foreman file.
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'smol-toml'
import type {
  CheckCommand,
  CustomPrompts,
  PreviewUrl,
  Repo,
  RepoLocalSettings,
  RepoMcpServer,
  RepoSettingKey,
  RepoSettings,
  RepoSettingsPatch,
  ResolvedRepoSettings,
  RunScript,
  Settings,
  SettingSource,
  SetupStep
} from '../shared/types'
import { parseTimeout, scriptAsSteps, stepsScript } from '../shared/setupSteps'
import { commandsFromToml, type RepoCommandDef } from '../shared/savedCommands'

export const SHARED_SETTINGS_FILES = [
  path.join('.foreman', 'settings.toml'),
  // Earlier name of this app.
  path.join('.switchyard', 'settings.toml')
]

// Written in a shared file to mean "explicitly unset".
const UNSET = '<none>'

const PROMPT_KEYS: Record<keyof CustomPrompts, string> = {
  general: 'general',
  createPr: 'create_pr',
  codeReview: 'code_review',
  fixErrors: 'fix_errors',
  resolveConflicts: 'resolve_merge_conflicts',
  renameBranch: 'rename_branch'
}

export function defaultPrompts(): CustomPrompts {
  return { general: '', createPr: '', codeReview: '', fixErrors: '', resolveConflicts: '', renameBranch: '' }
}

export function defaultRepoSettings(): RepoSettings {
  return {
    setupScript: '',
    setupSteps: [],
    setupRetryOnce: false,
    archiveScript: '',
    archiveSteps: [],
    runScripts: [],
    checks: [],
    sensitivePaths: [],
    checksAfterTurn: false,
    warnBaseMoved: false,
    suggestFollowups: true,
    runMode: 'exclusive',
    autoRunAfterSetup: false,
    filesToCopy: ['.env*'],
    spotlightTesting: false,
    previewUrls: [],
    prompts: defaultPrompts(),
    deleteBranchOnArchive: false,
    removeDockerContainers: false,
    removeDockerExtras: false,
    archiveOnMerge: false,
    pushAutoSetupRemote: true,
    workInRepoFolder: false,
    envFiles: [],
    // #2: off by default, and never read from the committed settings.toml: only this Mac turns them on.
    teachAgents: false,
    agentsMayStart: false
  }
}

// Repo settings that fall back to a user setting of the same name.
const USER_FALLBACK = ['deleteBranchOnArchive', 'archiveOnMerge', 'pushAutoSetupRemote', 'autoRunAfterSetup'] as const

/** The committed layer: settings plus its environment variables. */
export interface SharedLayer {
  file?: string
  error?: string
  values: RepoLocalSettings
  // null means explicitly unset.
  env: Record<string, string | null>
  // Servers `[mcp.servers.<name>]` proposes. Proposals only: nothing runs until this Mac approves them.
  mcp?: RepoMcpServer[]
  // O9: saved commands `[[commands]]` shares. Read-only; each needs this computer's approval before it runs.
  commands?: RepoCommandDef[]
}

type Doc = Record<string, unknown>

const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined)

function lines(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split('\n').map((x) => x.trim()).filter(Boolean)
  return undefined
}

function runScriptsFrom(v: unknown): RunScript[] | undefined {
  if (typeof v === 'string') return v.trim() ? [{ name: 'run', command: v, icon: 'play', default: true }] : []
  if (!isDoc(v)) return undefined
  const scripts: RunScript[] = []
  for (const [name, task] of Object.entries(v)) {
    if (typeof task === 'string') scripts.push({ name, command: task, icon: 'play' })
    else if (isDoc(task) && str(task.command)) {
      scripts.push({ name, command: str(task.command)!, icon: str(task.icon) ?? 'play', default: bool(task.default), hidden: bool(task.hide), ...(str(task.preview_url)?.trim() ? { previewUrl: str(task.preview_url)!.trim() } : {}) })
    }
  }
  return scripts
}

/**
 * O19: setup as `[[scripts.setup.steps]]` tables (name, command, timeout). A single
 * `setup = "…"` script stays one (setupScript), which resolves to one step called Setup.
 * G3: `parallel = true` on consecutive steps runs them together; `[[scripts.archive.steps]]` reads the same way.
 */
function setupStepsFrom(v: unknown): SetupStep[] | undefined {
  if (!isDoc(v) || !Array.isArray(v.steps)) return undefined
  const steps: SetupStep[] = []
  for (const entry of v.steps) {
    const command = typeof entry === 'string' ? entry : isDoc(entry) ? (str(entry.command) ?? str(entry.run)) : undefined
    if (!command?.trim()) continue
    const name = (isDoc(entry) ? str(entry.name)?.trim() : undefined) || `Step ${steps.length + 1}`
    const timeoutSec = isDoc(entry) ? parseTimeout(entry.timeout) : undefined
    const parallel = isDoc(entry) && bool(entry.parallel) === true
    steps.push({ name, command, ...(timeoutSec ? { timeoutSec } : {}), ...(parallel ? { parallel } : {}) })
  }
  return steps
}

/** `[[checks]]` tables with a name and command; a table keyed by check name works too. */
function checksFrom(v: unknown): CheckCommand[] | undefined {
  const entries: [string | undefined, unknown][] | undefined = Array.isArray(v)
    ? v.map((entry): [string | undefined, unknown] => [isDoc(entry) ? str(entry.name)?.trim() : undefined, entry])
    : isDoc(v)
      ? Object.entries(v)
      : undefined
  if (!entries) return undefined
  const checks: CheckCommand[] = []
  for (const [name, entry] of entries) {
    const command = typeof entry === 'string' ? entry : isDoc(entry) ? str(entry.command) : undefined
    if (name && command?.trim() && !checks.some((c) => c.name === name)) checks.push({ name, command })
  }
  return checks
}

function previewUrlsFrom(v: unknown): PreviewUrl[] | undefined {
  if (typeof v === 'string') return v.trim() ? [{ name: '', url: v.trim() }] : []
  if (!Array.isArray(v)) return undefined
  return v
    .map((entry) => (typeof entry === 'string' ? { name: '', url: entry } : isDoc(entry) ? { name: str(entry.name) ?? '', url: str(entry.url) ?? '' } : null))
    .filter((u): u is PreviewUrl => Boolean(u?.url.trim()))
}

const MCP_NAME = /^[A-Za-z0-9_-]{1,40}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const MAX_REPO_MCP_SERVERS = 8

/**
 * `[mcp.servers.<name>]` with `command`, `args`, `env` (variable names only; any values are ignored,
 * a committed file is no place for secrets) and `scopes` (the vault scopes it may read, default repo only).
 */
export function mcpFrom(v: unknown): RepoMcpServer[] {
  const servers = isDoc(v) && isDoc(v.servers) ? v.servers : {}
  const out: RepoMcpServer[] = []
  for (const [name, entry] of Object.entries(servers)) {
    // 'foreman' is Foreman's own server, and 'foreman-*' Integrations' bridge servers (foreman-linear).
    if (!isDoc(entry) || !MCP_NAME.test(name) || name === 'foreman' || name.startsWith('foreman-')) continue
    const command = str(entry.command)?.trim()
    if (!command) continue
    const names = Array.isArray(entry.env) ? entry.env : isDoc(entry.env) ? Object.keys(entry.env) : []
    const scopes = (Array.isArray(entry.scopes) ? entry.scopes : ['repo']).filter((x): x is 'user' | 'repo' => x === 'user' || x === 'repo')
    out.push({
      name,
      command,
      args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [],
      env: [...new Set(names.filter((n): n is string => typeof n === 'string' && ENV_NAME.test(n)))],
      scopes: [...new Set(scopes)]
    })
    if (out.length >= MAX_REPO_MCP_SERVERS) break
  }
  return out
}

/** Map a shared settings.toml document onto repo settings. */
export function fromToml(doc: Doc): Omit<SharedLayer, 'file' | 'error'> {
  const values: RepoLocalSettings = {}
  const scripts = isDoc(doc.scripts) ? doc.scripts : {}
  const git = isDoc(doc.git) ? doc.git : {}
  const prompts = isDoc(doc.prompts) ? doc.prompts : {}
  const archive = isDoc(doc.archive) ? doc.archive : {}
  const set = <K extends keyof RepoLocalSettings>(key: K, value: RepoLocalSettings[K] | undefined) => {
    if (value !== undefined) values[key] = value
  }
  set('setupScript', str(scripts.setup))
  set('setupSteps', setupStepsFrom(scripts.setup))
  set('setupRetryOnce', isDoc(scripts.setup) ? bool(scripts.setup.retry_failed_step) : undefined)
  set('archiveScript', str(scripts.archive))
  set('archiveSteps', setupStepsFrom(scripts.archive))
  set('runScripts', runScriptsFrom(scripts.run))
  set('checks', checksFrom(doc.checks))
  set('sensitivePaths', lines(doc.sensitive_paths))
  const mode = str(scripts.run_mode)
  set('runMode', mode === 'concurrent' ? 'concurrent' : mode ? 'exclusive' : undefined)
  set('autoRunAfterSetup', bool(scripts.auto_run_after_setup))
  set('checksAfterTurn', bool(scripts.checks_after_turn))
  set('filesToCopy', lines(doc.file_include_globs))
  set('spotlightTesting', bool(doc.spotlight_testing))
  set('previewUrls', previewUrlsFrom(doc.preview_urls))
  set('warnBaseMoved', bool(git.warn_base_moved))
  set('suggestFollowups', bool(doc.suggest_followups))
  set('deleteBranchOnArchive', bool(git.delete_branch_on_archive))
  // O18: `[archive] remove_docker_containers = true`.
  set('removeDockerContainers', bool(archive.remove_docker_containers))
  // G3 · O18: `[archive] remove_docker_volumes_networks = true`.
  set('removeDockerExtras', bool(archive.remove_docker_volumes_networks))
  set('archiveOnMerge', bool(git.archive_on_merge))
  set('pushAutoSetupRemote', bool(git.worktree_push_auto_setup_remote))
  set('workInRepoFolder', bool(git.work_in_repo_folder))
  set('envFiles', lines(doc.environment_variable_files))
  const promptValues: Partial<CustomPrompts> = {}
  for (const [key, tomlKey] of Object.entries(PROMPT_KEYS) as [keyof CustomPrompts, string][]) {
    const text = str(prompts[tomlKey])
    if (text !== undefined) promptValues[key] = text
  }
  if (Object.keys(promptValues).length) values.prompts = promptValues

  const env: Record<string, string | null> = {}
  const vars = isDoc(doc.environment_variables) ? doc.environment_variables : {}
  for (const [key, value] of Object.entries(vars)) {
    if (isDoc(value)) continue
    env[key] = value === UNSET ? null : String(value)
  }
  return { values, env, mcp: mcpFrom(doc.mcp), commands: commandsFromToml(doc.commands) }
}

const cache = new Map<string, { mtimeMs: number; layer: SharedLayer }>()
// Each repo's last answer and when its files were looked at, for readers that accept one a few seconds old (the snapshot).
const checked = new Map<string, { at: number; layer: SharedLayer }>()

/** Look at every repo's settings files again on the next read, whatever `maxAgeMs` says. */
export function revalidateSharedLayers(): void {
  checked.clear()
}

/**
 * The repo's committed settings, re-read when the file changes. With `maxAgeMs`, an answer from less than that long
 * ago is reused without touching the disk; anything that acts on the settings reads them fresh (the default).
 */
export function readSharedLayer(rootPath: string, options: { maxAgeMs?: number } = {}): SharedLayer {
  const now = Date.now()
  const last = checked.get(rootPath)
  if (last && options.maxAgeMs && now - last.at >= 0 && now - last.at < options.maxAgeMs) return last.layer
  const layer = statSharedLayer(rootPath)
  checked.set(rootPath, { at: now, layer })
  return layer
}

function statSharedLayer(rootPath: string): SharedLayer {
  for (const rel of SHARED_SETTINGS_FILES) {
    const file = path.join(rootPath, rel)
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      continue
    }
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === mtimeMs) return hit.layer
    let layer: SharedLayer
    try {
      layer = { file, ...fromToml(parse(readFileSync(file, 'utf8')) as Doc) }
    } catch (err) {
      layer = { file, error: `Could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`, values: {}, env: {} }
    }
    cache.set(file, { mtimeMs, layer })
    return layer
  }
  return { values: {}, env: {} }
}

function mergeRunScripts(shared: RunScript[] = [], local: RunScript[] = []): RunScript[] {
  const merged = new Map<string, RunScript>()
  for (const s of shared) merged.set(s.name, { ...s, source: 'shared' })
  for (const s of local) merged.set(s.name, { ...s, source: 'local', overrides: merged.has(s.name) || undefined })
  const list = [...merged.values()]
  // Exactly one default: one marked on this computer, then one marked in the shared file, else the first visible.
  const visible = list.filter((s) => !s.hidden)
  const chosen = visible.find((s) => s.default && s.source === 'local') ?? visible.find((s) => s.default) ?? visible[0]
  return list.map((s) => ({ ...s, default: s === chosen }))
}

function mergeChecks(shared: CheckCommand[] = [], local: CheckCommand[] = []): CheckCommand[] {
  const merged = new Map<string, CheckCommand>()
  for (const c of shared) merged.set(c.name, { ...c, source: 'shared' })
  for (const c of local) merged.set(c.name, { ...c, source: 'local', overrides: merged.has(c.name) || undefined })
  return [...merged.values()]
}

/** A layer's setup steps, from its steps or its single script; undefined when it sets neither. */
function layerSteps(layer: RepoLocalSettings): SetupStep[] | undefined {
  if (layer.setupSteps) return layer.setupSteps
  return layer.setupScript !== undefined ? scriptAsSteps(layer.setupScript) : undefined
}

/** G3: the same for the archive script: its steps, or its single script as one step called Archive. */
function layerArchiveSteps(layer: RepoLocalSettings): SetupStep[] | undefined {
  if (layer.archiveSteps) return layer.archiveSteps
  return layer.archiveScript !== undefined ? scriptAsSteps(layer.archiveScript, 'archive') : undefined
}

export function resolveRepoSettings(repo: Repo, user: Settings, options: { maxAgeMs?: number } = {}): ResolvedRepoSettings {
  const shared = readSharedLayer(repo.rootPath, options)
  const defaults = defaultRepoSettings()
  const values = { ...defaults, prompts: { ...defaults.prompts } }
  const sources: Partial<Record<RepoSettingKey, SettingSource>> = {}
  const inherited: Partial<Record<RepoSettingKey, SettingSource>> = {}
  const local = repo.local ?? {}

  const keys = (Object.keys(defaults) as (keyof RepoSettings)[]).filter((k) => !['prompts', 'runScripts', 'checks', 'setupScript', 'setupSteps', 'archiveScript', 'archiveSteps'].includes(k))
  for (const key of keys as Exclude<keyof RepoSettings, 'prompts' | 'runScripts' | 'checks' | 'setupScript' | 'setupSteps' | 'archiveScript' | 'archiveSteps'>[]) {
    const layers: [SettingSource, unknown][] = [
      ['local', local[key]],
      ['shared', shared.values[key]],
      ['user', (USER_FALLBACK as readonly string[]).includes(key) ? user[key as (typeof USER_FALLBACK)[number]] : undefined]
    ]
    const hit = layers.find(([, v]) => v !== undefined)
    if (hit) {
      ;(values as Record<string, unknown>)[key] = hit[1]
      sources[key] = hit[0]
    }
    const below = layers.slice(1).find(([, v]) => v !== undefined)
    if (below) inherited[key] = below[0]
  }

  // O19: one setting in two forms. A layer's steps win over its single script; either replaces the layers below.
  const stepLayers: [SettingSource, SetupStep[] | undefined][] = [
    ['local', layerSteps(local)],
    ['shared', layerSteps(shared.values)]
  ]
  const stepsHit = stepLayers.find(([, v]) => v !== undefined)
  if (stepsHit) {
    values.setupSteps = stepsHit[1]!
    sources.setupSteps = sources.setupScript = stepsHit[0]
  }
  if (stepLayers[1][1] !== undefined) inherited.setupSteps = inherited.setupScript = 'shared'
  values.setupScript = stepsScript(values.setupSteps)

  // G3 · O19: the archive script works the same way, steps or a single script.
  const archiveLayers: [SettingSource, SetupStep[] | undefined][] = [
    ['local', layerArchiveSteps(local)],
    ['shared', layerArchiveSteps(shared.values)]
  ]
  const archiveHit = archiveLayers.find(([, v]) => v !== undefined)
  if (archiveHit) {
    values.archiveSteps = archiveHit[1]!
    sources.archiveSteps = sources.archiveScript = archiveHit[0]
  }
  if (archiveLayers[1][1] !== undefined) inherited.archiveSteps = inherited.archiveScript = 'shared'
  values.archiveScript = stepsScript(values.archiveSteps)

  for (const key of Object.keys(PROMPT_KEYS) as (keyof CustomPrompts)[]) {
    const fromLocal = local.prompts?.[key]
    const fromShared = shared.values.prompts?.[key]
    if (fromShared !== undefined) inherited[`prompts.${key}`] = 'shared'
    if (fromLocal !== undefined) {
      values.prompts[key] = fromLocal
      sources[`prompts.${key}`] = 'local'
    } else if (fromShared !== undefined) {
      values.prompts[key] = fromShared
      sources[`prompts.${key}`] = 'shared'
    }
  }

  values.runScripts = mergeRunScripts(shared.values.runScripts, local.runScripts)
  if (local.runScripts?.length) sources.runScripts = 'local'
  else if (shared.values.runScripts?.length) sources.runScripts = 'shared'
  if (shared.values.runScripts?.length) inherited.runScripts = 'shared'

  values.checks = mergeChecks(shared.values.checks, local.checks)
  if (local.checks?.length) sources.checks = 'local'
  else if (shared.values.checks?.length) sources.checks = 'shared'
  if (shared.values.checks?.length) inherited.checks = 'shared'

  return { values, sources, inherited, sharedFile: shared.file, sharedError: shared.error }
}

/** Apply a patch to the local layer; null deletes a key so it inherits again. */
export function patchLocal(local: RepoLocalSettings, patch: RepoSettingsPatch): RepoLocalSettings {
  const next: RepoLocalSettings = { ...local, prompts: { ...local.prompts } }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'prompts') continue
    if (value === null) delete (next as Record<string, unknown>)[key]
    else if (value !== undefined) (next as Record<string, unknown>)[key] = value
  }
  for (const [key, value] of Object.entries(patch.prompts ?? {}) as [keyof CustomPrompts, string | null | undefined][]) {
    if (value === null) delete next.prompts![key]
    else if (value !== undefined) next.prompts![key] = value
  }
  if (!Object.keys(next.prompts!).length) delete next.prompts
  return next
}

/** Older state stored settings directly on the repo; move them into the local layer. */
export function migrateRepoFields(repo: Repo & Record<string, unknown>): void {
  if (repo.local) return
  const local: RepoLocalSettings = {}
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
  if (text(repo.setupScript)) local.setupScript = repo.setupScript as string
  if (text(repo.archiveScript)) local.archiveScript = repo.archiveScript as string
  if (text(repo.runScript)) local.runScripts = [{ name: 'run', command: repo.runScript as string, icon: 'play', default: true }]
  if (repo.runMode === 'concurrent') local.runMode = 'concurrent'
  if (text(repo.previewUrl)) local.previewUrls = [{ name: '', url: repo.previewUrl as string }]
  if (repo.spotlightTesting === true) local.spotlightTesting = true
  if (Array.isArray(repo.filesToCopy) && (repo.filesToCopy as string[]).join('\n') !== '.env*') local.filesToCopy = repo.filesToCopy as string[]
  const prompts = repo.prompts as Partial<CustomPrompts> | undefined
  const set = Object.entries(prompts ?? {}).filter(([, v]) => text(v))
  if (set.length) local.prompts = Object.fromEntries(set)
  for (const key of ['setupScript', 'archiveScript', 'runScript', 'runMode', 'previewUrl', 'spotlightTesting', 'filesToCopy', 'prompts']) delete repo[key]
  repo.local = local
  repo.remote ??= 'origin'
}
