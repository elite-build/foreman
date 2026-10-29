// The table behind `foreman repo settings`: one entry per repository setting the command line can read and write,
// and which Api call writes it. Pure and shared (no I/O, no Electron), like settingsSchema.ts.
// Keys are `<tab>.<id>` after the Repository settings tab the registry row sits on (`git`, `scripts`, `actions`,
// `repo`, `integrations`, `cloud`). The structured settings (setup and archive steps, run scripts, checks, auto
// review) have their own commands and are named in STRUCTURED_REPO_SETTINGS instead.
import { CLOUD_PROVIDER_IDS } from './cloud'
import { AGENT_TOOL_SERVICES, INTEGRATION_SERVICES, type RepoIntegrationService } from './integrations'
import { SETTINGS } from './settingsRegistry'
import type { CustomPrompts, PreviewUrl, RepoCloud, RepoIcon, RepoPatch, RepoSettings, RepoSettingsPatch } from './types'

export type RepoTab = 'git' | 'scripts' | 'actions' | 'repo' | 'integrations' | 'cloud'

/** The tabs in the order Repository settings shows them. */
export const REPO_TABS: readonly RepoTab[] = ['git', 'scripts', 'actions', 'repo', 'integrations', 'cloud']

/**
 * Which API writes the value: `local` is updateRepoSettings (this computer's layer; null inherits again), `repo` a
 * Repo field through updateRepo, `repoCloud` the same with `{ cloud }`, `integration` setRepoIntegration,
 * `integrationOptions` setRepoIntegrationOptions, `envFiles` setEnvFiles({ kind: 'repo' }).
 */
export type RepoTarget = 'local' | 'repo' | 'repoCloud' | 'integration' | 'integrationOptions' | 'envFiles'

export type RepoSettingType = 'boolean' | 'enum' | 'integer' | 'string' | 'text' | 'list' | 'icon' | 'urls'

export type RepoSettingField =
  | Exclude<keyof RepoSettings, 'prompts'>
  | `prompts.${keyof CustomPrompts}`
  | 'name'
  | 'defaultBranch'
  | 'remote'
  | 'icon'
  | `cloud.${keyof Omit<RepoCloud, 'build'>}`
  | `integrations.${RepoIntegrationService}`
  | 'integrations.rules'
  | 'integrations.allowOwnMcp'
  | `integrations.starts.${RepoIntegrationService}`

export interface RepoSettingSpec {
  // The full CLI key, `scripts.run-mode`.
  key: string
  // The part after the tab.
  id: string
  tab: RepoTab
  target: RepoTarget
  // The settingsRegistry.ts repository row it belongs to (title, description).
  registryId?: string
  field: RepoSettingField
  type: RepoSettingType
  values?: readonly string[]
  labels?: Readonly<Record<string, string>>
  // Lists: the only items allowed.
  itemValues?: readonly string[]
  min?: number
  max?: number
  step?: number
  options?: readonly number[]
  // Can also come from the committed .foreman/settings.toml (the window labels a local value that overrides it).
  shared?: true
  // The one line printed after a change, for settings that widen what an agent may do.
  note?: string
  // A caveat for help and `settings keys`.
  hint?: string
}

// ---- the table ----

interface Draft {
  registryId?: string
  // Only for a field with no registry row.
  tab?: RepoTab
  target?: RepoTarget
  field: RepoSettingField
  type: RepoSettingType
  values?: readonly string[]
  labels?: Readonly<Record<string, string>>
  itemValues?: readonly string[]
  min?: number
  max?: number
  step?: number
  options?: readonly number[]
  note?: string
  hint?: string
}

// This Mac only, never read from settings.toml: a committed file can't switch them on.
const LOCAL_ONLY: readonly string[] = ['teachAgents', 'agentsMayStart']

/**
 * The tab a registry row sits on. 'misc' is the Repository tab; the Environment tab's env files are listed under
 * the Repository tab too (PLAN §6.4), since the CLI has no separate tab for them.
 */
function tabOfRow(registryId: string): RepoTab {
  const row = SETTINGS.find((e) => e.id === registryId)
  if (!row) throw new Error(`repoSettingsSchema: no settingsRegistry row '${registryId}'`)
  if (row.page.section !== 'repo') throw new Error(`repoSettingsSchema: row '${registryId}' is not a repository row`)
  const tab = row.page.tab
  return tab === 'misc' || tab === 'environment' ? 'repo' : tab
}

