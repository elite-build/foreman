// `foreman repo settings|setup|archive-steps|scripts|checks|mcp|auto-review|integrations` and `foreman checks approve`:
// a repository's settings, layer by layer, through the Api calls the Repository settings window makes
//. Writes go to this computer's layer; the committed
// .foreman/settings.toml is only ever read here.
import path from 'node:path'
import { CLOUD_PROVIDERS, repoCloud, repoProvider } from '../../shared/cloud'
import {
  REPO_SETTINGS_SCHEMA,
  coerceRepoSettingValue,
  displayRepoValue,
  findRepoSetting,
  repoSettingPatch,
  repoSettingsByTab,
  type RepoIntegrationOptions,
  type RepoSettingSpec,
  type RepoTab
} from '../../shared/repoSettingsSchema'
import { SETTINGS_SCHEMA } from '../../shared/settingsSchema'
import { parseTimeout, scriptAsSteps, stepsPatch, type StepsKind } from '../../shared/setupSteps'
import type {
  ChecksApproveResult,
  RepoAutoReviewResult,
  RepoCheckRow,
  RepoChecksResult,
  RepoIntegrationRow,
  RepoIntegrationsResult,
  RepoMcpResult,
  RepoMcpRow,
  RepoScriptRow,
  RepoScriptsResult,
  RepoSettingChange,
  RepoSettingRow,
  RepoSettingsFileResult,
  RepoSettingsGetResult,
  RepoSettingsListResult,
  RepoSettingsSetResult,
  RepoSettingsUnsetResult,
  RepoSetupResult,
  RepoStepRow,
  RepoValueSource,
  StepsTarget
} from '../../shared/cli/repoSettings'
import type {
  AutoReviewShown,
  CheckCommand,
  CustomPrompts,
  Loadout,
  Repo,
  RepoLocalSettings,
  RepoPatch,
  RepoSettingKey,
  RepoSettingsPatch,
  ResolvedRepoSettings,
  RunScript,
  SetupStep,
  Settings
} from '../../shared/types'
import type { IntegrationService, RepoIntegrationService, RepoServiceView } from '../../shared/integrations'
import { commandHash } from '../checks'
import { SHARED_SETTINGS_FILES, defaultRepoSettings, readSharedLayer, type SharedLayer } from '../repoSettings'
import { CliCodedError, type CliHost } from './host'
import { columns, fromAgentTurn, flagParam, invalid, numberParam, paramsObject, textList, textParam, pairList, type MethodDef } from './kit'
import type { CliContext } from './methods'
import { findWorkspace, resolveRepo } from './resolve'

const TAB_TITLES: Record<RepoTab, string> = { git: 'Git', scripts: 'Scripts', actions: 'Actions', repo: 'Repository', integrations: 'Integrations', cloud: 'Remote' }

type Below = 'shared' | 'user' | 'default'

// ---- the repository and what is known about it ----

async function repoOf(host: CliHost, p: Record<string, unknown>): Promise<Repo> {
  const query = textParam(p, 'repo', { optional: true })?.trim()
  // `.` is the repository the caller is in (a bare folder name would only match its root).
  return resolveRepo(host.state(), textParam(p, 'cwd'), query && query !== '.' ? query : undefined)
}

const nameOf = (repo: Repo) => ({ id: repo.id, name: repo.name })

/** The committed file as people see it: relative to the repository, with forward slashes. */
function relFile(repo: Repo, file: string): string {
  return path.relative(repo.rootPath, file).split(path.sep).join('/')
}

interface Reading {
  host: CliHost
  repo: Repo
  resolved: ResolvedRepoSettings
  shared: SharedLayer
  settings: Settings
  // Undefined when the app can't say (a test without the call, an integration service that is down).
  integrations?: RepoServiceView[]
  // service → default connection id, for which provider a repository without its own choice uses.
  sandboxDefaults: Partial<Record<string, string>>
}

function sandboxDefaultsOf(host: CliHost): Partial<Record<string, string>> {
  try {
    const connections = host.snapshot().integrations?.connections ?? []
    return Object.fromEntries(connections.filter((c) => c.isDefault).map((c) => [c.service, c.id]))
  } catch {
    return {}
  }
}

async function reading(host: CliHost, repo: Repo, options: { integrations?: boolean } = {}): Promise<Reading> {
  const integrations = options.integrations === false ? undefined : await Promise.resolve().then(() => host.api.repoIntegrations(repo.id)).catch(() => undefined)
  return {
    host,
    repo,
    resolved: host.resolvedRepoSettings(repo.id),
    shared: readSharedLayer(repo.rootPath),
    settings: host.state().settings,
    integrations,
    sandboxDefaults: sandboxDefaultsOf(host)
  }
}

/** The value a layer holds for a setting, a prompt included. */
function layerValue(layer: object, spec: RepoSettingSpec): unknown {
  const record = layer as { prompts?: Partial<CustomPrompts> } & Record<string, unknown>
  if (spec.field.startsWith('prompts.')) return record.prompts?.[spec.field.slice('prompts.'.length) as keyof CustomPrompts]
  return record[spec.field]
}

/** The personal setting a repository value falls back to, by its key (`git.delete-branch-on-archive`). */
const userKeyOf = (spec: RepoSettingSpec): string | undefined => SETTINGS_SCHEMA.find((s) => s.field === spec.field)?.key

function belowValue(spec: RepoSettingSpec, below: Below, c: Reading): unknown {
  if (below === 'shared') return layerValue(c.shared.values, spec)
  if (below === 'user') return c.settings[spec.field as keyof Settings]
  return layerValue(defaultRepoSettings(), spec)
}

interface Read {
  value: unknown
  source: RepoValueSource
  // This computer overrides what this layer says.
  below?: Below
}

