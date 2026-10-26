// Parameters and results of the saved-command methods.
// Each result has a `text` the command prints unless --json is given.
import type { CommandScope } from '../savedCommands'

export interface CommandRow {
  id: string
  name: string
  command: string
  scope: CommandScope
  // The repository a repo-scoped command is for (its name), or the repository that shares it.
  repo?: string
  // A folder inside the workspace the command starts in.
  startIn?: string
  // Yours, or from the repository's .foreman/settings.toml (read-only, and it needs approval on this computer).
  source: 'personal' | 'repo'
  // Repository commands only: this computer approved the command's current text.
  approved?: boolean
}

export interface CommandsListParams {
  // Repository name, id or folder; otherwise the one the command ran in. With neither, every personal command is listed.
  repo?: string
  cwd: string
}

export interface CommandsListResult {
  commands: CommandRow[]
  // The repository the list is for, when there is one.
  repo?: string
  text: string
}

export interface CommandsAddParams {
  name: string
  command: string
  scope: CommandScope
  // Scope `repo`: the repository (otherwise the one the command ran in).
  repo?: string
  // Where the command ran.
  cwd: string
  // A folder inside the workspace to start in, relative to it.
  startIn?: string
}

export interface CommandsEditParams {
  // A command's id or name.
  id: string
  repo?: string
  cwd: string
  name?: string
  command?: string
  scope?: CommandScope
  startIn?: string
  clearStartIn?: boolean
}

export interface CommandsRemoveParams {
  id: string
  repo?: string
  cwd: string
}

export interface CommandChangeResult {
  command: CommandRow
  text: string
}

export interface CommandsRemoveResult {
  removed: CommandRow
  text: string
}

export interface CommandsApproveParams {
  // The workspace the command would run in (name, id, branch or "."), and where the command ran.
  workspace: string
  cwd: string
  // The repository command's id or name.
  id: string
  // The text the user was shown (the preview's `command`); the approval is refused when the repository's file no longer says this.
  shown?: string
  // Approve the current text without a preview (`--yes`).
  confirmed?: boolean
}

export interface CommandsApproveResult {
  command: CommandRow
  // False: nothing was approved (the preview, or it was approved already).
  approved: boolean
  needsConfirmation?: boolean
  // What approving covers: the command's text, and the text approved before under this name when it changed.
  shown?: string
  previous?: string
  text: string
}
