// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from '../../src/renderer/src/ui/Button'
import { Kbd } from '../../src/renderer/src/ui/Kbd'

afterEach(cleanup)

describe('Kbd', () => {
  it('renders a kbd element with its text', () => {
    const ref = createRef<HTMLElement>()
    render(<p>Press <Kbd ref={ref}>Esc</Kbd></p>)
    const el = screen.getByText('Esc')
    expect(el.tagName).toBe('KBD')
    expect(el.className).toBe('ui-kbd')
    expect(ref.current).toBe(el)
  })

  it('keeps a layout className and native props', () => {
    render(<Kbd className="mine" title="Escape">Esc</Kbd>)
    const el = screen.getByText('Esc')
    expect(el.className).toBe('ui-kbd mine')
    expect(el.getAttribute('title')).toBe('Escape')
  })

  it('inside a filled button follows the button text colour instead of the muted one', () => {
    render(
      <>
        <Button variant="primary">New <Kbd>N</Kbd></Button>
        <Button variant="danger">Delete <Kbd>D</Kbd></Button>
      </>
    )
    expect(screen.getByText('N').closest('button')?.className).toContain('ui-btn--primary')
    expect(screen.getByText('D').closest('button')?.className).toContain('ui-btn--danger')
    // jsdom loads no stylesheets, so read the rule: both filled variants reset the hint to the button's colour.
    const css = readFileSync('src/renderer/src/ui/css/button.css', 'utf8')
    expect(css).toMatch(/\.ui-btn--primary \.ui-kbd,\s*\.ui-btn--danger \.ui-kbd\s*\{\s*color: inherit;/)
  })
})
