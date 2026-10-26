// Logic behind dropping a folder on the window to add it as a repository (O21), kept out of
// the component so it can be tested.
import type { DroppedFolder } from '../../../shared/types'

/**
 * Whether a drag may be carrying a folder. Mid-drag Chromium shows only each item's kind and
 * MIME type, never its name: a folder is a 'file' with no type. So is a file of unknown type,
 * which is let through too; main turns it down on drop.
 */
export function mightBeFolder(items: ArrayLike<{ kind: string; type: string }> | null | undefined): boolean {
  if (!items) return false
  return Array.from(items).some((item) => item.kind === 'file' && !item.type)
}

/**
 * Places that take their own drops, so the add-repo overlay stays out of their way: the composer (attachments)
 * and, G3, a terminal pane (a dropped path is typed into the shell there, as terminals do).
 */
export const OWN_DROP_SELECTOR = '.composer-box, .terminal, .term-restored'

/** G3: dropped paths as a terminal gets them: each quoted when it has a space or quote, separated by spaces. */
export function terminalDropText(paths: string[]): string {
  return paths
    .filter(Boolean)
    .map((p) => (/[\s"'&;()]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p))
    .join(' ')
}

export interface DropPlan {
  // Folders to list in the confirmation, in the order dropped. Two folders in one repo show once.
  shown: DroppedFolder[]
  // Repo top folders Add will add.
  addable: string[]
  // Dropped things that weren't folders (files, or gone by the time they were read).
  skipped: number
}

/** What the confirmation shows for what main found. */
export function dropPlan(found: DroppedFolder[]): DropPlan {
  const shown: DroppedFolder[] = []
  let skipped = 0
  for (const folder of found) {
    if (folder.kind === 'file' || folder.kind === 'missing') {
      skipped++
      continue
    }
    if (folder.root && shown.some((s) => s.root === folder.root)) continue
    shown.push(folder)
  }
  const addable = shown.filter((f) => f.kind === 'repo' && f.root).map((f) => f.root!)
  return { shown, addable, skipped }
}