function read(spec: RepoSettingSpec, c: Reading): Read {
  const { repo } = c
  switch (spec.target) {
    case 'local':
    case 'envFiles': {
      const key = spec.field as RepoSettingKey
      const source: RepoValueSource = c.resolved.sources[key] ?? 'default'
      return { value: layerValue(c.resolved.values, spec), source, ...(source === 'local' ? { below: (c.resolved.inherited[key] ?? 'default') as Below } : {}) }
    }
    case 'repo':
      return { value: (repo as unknown as Record<string, unknown>)[spec.field], source: 'repo' }
    case 'repoCloud': {
      const key = spec.field.slice('cloud.'.length)
      const own = (repo.cloud as unknown as Record<string, unknown> | undefined)?.[key]
      const value = key === 'provider' ? repoProvider(repo.cloud, c.sandboxDefaults) : (repoCloud(repo) as unknown as Record<string, unknown>)[key]
      return { value: value ?? '', source: own !== undefined ? 'repo' : 'default' }
    }
    case 'integration': {
      const service = spec.field.slice('integrations.'.length)
      const row = c.integrations?.find((r) => r.service === service)
      const choice = row?.choice ?? repo.integrations?.services?.[service as IntegrationService] ?? 'default'
      const resolution = row?.resolution as { connection?: { name: string } } | undefined
      return { value: choice === 'default' || choice === 'off' ? choice : (resolution?.connection?.name ?? choice), source: 'repo' }
    }
    case 'integrationOptions': {
      if (spec.field.startsWith('integrations.starts.')) {
        const own = repo.integrations?.starts?.[spec.field.slice('integrations.starts.'.length) as RepoIntegrationService]
        return { value: own ?? 'default', source: own ? 'repo' : 'default' }
      }
      return { value: spec.field === 'integrations.rules' ? (repo.integrations?.rules ?? 'mine') : (repo.integrations?.allowOwnMcp ?? []), source: 'repo' }
    }
  }
}

function rowOf(spec: RepoSettingSpec, c: Reading): RepoSettingRow {
  const r = read(spec, c)
  const row: RepoSettingRow = { key: spec.key, tab: spec.tab, type: spec.type, value: displayRepoValue(spec, r.value), source: r.source }
  if (r.below) row.inherited = { source: r.below, value: displayRepoValue(spec, belowValue(spec, r.below, c)) }
  if (r.source === 'user') {
    const userKey = userKeyOf(spec)
    if (userKey) row.userKey = userKey
  }
  return row
}

/** Where a layer's value comes from, in words: the file, your settings key, this computer. */
function layerLabel(source: RepoValueSource, spec: RepoSettingSpec, c: Reading): string {
  switch (source) {
    case 'local':
      return 'this computer'
    case 'shared':
      return c.shared.file ? relFile(c.repo, c.shared.file) : '.foreman/settings.toml'
    case 'user': {
      const key = userKeyOf(spec)
      return key ? `your settings (${key})` : 'your settings'
    }
    case 'default':
      return 'default'
    case 'repo':
      return ''
  }
}

function specsOf(keys: string[]): RepoSettingSpec[] {
  const specs: RepoSettingSpec[] = []
  const errors: string[] = []
  for (const key of keys) {
    const found = findRepoSetting(key)
    if ('error' in found) errors.push(found.error)
    else specs.push(found.spec)
  }
  if (errors.length) throw new CliCodedError('not-found', errors.join('\n'))
  return specs
}

// ---- list, get, file ----

function sharedFileInfo(repo: Repo, shared: SharedLayer): { path: string; exists: boolean; error?: string } {
  const file = shared.file ?? path.join(repo.rootPath, SHARED_SETTINGS_FILES[0])
  return { path: relFile(repo, file), exists: Boolean(shared.file), ...(shared.error ? { error: shared.error } : {}) }
}

function rowLine(row: RepoSettingRow, spec: RepoSettingSpec, c: Reading): string[] {
  let label = layerLabel(row.source, spec, c)
  if (row.source === 'local' && row.inherited && row.inherited.source !== 'default') label = `this computer (overrides ${layerLabel(row.inherited.source, spec, c)}: ${row.inherited.value})`
  return [row.key, row.value, label]
}

export async function repoSettingsList(host: CliHost, params: unknown): Promise<RepoSettingsListResult> {
  const p = paramsObject(params)
  const repo = await repoOf(host, p)
  const c = await reading(host, repo)
  const file = sharedFileInfo(repo, c.shared)
  const rows: RepoSettingRow[] = []
  const lines: string[] = []
  if (flagParam(p, 'shared')) {
    lines.push(file.exists ? `Committed settings for ${repo.name}: ${file.path}` : `${repo.name} has no committed settings file. ${file.path} would hold them (foreman repo settings file --open).`)
    if (file.error) lines.push(file.error)
    const cells: string[][] = []
    for (const spec of REPO_SETTINGS_SCHEMA) {
      if (!spec.shared) continue
      const value = layerValue(c.shared.values, spec)
      if (value === undefined) continue
      const row: RepoSettingRow = { key: spec.key, tab: spec.tab, type: spec.type, value: displayRepoValue(spec, value), source: 'shared' }
      rows.push(row)
      cells.push([row.key, row.value])
    }
    if (cells.length) lines.push(...columns(cells).map((l) => `  ${l}`))
    else if (file.exists && !file.error) lines.push('  It sets none of these settings.')
    return { repo: nameOf(repo), rows, file, text: lines.join('\n') }
  }
  for (const group of repoSettingsByTab()) {
    const cells: string[][] = []
    for (const spec of group.specs) {
      const row = rowOf(spec, c)
      rows.push(row)
      cells.push(rowLine(row, spec, c))
    }
    if (lines.length) lines.push('')
    lines.push(TAB_TITLES[group.tab], ...columns(cells).map((l) => `  ${l}`))
  }
  lines.push('', 'Also: foreman repo setup, archive-steps, scripts, checks, mcp and auto-review.')
  if (c.shared.error) lines.push(c.shared.error)
  return { repo: nameOf(repo), rows, file, text: lines.join('\n') }
}

export async function repoSettingsGet(host: CliHost, params: unknown): Promise<RepoSettingsGetResult> {
  const p = paramsObject(params)
  const keys = textList(p, 'keys')
  if (!keys.length) throw invalid('Name at least one repository setting. `foreman repo settings list` shows them.')
  const specs = specsOf(keys)
  const repo = await repoOf(host, p)
  const c = await reading(host, repo)
  const rows = specs.map((spec) => rowOf(spec, c))
  const cells = rows.map((row, i) => rowLine(row, specs[i], c))
  return { repo: nameOf(repo), rows, text: columns(cells).join('\n') }
}

