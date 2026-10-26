// What one turn changed: the diff between the checkpoints saved when it
// started and when it ended (see checkpoints.ts). A missing checkpoint means
// "unknown", never "nothing changed".
import { randomUUID } from 'node:crypto'
import { sensitiveMatches } from '../shared/sensitive'
import type { SensitiveAlert, TurnDelta } from '../shared/types'
import { CHECKPOINT_REF_PREFIX } from './checkpoints'
import { git, revParse, type GitTarget } from './git'

export const startCheckpointId = (sessionId: string, turnId: string) => `${sessionId}-${turnId}-start`
export const endCheckpointId = (sessionId: string, turnId: string) => `${sessionId}-${turnId}-end`

/** Files and +/- counts between two checkpoints, or 'unavailable' if either is missing or the diff fails. */
export async function checkpointDelta(dir: GitTarget, startId: string, endId: string): Promise<TurnDelta | 'unavailable'> {
  try {
    const [start, end] = await Promise.all([revParse(dir, CHECKPOINT_REF_PREFIX + startId), revParse(dir, CHECKPOINT_REF_PREFIX + endId)])
    if (!start || !end) return 'unavailable'
    const { stdout, code } = await git(dir, ['diff', '--numstat', '-z', '--no-renames', start, end], { allowFail: true })
    if (code !== 0) return 'unavailable'
    const files: TurnDelta['files'] = []
    for (const entry of stdout.split('\0').filter(Boolean)) {
      const [added, deleted, ...rest] = entry.split('\t')
      // Binary files report "-" for both counts.
      files.push({ path: rest.join('\t'), additions: Number(added) || 0, deletions: Number(deleted) || 0 })
    }
    return {
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0)
    }
  } catch {
    return 'unavailable'
  }
}

export function turnDelta(dir: GitTarget, sessionId: string, turnId: string): Promise<TurnDelta | 'unavailable'> {
  return checkpointDelta(dir, startCheckpointId(sessionId, turnId), endCheckpointId(sessionId, turnId))
}

/**
 * The alert for a finished turn, or null when no sensitive file changed. It
 * compares the whole worktree between the turn's checkpoints (other tabs and the
 * user's own edits included), so it counts net changes only. A missing checkpoint
 * gives an "unavailable" alert, never a clean result. No globs, no alert.
 */
export async function sensitiveAlert(
  dir: GitTarget,
  sessionId: string,
  turnId: string,
  globs: string[],
  known?: TurnDelta | 'unavailable'
): Promise<SensitiveAlert | null> {
  if (!globs.some((g) => g.trim())) return null
  const delta = known ?? (await turnDelta(dir, sessionId, turnId))
  const base = {
    id: randomUUID(),
    sessionId,
    turnId,
    startRef: CHECKPOINT_REF_PREFIX + startCheckpointId(sessionId, turnId),
    endRef: CHECKPOINT_REF_PREFIX + endCheckpointId(sessionId, turnId),
    at: new Date().toISOString()
  }
  if (delta === 'unavailable') return { ...base, files: [], unavailable: true }
  const files = sensitiveMatches(delta.files.map((f) => f.path), globs)
  return files.length ? { ...base, files } : null
}
