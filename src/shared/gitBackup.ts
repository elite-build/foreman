import type { PromptTemplate, RepoIcon, RepoLocalSettings, Settings, WorkspaceStatus } from './types'

export const GIT_BACKUP_FOLDER = 'foreman-backup'
export const GIT_BACKUP_VERSION = 1

export interface GitBackupConfig {
  remoteUrl: string
  /** A signed-in gh account for github.com remotes; other remotes use Git's credentials. */
  account?: string
  daily: boolean
}

export interface GitBackupStatus {
  config?: GitBackupConfig
  lastSuccessAt?: string
  lastError?: string
  lastAttemptAt?: string
}

export interface GitBackupRepo {
  id: string
  name: string
  rootPath: string
  remoteUrl?: string
  rootCommit?: string
  defaultBranch: string
  remote: string
  local: RepoLocalSettings
  icon?: RepoIcon
  githubAccount?: string
  integrations?: import('./integrations').RepoIntegrations
}

export interface GitBackupWorkspace {
  id: string
  repoId: string
  name: string
  branch: string
  baseBranch: string
  path: string
  direct?: boolean
  pinned?: boolean
  status?: WorkspaceStatus
}

export interface GitBackupFiles {
  manifest: { format: 'foreman-git-backup'; version: number; createdAt: string }
  settings: Omit<Settings, 'promptTemplates'>
  templates: PromptTemplate[]
  repositories: GitBackupRepo[]
  workspaces: GitBackupWorkspace[]
  variableNames: { user: string[]; repos: Record<string, string[]> }
}

export interface GitBackupPreview {
  stageId: string
  createdAt: string
  settingsChanged: string[]
  machinePaths: { key: string; saved: string; available: boolean }[]
  templates: { id: string; name: string; action: 'add' | 'update' | 'same' }[]
  repositories: (GitBackupRepo & { suggestedPath?: string; matchedRepoId?: string })[]
  workspaces: (GitBackupWorkspace & { suggestedPath?: string; alreadyAdded: boolean })[]
  variableNames: GitBackupFiles['variableNames']
  variableChecklist: { scope: string; name: string; present: boolean }[]
  unavailableAccounts: string[]
}

export interface GitBackupRestoreChoice {
  stageId: string
  categories: { settings: boolean; templates: boolean; repositories: boolean; workspaces: boolean }
  repositoryPaths: Record<string, string>
  workspacePaths: Record<string, string>
}

export interface GitBackupRestoreResult {
  settings: number
  templates: number
  repositories: number
  workspaces: number
  skipped: string[]
}

export interface GitBackupRunResult {
  changed: boolean
  at: string
  remoteUrl: string
}
