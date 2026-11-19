import { describe, expect, it } from 'vitest'
import { DEFAULT_QUICK_TILES, GEAR_TILES, hiddenQuickTiles, moveQuickTile, normalizeQuickTiles, QUICK_TILES } from '../src/shared/quickTiles'

describe('Quick tiles', () => {
  it('nothing saved, or not a list, is the default list; the gear shows fewer than all of it', () => {
    expect(normalizeQuickTiles(null)).toEqual([...DEFAULT_QUICK_TILES])
    expect(normalizeQuickTiles('theme')).toEqual([...DEFAULT_QUICK_TILES])
    expect(DEFAULT_QUICK_TILES.length).toBeGreaterThan(GEAR_TILES)
  })

  it('keeps the saved order, dropping unknown ids and repeats; an empty list stays empty', () => {
    expect(normalizeQuickTiles(['zoom', 'from-a-newer-foreman', 'theme', 'zoom', 7])).toEqual(['zoom', 'theme'])
    expect(normalizeQuickTiles([])).toEqual([])
  })

  it('offers the tiles not shown, in catalogue order', () => {
    expect(hiddenQuickTiles(['language', 'theme'])).toEqual(QUICK_TILES.filter((id) => id !== 'language' && id !== 'theme'))
    expect(hiddenQuickTiles([...QUICK_TILES])).toEqual([])
  })

  it('moves a tile one place either way, and not past either end', () => {
    expect(moveQuickTile(['theme', 'zoom', 'language'], 'zoom', -1)).toEqual(['zoom', 'theme', 'language'])
    expect(moveQuickTile(['theme', 'zoom', 'language'], 'zoom', 1)).toEqual(['theme', 'language', 'zoom'])
    expect(moveQuickTile(['theme', 'zoom'], 'theme', -1)).toEqual(['theme', 'zoom'])
    expect(moveQuickTile(['theme', 'zoom'], 'zoom', 1)).toEqual(['theme', 'zoom'])
    expect(moveQuickTile(['theme'], 'zoom', 1)).toEqual(['theme'])
  })
})
