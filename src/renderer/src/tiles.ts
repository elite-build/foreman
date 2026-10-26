// The Tiles layout's rules: which workspaces are on screen and where a newly opened one goes.
// Tiles keep their places, so watching several agents never means hunting for one that moved.

export const TILE_COUNTS = [2, 4, 6] as const
export type TileCount = (typeof TILE_COUNTS)[number]
export const DEFAULT_TILE_COUNT: TileCount = 4

/** A remembered count, or the default when it isn't one we offer. */
export function tileCountOf(value: unknown): TileCount {
  return TILE_COUNTS.find((n) => n === value) ?? DEFAULT_TILE_COUNT
}

/**
 * The workspaces on screen, in tile order: the remembered tiles that still exist, then free tiles filled in the
 * sidebar's order, up to `count`.
 */
export function tilesShown(remembered: string[], order: string[], live: ReadonlySet<string>, count: number): string[] {
  const shown = [...new Set(remembered)].filter((id) => live.has(id)).slice(0, count)
  for (const id of order) {
    if (shown.length >= count) break
    if (live.has(id) && !shown.includes(id)) shown.push(id)
  }
  return shown
}

/**
 * Puts a workspace on screen. One already there stays where it is; otherwise it takes a free tile, or the place of
 * the tile looked at least recently (`recent` is most recent first; a tile not in it counts as the oldest).
 */
export function placeTile(shown: string[], id: string, recent: string[], count: number): string[] {
  if (shown.includes(id)) return shown
  if (shown.length < count) return [...shown, id]
  const age = (tile: string) => (recent.includes(tile) ? recent.indexOf(tile) : Infinity)
  let oldest = 0
  for (let i = 1; i < shown.length; i++) if (age(shown[i]) > age(shown[oldest])) oldest = i
  return shown.map((tile, i) => (i === oldest ? id : tile))
}

// A tile narrower than this can't show a chat beside its composer, so tiles stack (and the grid scrolls) instead.
export const MIN_TILE_WIDTH = 360
// Below this a tile's header has no room for a status in words; it shows the status's shape, the word as its tooltip.
export const COMPACT_TILE_WIDTH = 440
// The grid's gap and padding (tiles.css).
const GAP = 8

/**
 * Columns for this many tiles, and how wide each is: one, side by side, then two or three across, but never so many
 * that a tile is narrower than MIN_TILE_WIDTH. `width` is the grid's (0 before it has been measured: as wide as needed).
 */
export function tileLayout(tiles: number, width: number): { columns: number; tileWidth: number } {
  const wanted = tiles <= 1 ? 1 : tiles <= 4 ? 2 : 3
  const inner = width > 0 ? width - 2 * GAP : Infinity
  const fit = Math.max(1, Math.floor((inner + GAP) / (MIN_TILE_WIDTH + GAP)))
  const columns = Math.min(wanted, fit)
  return { columns, tileWidth: (inner - GAP * (columns - 1)) / columns }
}
