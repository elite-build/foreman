// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IconButton } from '../../src/renderer/src/ui/IconButton'
import { readCss, ruleBody } from './cssRule'

const icon = <svg data-testid="icon" />

afterEach(cleanup)

describe('IconButton', () => {
  it('is named and titled by label, with the icon hidden', () => {
    render(<IconButton label="Copy">{icon}</IconButton>)
    const b = screen.getByRole('button', { name: 'Copy' })
    expect(b.getAttribute('title')).toBe('Copy')
    expect(b.getAttribute('type')).toBe('button')
    expect(screen.getByTestId('icon').parentElement?.getAttribute('aria-hidden')).toBe('true')
  })

  it('requires label and takes its name and tooltip from it only', () => {
    // @ts-expect-error label is required
    render(<IconButton>{icon}</IconButton>)
    render(<IconButton label="A" aria-label="B">{icon}</IconButton>)
    // @ts-expect-error the tooltip comes from label only
    render(<IconButton label="C" title="D">{icon}</IconButton>)
    expect(screen.getByRole('button', { name: 'A' }).getAttribute('title')).toBe('A')
    expect(screen.getByRole('button', { name: 'C' }).getAttribute('title')).toBe('C')
  })

  it('exposes pressed as aria-pressed only when it is a toggle', () => {
    render(
      <>
        <IconButton label="Plain">{icon}</IconButton>
        <IconButton label="On" pressed>{icon}</IconButton>
        <IconButton label="Off" pressed={false}>{icon}</IconButton>
      </>
    )
    expect(screen.getByRole('button', { name: 'Plain' }).hasAttribute('aria-pressed')).toBe(false)
    expect(screen.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('activates with Space and Enter, and not when disabled', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <IconButton label="Go" onClick={onClick}>{icon}</IconButton>
        <IconButton label="Off" disabled onClick={onClick}>{icon}</IconButton>
      </>
    )
    await user.tab()
    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: 'Off' }))
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('passes aria-haspopup and aria-expanded through for a menu trigger', () => {
    render(<IconButton label="More" aria-haspopup="menu" aria-expanded={true}>{icon}</IconButton>)
    const b = screen.getByRole('button', { name: 'More' })
    expect(b.getAttribute('aria-haspopup')).toBe('menu')
    expect(b.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('IconButton variant', () => {
  it('primary is the filled round button; the default has no modifier', () => {
    render(
      <>
        <IconButton label="Send" variant="primary">{icon}</IconButton>
        <IconButton label="Copy">{icon}</IconButton>
      </>
    )
    expect(screen.getByRole('button', { name: 'Send' }).classList.contains('ui-icon-btn--primary')).toBe(true)
    expect(screen.getByRole('button', { name: 'Copy' }).className).toBe('ui-icon-btn')
  })
})

describe('IconButton tone', () => {
  it('danger adds the modifier, and the default has none', () => {
    render(
      <>
        <IconButton label="Delete" tone="danger">{icon}</IconButton>
        <IconButton label="Copy">{icon}</IconButton>
      </>
    )
    expect(screen.getByRole('button', { name: 'Delete' }).className).toBe('ui-icon-btn ui-icon-btn--danger')
    expect(screen.getByRole('button', { name: 'Copy' }).className).toBe('ui-icon-btn')
  })

  it('a disabled danger button is disabled and keeps its name', () => {
    render(<IconButton label="Delete" tone="danger" disabled>{icon}</IconButton>)
    const b = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    expect(b.getAttribute('title')).toBe('Delete')
  })
})

describe('IconButton badge', () => {
  it('adds the badge modifier and keeps the name, the title and a 24px target', () => {
    render(<IconButton label="Remove slot 2" variant="badge">{icon}</IconButton>)
    const b = screen.getByRole('button', { name: 'Remove slot 2' })
    expect(b.className).toBe('ui-icon-btn ui-icon-btn--badge')
    expect(b.getAttribute('title')).toBe('Remove slot 2')
    const rule = ruleBody(readCss('icon-button'), '.ui-icon-btn--badge') ?? ''
    expect(rule).toMatch(/width:\s*var\(--target-min\)/)
    expect(rule).toMatch(/height:\s*var\(--target-min\)/)
    // Its own control edge, and a ring in the page colour that cuts it out of the card's edge under it.
    expect(rule).toMatch(/border:\s*1px solid var\(--border-control\)/)
    expect(rule).toMatch(/0 0 0 2px var\(--bg\)/)
  })

  it('fires on click and keyboard like any icon button', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<IconButton label="Remove" variant="badge" onClick={onClick}>{icon}</IconButton>)
    await user.tab()
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onClick).toHaveBeenCalledTimes(2)
  })
})

describe('IconButton framed and dashed', () => {
  it('framed: a control-edge square for the current value; dashed: a placeholder tile, solid while open', () => {
    render(
      <>
        <IconButton label="Change icon" variant="framed">{icon}</IconButton>
        <IconButton label="Add" variant="dashed">{icon}</IconButton>
      </>
    )
    expect(screen.getByRole('button', { name: 'Change icon' }).className).toBe('ui-icon-btn ui-icon-btn--framed')
    expect(screen.getByRole('button', { name: 'Add' }).className).toBe('ui-icon-btn ui-icon-btn--dashed')
    const css = readCss('icon-button')
    expect(ruleBody(css, '.ui-icon-btn--framed')).toMatch(/border:\s*1px solid var\(--border-control\)/)
    expect(ruleBody(css, '.ui-icon-btn--dashed')).toMatch(/border:\s*1px dashed var\(--border-control\)/)
    expect(ruleBody(css, ".ui-icon-btn--dashed[aria-expanded='true']")).toMatch(/border-style:\s*solid/)
  })
})
