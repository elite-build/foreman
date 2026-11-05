// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChipButton } from '../../src/renderer/src/ui/ChipButton'
import { readCss, ruleBody, ruleIndex } from './cssRule'

afterEach(cleanup)

describe('ChipButton', () => {
  it('is a plain button with no state attributes by default', () => {
    render(<ChipButton>Filter</ChipButton>)
    const b = screen.getByRole('button', { name: 'Filter' })
    expect(b.getAttribute('type')).toBe('button')
    expect(b.hasAttribute('aria-pressed')).toBe(false)
    expect(b.hasAttribute('aria-haspopup')).toBe(false)
    expect(b.hasAttribute('aria-expanded')).toBe(false)
  })

  it('exposes a toggle with aria-pressed', () => {
    render(
      <>
        <ChipButton pressed>Plan</ChipButton>
        <ChipButton pressed={false}>Other</ChipButton>
      </>
    )
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Other' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('exposes a popup trigger with aria-haspopup and aria-expanded (closed until told)', () => {
    const { rerender } = render(<ChipButton haspopup="menu">Agent</ChipButton>)
    let b = screen.getByRole('button', { name: 'Agent' })
    expect(b.getAttribute('aria-haspopup')).toBe('menu')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    rerender(<ChipButton haspopup="menu" expanded>Agent</ChipButton>)
    b = screen.getByRole('button', { name: 'Agent' })
    expect(b.getAttribute('aria-expanded')).toBe('true')
  })

  it('maps tone and pill to classes, and has no coral tone', () => {
    render(
      <>
        <ChipButton>a</ChipButton>
        <ChipButton pill>b</ChipButton>
      </>
    )
    expect(screen.getByText('a').className).toBe('ui-chip-btn')
    expect(screen.getByText('b').className).toBe('ui-chip-btn ui-chip-btn--pill')
    expect(readCss('chip-button')).not.toMatch(/--accent/)
  })

  it('has a path look: the inline-code look of a path, the control edge on hover, never coral or a link colour', () => {
    const onClick = vi.fn()
    render(
      <ChipButton path onClick={onClick}>
        src/app.ts
      </ChipButton>
    )
    const b = screen.getByRole('button', { name: 'src/app.ts' })
    expect(b.className).toBe('ui-chip-btn ui-chip-btn--path')
    b.click()
    expect(onClick).toHaveBeenCalledTimes(1)
    const css = readCss('chip-button')
    const rest = ruleBody(css, '.ui-chip-btn--path')
    expect(rest).toMatch(/background:\s*var\(--bg-raised\)/)
    expect(rest).toMatch(/font-family:\s*var\(--mono\)/)
    expect(rest).toMatch(/border-color:\s*transparent/)
    expect(ruleBody(css, ".ui-chip-btn--path[aria-expanded='true']")).toMatch(/border-color:\s*var\(--border-control\)/)
    expect(rest).not.toMatch(/--blue|--accent/)
  })

  it('has a warn tone, and every tone combines with pill', () => {
    render(
      <>
        <ChipButton tone="warn">w</ChipButton>
        <ChipButton tone="warn" pill>wp</ChipButton>
        <ChipButton pill>np</ChipButton>
      </>
    )
    expect(screen.getByText('w').className).toBe('ui-chip-btn ui-chip-btn--warn')
    expect(screen.getByText('wp').className).toBe('ui-chip-btn ui-chip-btn--warn ui-chip-btn--pill')
    expect(screen.getByText('np').className).toBe('ui-chip-btn ui-chip-btn--pill')
  })

  it('declares the pill surface before the tones, so a tone is never lost to the pill', () => {
    const css = readCss('chip-button')
    const pill = ruleIndex(css, '.ui-chip-btn--pill')
    expect(pill).toBeGreaterThan(-1)
    for (const tone of ['warn']) expect(ruleIndex(css, `.ui-chip-btn--${tone}`), tone).toBeGreaterThan(pill)
    expect(ruleBody(css, '.ui-chip-btn--warn')).toContain('--amber')
  })

  it('keeps type=button and role=button whatever the caller passes', () => {
    // @ts-expect-error not props
    render(<ChipButton type="submit" role="tab">x</ChipButton>)
    expect(screen.getByRole('button', { name: 'x' }).getAttribute('type')).toBe('button')
  })

  it('activates by keyboard and is skipped when disabled', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <ChipButton disabled onClick={onClick}>Off</ChipButton>
        <ChipButton onClick={onClick}>On</ChipButton>
      </>
    )
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'On' }))
    await user.keyboard(' ')
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('ChipButton with a Popover trigger spread', () => {
  it('keeps the native aria-haspopup and aria-expanded it is given, and haspopup / expanded win', () => {
    const { rerender } = render(<ChipButton aria-haspopup="dialog" aria-expanded={true} aria-controls="panel">Agent</ChipButton>)
    const b = screen.getByRole('button', { name: 'Agent' })
    expect(b.getAttribute('aria-haspopup')).toBe('dialog')
    expect(b.getAttribute('aria-expanded')).toBe('true')
    expect(b.getAttribute('aria-controls')).toBe('panel')
    rerender(<ChipButton aria-haspopup="dialog" aria-expanded={true} haspopup="menu" expanded={false}>Agent</ChipButton>)
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-haspopup')).toBe('menu')
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-expanded')).toBe('false')
  })
})
