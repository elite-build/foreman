import { describe, expect, it, vi } from 'vitest'
import { createTypeahead, nextIndex, tabStop, typeahead } from '../src/renderer/src/ui/keys'

describe('design-system keys: roving focus', () => {
  it('moves with the arrows of its orientation and ignores the others', () => {
    expect(nextIndex('ArrowRight', 0, 3, { orientation: 'horizontal' })).toBe(1)
    expect(nextIndex('ArrowDown', 0, 3, { orientation: 'horizontal' })).toBeUndefined()
    expect(nextIndex('ArrowDown', 0, 3, { orientation: 'vertical' })).toBe(1)
    expect(nextIndex('ArrowLeft', 0, 3, { orientation: 'vertical' })).toBeUndefined()
    expect(nextIndex('ArrowUp', 1, 3)).toBe(0)
    expect(nextIndex('Enter', 1, 3)).toBeUndefined()
  })

  it('wraps by default, and stays put at the ends without wrapping', () => {
    expect(nextIndex('ArrowDown', 2, 3)).toBe(0)
    expect(nextIndex('ArrowUp', 0, 3)).toBe(2)
    expect(nextIndex('ArrowDown', 2, 3, { wrap: false })).toBe(2)
    expect(nextIndex('ArrowUp', 0, 3, { wrap: false })).toBe(0)
  })

  it('steps over disabled items with arrows, Home and End', () => {
    const disabled = (i: number) => i === 1 || i === 3
    expect(nextIndex('ArrowDown', 0, 4, { disabled })).toBe(2)
    expect(nextIndex('ArrowDown', 2, 4, { disabled })).toBe(0)
    expect(nextIndex('Home', 2, 4, { disabled: (i) => i === 0 })).toBe(1)
    expect(nextIndex('End', 0, 4, { disabled })).toBe(2)
  })

  it('lands on the first or last enabled item when nothing has focus yet', () => {
    expect(nextIndex('ArrowDown', -1, 3, { disabled: (i) => i === 0 })).toBe(1)
    expect(nextIndex('ArrowUp', -1, 3)).toBe(2)
  })

  it('stays put when every other item is disabled, and has nowhere to go with none enabled', () => {
    expect(nextIndex('ArrowDown', 1, 3, { disabled: (i) => i !== 1 })).toBe(1)
    expect(nextIndex('Home', 0, 2, { disabled: () => true })).toBeUndefined()
    expect(nextIndex('ArrowDown', 0, 0)).toBeUndefined()
  })
})

describe('design-system keys: tab stop', () => {
  it('is the selected item, unless it is disabled or nothing is selected', () => {
    expect(tabStop(2, 3)).toBe(2)
    expect(tabStop(-1, 3)).toBe(0)
    expect(tabStop(0, 3, (i) => i === 0)).toBe(1)
    expect(tabStop(0, 2, () => true)).toBeUndefined()
  })
})

describe('design-system keys: typeahead', () => {
  const labels = ['Rename', 'Remove', 'Archive', 'Restart']

  it('finds the next item starting with the query, after the current one', () => {
    expect(typeahead('r', labels, -1)).toBe(0)
    expect(typeahead('r', labels, 0)).toBe(1)
    expect(typeahead('r', labels, 1)).toBe(3)
    expect(typeahead('r', labels, 3)).toBe(0)
    expect(typeahead('a', labels, 0)).toBe(2)
  })

  it('matches a longer query from the current item, and cycles on a repeated letter', () => {
    expect(typeahead('rem', labels, 0)).toBe(1)
    expect(typeahead('ren', labels, 0)).toBe(0)
    expect(typeahead('rr', labels, 0)).toBe(1)
  })

  it('skips disabled items and finds nothing for no match', () => {
    expect(typeahead('r', labels, -1, (i) => i === 0)).toBe(1)
    expect(typeahead('z', labels, 0)).toBeUndefined()
    expect(typeahead('', labels, 0)).toBeUndefined()
  })

  it('collects typed letters and resets after a pause', () => {
    vi.useFakeTimers()
    const t = createTypeahead(500)
    expect(t.push('r')).toBe('r')
    expect(t.push('e')).toBe('re')
    expect(t.push('ArrowDown')).toBeUndefined()
    vi.advanceTimersByTime(600)
    expect(t.push('a')).toBe('a')
    expect(t.push(' ')).toBe('a ')
    t.reset()
    expect(t.push(' ')).toBeUndefined()
    vi.useRealTimers()
  })
})
