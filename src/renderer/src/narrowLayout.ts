// A narrow window, or 200% zoom (660 CSS px wide in a 1320 px window): the workspace takes each step only when the
// layout's own minimum widths stop fitting, so nothing changes above the first one.
//   1. Under LIST_FOLDS_BELOW the workspace list folds to its rail (the Editor layout's rail-only sidebar); ⌘B / Ctrl+B
//      shows the list beside it again, and folds it back.
//   2. Under PANEL_SHEET_BELOW of the workspace's own width the side panel can't sit beside the chat, so it opens as a
//      sheet over the chat from a "Changes 3" button in the header.
//   3. Also under LIST_FOLDS_BELOW, the header puts Compare, Export, Hand off and Open in into one More menu, so the
//      workspace's name and branch keep their width, and the Note bar becomes a Note chip in the tab strip. In a short
//      window (composer.css) the composer starts as one line.
// The Editor layout arranges its own columns (its rail is always there) and takes none of these steps.

/** The chat column's narrowest width (App.tsx, WorkspaceView.tsx). */
export const CHAT_MIN_WIDTH = 420
/** The side panel's narrowest width (WorkspaceView.tsx). */
export const SIDE_PANEL_MIN_WIDTH = 280
/** The sidebar's default width, its rail (70 px) included, so its list has about 290 px (App.tsx). */
export const SIDEBAR_DEFAULT_WIDTH = 360
/** The sidebar's narrowest width, its rail included: its list keeps about 255 px, so a row's label still shows. */
export const SIDEBAR_MIN_WIDTH = 320
/** The window width under which the list folds to its rail: the sidebar, the chat and the side panel at their narrowest. */
export const LIST_FOLDS_BELOW = SIDEBAR_DEFAULT_WIDTH + CHAT_MIN_WIDTH + SIDE_PANEL_MIN_WIDTH
/** The workspace's own width under which its side panel opens as a sheet: the chat and the panel at their narrowest. */
export const PANEL_SHEET_BELOW = CHAT_MIN_WIDTH + SIDE_PANEL_MIN_WIDTH

/** Whether the window is narrow enough for the workspace list to fold to its rail (never in the Editor layout). */
export function listFolds(windowWidth: number, windowLayout: string | undefined): boolean {
  return windowLayout !== 'editor' && windowWidth < LIST_FOLDS_BELOW
}

/**
 * What the sidebar shows outside the Editor layout: nothing (hidden with ⌘B), its rail alone (folded in a narrow window,
 * until ⌘B asks for the list), or the rail and the list.
 */
export function sidebarShows(opts: { windowWidth: number; windowLayout: string | undefined; leftPanelOpen: boolean; narrowList: boolean }): 'none' | 'rail' | 'list' {
  if (!opts.leftPanelOpen) return 'none'
  return listFolds(opts.windowWidth, opts.windowLayout) && !opts.narrowList ? 'rail' : 'list'
}
