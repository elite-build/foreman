// Image before/after in the diff (#19, G3): which sides a changed picture has,
// and the swipe's split. The before side is the file at the branch point (read
// from git), the after side the worktree's file. Pure, so it's tested without a DOM.
import { previewFormat } from './imageInfo'
import type { DiffFile } from './types'

export type ImageDiffMode = 'side' | 'swipe'

/**
 * The sides to show for a file in the workspace diff, or null when it isn't a picture the viewer reads
 * (or the diff has no branch point to read the before side from). An added file has only after,
 * a deleted one only before; a rename reads its before side under the old name.
 */
export function imageDiffSides(file: Pick<DiffFile, 'path' | 'oldPath' | 'status'>, mergeBase: string | undefined): { before?: string; after?: string } | null {
  if (!previewFormat(file.path) && !(file.oldPath && previewFormat(file.oldPath))) return null
  const before = file.status === 'added' || !mergeBase ? undefined : (file.oldPath ?? file.path)
  const after = file.status === 'deleted' ? undefined : file.path
  if (before && !previewFormat(before)) return after ? { after } : null
  if (after && !previewFormat(after)) return before ? { before } : null
  return before || after ? { ...(before ? { before } : {}), ...(after ? { after } : {}) } : null
}

/** The swipe handle's position as a whole percent, 0–100 (the after picture shows right of it). */
export function swipePercent(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.round(Math.min(100, Math.max(0, value)))
}
