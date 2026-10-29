// The Editor layout's rules: what the activity bar can show in the sidebar, and which of it is the workspace's own.
// Workspaces is the usual sidebar list; the others are the workspace's side panel, moved beside the activity bar.
import type { WorkspaceSurfaces } from './archivedView'

export const EDITOR_VIEWS = ['workspaces', 'changes', 'commits', 'files', 'checks'] as const
export type EditorView = (typeof EDITOR_VIEWS)[number]
/** The views that belong to the workspace on screen: the side panel's tabs. */
export type WorkspacePanelView = Exclude<EditorView, 'workspaces'>

// The activity bar is the repository rail (52px) and the sidebar's edge, so the sidebar shrinks to this with its list hidden.
export const RAIL_WIDTH = 53

/** A remembered view, or Workspaces when it isn't one we offer. */
export function editorViewOf(value: unknown): EditorView {
  return EDITOR_VIEWS.find((v) => v === value) ?? 'workspaces'
}

/**
 * Picking a view in the activity bar: the one already showing hides the sidebar, as in an editor; any other shows it.
 */
export function pickEditorView(current: EditorView, open: boolean, picked: EditorView): { view: EditorView; open: boolean } {
  if (picked === current) return { view: current, open: !open }
  return { view: picked, open: true }
}

/**
 * The views there is something to show for, given the workspace on screen (null: none, or something covers it). The same
 * as the side panel's tabs: Commits needs a worktree and Files one on this computer; an archived workspace has only its
 * summary, shown under Changes.
 */
export function editorViewsFor(surfaces: Pick<WorkspaceSurfaces, 'worktree' | 'local' | 'archived'> | null): ReadonlySet<EditorView> {
  if (!surfaces) return new Set(['workspaces'])
  if (surfaces.archived) return new Set(['workspaces', 'changes'])
  return new Set<EditorView>(['workspaces', 'changes', ...(surfaces.worktree ? (['commits'] as const) : []), ...(surfaces.local ? (['files'] as const) : []), 'checks'])
}

/** The view the sidebar shows: the one picked, or Workspaces while the picked one has nothing to show. */
export function shownEditorView(picked: EditorView, available: ReadonlySet<EditorView>): EditorView {
  return available.has(picked) ? picked : 'workspaces'
}
