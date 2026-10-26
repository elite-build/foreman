// A workspace's identity is its UUID; `path` is only the local worktree binding and is
// absent while the workspace is history only (imported, no worktree on this machine).
// A cloud workspace has no `path` either, but it is live: its worktree is in a sandbox
// (`cloud`). wsPath still throws for it, so code not yet taught about the cloud fails closed.
import type { Workspace } from './types'

export const HISTORY_ONLY_REASON = 'This workspace is history only: there is no worktree on this machine.'
export const CLOUD_NO_FOLDER_REASON = 'This is a cloud workspace: its worktree is in a sandbox, not a folder on this machine.'

type Binding = Pick<Workspace, 'path' | 'state'> & Partial<Pick<Workspace, 'cloud'>>

/** The worktree lives in a cloud sandbox, not a folder here. */
export function isCloud(ws: Partial<Pick<Workspace, 'cloud'>>): ws is { cloud: NonNullable<Workspace['cloud']> } {
  return Boolean(ws.cloud)
}

export function isHistoryOnly(ws: Binding): boolean {
  return ws.state === 'history' || (!ws.path && !isCloud(ws))
}

/**
 * Only the chats are shown: history only, or archived and opened read-only (#13). Nothing
 * else is touched for it: no git, diff, editor, terminal, setup log or watcher call.
 */
export function chatsOnly(ws: Binding): boolean {
  return isHistoryOnly(ws) || ws.state === 'archived'
}

/** The worktree folder, or a clear error for a history-only (or cloud) workspace. */
export function wsPath(ws: Pick<Workspace, 'path'> & Partial<Pick<Workspace, 'cloud'>>): string {
  if (!ws.path) throw new Error(isCloud(ws) ? CLOUD_NO_FOLDER_REASON : HISTORY_ONLY_REASON)
  return ws.path
}

/** A tab that can never send: history-only or archived workspace, or a tab imported as history. */
export function sessionReadOnly(ws: Binding, session: { importedMode?: string }): boolean {
  return chatsOnly(ws) || session.importedMode === 'history'
}
