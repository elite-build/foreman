// Cues (O9), main side: the repo's shared commands with this computer's approvals, approving
// one, and what a command's terminal tab starts with. Approvals are the checks' list
// (state.checkApprovals, command hashes per repository), so approving a command in either
// place counts for both, and a changed text asks again.
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { commandBanner, commandInput, findCommand, needsApproval, repoCommandList, type SavedCommand } from '../shared/savedCommands'
import type { TFunction } from '../shared/i18n'
import type { CheckConsentItem, Repo } from '../shared/types'
import { commandHash } from './checks'
import { readSharedLayer } from './repoSettings'
import type { PersistedState } from './store'

type ApprovalState = Pick<PersistedState, 'checkApprovals' | 'commandApprovedText'>

/** Whether this computer approved this exact text for the repository (here or as a check). */
export function isApproved(state: ApprovalState, repoId: string, command: string): boolean {
  return (state.checkApprovals?.[repoId] ?? []).includes(commandHash(command))
}

/** The repository's commands from its .foreman/settings.toml, each marked approved or not. `maxAgeMs` as for readSharedLayer. */
export function repoCommands(state: ApprovalState, repo: Pick<Repo, 'id' | 'rootPath'>, options: { maxAgeMs?: number } = {}): SavedCommand[] {
  return repoCommandList(repo.id, readSharedLayer(repo.rootPath, options).commands ?? [], (command) => isApproved(state, repo.id, command))
}

/** What the approval dialog shows: the command, and the text approved before under this name when it changed. */
export function consentItem(state: ApprovalState, c: SavedCommand): CheckConsentItem {
  const previous = c.repoId ? state.commandApprovedText?.[c.repoId]?.[c.name] : undefined
  return { name: c.name, command: c.command, previous: previous !== undefined && previous !== c.command ? previous : undefined, source: 'shared' }
}

/** Approve a repo command's current text. Added to the checks' approvals, and remembered by name to show what changed next time. */
export function approveCommand(state: ApprovalState, c: SavedCommand): void {
  if (c.source !== 'repo' || !c.repoId) return
  const approvals = new Set(state.checkApprovals?.[c.repoId] ?? [])
  approvals.add(commandHash(c.command))
  state.checkApprovals = { ...state.checkApprovals, [c.repoId]: [...approvals] }
  state.commandApprovedText = { ...state.commandApprovedText, [c.repoId]: { ...state.commandApprovedText?.[c.repoId], [c.name]: c.command } }
}

/**
 * The command `id` as a workspace in `repoId` may run it now. Missing, or a repo command not approved
 * for its current text, is an error: nothing starts.
 */
export function runnableCommand(personal: SavedCommand[], fromRepo: SavedCommand[], repoId: string, id: string): SavedCommand {
  const c = findCommand(personal, fromRepo, repoId, id)
  if (!c) throw new Error('That command isn’t saved for this repository any more')
  if (!c.command.trim()) throw new Error('This command is empty')
  if (needsApproval(c)) throw new Error(`Approve “${c.name}” before it runs: it’s new or its text changed in the repo’s settings`)
  return c
}

export interface CommandLaunch {
  // The folder the shell starts in: the workspace, or the command's folder inside it.
  cwd: string
  // Typed into the shell once it's up.
  input: string
  // Dimmed lines written above the shell's first output.
  notice: string
}

/** How a command's tab starts: in the workspace (or its folder inside it), with the banner, then the command typed in. */
export function commandLaunch(c: SavedCommand, workspace: { name: string; path: string }, t: TFunction, exists: (dir: string) => boolean = isDir): CommandLaunch {
  const cwd = c.cwd ? path.join(workspace.path, ...c.cwd.split('/')) : workspace.path
  // Normalized when saved and parsed; checked again so a start folder can never leave the workspace.
  const relative = path.relative(workspace.path, cwd)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The command’s folder is outside the workspace')
  if (!exists(cwd)) throw new Error(`The folder ${c.cwd} isn’t in this workspace`)
  return { cwd, input: commandInput(c.command), notice: commandBanner(c, workspace.name, t) }
}

function isDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}
