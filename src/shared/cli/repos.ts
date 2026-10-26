// Parameters and results of the repository methods and `attention`. Each result
// has a `text` the command prints unless --json is given. The settings sub-nouns (`repo settings`, `repo checks`, …) are
// in repoSettings.ts.
import type { AccountDetection, BranchInfo, WorktreeInfo } from '../types'

export interface RepoRef {
  id: string
  name: string
}

/** `repo` is a name, id or folder; without it, the repository the command runs in. */
export interface RepoQuery {
  repo?: string
  cwd?: string
}

export interface RepoRow {
  name: string
  id: string
  path: string
  defaultBranch: string
  remote: string
  hasOrigin: boolean
  // The GitHub connection it uses (by name), when it has one.
  account?: string
  cloud: boolean
}

export interface ReposListResult {
  repos: RepoRow[]
  text: string
}

export interface RepoAddParams {
  path: string
  cwd?: string
}

export interface RepoCloneParams {
  url: string
  into?: string
  account?: string
  cwd?: string
}

export interface RepoInitParams {
  name: string
  into?: string
  cwd?: string
}

export interface RepoAddedResult {
  repo: RepoRef & { path: string }
  text: string
}

export interface RepoRemoveParams extends RepoQuery {
  repo: string
  confirmed?: boolean
}

export interface RepoRemoveResult {
  repo: RepoRef
  // What goes with it: every workspace of the repository (live and archived), by name.
  workspaces: { name: string; branch: string; state: string; running?: boolean }[]
  needsConfirmation?: boolean
  removed?: boolean
  previewText?: string
  text: string
}

export interface RepoShowResult {
  repo: RepoRef & {
    path: string
    defaultBranch: string
    remote: string
    hasOrigin: boolean
    remoteUrl?: string
    rootCommit?: string
    createdAt: string
  }
  account?: string
  workspaces: { live: number; archived: number }
  // How many of the repository's settings each layer supplies.
  settings?: { local: number; shared: number; user: number; sharedFile?: string; sharedError?: string }
  templates?: number
  cloud: { enabled: boolean; provider: string; vcpus: number; region: string; idleMinutes: number; build?: string }
  integrations: Record<string, string>
  text: string
}

export interface RepoBranchesParams extends RepoQuery {
  fetch?: boolean
}

export interface RepoBranchesResult {
  repo: RepoRef
  branches: BranchInfo[]
  text: string
}

export interface RepoRemotesResult {
  repo: RepoRef
  remotes: string[]
  // The one Foreman pushes to and opens pull requests against.
  remote: string
  text: string
}

export interface RepoWorktreesResult {
  repo: RepoRef
  worktrees: WorktreeInfo[]
  text: string
}

export interface RepoAccountParams extends RepoQuery {
  detect?: boolean
  save?: boolean
}

export interface RepoAccountResult {
  repo: RepoRef
  account?: string
  detection?: AccountDetection
  saved?: boolean
  text: string
}

export interface RepoFilesParams extends RepoQuery {
  patterns?: string[]
}

export interface RepoFilesResult {
  repo: RepoRef
  files: string[]
  patterns: string[]
  fromWorktreeInclude: boolean
  text: string
}

export type AttentionVerb = 'list' | 'seen'

export interface AttentionParams {
  verb?: AttentionVerb
}

export interface AttentionRow {
  id: string
  at: string
  firstAt: string
  kind: string
  workspace: string
  workspaceId: string
  label?: string
  detail?: string
  count: number
  // Newer than the last "mark all seen".
  unseen: boolean
}

export interface AttentionResult {
  verb: AttentionVerb
  events: AttentionRow[]
  seenAt?: string
  text: string
}
