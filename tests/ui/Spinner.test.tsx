// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Spinner } from '../../src/renderer/src/ui/Spinner'

afterEach(cleanup)

describe('Spinner', () => {
  it('is decorative without a label: hidden from assistive tech', () => {
    const { container } = render(<Spinner />)
    const root = container.firstElementChild!
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(root.hasAttribute('role')).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('is a named status when labelled', () => {
    render(<Spinner label="Cloning" />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Cloning')
    expect(status.hasAttribute('aria-hidden')).toBe(false)
  })

  it('sizes the icon', () => {
    const { container } = render(<Spinner size={20} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps a layout className', () => {
    const { container } = render(<Spinner className="mine" />)
    expect(container.firstElementChild!.className).toBe('ui-spinner mine')
  })
})