export async function repoSettingsFile(host: CliHost, params: unknown, ctx: Pick<CliContext, 'caller'>): Promise<RepoSettingsFileResult> {
  const p = paramsObject(params)
  const repo = await repoOf(host, p)
  const shared = readSharedLayer(repo.rootPath)
  const file = sharedFileInfo(repo, shared)
  let opened = false
  if (flagParam(p, 'open')) {
    // Opening makes the file when there is none, and starts an editor on this computer.
    if (fromAgentTurn(ctx)) throw new CliCodedError('refused', 'The settings file can’t be opened from inside an agent turn.')
    await host.api.openRepoSettingsFile(repo.id)
    opened = true
  }
  const text = `${file.path}${file.exists ? '' : ' (not there yet; --open creates it from a template)'}${opened ? '\nOpened in your editor.' : ''}`
  return { repo: nameOf(repo), path: file.path, exists: file.exists, opened, text }
}

// ---- set, unset ----

interface Planned {
  spec: RepoSettingSpec
  value: unknown
  // What to show after the write, when it isn't the value itself (an integration is given by name, stored by id).
  shown?: string
}

/** The connection a repository's service should use: `default`, `off`, or a connection of that service by id or name. */
function resolveConnection(host: CliHost, service: RepoIntegrationService, typed: string): string {
  const word = typed.trim()
  const lower = word.toLowerCase()
  if (lower === 'default' || lower === 'off') return lower
  const connections = host.snapshot().integrations.connections.filter((conn) => conn.service === service)
  const hit = connections.find((conn) => conn.id === word) ?? connections.find((conn) => conn.name.toLowerCase() === lower)
  if (!hit) {
    const names = connections.map((conn) => `'${conn.name}'`).join(', ')
    throw invalid(`There is no ${service} connection called '${word}'. ${names ? `Connections: ${names}.` : `Add one first (foreman connections add ${service}).`} Or use default or off.`)
  }
  return hit.id
}

/** The checks that need the repository: a vCPU count or region another provider doesn't offer, a remote it doesn't have. */
async function validateAgainstRepo(host: CliHost, repo: Repo, planned: Planned[]): Promise<void> {
  const errors: string[] = []
  const valueOf = (field: string) => planned.find((x) => x.spec.field === field)?.value
  const remote = valueOf('remote')
  if (typeof remote === 'string') {
    const remotes = await host.api.listRemotes(repo.id)
    if (!remotes.includes(remote)) errors.push(`${repo.name} has no remote called '${remote}'.${remotes.length ? ` Remotes: ${remotes.join(', ')}.` : ' It has no remotes.'}`)
  }
  const vcpus = valueOf('cloud.vcpus')
  const region = valueOf('cloud.region')
  if (vcpus !== undefined || region !== undefined) {
    const provider = (valueOf('cloud.provider') as string | undefined) ?? repoProvider(repo.cloud, sandboxDefaultsOf(host))
    const caps = CLOUD_PROVIDERS[provider as keyof typeof CLOUD_PROVIDERS].capabilities
    if (typeof vcpus === 'number' && !caps.vcpuOptions.includes(vcpus)) errors.push(`${provider} offers ${caps.vcpuOptions.join(', ')} vCPUs, not ${vcpus}.`)
    if (typeof region === 'string') {
      if (caps.regions.length && !caps.regions.includes(region)) errors.push(`${provider} regions are ${caps.regions.join(', ')}, not '${region}'.`)
      if (!caps.regions.length && region !== '') errors.push(`${provider} has no regions; leave the region empty.`)
    }
  }
  if (errors.length) throw invalid(errors.join('\n'))
}

