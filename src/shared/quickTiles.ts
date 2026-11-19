// Settings › Quick and the sidebar gear's popover: one ordered list of tiles, each a setting people change often, drawn
// with that setting's own control (components/settings/QuickTiles.tsx). The gear shows the first GEAR_TILES; the page
// shows them all. The order is the window's preference (localStorage, as the panel widths are), so it lives here pure.

export const QUICK_TILES = [
  'new-chats',
  'theme',
  'zoom',
  'notifications',
  'plan-first',
  'review-model',
  'keep-awake',
  'privacy-mode',
  'connections',
  'language'
] as const

export type QuickTile = (typeof QUICK_TILES)[number]

/** How many of the list the gear's popover shows. */
export const GEAR_TILES = 6

export const DEFAULT_QUICK_TILES: readonly QuickTile[] = QUICK_TILES

export function isQuickTile(value: unknown): value is QuickTile {
  return typeof value === 'string' && (QUICK_TILES as readonly string[]).includes(value)
}

/**
 * A saved list made safe: unknown ids (a newer Foreman's, a hand edit) and repeats dropped, in the saved order. Nothing
 * saved yet, or not a list, is the default list. An empty list stays empty: everything was removed on purpose.
 */
export function normalizeQuickTiles(saved: unknown): QuickTile[] {
  if (!Array.isArray(saved)) return [...DEFAULT_QUICK_TILES]
  return [...new Set(saved.filter(isQuickTile))]
}

/** The tiles not in the list, in catalogue order: what Add a tile offers. */
export function hiddenQuickTiles(tiles: readonly QuickTile[]): QuickTile[] {
  return QUICK_TILES.filter((id) => !tiles.includes(id))
}

/** `tiles` with `id` moved one place earlier (-1) or later (+1); the same list when it can't move. */
export function moveQuickTile(tiles: readonly QuickTile[], id: QuickTile, by: -1 | 1): QuickTile[] {
  const from = tiles.indexOf(id)
  const to = from + by
  if (from < 0 || to < 0 || to >= tiles.length) return [...tiles]
  const next = [...tiles]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}
