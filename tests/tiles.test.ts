// The Tiles layout's rules: which workspaces are on screen, and where a newly opened one goes.
import { describe, expect, it } from 'vitest'
import { DEFAULT_TILE_COUNT, MIN_TILE_WIDTH, placeTile, tileCountOf, tileLayout, tilesShown } from '../src/renderer/src/tiles'

const live = (...ids: string[]) => new Set(ids)

describe('tiles on screen', () => {
  it('keeps the remembered tiles in their places, then fills free ones in the sidebar order', () => {
    expect(tilesShown(['c', 'a'], ['a', 'b', 'c', 'd'], live('a', 'b', 'c', 'd'), 4)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('drops a workspace that is gone (archived or deleted) and refills its tile', () => {
    expect(tilesShown(['x', 'a'], ['a', 'b'], live('a', 'b'), 2)).toEqual(['a', 'b'])
  })

  it('never shows more than the count, or the same workspace twice', () => {
    expect(tilesShown(['a', 'a', 'b', 'c'], ['d'], live('a', 'b', 'c', 'd'), 2)).toEqual(['a', 'b'])
  })

  it('shows fewer tiles when there are fewer workspaces', () => {
    expect(tilesShown([], ['a'], live('a'), 6)).toEqual(['a'])
    expect(tilesShown([], [], live(), 4)).toEqual([])
  })
})

describe('placing a workspace', () => {
  it('leaves one already on screen where it is', () => {
    const shown = ['a', 'b']
    expect(placeTile(shown, 'b', [], 2)).toBe(shown)
  })

  it('takes a free tile when there is one', () => {
    expect(placeTile(['a'], 'b', [], 2)).toEqual(['a', 'b'])
  })

  it('replaces the tile looked at least recently, in place', () => {
    expect(placeTile(['a', 'b', 'c', 'd'], 'e', ['c', 'a', 'd', 'b'], 4)).toEqual(['a', 'e', 'c', 'd'])
  })

  it('treats a tile never looked at as the oldest', () => {
    expect(placeTile(['a', 'b', 'c'], 'e', ['b', 'a'], 3)).toEqual(['a', 'b', 'e'])
  })
})

describe('tile grid and count', () => {
  it('lays out one, then two, then three columns when there is room', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => tileLayout(n, 2400).columns)).toEqual([1, 2, 2, 2, 3, 3])
    // Before the grid is measured, as many as wanted.
    expect(tileLayout(6, 0).columns).toBe(3)
  })

  it('never makes a tile narrower than the minimum: a narrow grid stacks them', () => {
    // A 1000px grid fits two 360px tiles, not three.
    expect(tileLayout(6, 1000)).toEqual({ columns: 2, tileWidth: (1000 - 16 - 8) / 2 })
    // 200% zoom in a small window: one column.
    expect(tileLayout(4, 400).columns).toBe(1)
    for (const width of [400, 760, 1000, 1500, 2400]) {
      const { columns, tileWidth } = tileLayout(6, width)
      if (columns > 1) expect(tileWidth).toBeGreaterThanOrEqual(MIN_TILE_WIDTH)
    }
  })

  it('only takes a count it offers', () => {
    expect(tileCountOf(6)).toBe(6)
    expect(tileCountOf(3)).toBe(DEFAULT_TILE_COUNT)
    expect(tileCountOf('4')).toBe(DEFAULT_TILE_COUNT)
  })
})
