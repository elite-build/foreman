// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Meter } from '../../src/renderer/src/ui/Meter'

afterEach(cleanup)

describe('Meter', () => {
  it('is a named meter with its range and value', () => {
    render(<Meter label="Usage" value={40} />)
    const m = screen.getByRole('meter', { name: 'Usage' })
    expect(m.getAttribute('aria-valuemin')).toBe('0')
    expect(m.getAttribute('aria-valuemax')).toBe('100')
    expect(m.getAttribute('aria-valuenow')).toBe('40')
    expect((m.firstElementChild as HTMLElement).style.width).toBe('40%')
  })

  it('reads the value text instead of the bare number', () => {
    render(<Meter label="Usage" value={8} max={20} valueText="8 of 20 hours" />)
    const m = screen.getByRole('meter')
    expect(m.getAttribute('aria-valuetext')).toBe('8 of 20 hours')
    expect((m.firstElementChild as HTMLElement).style.width).toBe('40%')
  })

  it('uses a custom range', () => {
    render(<Meter label="Temp" value={15} min={10} max={20} />)
    expect((screen.getByRole('meter').firstElementChild as HTMLElement).style.width).toBe('50%')
  })

  it('clamps out-of-range and non-finite values', () => {
    const { rerender } = render(<Meter label="U" value={150} />)
    let m = screen.getByRole('meter')
    expect(m.getAttribute('aria-valuenow')).toBe('100')
    expect((m.firstElementChild as HTMLElement).style.width).toBe('100%')
    rerender(<Meter label="U" value={-5} />)
    m = screen.getByRole('meter')
    expect(m.getAttribute('aria-valuenow')).toBe('0')
    rerender(<Meter label="U" value={Number.NaN} />)
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('0')
  })

  it('maps tone to a class on the track', () => {
    render(
      <>
        <Meter label="a" value={1} />
        <Meter label="b" value={1} tone="warn" />
        <Meter label="c" value={1} tone="error" />
      </>
    )
    expect(screen.getByRole('meter', { name: 'a' }).className).toBe('ui-meter')
    expect(screen.getByRole('meter', { name: 'b' }).className).toBe('ui-meter ui-meter--warn')
    expect(screen.getByRole('meter', { name: 'c' }).className).toBe('ui-meter ui-meter--error')
  })

  it('requires a label (type level) and fails loudly on an empty range', () => {
    // @ts-expect-error label is required
    render(<Meter value={1} />)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() => render(<Meter label="x" value={1} min={5} max={5} />)).toThrow(/max > min/)
    } finally {
      spy.mockRestore()
    }
  })
})
