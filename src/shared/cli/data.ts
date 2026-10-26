// Parameters and results of the backup, Git backup, data and usage methods.
// Each result has a `text` the command prints unless --json is given. A remote's user name and password never appear in a result.
import type { GitBackupRestoreResult } from '../gitBackup'

export interface BackupNowResult {
  path: string
  manifest: string
  attachments: number
  missingAttachments: number
  at: string
  text: string
}

export interface BackupStatusResult {
  // The database file and the folder backups go to.
  path: string
  backupFolder: string
  sizeBytes: number
  messages: number
  lastBackup?: { at: string; path: string }
  // Files from before the database that are still on disk.
  legacy: { files: number; bytes: number }
  text: string
}

export interface DataInfoResult extends BackupStatusResult {
  dataFolder: string
  claudeTranscripts: { sessions: number; errors: number; partial?: number }
  // How the move into the database went the first time (absent on a fresh install).
  migration?: { status: 'migrated' | 'fresh'; at: string; malformed: number; warnings: string[] }
}

export interface GitBackupConfigView {
  // The remote with any user name and password taken out.
  remote: string
  account?: string
  daily: boolean
}

export interface GitBackupStatusResult {
  configured: boolean
  config?: GitBackupConfigView
  lastSuccessAt?: string
  lastAttemptAt?: string
  lastError?: string
  text: string
}

export interface GitBackupConfigureParams {
  remote: string
  // A signed-in gh account for github.com remotes.
  account?: string
  // Back up once a day while Foreman is open. Default: as it is now (off for a first setup).
  daily?: boolean
}

export interface GitBackupCreateRepoParams {
  name: string
  account?: string
}

export interface GitBackupNowResult {
  changed: boolean
  at: string
  remote: string
  text: string
}

export interface GitBackupRemoteParams {
  remote: string
  account?: string
}

export interface GitBackupPreviewResult {
  stageId: string
  createdAt: string
  // Settings that differ here from the backup's, template changes, repositories and workspaces, and what to look at before restoring.
  settingsChanged: string[]
  templates: { id: string; name: string; action: 'add' | 'update' | 'same' }[]
  repositories: { name: string; folder?: string; matched: boolean }[]
  workspaces: { name: string; branch: string; alreadyAdded: boolean; folder?: string }[]
  machinePaths: { key: string; saved: string; available: boolean }[]
  variableChecklist: { scope: string; name: string; present: boolean }[]
  unavailableAccounts: string[]
  text: string
}

export type GitBackupCategory = 'settings' | 'templates' | 'repositories' | 'workspaces'

export interface GitBackupRestoreParams extends GitBackupRemoteParams {
  // Default: all four.
  categories?: GitBackupCategory[]
  // Restore the preview with this id (the one the user was shown). Without it a fresh one is made first.
  stageId?: string
  // Without this the preview comes back and nothing is restored.
  confirmed?: boolean
}

export interface GitBackupRestoreCliResult {
  restored: boolean
  needsConfirmation?: boolean
  preview?: GitBackupPreviewResult
  result?: GitBackupRestoreResult
  text: string
}

export interface DeleteLegacyResult {
  files: number
  bytes: number
  text: string
}

export interface UsageParams {
  // The last 7, 30 or 90 days (any whole number of days up to a year). Default 30.
  days?: number
}

export interface UsageRowOut {
  // The repository's or model's name.
  name: string
  turns: number
  agentMs: number
  // Null when no turn reported a cost; with `partial` a lower bound.
  costUsd: number | null
  partial: boolean
}

export interface UsageResult {
  days: number
  since: string
  total: UsageRowOut
  byRepo: UsageRowOut[]
  byModel: (UsageRowOut & { agent: string; model: string })[]
  text: string
}
