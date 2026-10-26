// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Glyph } from '../../src/renderer/src/ui/Glyph'
import type { GlyphName } from '../../src/renderer/src/ui/Glyph'

const NAMES: GlyphName[] = ['ok', 'warn', 'error', 'info', 'off']

afterEach(cleanup)

describe('Glyph', () => {
  it.each(NAMES)('%s is a decorative svg with the shared class and data-glyph', (name) => {
    const { container } = render(<Glyph name={name} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('class')).toBe('ui-glyph')
    expect(svg.getAttribute('data-glyph')).toBe(name)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.getAttribute('viewBox')).toBe('0 0 12 12')
    expect(svg.children.length).toBeGreaterThan(0)
  })

  it('draws a different shape for each state, so no state rests on colour', () => {
    const shapes = NAMES.map((name) => render(<Glyph name={name} />).container.querySelector('svg')!.innerHTML)
    expect(new Set(shapes).size).toBe(NAMES.length)
  })

  it('cannot be made accessible: aria-hidden stays true', () => {
    const { container } = render(<Glyph name="ok" aria-hidden={false} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps a layout className', () => {
    const { container } = render(<Glyph name="ok" className="mine" />)
    expect(container.querySelector('svg')!.getAttribute('class')).toBe('ui-glyph mine')
  })
})