function def(id: string, draft: Draft): RepoSettingSpec {
  const fromRow = draft.registryId ? tabOfRow(draft.registryId) : undefined
  const tab = fromRow ?? draft.tab
  if (!tab) throw new Error(`repoSettingsSchema: '${id}' needs a registry row or a tab`)
  if (fromRow && draft.tab && draft.tab !== fromRow) throw new Error(`repoSettingsSchema: '${id}' names tab '${draft.tab}' but its row is on '${fromRow}'`)
  const { tab: _tab, target, ...rest } = draft
  const spec: RepoSettingSpec = { key: `${tab}.${id}`, id, tab, target: target ?? 'local', ...rest }
  if ((spec.target === 'local' || spec.target === 'envFiles') && !LOCAL_ONLY.includes(spec.field)) spec.shared = true
  return spec
}

const flag = (id: string, registryId: string | undefined, field: RepoSettingField, extra: Partial<Draft> = {}) => def(id, { registryId, field, type: 'boolean', ...extra })
const prompt = (id: keyof CustomPrompts, registryId: string) => def(registryId, { registryId, field: `prompts.${id}`, type: 'text' })

export const REPO_SETTINGS_SCHEMA: readonly RepoSettingSpec[] = [
  // Git
  def('base-branch', { registryId: 'repo-base-branch', target: 'repo', field: 'defaultBranch', type: 'string' }),
  def('remote', { registryId: 'repo-remote', target: 'repo', field: 'remote', type: 'string', hint: 'Checked against the repository’s remotes.' }),
  flag('work-in-repo-folder', 'repo-work-in-repo-folder', 'workInRepoFolder'),
  flag('delete-branch-on-archive', 'repo-delete-branch-on-archive', 'deleteBranchOnArchive'),
  flag('archive-on-merge', 'repo-archive-on-merge', 'archiveOnMerge'),
  flag('push-auto-setup-remote', 'repo-push-auto-setup-remote', 'pushAutoSetupRemote'),
  def('sensitive-paths', { registryId: 'sensitive-paths', field: 'sensitivePaths', type: 'list' }),
  def('warn-base-moved', { tab: 'git', field: 'warnBaseMoved', type: 'boolean' }),

  // Scripts
  flag('setup-retry', 'setup-retry', 'setupRetryOnce'),
  flag('checks-after-turn', 'repo-checks-after-turn', 'checksAfterTurn'),
  def('run-mode', { registryId: 'run-mode', field: 'runMode', type: 'enum', values: ['exclusive', 'concurrent'] }),
  def('auto-run-after-setup', { tab: 'scripts', field: 'autoRunAfterSetup', type: 'boolean' }),
  flag('docker-cleanup', 'repo-docker-cleanup', 'removeDockerContainers'),
  flag('docker-extras', 'repo-docker-extras', 'removeDockerExtras'),

  // Actions
  flag('teach-agents', 'teach-agents', 'teachAgents', { note: 'New chats in this repository get instructions about `foreman report` and `foreman review` in their system prompt.' }),
  flag('agents-may-start', 'agents-may-start', 'agentsMayStart', { note: 'Agents in this repository may now use `foreman run` and `foreman send` to start workspaces and queue messages.' }),
  flag('spotlight-testing', 'spotlight-testing', 'spotlightTesting'),
  def('suggest-followups', { tab: 'actions', field: 'suggestFollowups', type: 'boolean' }),
  prompt('general', 'prompt-general'),
  prompt('createPr', 'prompt-create-pr'),
  prompt('codeReview', 'prompt-code-review'),
  prompt('fixErrors', 'prompt-fix-errors'),
  prompt('resolveConflicts', 'prompt-resolve-conflicts'),
  prompt('renameBranch', 'prompt-rename-branch'),

  // Repository
  def('name', { tab: 'repo', target: 'repo', field: 'name', type: 'string' }),
  def('icon', { registryId: 'repo-icon', target: 'repo', field: 'icon', type: 'icon', hint: 'emoji:🚀 or lucide:rocket (an image comes from --file).' }),
  def('files-to-copy', { registryId: 'files-to-copy', field: 'filesToCopy', type: 'list' }),
  def('preview-urls', { registryId: 'preview-urls', field: 'previewUrls', type: 'urls', hint: 'name=url or just a url; $FOREMAN_PORT is substituted.' }),
  def('env-files', { registryId: 'repo-env-files', target: 'envFiles', field: 'envFiles', type: 'list' }),

  // Integrations
  def('github-account', { registryId: 'repo-github-account', target: 'integration', field: 'integrations.github', type: 'string', hint: 'A connection id or name, `default`, or `off`.' }),
  def('linear', { registryId: 'repo-linear', target: 'integration', field: 'integrations.linear', type: 'string', hint: 'A connection id or name, `default`, or `off`.' }),
  def('slack', { registryId: 'repo-slack', target: 'integration', field: 'integrations.slack', type: 'string', hint: 'A connection id or name, `default`, or `off`.' }),
  def('slack-rules', { tab: 'integrations', target: 'integrationOptions', field: 'integrations.rules', type: 'enum', values: ['mine', 'off'] }),
  def('allow-own-mcp', { tab: 'integrations', target: 'integrationOptions', field: 'integrations.allowOwnMcp', type: 'list', itemValues: INTEGRATION_SERVICES }),
  // Whether a service's tools start on in this repository's new workspaces; `default` follows the connection's own setting.
  ...AGENT_TOOL_SERVICES.map((service) =>
    def(`${service}-in-new-workspaces`, { tab: 'integrations', target: 'integrationOptions', field: `integrations.starts.${service}`, type: 'enum', values: ['default', 'on', 'off'], hint: '`default` follows the connection (`foreman connections edit <id> --new-workspaces on|off`).' })
  ),

  // Remote workspaces (this repository's `cloud` record on Repo; the build is Foreman's own)
  flag('enabled', 'repo-cloud-enabled', 'cloud.enabled', { target: 'repoCloud' }),
  def('provider', { registryId: 'repo-cloud-provider', target: 'repoCloud', field: 'cloud.provider', type: 'enum', values: CLOUD_PROVIDER_IDS }),
  def('connection', { tab: 'cloud', target: 'repoCloud', field: 'cloud.connectionId', type: 'string', hint: 'A connection id of the provider’s service; empty is the service’s default.' }),
  // One of the provider's own sizes: only the server knows the provider, so it checks against vcpuOptions.
  def('vcpus', { registryId: 'repo-cloud-size', target: 'repoCloud', field: 'cloud.vcpus', type: 'integer', hint: 'One of the provider’s sizes (2, 4, 8 on Vercel); checked against the provider.' }),
  def('region', { registryId: 'repo-cloud-region', target: 'repoCloud', field: 'cloud.region', type: 'string', hint: 'The provider’s region id; empty for providers without regions.' }),
  def('idle-minutes', { registryId: 'repo-cloud-idle', target: 'repoCloud', field: 'cloud.idleMinutes', type: 'integer', min: 1, max: 24 * 60 }),
  flag('continue', 'repo-cloud-continue', 'cloud.autoContinue', { target: 'repoCloud' }),
  def('install-script', { registryId: 'repo-cloud-install', target: 'repoCloud', field: 'cloud.installScript', type: 'text' }),
  def('max-running', { tab: 'cloud', target: 'repoCloud', field: 'cloud.maxRunning', type: 'integer', min: 1, max: 10_000 })
]

