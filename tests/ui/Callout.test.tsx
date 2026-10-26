// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from '../../src/renderer/src/ui/Button'
import { Callout } from '../../src/renderer/src/ui/Callout'

afterEach(cleanup)

describe('Callout', () => {
  it('is a note by default, with no glyph for the neutral tone', () => {
    render(<Callout>Heads up</Callout>)
    const el = screen.getByRole('note')
    expect(el.textContent).toBe('Heads up')
    expect(el.querySelector('svg')).toBeNull()
    expect(el.className).toBe('ui-callout ui-callout--neutral')
  })

  it.each(['status', 'alert'] as const)('can be role=%s', (role) => {
    render(<Callout role={role}>Text</Callout>)
    expect(screen.getByRole(role)).toBeTruthy()
  })

  it('does not accept an arbitrary role (type level)', () => {
    // @ts-expect-error only note, status and alert
    render(<Callout role="button">x</Callout>)
    expect(document.querySelector('.ui-callout')).not.toBeNull()
  })

  it.each(['info', 'ok', 'warn', 'error'] as const)('%s tone shows its glyph, hidden from assistive tech', (tone) => {
    render(<Callout tone={tone}>Words say it</Callout>)
    const svg = screen.getByRole('note').querySelector('svg')!
    expect(svg.getAttribute('data-glyph')).toBe(tone)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('note').textContent).toBe('Words say it')
  })

  it('renders a title and body', () => {
    render(<Callout title="Run failed">Details here</Callout>)
    expect(screen.getByText('Run failed').className).toBe('ui-callout__title')
    expect(screen.getByText('Details here')).toBeTruthy()
  })

  it('puts actions under the text in a box and at the end of the line in a banner', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Callout actions={<Button onClick={onClick}>Retry</Button>}>Failed</Callout>)
    const btn = screen.getByRole('button', { name: 'Retry' })
    expect(btn.closest('.ui-callout__body')).not.toBeNull()
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(<Callout banner actions={<Button onClick={onClick}>Retry</Button>}>Failed</Callout>)
    const banner = screen.getByRole('note')
    expect(banner.className).toContain('ui-callout--banner')
    expect(screen.getByRole('button', { name: 'Retry' }).closest('.ui-callout__body')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' }).closest('.ui-callout')).toBe(banner)
  })

  it('passes native props and a layout className through', () => {
    render(<Callout className="mine" id="n" data-x="1">x</Callout>)
    const el = screen.getByRole('note')
    expect(el.className).toContain('mine')
    expect(el.id).toBe('n')
  })
})
