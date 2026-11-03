// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Countdown } from '../../src/renderer/src/ui/Countdown'
import { IconButton } from '../../src/renderer/src/ui/IconButton'

afterEach(cleanup)

describe('Countdown', () => {
  it('draws a ring hidden from assistive tech around a control that keeps its own name', () => {
    const { container } = render(
      <Countdown durationMs={5000}>
        <IconButton label="Dismiss">×</IconButton>
      </Countdown>
    )
    const svg = container.querySelector('svg.ui-countdown__ring')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    expect(container.firstElementChild!.hasAttribute('role')).toBe(false)
  })

  it('takes its duration, and a step a second for Reduce Motion', () => {
    const { container } = render(<Countdown durationMs={4500}>x</Countdown>)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.getPropertyValue('--ui-countdown-duration')).toBe('4500ms')
    expect(root.style.getPropertyValue('--ui-countdown-steps')).toBe('5')
  })

  it('never takes a negative time or fewer than one step', () => {
    const { container } = render(<Countdown durationMs={-20}>x</Countdown>)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.getPropertyValue('--ui-countdown-duration')).toBe('0ms')
    expect(root.style.getPropertyValue('--ui-countdown-steps')).toBe('1')
  })

  it('says when it is paused, and keeps a layout className', () => {
    const { container, rerender } = render(<Countdown durationMs={1000} className="mine">x</Countdown>)
    expect(container.firstElementChild!.className).toBe('ui-countdown mine')
    rerender(
      <Countdown durationMs={1000} className="mine" paused>
        x
      </Countdown>
    )
    expect(container.firstElementChild!.className).toBe('ui-countdown ui-countdown--paused mine')
  })
})