/** Repository settings with their own commands (setup, archive, run scripts, checks, auto review); setupScript and archiveScript are the older one-script forms of the steps. */
export const STRUCTURED_REPO_SETTINGS: readonly string[] = ['setupScript', 'setupSteps', 'archiveScript', 'archiveSteps', 'runScripts', 'checks', 'autoReview']

// ---- lookups ----

const BY_KEY = new Map(REPO_SETTINGS_SCHEMA.map((spec) => [spec.key, spec]))

function kebab(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function closeKeys(typed: string): string[] {
  const wanted = kebab(typed.trim())
  const dot = wanted.indexOf('.')
  const id = dot >= 0 ? wanted.slice(dot + 1) : wanted
  const same = REPO_SETTINGS_SCHEMA.filter((s) => s.id === id || kebab(s.field.replace(/^(cloud|integrations)\./, '')) === id)
  const loose = REPO_SETTINGS_SCHEMA.filter((s) => !same.includes(s) && id.length >= 3 && (s.key.includes(id) || id.includes(s.id)))
  return [...same, ...loose].slice(0, 6).map((s) => s.key)
}

/** The repository setting with exactly this key (`scripts.run-mode`); a near miss is named in the error. */
export function findRepoSetting(key: string): { spec: RepoSettingSpec } | { error: string } {
  const spec = BY_KEY.get(key.trim().toLowerCase())
  if (spec) return { spec }
  const close = closeKeys(key)
  if (close.length) return { error: `No repository setting called '${key}'. Did you mean ${close.map((k) => `'${k}'`).join(', ')}?` }
  return { error: `No repository setting called '${key}'. List the keys with: foreman repo settings list` }
}

/** The specs grouped by tab, in Repository settings' order. */
export function repoSettingsByTab(): { tab: RepoTab; specs: RepoSettingSpec[] }[] {
  return REPO_TABS.map((tab) => ({ tab, specs: REPO_SETTINGS_SCHEMA.filter((s) => s.tab === tab) })).filter((g) => g.specs.length > 0)
}

/** The settingsRegistry.ts row a spec points at (title, description), when it has one. */
export function repoRegistryRowOf(spec: RepoSettingSpec) {
  return spec.registryId ? SETTINGS.find((e) => e.id === spec.registryId) : undefined
}

// ---- text to value ----

const TRUE_WORDS = ['on', 'true', 'yes', '1']
const FALSE_WORDS = ['off', 'false', 'no', '0']

function enumStored(spec: RepoSettingSpec, raw: string): string | undefined {
  const wanted = raw.trim().toLowerCase()
  const spelling = spec.values?.find((v) => v.toLowerCase() === wanted)
  return spelling === undefined ? undefined : (spec.labels?.[spelling] ?? spelling)
}

function splitList(raw: string | readonly string[]): string[] {
  const parts = typeof raw === 'string' ? raw.split(',') : raw
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** `name=url` or a bare url. A url holds `=` and `:` itself, so the name is only what stands before the first `=` when it has neither a colon nor a slash. */
function previewUrl(item: string): PreviewUrl {
  const at = item.indexOf('=')
  if (at > 0 && !/[:/]/.test(item.slice(0, at))) return { name: item.slice(0, at).trim(), url: item.slice(at + 1).trim() }
  return { name: '', url: item.trim() }
}

function repoIcon(text: string): RepoIcon | undefined {
  const at = text.indexOf(':')
  const kind = at < 0 ? '' : text.slice(0, at).toLowerCase()
  const rest = at < 0 ? '' : text.slice(at + 1).trim()
  if (!rest) return undefined
  if (kind === 'emoji') return { kind: 'emoji', value: rest }
  if (kind === 'lucide' && /^[a-z0-9-]+$/.test(rest)) return { kind: 'lucide', name: rest }
  if (kind === 'data' && /^image\//.test(rest)) return { kind: 'image', dataUrl: text.trim() }
  return undefined
}

/**
 * Text from the command line as the value to store, or the reason it can't be. Lists take `a,b,c` or an array
 * (preview URLs: `name=url`); text keeps its line breaks and spaces.
 */
export function coerceRepoSettingValue(spec: RepoSettingSpec, raw: string | readonly string[]): { value: unknown } | { error: string } {
  if (spec.type === 'list' || spec.type === 'urls') {
    const items = splitList(raw)
    if (spec.type === 'urls') {
      const urls = items.map(previewUrl)
      if (urls.some((u) => !u.url)) return { error: `${spec.key} takes name=url or a url; an item has no url.` }
      return { value: urls }
    }
    const bad = spec.itemValues ? items.filter((i) => !spec.itemValues!.includes(i.toLowerCase())) : []
    if (bad.length) return { error: `'${bad.join("', '")}' is not a choice for ${spec.key}. Choose from: ${spec.itemValues!.join(', ')}.` }
    return { value: spec.itemValues ? items.map((i) => i.toLowerCase()) : items }
  }
  const text = typeof raw === 'string' ? raw : raw.join(',')
  switch (spec.type) {
    case 'boolean': {
      const word = text.trim().toLowerCase()
      if (TRUE_WORDS.includes(word)) return { value: true }
      if (FALSE_WORDS.includes(word)) return { value: false }
      return { error: `${spec.key} is on or off (also true/false, yes/no, 1/0), not '${text}'.` }
    }
    case 'enum': {
      const stored = enumStored(spec, text)
      if (stored !== undefined) return { value: stored }
      return { error: `'${text}' is not a choice for ${spec.key}. Choose one of: ${spec.values?.join(', ')}.` }
    }
    case 'integer': {
      const word = text.trim()
      if (!/^-?\d+$/.test(word)) return { error: `${spec.key} is a whole number, not '${text}'.` }
      const value = Number(word)
      const range = spec.min !== undefined && spec.max !== undefined ? ` (between ${spec.min} and ${spec.max})` : ''
      if (spec.min !== undefined && value < spec.min) return { error: `${spec.key} must be at least ${spec.min}${range}.` }
      if (spec.max !== undefined && value > spec.max) return { error: `${spec.key} must be at most ${spec.max}${range}.` }
      return { value }
    }
    case 'icon': {
      const icon = repoIcon(text.trim())
      return icon ? { value: icon } : { error: `${spec.key} is emoji:<emoji> or lucide:<name> (an image comes from --file).` }
    }
    case 'text':
      return { value: text }
    default: {
      if (/[\r\n]/.test(text)) return { error: `${spec.key} is one line of text.` }
      const value = text.trim()
      // A name can't be blank: updateRepo would quietly keep the old one.
      if (!value && (spec.field === 'name' || spec.field === 'defaultBranch')) return { error: `${spec.key} can't be empty.` }
      return { value }
    }
  }
}

// ---- value to patch ----

/** What setRepoIntegrationOptions takes from the command line. */
export interface RepoIntegrationOptions {
  rules?: 'mine' | 'off'
  allowOwnMcp?: RepoIntegrationService[]
  starts?: Partial<Record<RepoIntegrationService, 'default' | 'on' | 'off'>>
}

/** What to call to write one value (see RepoTarget). */
export type RepoSettingWrite =
  | { kind: 'local'; patch: RepoSettingsPatch }
  | { kind: 'repo'; patch: RepoPatch }
  | { kind: 'integration'; service: RepoIntegrationService; choice: string }
  | { kind: 'integrationOptions'; options: RepoIntegrationOptions }
  | { kind: 'envFiles'; files: string[] }

/**
 * The write for one value. `null` unsets: only this computer's layer (`local`) can inherit again; the others hold a
 * value of their own, so asking is an error that says what to do instead.
 */
export function repoSettingPatch(spec: RepoSettingSpec, value: unknown | null): RepoSettingWrite | { error: string } {
  if (value === null && spec.target !== 'local') {
    return { error: `${spec.key} has no inherited value to go back to; set it to a value instead${spec.type === 'list' ? ' (an empty list clears it)' : ''}.` }
  }
  switch (spec.target) {
    case 'local': {
      if (spec.field.startsWith('prompts.')) return { kind: 'local', patch: { prompts: { [spec.field.slice('prompts.'.length)]: value } } as RepoSettingsPatch }
      return { kind: 'local', patch: { [spec.field]: value } as RepoSettingsPatch }
    }
    case 'repo':
      return { kind: 'repo', patch: { [spec.field]: value } as RepoPatch }
    case 'repoCloud':
      return { kind: 'repo', patch: { cloud: { [spec.field.slice('cloud.'.length)]: value } } as RepoPatch }
    case 'integration':
      return { kind: 'integration', service: spec.field.slice('integrations.'.length) as RepoIntegrationService, choice: String(value) }
    case 'integrationOptions': {
      if (spec.field.startsWith('integrations.starts.')) return { kind: 'integrationOptions', options: { starts: { [spec.field.slice('integrations.starts.'.length)]: value as 'default' | 'on' | 'off' } } }
      return { kind: 'integrationOptions', options: spec.field === 'integrations.rules' ? { rules: value as 'mine' | 'off' } : { allowOwnMcp: value as RepoIntegrationService[] } }
    }
    case 'envFiles':
      return { kind: 'envFiles', files: value as string[] }
  }
}

// ---- value to text ----

/** A value as the command line prints it. */
export function displayRepoValue(spec: RepoSettingSpec, value: unknown): string {
  switch (spec.type) {
    case 'boolean':
      return value ? 'on' : 'off'
    case 'list': {
      const items = Array.isArray(value) ? (value as unknown[]) : []
      return items.length ? items.join(', ') : '(none)'
    }
    case 'urls': {
      const urls = Array.isArray(value) ? (value as PreviewUrl[]) : []
      return urls.length ? urls.map((u) => (u.name ? `${u.name}=${u.url}` : u.url)).join(', ') : '(none)'
    }
    case 'icon': {
      const icon = value as RepoIcon | undefined
      return !icon ? '(none)' : icon.kind === 'emoji' ? `emoji:${icon.value}` : icon.kind === 'lucide' ? `lucide:${icon.name}` : 'image'
    }
    case 'text':
    case 'string':
      return value === '' || value === undefined ? '(empty)' : String(value)
    default:
      return String(value)
  }
}

/** What a key takes, for help and `repo settings list`. */
export function describeRepoSpec(spec: RepoSettingSpec): string {
  const base = (() => {
    switch (spec.type) {
      case 'boolean':
        return 'on | off'
      case 'enum':
        return spec.values?.join(' | ') ?? 'choice'
      case 'integer':
        return spec.min !== undefined && spec.max !== undefined ? `integer ${spec.min}-${spec.max}` : 'integer'
      case 'list':
        return spec.itemValues ? `list of ${spec.itemValues.join(', ')}` : 'list (a,b,c)'
      case 'urls':
        return 'list of name=url'
      case 'icon':
        return 'emoji:<emoji> | lucide:<name>'
      case 'text':
        return 'text (--file or --stdin)'
      default:
        return 'text'
    }
  })()
  return spec.hint ? `${base}. ${spec.hint}` : base
}