function planPairs(host: CliHost, pairs: [string, string][]): Planned[] {
  const specs = specsOf(pairs.map(([key]) => key))
  const planned: Planned[] = []
  const errors: string[] = []
  pairs.forEach(([, raw], i) => {
    const spec = specs[i]
    const coerced = coerceRepoSettingValue(spec, raw)
    if ('error' in coerced) return void errors.push(coerced.error)
    if (spec.target === 'integration') {
      try {
        const service = spec.field.slice('integrations.'.length) as RepoIntegrationService
        const id = resolveConnection(host, service, String(coerced.value))
        planned.push({ spec, value: id, shown: String(coerced.value).trim() })
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
      return
    }
    planned.push({ spec, value: coerced.value })
  })
  if (errors.length) throw invalid(errors.join('\n'))
  return planned
}

interface Writes {
  local: RepoSettingsPatch
  repo: RepoPatch
  integrations: { service: RepoIntegrationService; choice: string }[]
  options: RepoIntegrationOptions
  envFiles?: string[]
}

function planWrites(planned: Planned[]): Writes {
  const writes: Writes = { local: {}, repo: {}, integrations: [], options: {} }
  for (const { spec, value } of planned) {
    const w = repoSettingPatch(spec, value)
    if ('error' in w) throw invalid(w.error)
    if (w.kind === 'local') mergeLocal(writes.local, w.patch)
    else if (w.kind === 'repo') {
      const { cloud, ...rest } = w.patch
      Object.assign(writes.repo, rest)
      if (cloud) writes.repo.cloud = { ...writes.repo.cloud, ...cloud }
    } else if (w.kind === 'integration') writes.integrations.push({ service: w.service, choice: w.choice })
    else if (w.kind === 'integrationOptions') {
      const { starts, ...rest } = w.options
      Object.assign(writes.options, rest)
      if (starts) writes.options.starts = { ...writes.options.starts, ...starts }
    }
    else writes.envFiles = w.files
  }
  return writes
}

function mergeLocal(into: RepoSettingsPatch, patch: RepoSettingsPatch): void {
  const { prompts, ...rest } = patch
  Object.assign(into, rest)
  if (prompts) into.prompts = { ...into.prompts, ...prompts }
}

async function applyWrites(host: CliHost, repo: Repo, writes: Writes): Promise<void> {
  if (Object.keys(writes.local).length) await host.api.updateRepoSettings(repo.id, writes.local)
  if (Object.keys(writes.repo).length) await host.api.updateRepo(repo.id, writes.repo)
  for (const { service, choice } of writes.integrations) await host.api.setRepoIntegration(repo.id, service, choice)
  if (Object.keys(writes.options).length) await host.api.setRepoIntegrationOptions(repo.id, writes.options)
  if (writes.envFiles) await host.api.setEnvFiles({ kind: 'repo', repoId: repo.id }, writes.envFiles)
}

function changeText(change: RepoSettingChange, spec: RepoSettingSpec, c: Reading): string {
  const parts = [`was ${change.was}`]
  if (change.wasSource === 'shared' || change.wasSource === 'user') parts[0] += `, from ${layerLabel(change.wasSource, spec, c)}`
  if (change.overrides) {
    parts.push(change.wasSource === change.overrides.source ? 'this computer now overrides it' : `this computer overrides ${layerLabel(change.overrides.source, spec, c)}, which says ${change.overrides.value}`)
  }
  return `(${parts.join('; ')})`
}

export async function repoSettingsSet(host: CliHost, params: unknown): Promise<RepoSettingsSetResult> {
  const p = paramsObject(params)
  const pairs = pairList(p, 'pairs')
  if (!pairs.length) throw invalid('Say what to set: foreman repo settings set <key> <value>.')
  const repo = await repoOf(host, p)
  const planned = planPairs(host, pairs)
  await validateAgainstRepo(host, repo, planned)
  const writes = planWrites(planned)
  const c = await reading(host, repo)
  const before = planned.map(({ spec }) => read(spec, c))
  await applyWrites(host, repo, writes)
  const changes: RepoSettingChange[] = planned.map(({ spec, value, shown }, i) => {
    const was = before[i]
    const change: RepoSettingChange = { key: spec.key, value: shown ?? displayRepoValue(spec, value), was: displayRepoValue(spec, was.value), wasSource: was.source }
    // A local value over a committed or personal one: say which one it hides (also when it was local already).
    const hidden = was.source === 'local' ? was.below : was.source === 'shared' || was.source === 'user' ? was.source : undefined
    if (spec.target === 'local' && (hidden === 'shared' || hidden === 'user')) change.overrides = { source: hidden, value: displayRepoValue(spec, belowValue(spec, hidden, c)) }
    if (spec.note && !(spec.type === 'boolean' && value === false)) change.note = spec.note
    return change
  })
  const lines = columns(changes.map((ch, i) => [ch.key, ch.value, changeText(ch, planned[i].spec, c)]))
  const notes = [...new Set(changes.flatMap((ch) => (ch.note ? [ch.note] : [])))]
  return { repo: nameOf(repo), changes, text: [...lines, ...(notes.length ? ['', ...notes] : [])].join('\n') }
}

export async function repoSettingsUnset(host: CliHost, params: unknown): Promise<RepoSettingsUnsetResult> {
  const p = paramsObject(params)
  const keys = textList(p, 'keys')
  if (!keys.length) throw invalid('Name the settings to unset: foreman repo settings unset <key>.')
  const specs = specsOf(keys)
  const refused = specs.filter((s) => s.target !== 'local')
  if (refused.length) throw invalid(refused.map((s) => `${s.key} can’t be unset; set a value instead${s.type === 'list' || s.type === 'urls' ? ' (an empty list clears it)' : ''}.`).join('\n'))
  const repo = await repoOf(host, p)
  const c = await reading(host, repo, { integrations: false })
  const local: RepoSettingsPatch = {}
  const changes: RepoSettingsUnsetResult['changes'] = []
  const lines: string[][] = []
  for (const spec of specs) {
    const r = read(spec, c)
    const hadLocalValue = r.source === 'local'
    const inherits: Below = hadLocalValue ? (r.below ?? 'default') : (r.source as Below)
    const value = hadLocalValue ? displayRepoValue(spec, belowValue(spec, inherits, c)) : displayRepoValue(spec, r.value)
    changes.push({ key: spec.key, value, inherits, hadLocalValue })
    lines.push([spec.key, value, hadLocalValue ? `(inherits ${inherits === 'default' ? 'the default' : layerLabel(inherits, spec, c)} again)` : '(nothing was set on this computer)'])
    if (hadLocalValue) {
      const w = repoSettingPatch(spec, null)
      if ('error' in w) throw invalid(w.error)
      if (w.kind === 'local') mergeLocal(local, w.patch)
    }
  }
  if (Object.keys(local).length) await host.api.updateRepoSettings(repo.id, local)
  return { repo: nameOf(repo), changes, text: columns(lines).join('\n') }
}

// ---- setup and archive steps ----

const STEP_FIELDS = {
  setup: { steps: 'setupSteps', script: 'setupScript', kind: 'setup' as StepsKind, title: 'Setup' },
  archive: { steps: 'archiveSteps', script: 'archiveScript', kind: 'archive' as StepsKind, title: 'Archive' }
} as const

function localSteps(local: RepoLocalSettings, target: StepsTarget): SetupStep[] | undefined {
  const f = STEP_FIELDS[target]
  const own = local[f.steps]
  if (own) return own
  const script = local[f.script]
  return script !== undefined ? scriptAsSteps(script, f.kind) : undefined
}

function stepRows(steps: SetupStep[]): RepoStepRow[] {
  return steps.map((s, i) => ({ position: i + 1, name: s.name, command: s.command, ...(s.timeoutSec ? { timeoutSec: s.timeoutSec } : {}), ...(s.parallel ? { parallel: true } : {}) }))
}

function stepsText(repo: Repo, target: StepsTarget, rows: RepoStepRow[], source: string, extra: string[] = []): string {
  const head = rows.length ? `${STEP_FIELDS[target].title} steps for ${repo.name} (${source}):` : `${repo.name} has no ${target} steps${source === 'default' ? '' : ` (${source})`}.`
  const cells = rows.map((r) => [`  ${r.position}.`, r.name, `${r.command.includes('\n') ? `${r.command.split('\n')[0]} …` : r.command}${r.timeoutSec ? `  [timeout ${r.timeoutSec}s]` : ''}${r.parallel ? '  [parallel]' : ''}`])
  return [head, ...columns(cells), ...extra].join('\n')
}

const SOURCE_WORDS = { local: 'this computer', shared: 'the committed settings file', default: 'default' } as const

export async function repoSetup(host: CliHost, params: unknown): Promise<RepoSetupResult> {
  const p = paramsObject(params)
  const target = textParam(p, 'target') as StepsTarget
  if (target !== 'setup' && target !== 'archive') throw invalid('target is setup or archive.')
  const verb = textParam(p, 'verb')
  const repo = await repoOf(host, p)
  const f = STEP_FIELDS[target]
  const before = host.resolvedRepoSettings(repo.id)
  const resolvedSteps = before.values[f.steps]
  const own = localSteps(repo.local ?? {}, target)
  const notes: string[] = []
  // Editing starts from this computer's steps; with none, from the committed ones (copied here, which the text says).
  const base = (): SetupStep[] => {
    if (own) return [...own]
    if (resolvedSteps.length) notes.push(`Copied the ${resolvedSteps.length} ${target} step${resolvedSteps.length === 1 ? '' : 's'} from ${before.sharedFile ? relFile(repo, before.sharedFile) : 'the committed settings file'} to this computer first.`)
    return [...resolvedSteps]
  }
  const write = async (patch: RepoSettingsPatch) => host.api.updateRepoSettings(repo.id, patch)
  let patch: RepoSettingsPatch | undefined
  let lead = ''

  switch (verb) {
    case 'list':
      break
    case 'add': {
      const name = textParam(p, 'name', { optional: true })?.trim()
      const command = textParam(p, 'command', { optional: true })
      if (!name) throw invalid('A step needs a name.')
      if (!command?.trim()) throw invalid('A step needs a command.')
      const timeoutSec = numberParam(p, 'timeoutSec')
      if (timeoutSec !== undefined && (!Number.isInteger(timeoutSec) || timeoutSec <= 0 || parseTimeout(timeoutSec) === undefined)) throw invalid('timeoutSec is a whole number of seconds above 0.')
      const steps = base()
      if (steps.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw invalid(`There is already a ${target} step called '${name}'.`)
      const at = numberParam(p, 'at')
      if (at !== undefined && (!Number.isInteger(at) || at < 1 || at > steps.length + 1)) throw invalid(`at is a position from 1 to ${steps.length + 1}.`)
      steps.splice(at !== undefined ? at - 1 : steps.length, 0, { name, command, ...(timeoutSec ? { timeoutSec } : {}), ...(flagParam(p, 'parallel') ? { parallel: true } : {}) })
      patch = stepsPatch(steps, f.kind)
      lead = `Added ${target} step '${name}'.`
      break
    }
    case 'remove': {
      const which = textParam(p, 'name').trim()
      const steps = base()
      const index = /^\d+$/.test(which) ? Number(which) - 1 : steps.findIndex((s) => s.name.toLowerCase() === which.toLowerCase())
      if (!Number.isInteger(index) || index < 0 || index >= steps.length) throw new CliCodedError('not-found', `There is no ${target} step '${which}'. Steps: ${steps.map((s, i) => `${i + 1}. ${s.name}`).join(', ') || 'none'}.`)
      const [gone] = steps.splice(index, 1)
      patch = stepsPatch(steps, f.kind)
      lead = `Removed ${target} step '${gone.name}'.`
      break
    }
    case 'move': {
      const steps = base()
      const from = numberParam(p, 'from')
      const to = numberParam(p, 'to')
      const bad = (n: number | undefined) => n === undefined || !Number.isInteger(n) || n < 1 || n > steps.length
      if (bad(from) || bad(to)) throw invalid(`from and to are positions from 1 to ${steps.length}.`)
      const [moved] = steps.splice(from! - 1, 1)
      steps.splice(to! - 1, 0, moved)
      patch = stepsPatch(steps, f.kind)
      lead = `Moved ${target} step '${moved.name}' to position ${to}.`
      break
    }
    case 'clear':
      patch = stepsPatch([], f.kind)
      lead = `This computer now has no ${target} steps${resolvedSteps.length && before.sources[f.steps] === 'shared' ? ' (that overrides the committed ones)' : ''}.`
      break
    case 'inherit':
      patch = { [f.script]: null, [f.steps]: null } as RepoSettingsPatch
      lead = `This computer no longer sets ${target} steps; the committed settings (or the default) apply again.`
      break
    default:
      throw invalid('verb is list, add, remove, move, clear or inherit.')
  }
  if (patch) await write(patch)
  const after = patch ? host.resolvedRepoSettings(repo.id) : before
  const sourceKey = after.sources[f.steps] ?? 'default'
  const rows = stepRows(after.values[f.steps])
  return { repo: nameOf(repo), target, steps: rows, source: sourceKey === 'user' ? 'default' : sourceKey, text: [...(lead ? [lead, ...notes] : []), stepsText(repo, target, rows, SOURCE_WORDS[sourceKey === 'user' ? 'default' : sourceKey])].join('\n') }
}

// ---- run scripts ----

function scriptRows(resolved: ResolvedRepoSettings): RepoScriptRow[] {
  return resolved.values.runScripts.map((s) => ({
    name: s.name,
    command: s.command,
    icon: s.icon,
    default: Boolean(s.default),
    hidden: Boolean(s.hidden),
    ...(s.previewUrl ? { previewUrl: s.previewUrl } : {}),
    source: s.source ?? 'local',
    ...(s.overrides ? { overrides: true } : {})
  }))
}

function scriptsText(repo: Repo, rows: RepoScriptRow[]): string {
  if (!rows.length) return `${repo.name} has no run scripts.`
  const cells = rows.map((r) => [`  ${r.name}${r.default ? ' *' : ''}`, r.command.split('\n')[0] + (r.command.includes('\n') ? ' …' : ''), [r.hidden ? 'hidden' : '', r.source === 'shared' ? 'committed' : 'this computer', r.overrides ? 'overrides the committed one' : '', r.previewUrl ? `preview ${r.previewUrl}` : ''].filter(Boolean).join(', ')])
  return [`Run scripts for ${repo.name} (* is the default):`, ...columns(cells)].join('\n')
}

const cleanLocal = (s: RunScript): RunScript => ({ name: s.name, command: s.command, icon: s.icon, ...(s.default ? { default: true } : {}), ...(s.hidden ? { hidden: true } : {}), ...(s.previewUrl ? { previewUrl: s.previewUrl } : {}) })

export async function repoScripts(host: CliHost, params: unknown): Promise<RepoScriptsResult> {
  const p = paramsObject(params)
  const verb = textParam(p, 'verb')
  const repo = await repoOf(host, p)
  const before = host.resolvedRepoSettings(repo.id)
  const mine: RunScript[] = (repo.local?.runScripts ?? []).map(cleanLocal)
  const name = textParam(p, 'name', { optional: true })?.trim()
  let next: RunScript[] | undefined
  let lead = ''
  switch (verb) {
    case 'list':
      break
    case 'add': {
      const command = textParam(p, 'command', { optional: true })
      if (!name) throw invalid('A script needs a name.')
      if (!command?.trim()) throw invalid('A script needs a command.')
      if (mine.some((s) => s.name === name)) throw invalid(`This computer already has a run script called '${name}'. Remove it first.`)
      const wantDefault = flagParam(p, 'default')
      const previewUrl = textParam(p, 'previewUrl', { optional: true })?.trim()
      next = [...(wantDefault ? mine.map((s) => ({ ...s, default: undefined })) : mine).map(cleanLocal), cleanLocal({ name, command, icon: textParam(p, 'icon', { optional: true })?.trim() || 'play', default: wantDefault, hidden: flagParam(p, 'hidden'), ...(previewUrl ? { previewUrl } : {}) })]
      lead = `Added run script '${name}'.`
      break
    }
    case 'remove': {
      if (!name) throw invalid('Say which script to remove.')
      if (!mine.some((s) => s.name === name)) {
        const shared = before.values.runScripts.find((s) => s.name === name && s.source === 'shared')
        if (shared) throw invalid(`'${name}' comes from the committed settings file, which can’t be changed here. Add a script called '${name}' with --hidden to hide it on this computer.`)
        throw new CliCodedError('not-found', `This computer has no run script called '${name}'.`)
      }
      next = mine.filter((s) => s.name !== name)
      lead = `Removed run script '${name}'.`
      break
    }
    case 'set-default': {
      if (!name) throw invalid('Say which script should be the default.')
      const found = before.values.runScripts.find((s) => s.name === name)
      if (!found) throw new CliCodedError('not-found', `${repo.name} has no run script called '${name}'. Scripts: ${before.values.runScripts.map((s) => s.name).join(', ') || 'none'}.`)
      const cleared = mine.map((s) => cleanLocal({ ...s, default: false }))
      next = cleared.some((s) => s.name === name) ? cleared.map((s) => (s.name === name ? { ...s, default: true } : s)) : [...cleared, cleanLocal({ ...found, default: true })]
      lead = `'${name}' is the default run script.`
      break
    }
    default:
      throw invalid('verb is list, add, remove or set-default.')
  }
  if (next) await host.api.updateRepoSettings(repo.id, { runScripts: next })
  const rows = scriptRows(next ? host.resolvedRepoSettings(repo.id) : before)
  return { repo: nameOf(repo), scripts: rows, text: [...(lead ? [lead] : []), scriptsText(repo, rows)].join('\n') }
}

// ---- checks ----

function checkRows(resolved: ResolvedRepoSettings): RepoCheckRow[] {
  return resolved.values.checks.map((c) => ({ name: c.name, command: c.command, source: c.source ?? 'local', ...(c.overrides ? { overrides: true } : {}) }))
}

export async function repoChecks(host: CliHost, params: unknown): Promise<RepoChecksResult> {
  const p = paramsObject(params)
  const verb = textParam(p, 'verb')
  const repo = await repoOf(host, p)
  const before = host.resolvedRepoSettings(repo.id)
  const mine: CheckCommand[] = (repo.local?.checks ?? []).map((c) => ({ name: c.name, command: c.command }))
  const name = textParam(p, 'name', { optional: true })?.trim()
  let next: CheckCommand[] | undefined
  let lead = ''
  switch (verb) {
    case 'list':
      break
    case 'add': {
      const command = textParam(p, 'command', { optional: true })
      if (!name) throw invalid('A check needs a name.')
      if (!command?.trim()) throw invalid('A check needs a command.')
      if (mine.some((c) => c.name === name)) throw invalid(`This computer already has a check called '${name}'. Remove it first.`)
      next = [...mine, { name, command }]
      lead = `Added check '${name}'. It needs approval before it first runs: foreman checks approve.`
      break
    }
    case 'remove': {
      if (!name) throw invalid('Say which check to remove.')
      if (!mine.some((c) => c.name === name)) {
        if (before.values.checks.some((c) => c.name === name && c.source === 'shared')) throw invalid(`'${name}' comes from the committed settings file, which can’t be changed here.`)
        throw new CliCodedError('not-found', `This computer has no check called '${name}'.`)
      }
      next = mine.filter((c) => c.name !== name)
      lead = `Removed check '${name}'.`
      break
    }
    default:
      throw invalid('verb is list, add or remove.')
  }
  if (next) await host.api.updateRepoSettings(repo.id, { checks: next })
  const rows = checkRows(next ? host.resolvedRepoSettings(repo.id) : before)
  const body = rows.length ? [`Checks for ${repo.name}:`, ...columns(rows.map((r) => [`  ${r.name}`, r.command.split('\n')[0] + (r.command.includes('\n') ? ' …' : ''), r.source === 'shared' ? '(committed)' : r.overrides ? '(this computer, overrides the committed one)' : '(this computer)']))] : [`${repo.name} has no checks.`]
  return { repo: nameOf(repo), checks: rows, text: [...(lead ? [lead] : []), ...body].join('\n') }
}

/** `foreman checks approve`: what would run (with the hash each approval is tied to), or approve those hashes and start the checks. */
export async function checksApprove(host: CliHost, params: unknown): Promise<ChecksApproveResult> {
  const p = paramsObject(params)
  const cwd = textParam(p, 'cwd')
  const ws = findWorkspace(host.state(), textParam(p, 'workspace', { optional: true }) ?? '.', cwd)
  const configured = host.resolvedRepoSettings(ws.repoId).values.checks
  if (!configured.length) throw new CliCodedError('not-found', 'No checks are configured for this repository.')
  const waiting = host.checkConsent ? new Set(host.checkConsent(ws.id).map((i) => i.name)) : undefined
  const items = configured.map((c) => ({ name: c.name, command: c.command, hash: commandHash(c.command), source: c.source ?? 'local', ...(waiting ? { approved: !waiting.has(c.name) } : {}) }))
  const base = { workspace: { id: ws.id, name: ws.name }, items }
  const hashes = textList(p, 'hashes', { optional: true })
  if (!hashes) {
    const cells = items.map((i) => [`  ${i.name}`, i.hash.slice(0, 12), i.approved === undefined ? '' : i.approved ? 'approved' : 'needs approval'])
    const lines = [`Checks for ${ws.name}:`, ...columns(cells), ...items.flatMap((i) => [`  ${i.name}: ${i.command}`])]
    if (!waiting || waiting.size) lines.push('', 'Approving runs the checks as written above. Approve with: foreman checks approve --yes')
    return { ...base, text: lines.join('\n') }
  }
  if (!hashes.length) throw invalid('Name the commands to approve by their hashes (`foreman checks approve` lists them).')
  const unknown = hashes.filter((h) => !items.some((i) => i.hash === h))
  if (unknown.length) throw new CliCodedError('needs-consent', 'A check command changed since you looked at it. Nothing was approved or run; list them again with `foreman checks approve`.')
  const outcome = await host.api.runChecks(ws.id, hashes)
  if (outcome.started) return { ...base, started: true, text: `Approved ${hashes.length} command${hashes.length === 1 ? '' : 's'} and started the checks in ${ws.name}.` }
  const left = outcome.consent.map((i) => i.name)
  return { ...base, started: false, consent: outcome.consent, text: `Not started: still waiting for approval of ${left.join(', ')}. Approve them too to run the checks.` }
}

// ---- repo MCP proposals ----

function mcpRows(view: Awaited<ReturnType<CliHost['api']['repoMcp']>>): RepoMcpRow[] {
  return view.proposals.map((pr) => ({
    name: pr.server.name,
    command: [pr.server.command, ...pr.server.args].join(' '),
    state: pr.state,
    fingerprint: pr.fingerprint,
    env: pr.server.env,
    scopes: pr.server.scopes,
    missingEnv: pr.missingEnv,
    scripts: pr.scripts.map((s) => s.path)
  }))
}

function mcpText(wsName: string, file: string | undefined, rows: RepoMcpRow[]): string {
  if (!rows.length) return `${file ?? 'The repository’s settings'} proposes no MCP servers for ${wsName}.`
  const lines = [`MCP servers proposed by ${file ?? 'the repository'} for ${wsName}:`]
  for (const r of rows) {
    lines.push(`  ${r.name}  ${r.state === 'approved' ? 'approved' : r.state === 'changed' ? 'changed since approved' : 'new'}  (fingerprint ${r.fingerprint.slice(0, 12)})`)
    lines.push(`    runs: ${r.command}`)
    if (r.env.length) lines.push(`    variables: ${r.env.join(', ')} (from: ${r.scopes.join(', ')})${r.missingEnv.length ? `; no value for ${r.missingEnv.join(', ')}` : ''}`)
    if (r.scripts.length) lines.push(`    runs repository files: ${r.scripts.join(', ')}`)
  }
  return lines.join('\n')
}

export async function repoMcpProposals(host: CliHost, params: unknown): Promise<RepoMcpResult> {
  const p = paramsObject(params)
  const ws = findWorkspace(host.state(), textParam(p, 'workspace', { optional: true }) ?? '.', textParam(p, 'cwd'))
  const view = await host.api.repoMcp(ws.id)
  const rows = mcpRows(view)
  const base = { workspace: { id: ws.id, name: ws.name }, proposals: rows, ...(view.file ? { file: view.file } : {}) }
  const approve = textList(p, 'approve', { optional: true })
  if (!approve) return { ...base, text: mcpText(ws.name, view.file, rows) }
  const missing = approve.filter((n) => !rows.some((r) => r.name === n))
  if (missing.length) throw new CliCodedError('not-found', `${ws.name} has no proposed MCP server called ${missing.map((n) => `'${n}'`).join(', ')}. Proposed: ${rows.map((r) => r.name).join(', ') || 'none'}.`)
  const shownRaw = p.shown
  if (approve.length && (!shownRaw || typeof shownRaw !== 'object' || Array.isArray(shownRaw))) {
    throw new CliCodedError('needs-confirmation', `Look at the proposals first, then approve them with what you saw.\n${mcpText(ws.name, view.file, rows)}`)
  }
  const shown = Object.fromEntries(Object.entries((shownRaw ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  await host.api.approveRepoMcp(ws.id, approve, shown)
  const rest = rows.filter((r) => !approve.includes(r.name)).map((r) => r.name)
  const text = [approve.length ? `Approved: ${approve.join(', ')}.` : 'Approved none.', rest.length ? `Not approved now: ${rest.join(', ')} (an earlier approval of these is withdrawn).` : ''].filter(Boolean).join('\n')
  return { ...base, approved: approve, text }
}

// ---- auto review ----

const loadoutText = (l: Pick<Loadout, 'agent' | 'model' | 'effort' | 'fast'>): string => [l.agent, l.model, l.effort, l.fast ? 'fast' : ''].filter(Boolean).join(' · ')

function previewText(repo: Repo, shown: AutoReviewShown): string {
  return [
    `Auto review for ${repo.name} would:`,
    ...columns([
      ['  Review with', loadoutText(shown.reviewer)],
      ['  Skip when only these change', shown.exclusions.length ? shown.exclusions.join(', ') : '(nothing is skipped)'],
      ['  Budget', `${shown.perDay} reviews a day, ${shown.maxMinutes} minutes each, after the workspace has been idle ${shown.idleMinutes} minutes`],
      ['  Read-only', shown.readOnly === 'plan' ? 'held to the agent’s plan mode: it can read but not change files' : 'held to the agent’s read-only sandbox']
    ]),
    '  First message to the reviewer (the diff follows it):',
    ...shown.prompt.split('\n').map((l) => `    ${l}`)
  ].join('\n')
}

export async function repoAutoReview(host: CliHost, params: unknown): Promise<RepoAutoReviewResult> {
  const p = paramsObject(params)
  const verb = textParam(p, 'verb')
  const repo = await repoOf(host, p)
  const base = { repo: nameOf(repo) }
  if (verb === 'status') {
    const consent = repo.autoReview
    if (!consent) return { ...base, enabled: false, text: `Auto review is off for ${repo.name}.` }
    const paused = consent.paused?.reason
    return {
      ...base,
      enabled: !paused,
      current: { reviewer: consent.reviewer, exclusions: consent.exclusions, ...(paused ? { paused } : {}) },
      text: [`Auto review is ${paused ? 'paused' : 'on'} for ${repo.name}: ${loadoutText(consent.reviewer)}.`, consent.exclusions.length ? `Skips changes that only touch: ${consent.exclusions.join(', ')}.` : '', paused ?? ''].filter(Boolean).join('\n')
    }
  }
  if (verb === 'off') {
    await host.api.setAutoReview(repo.id, null)
    return { ...base, enabled: false, text: `Auto review is off for ${repo.name}.` }
  }
  if (verb !== 'on') throw invalid('verb is status, on or off.')
  const shownRaw = p.shown
  if (shownRaw !== undefined && shownRaw !== null) {
    if (typeof shownRaw !== 'object' || Array.isArray(shownRaw)) throw invalid('shown must be what the preview returned.')
    await host.api.setAutoReview(repo.id, shownRaw as AutoReviewShown)
    return { ...base, enabled: true, text: `Auto review is on for ${repo.name}.` }
  }
  // No consent yet: ask the service what it would do and hand that back.
  const reviewer = p.reviewer as { agent?: unknown; model?: unknown; effort?: unknown; fast?: unknown } | undefined
  if (reviewer !== undefined && (typeof reviewer !== 'object' || reviewer === null || typeof reviewer.agent !== 'string' || typeof reviewer.model !== 'string')) throw invalid('reviewer needs an agent and a model.')
  const exclusions = textList(p, 'exclusions', { optional: true })
  const choice = {
    ...(reviewer ? { reviewer: { agent: reviewer.agent, model: reviewer.model, ...(typeof reviewer.effort === 'string' ? { effort: reviewer.effort } : {}), fast: reviewer.fast === true } as Loadout } : {}),
    ...(exclusions ? { exclusions } : {})
  }
  const preview = await host.api.autoReviewPreview(repo.id, choice)
  return { ...base, enabled: false, needsConfirmation: true, preview, text: `${previewText(repo, preview)}\nNothing is on yet. Turn it on with what is shown above: foreman repo auto-review on --yes` }
}

// ---- integrations ----

export async function repoIntegrations(host: CliHost, params: unknown): Promise<RepoIntegrationsResult> {
  const repo = await repoOf(host, paramsObject(params))
  const views = await host.api.repoIntegrations(repo.id)
  const rows: RepoIntegrationRow[] = views.map((v) => {
    const res = v.resolution
    const connection = 'connection' in res ? res.connection : undefined
    let using: string
    let problem: string | undefined
    if (res.state === 'ready') using = `${connection!.name} (${res.source === 'default' ? 'the default' : 'chosen here'})`
    else if (res.state === 'env') using = 'GH_TOKEN from the repository’s environment'
    else if (res.state === 'none') using = res.off ? 'off for this repository' : 'none set up'
    else {
      using = connection ? connection.name : (res.connectionId ?? 'a missing connection')
      problem = res.reason === 'missing' ? 'the chosen connection is gone' : res.reason === 'env-conflict' ? 'the repository’s GH_TOKEN conflicts with the chosen connection' : (connection?.problem ?? 'the chosen connection has a problem')
    }
    return { service: v.service, choice: v.choice, using, ...(problem ? { problem } : {}) }
  })
  const text = columns(rows.map((r) => [r.service, r.choice === 'default' || r.choice === 'off' ? r.choice : 'chosen', r.using + (r.problem ? ` — ${r.problem}` : '')])).join('\n')
  return { repo: nameOf(repo), rows, text: `Integrations for ${repo.name}:\n${text.split('\n').map((l) => `  ${l}`).join('\n')}` }
}

// ---- the registry rows ----

/** The same handler with some parameters fixed: the read twin of a method that both looks and changes. */
const twin =
  (handle: MethodDef['handle'], fixed: Record<string, unknown>): MethodDef['handle'] =>
  (host, params, ctx) =>
    handle(host, { ...paramsObject(params), ...fixed }, ctx)

/**
 * `foreman repo …` and `foreman checks approve`. Changing anything, and approving, is admin. The methods that
 * mix looking and changing (setup, scripts, checks, mcp, auto review) are admin as a whole, so each has a read
 * twin (`…-list`, `…-status`) for a caller that only wants to look, an agent turn included.
 */
export const REPO_SETTINGS_METHODS: Record<string, MethodDef> = {
  'repo-settings-list': { tier: 'read', handle: async (host, params) => repoSettingsList(host, params) },
  'repo-settings-get': { tier: 'read', handle: async (host, params) => repoSettingsGet(host, params) },
  'repo-settings-file': { tier: 'read', handle: async (host, params, ctx) => repoSettingsFile(host, params, ctx) },
  'repo-integrations': { tier: 'read', handle: async (host, params) => repoIntegrations(host, params) },
  'repo-settings-set': { tier: 'admin', handle: async (host, params) => repoSettingsSet(host, params) },
  'repo-settings-unset': { tier: 'admin', handle: async (host, params) => repoSettingsUnset(host, params) },
  'repo-setup': { tier: 'admin', handle: async (host, params) => repoSetup(host, params) },
  'repo-setup-list': { tier: 'read', handle: twin(async (host, params) => repoSetup(host, params), { verb: 'list' }) },
  'repo-scripts': { tier: 'admin', handle: async (host, params) => repoScripts(host, params) },
  'repo-scripts-list': { tier: 'read', handle: twin(async (host, params) => repoScripts(host, params), { verb: 'list' }) },
  'repo-checks': { tier: 'admin', handle: async (host, params) => repoChecks(host, params) },
  'repo-checks-list': { tier: 'read', handle: twin(async (host, params) => repoChecks(host, params), { verb: 'list' }) },
  'checks-approve': { tier: 'admin', handle: async (host, params) => checksApprove(host, params) },
  'checks-list': { tier: 'read', handle: twin(async (host, params) => checksApprove(host, params), { hashes: undefined }) },
  'repo-mcp-proposals': { tier: 'admin', handle: async (host, params) => repoMcpProposals(host, params) },
  'repo-mcp-list': { tier: 'read', handle: twin(async (host, params) => repoMcpProposals(host, params), { approve: undefined, shown: undefined }) },
  'repo-auto-review': { tier: 'admin', handle: async (host, params) => repoAutoReview(host, params) },
  'repo-auto-review-status': { tier: 'read', handle: twin(async (host, params) => repoAutoReview(host, params), { verb: 'status' }) }
}
