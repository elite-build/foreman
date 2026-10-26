// "Viewed" marks on files in Changes. A mark belongs to one version of one file:
// it is keyed by (path, blobId, mergeBase), so editing the file or moving the
// branch point clears it without anyone having to unmark.
import type { ViewedMark } from './types'

interface FileVersion {
  path: string
  blobId?: string
}

export function isViewed(marks: ViewedMark[] | undefined, file: FileVersion, mergeBase: string | undefined): boolean {
  if (!file.blobId || !mergeBase) return false
  return Boolean(marks?.some((m) => m.path === file.path && m.blobId === file.blobId && m.mergeBase === mergeBase))
}

/** Marks with this file's mark replaced (or removed). */
export function withMark(marks: ViewedMark[] | undefined, mark: ViewedMark, viewed: boolean): ViewedMark[] {
  const rest = (marks ?? []).filter((m) => m.path !== mark.path)
  return viewed ? [...rest, mark] : rest
}

/** Only the marks that still match a file in the diff as it is now. */
export function pruneViewed(marks: ViewedMark[] | undefined, files: FileVersion[], mergeBase: string): ViewedMark[] {
  return (marks ?? []).filter((m) => m.mergeBase === mergeBase && files.some((f) => f.path === m.path && f.blobId === m.blobId))
}

/** "n of m viewed". */
export function viewedCount(marks: ViewedMark[] | undefined, files: FileVersion[], mergeBase: string | undefined): { viewed: number; total: number } {
  return { viewed: files.filter((f) => isViewed(marks, f, mergeBase)).length, total: files.length }
}
