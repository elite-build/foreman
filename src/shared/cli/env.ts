// Parameters and results of the environment, key and token methods. Nothing a result
// holds is a secret except `env-reveal` and `keys-reveal`, which exist to print one; every other result shows
// names, origins and at most the last four characters.
import type { EnvFileInfo, EnvVarRow } from '../types'

/** Without `repo` the user's own variables; with it, that repository's (a name, id, folder, or `.` for the one `cwd` is in). */
export interface EnvTarget {
  repo?: string
  cwd: string
}

export interface EnvScopeInfo {
  kind: 'user' | 'repo'
  // The repository's name; absent for the user's.
  repo?: { id: string; name: string }
}

export interface EnvListResult {
  scope: EnvScopeInfo
  vars: EnvVarRow[]
  files: EnvFileInfo[]
  // A repository's committed layer and the user's variables underneath it.
  shared?: EnvVarRow[]
  inherited?: EnvVarRow[]
  text: string
}

export interface EnvSetParams extends EnvTarget {
  key: string
  // Stored as given; never echoed back.
  value: string
}

export interface EnvSetResult {
  scope: EnvScopeInfo
  key: string
  // The last four characters, when the value is long enough that they say little.
  hint?: string
  text: string
}

export interface EnvUnsetParams extends EnvTarget {
  keys: string[]
}

export interface EnvUnsetResult {
  scope: EnvScopeInfo
  removed: string[]
  text: string
}

export interface EnvRenameParams extends EnvTarget {
  from: string
  to: string
}

export interface EnvRenameResult {
  scope: EnvScopeInfo
  from: string
  to: string
  text: string
}

export interface EnvFilesParams extends EnvTarget {
  verb: 'list' | 'add' | 'remove'
  path?: string
}

export interface EnvFilesResult {
  scope: EnvScopeInfo
  files: { path: string; resolved?: string; count?: number; error?: string }[]
  text: string
}

export interface EnvImportParams extends EnvTarget {
  // [name, value] pairs the command read from a .env file.
  entries: [string, string][]
  dryRun?: boolean
}

export interface EnvImportResult {
  scope: EnvScopeInfo
  // Each name and whether it is new or replaces a saved value; never the values.
  names: { key: string; status: 'new' | 'replaces' }[]
  saved: boolean
  text: string
}

export interface EnvRevealParams extends EnvTarget {
  key: string
  layer?: 'own' | 'shared' | 'inherited'
}

export interface EnvRevealResult {
  key: string
  value: string
  text: string
}

// ---- provider keys ----

export interface KeyRow {
  envVar: string
  label: string
  // Saved in Foreman; or only found in the shell Foreman started from (it can be imported).
  saved: boolean
  inShell: boolean
  // The last four characters ('' when too short). Left out for a request from inside an agent turn.
  hint?: string
  // The agents that get this key (OpenCode always does).
  agents: string[]
}

export interface KeysListResult {
  keys: KeyRow[]
  text: string
}

export interface KeysSetParams {
  envVar: string
  value?: string
  // Copy it from the shell Foreman started from.
  fromShell?: boolean
}

export interface KeysSetResult {
  envVar: string
  hint?: string
  text: string
}

export interface KeysRemoveParams {
  envVar: string
}

export interface KeysAgentsParams {
  envVar: string
  agents: string[]
}

export interface KeysAgentsResult {
  envVar: string
  agents: string[]
  text: string
}

export interface KeysRevealParams {
  envVar: string
}

// ---- GitHub, GitLab, the cloud setup token, an agent's own key ----

export interface GithubStatusResult {
  installed: boolean
  loggedIn: boolean
  user?: string
  method: 'cli' | 'token'
  tokenSaved: boolean
  detail?: string
  text: string
}

export interface GithubTokenSetParams {
  token: string
}

export interface TokenSavedResult {
  hint?: string
  saved: boolean
  text: string
}

export interface GithubAccountsResult {
  accounts: { login: string; active: boolean }[]
  text: string
}

export interface GitlabListResult {
  hosts: { host: string; url: string; selfManaged: boolean; tokenSaved: boolean; repos: string[] }[]
  // The glab command is installed, so `gitlab add --from-glab` can work.
  glab: boolean
  text: string
}

export interface GitlabAddParams {
  url: string
  token?: string
  // Use the token glab already has for this host.
  fromGlab?: boolean
}

export interface GitlabConnectionResult {
  ok: boolean
  version?: string
  user?: string
  error?: string
  text: string
}

export interface GitlabRemoveParams {
  host: string
}

export interface GitlabTestParams {
  url: string
  // Test this token instead of the saved one.
  token?: string
}

export interface CloudTokenStatusResult {
  saved: boolean
  hint?: string
  savedAt?: string
  text: string
}

export interface CloudTokenSetParams {
  token: string
}

export interface AgentKeySetParams {
  agent: string
  value?: string
  fromShell?: boolean
  remove?: boolean
}

export interface AgentKeySetResult {
  agent: string
  hint?: string
  text: string
}
