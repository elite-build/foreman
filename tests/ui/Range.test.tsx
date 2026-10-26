// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Range } from '../../src/renderer/src/ui/Range'

afterEach(cleanup)

describe('Range', () => {
  it('is a named slider with its bounds and a spoken value', () => {
    render(<Range aria-label="Font size" min={10} max={20} step={1} value={14} valueText="14px" onChange={() => {}} />)
    const slider = screen.getByRole('slider', { name: 'Font size' }) as HTMLInputElement
    expect(slider.min).toBe('10')
    expect(slider.max).toBe('20')
    expect(slider.value).toBe('14')
    expect(slider.getAttribute('aria-valuetext')).toBe('14px')
  })

  it('passes native change events and works controlled', () => {
    const seen: number[] = []
    function Box() {
      const [value, setValue] = useState(14)
      return (
        <Range
          aria-label="Size"
          min={10}
          max={20}
          value={value}
          onChange={(e) => {
            seen.push(Number(e.target.value))
            setValue(Number(e.target.value))
          }}
        />
      )
    }
    render(<Box />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '18' } })
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('18')
    expect(seen).toEqual([18])
  })

  it('cannot be turned into another input type', () => {
    render(<Range aria-label="x" {...({ type: 'text' } as object)} />)
    expect(screen.getByRole('slider').getAttribute('type')).toBe('range')
  })

  it('fails loudly without a name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Range />)).toThrow(/Range has no accessible name/)
    spy.mockRestore()
  })
})
