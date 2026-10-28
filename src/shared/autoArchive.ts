// Auto-archive: a workspace archived on its own after its scheduled run completed (the Schedule dialog's "After each
// run") or after its pull request was merged (Settings → Git → Archive on merge), and the cleanup that later deletes
// such workspaces (Settings → Git → Delete auto-archived workspaces after). Pure and shared: the main process decides
// what to archive and delete with these, and the Archived list filters and labels its rows with them.
import type { ArchiveReason, PullRequestInfo, Workspace } from './types'

/** "Delete auto-archived workspaces after", in days; 0 is never. */
export const ARCHIVE_CLEANUP_DAYS = [0, 7, 30, 90] as const

const DAY_MS = 24 * 60 * 60_000

/** Why it was archived. Workspaces archived before reasons were kept were archived by hand. */
export function archiveReason(ws: Pick<Workspace, 'archiveReason'>): ArchiveReason {
  return ws.archiveReason ?? { kind: 'manual' }
}

/** Archived by Foreman (a completed run, a merged pull request) rather than by hand. */
export function autoArchived(ws: Pick<Workspace, 'archiveReason'>): boolean {
  return archiveReason(ws).kind !== 'manual'
}

/**
 * When the cleanup deletes this workspace (epoch ms), or null when it never will: archived by hand, kept, a remote
 * workspace (its sandbox is the only copy), or the cleanup is off. Unpushed work is checked when the time comes.
 */
export function cleanupAt(ws: Workspace, days: number): number | null {
  if (days <= 0 || ws.state !== 'archived' || !autoArchived(ws) || ws.keepArchived || ws.cloud || !ws.archivedAt) return null
  const at = Date.parse(ws.archivedAt)
  return Number.isNaN(at) ? null : at + days * DAY_MS
}

export function cleanupDue(ws: Workspace, days: number, now: number): boolean {
  const at = cleanupAt(ws, days)
  return at !== null && at <= now
}

/** The pull request went from open to merged on this lookup: merged in Foreman, on GitHub or on GitLab. */
export function mergedNow(previous: PullRequestInfo['state'] | undefined, next: PullRequestInfo['state'] | undefined): boolean {
  return previous === 'OPEN' && next === 'MERGED'
}

/** The Archived list's filter: everything, what Foreman archived on its own, merged pull requests, completed runs, or by hand. */
export type ArchivedFilter = 'all' | 'auto' | 'merged' | 'run' | 'manual'

export const ARCHIVED_FILTERS: readonly ArchivedFilter[] = ['all', 'auto', 'merged', 'run', 'manual']

export function matchesArchivedFilter(ws: Pick<Workspace, 'archiveReason'>, filter: ArchivedFilter): boolean {
  const kind = archiveReason(ws).kind
  if (filter === 'all') return true
  if (filter === 'auto') return kind !== 'manual'
  return kind === filter
}
