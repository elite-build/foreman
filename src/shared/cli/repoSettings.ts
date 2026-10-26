// Parameters and results of the `foreman repo …` settings methods. Every result has
// a `text` the command prints unless --json is given.
import type { AutoReviewShown, CheckConsentItem, Loadout, RepoMcpProposal } from '../types'
import type { RepoSettingType, RepoTab } from '../repoSettingsSchema'

/** Which of the layers a value came from; `repo` is a field of the repository itself (name, base branch, cloud …). */
export type RepoValueSource = 'local' | 'shared' | 'user' | 'default' | 'repo'

/** Every repository method says which repository: `repo` is a name, id or folder; without it, the one `cwd` is in. */
export interface RepoTarget {
  repo?: string
  cwd: string
}

export interface RepoSettingRow {
  key: string
  tab: RepoTab
  type: RepoSettingType
  value: string
  source: RepoValueSource
  // This computer overrides a value another layer has: what it would be without the override.
  inherited?: { source: Exclude<RepoValueSource, 'local' | 'repo'>; value: string }
  // Set when `source` is `user`: the Settings key the value comes from.
  userKey?: string
}

export interface RepoSettingsListParams extends RepoTarget {
  // Only what the committed .foreman/settings.toml sets.
  shared?: boolean
}

export interface RepoSettingsListResult {
  repo: { id: string; name: string }
  rows: RepoSettingRow[]
  // The committed settings file in use (or the one a new file would be), and whether it can be read.
  file: { path: string; exists: boolean; error?: string }
  text: string
}

export interface RepoSettingsGetParams extends RepoTarget {
  keys: string[]
}

export interface RepoSettingsGetResult {
  repo: { id: string; name: string }
  rows: RepoSettingRow[]
  text: string
}

export interface RepoSettingsSetParams extends RepoTarget {
  pairs: [string, string][]
}

export interface RepoSettingChange {
  key: string
  value: string
  was: string
  // Where the previous value came from.
  wasSource: RepoValueSource
  // This computer's value now overrides what another layer sets.
  overrides?: { source: 'shared' | 'user'; value: string }
  note?: string
}

export interface RepoSettingsSetResult {
  repo: { id: string; name: string }
  changes: RepoSettingChange[]
  text: string
}

export interface RepoSettingsUnsetParams extends RepoTarget {
  keys: string[]
}

export interface RepoSettingsUnsetResult {
  repo: { id: string; name: string }
  // The value each key has now that this computer no longer sets it.
  changes: { key: string; value: string; inherits: 'shared' | 'user' | 'default'; hadLocalValue: boolean }[]
  text: string
}

export interface RepoSettingsFileParams extends RepoTarget {
  open?: boolean
}

export interface RepoSettingsFileResult {
  repo: { id: string; name: string }
  path: string
  exists: boolean
  opened: boolean
  text: string
}

// ---- structured settings ----

export type StepsTarget = 'setup' | 'archive'

export interface RepoSetupParams extends RepoTarget {
  verb: 'list' | 'add' | 'remove' | 'move' | 'clear' | 'inherit'
  target: StepsTarget
  // add: the step. remove: its name, or the number from `list` in `name`.
  name?: string
  command?: string
  timeoutSec?: number
  parallel?: boolean
  // add: the position (from 1) to insert at; default the end.
  at?: number
  // move: positions from 1.
  from?: number
  to?: number
}

export interface RepoStepRow {
  position: number
  name: string
  command: string
  timeoutSec?: number
  parallel?: boolean
}

export interface RepoSetupResult {
  repo: { id: string; name: string }
  target: StepsTarget
  steps: RepoStepRow[]
  // The layer the steps come from now.
  source: 'local' | 'shared' | 'default'
  text: string
}

export interface RepoScriptsParams extends RepoTarget {
  verb: 'list' | 'add' | 'remove' | 'set-default'
  name?: string
  command?: string
  icon?: string
  default?: boolean
  hidden?: boolean
  previewUrl?: string
}

export interface RepoScriptRow {
  name: string
  command: string
  icon: string
  default: boolean
  hidden: boolean
  previewUrl?: string
  source: 'local' | 'shared'
  overrides?: boolean
}

export interface RepoScriptsResult {
  repo: { id: string; name: string }
  scripts: RepoScriptRow[]
  text: string
}

export interface RepoChecksParams extends RepoTarget {
  verb: 'list' | 'add' | 'remove'
  name?: string
  command?: string
}

export interface RepoCheckRow {
  name: string
  command: string
  source: 'local' | 'shared'
  overrides?: boolean
}

export interface RepoChecksResult {
  repo: { id: string; name: string }
  checks: RepoCheckRow[]
  text: string
}

export interface ChecksApproveParams {
  cwd: string
  // A workspace's name, id or branch; default the one `cwd` is in.
  workspace?: string
  // The hashes of the commands the user was shown. Without them: only list.
  hashes?: string[]
}

export interface ChecksApproveItem {
  name: string
  command: string
  hash: string
  source: 'local' | 'shared'
  // Undefined when the app can't say.
  approved?: boolean
}

export interface ChecksApproveResult {
  workspace: { id: string; name: string }
  items: ChecksApproveItem[]
  // With hashes: the checks were approved and started; else what still needs approval.
  started?: boolean
  consent?: CheckConsentItem[]
  text: string
}

export interface RepoMcpParams {
  // A workspace's name, id or branch (the proposals are read as that workspace has them); default the one `cwd` is in.
  workspace?: string
  cwd: string
  // Names to approve, as they were shown. Every other proposal is left unapproved.
  approve?: string[]
  // Name → fingerprint, from the list the user read.
  shown?: Record<string, string>
}

export interface RepoMcpRow {
  name: string
  command: string
  state: RepoMcpProposal['state']
  fingerprint: string
  env: string[]
  scopes: string[]
  missingEnv: string[]
  scripts: string[]
}

export interface RepoMcpResult {
  workspace: { id: string; name: string }
  proposals: RepoMcpRow[]
  file?: string
  approved?: string[]
  text: string
}

export interface RepoAutoReviewParams extends RepoTarget {
  verb: 'status' | 'on' | 'off'
  reviewer?: Pick<Loadout, 'agent' | 'model'> & Partial<Pick<Loadout, 'effort' | 'fast'>>
  exclusions?: string[]
  // What the user read: the preview this method returned.
  shown?: AutoReviewShown
}

export interface RepoAutoReviewResult {
  repo: { id: string; name: string }
  enabled: boolean
  // `on` without `shown`: the preview to read, and nothing is changed until it comes back as `shown`.
  needsConfirmation?: boolean
  preview?: AutoReviewShown
  // status: what is on now.
  current?: { reviewer: Loadout; exclusions: string[]; paused?: string }
  text: string
}

export interface RepoIntegrationRow {
  service: string
  // 'default', 'off' or a connection id.
  choice: string
  // The connection it resolves to, or why there is none.
  using: string
  default?: string
  problem?: string
}

export interface RepoIntegrationsResult {
  repo: { id: string; name: string }
  rows: RepoIntegrationRow[]
  text: string
}
