// Reading an archived workspace's chats without restoring it (#13). It goes through the
// history-only path (shared/workspacePath chatsOnly): the workspace view shows the chats and
// nothing else, so no worktree, setup, agent, git, terminal or watcher call is made for it.
// Pure, so the rules are tested without a DOM.
import type { ChatHit, NoteHit, PullRequestInfo, Session, Workspace } from '../../shared/types'

/** What the workspace view may load, start or offer for a workspace. */
export interface WorkspaceSurfaces {
  // Diff, git status, checks, editor, file viewer, compare, hand-off and new chats.
  worktree: boolean
  // The chat tabs are shown (and only read, unless the composer allows sending).
  chats: boolean
  // Archived and opened read-only: tabs are fixed, the composer is a banner, the side panel lists facts.
  archived: boolean
  setupLog: boolean
  terminal: boolean
  exportable: boolean
  // The worktree is a folder on this machine: the editor and Open in, the Files tab and file viewer,
  // spotlight, compare, hand-off and previews. (Checkpoints and Restore work in both: a cloud workspace's are in its sandbox.)
  local: boolean
  // The worktree is in a cloud sandbox: chats, Changes, commits, the git
  // panel, terminals and run scripts work through it (§8), and `local` is off.
  cloud: boolean
}

export function workspaceSurfaces(ws: Pick<Workspace, 'state'> & Partial<Pick<Workspace, 'cloud'>>): WorkspaceSurfaces {
  const archived = ws.state === 'archived'
  const worktree = ws.state !== 'creating' && ws.state !== 'error' && ws.state !== 'history' && !archived
  const cloud = Boolean(ws.cloud) && !archived
  return {
    worktree,
    chats: worktree || ws.state === 'history' || archived,
    archived,
    setupLog: !archived,
    terminal: !archived,
    exportable: !archived && !cloud,
    local: worktree && !cloud,
    cloud
  }
}

/** Where a search result opens: an archived workspace's chat opens read-only, never through restore. */
export function hitRoute(hit: Pick<ChatHit, 'archived' | 'closed'> | Pick<NoteHit, 'archived'>): 'read-only' | 'reopen' | 'open' {
  if (hit.archived) return 'read-only'
  return 'closed' in hit && hit.closed ? 'reopen' : 'open'
}

/**
 * The tabs an archived workspace shows: the ones open when it was archived, plus a closed one
 * being read (from a search result). Nothing is reopened; closing state stays as it was.
 */
export function archivedTabs(sessions: Session[], workspaceId: string, shown?: string): Session[] {
  return sessions.filter((s) => s.workspaceId === workspaceId && (!s.closedAt || s.id === shown))
}

/** What the side panel can say about an archived workspace without its worktree. */
export interface ArchivedFacts {
  archivedAt?: string
  branch: string
  // As last seen before archiving; not looked up again.
  pr?: { number: number; state: PullRequestInfo['state'] }
  openTabs: number
  closedTabs: number
  // The latest turn end across its chats; unknown when no turn ever finished.
  lastActivity?: string
  folder: ArchivedFolder
}

export function archivedFacts(ws: Workspace, sessions: Session[]): ArchivedFacts {
  const own = sessions.filter((s) => s.workspaceId === ws.id)
  const ends = own.map((s) => s.lastTurn?.endedAt).filter((at): at is string => Boolean(at))
  return {
    archivedAt: ws.archivedAt,
    branch: ws.branch,
    pr: ws.prInfo ? { number: ws.prInfo.number, state: ws.prInfo.state } : undefined,
    openTabs: own.filter((s) => !s.closedAt).length,
    closedTabs: own.filter((s) => s.closedAt).length,
    lastActivity: ends.sort().at(-1),
    folder: archivedFolder(ws)
  }
}

/**
 * What happened to the folder, which is also what Restore does: archive removes a worktree Foreman
 * made (restore recreates it from the branch), leaves a folder added from disk where it was (restore
 * uses it again), and a history-only workspace never had one here (restore leaves it history only).
 */
export type ArchivedFolder = 'removed' | 'left' | 'none'

export function archivedFolder(ws: Pick<Workspace, 'path' | 'adopted'>): ArchivedFolder {
  if (!ws.path) return 'none'
  return ws.adopted ? 'left' : 'removed'
}
