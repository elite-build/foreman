// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Status } from '../../src/renderer/src/ui/Status'

afterEach(cleanup)

describe('Status', () => {
  it.each(['ok', 'warn', 'error', 'info', 'off'] as const)('%s shows its glyph and the word', (tone) => {
    const { container } = render(<Status tone={tone} label="The state" />)
    const root = container.firstElementChild!
    expect(root.className).toContain(`ui-status--${tone}`)
    const svg = root.querySelector('svg')!
    expect(svg.getAttribute('data-glyph')).toBe(tone)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('The state')).toBeTruthy()
  })

  it('keeps the word in the accessible text when compact, as the only text', () => {
    const { container } = render(<Status tone="warn" label="Needs you" compact />)
    expect(container.firstElementChild!.className).toContain('ui-status--compact')
    // Still in the DOM, so a screen reader reads it; the stylesheet hides it visually.
    expect(screen.getByText('Needs you')).toBeTruthy()
    expect(container.textContent).toBe('Needs you')
  })

  it('shows extra content after the word', () => {
    render(<Status tone="warn" label="Needs you">2</Status>)
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('requires a label (type level)', () => {
    // @ts-expect-error label is required
    render(<Status tone="ok" />)
    expect(document.querySelector('.ui-status')).not.toBeNull()
  })

  it('passes native props through', () => {
    render(<Status tone="ok" label="Connected" className="mine" data-testid="s" />)
    expect(screen.getByTestId('s').className).toContain('mine')
  })
})
