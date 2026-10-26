// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionRow } from '../../src/renderer/src/ui/ActionRow'
import { Card, CardButton } from '../../src/renderer/src/ui/Card'
import { IconButton } from '../../src/renderer/src/ui/IconButton'
import { readCss, ruleBody, ruleIndex } from './cssRule'

afterEach(cleanup)

describe('Card', () => {
  it('is a quiet frame by default and a control outline when interactive', () => {
    render(
      <>
        <Card data-testid="quiet">Frame</Card>
        <Card data-testid="live" interactive>
          Live
        </Card>
      </>
    )
    expect(screen.getByTestId('quiet').className).toBe('ui-card')
    expect(screen.getByTestId('live').className).toBe('ui-card ui-card--interactive')
    const css = readCss('card')
    expect(ruleBody(css, '.ui-card')).toMatch(/border:\s*1px solid var\(--border\)/)
    // The edge of a card the user can pick up meets 3:1 (WCAG 1.4.11): the control outline, not the hairline.
    expect(ruleBody(css, '.ui-card--interactive')).toMatch(/border-color:\s*var\(--border-control\)/)
  })

  it('renders the element asked for and passes ref, className and native props through', () => {
    const ref = createRef<HTMLDivElement>()
    const { container } = render(
      <ul>
        <Card as="li" ref={ref} className="layout" aria-label="One" draggable>
          x
        </Card>
      </ul>
    )
    const li = container.querySelector('li')!
    expect(ref.current).toBe(li)
    expect(li.className).toBe('ui-card layout')
    expect(li.getAttribute('aria-label')).toBe('One')
    expect(li.getAttribute('draggable')).toBe('true')
  })

  it('shows each state as a data attribute, and none when it is off', () => {
    const { rerender } = render(
      <Card data-testid="c" interactive selected target empty lifted ghost tone="danger" drop="after" stripe="warn" size="sm">
        x
      </Card>
    )
    const c = screen.getByTestId('c')
    for (const name of ['selected', 'target', 'empty', 'lifted', 'ghost']) expect(c.hasAttribute(`data-${name}`), name).toBe(true)
    expect(c.getAttribute('data-tone')).toBe('danger')
    expect(c.getAttribute('data-drop')).toBe('after')
    expect(c.getAttribute('data-stripe')).toBe('warn')
    expect(c.classList.contains('ui-card--sm')).toBe(true)
    rerender(
      <Card data-testid="c" interactive>
        x
      </Card>
    )
    for (const name of ['selected', 'target', 'empty', 'lifted', 'ghost', 'tone', 'drop', 'stripe']) {
      expect(screen.getByTestId('c').hasAttribute(`data-${name}`), name).toBe(false)
    }
  })

  it('may hold controls: a card is not a button', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <Card interactive>
        <IconButton label="Remove" onClick={onClick}>
          <svg />
        </IconButton>
      </Card>
    )
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('CardButton', () => {
  it('is a Pressable wearing the interactive card look', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <CardButton className="starter" onClick={onClick}>
        Open a repo
      </CardButton>
    )
    const b = screen.getByRole('button', { name: 'Open a repo' })
    expect(b.getAttribute('type')).toBe('button')
    expect(b.className).toBe('ui-pressable ui-card ui-card--interactive starter')
    await user.tab()
    expect(document.activeElement).toBe(b)
    await user.keyboard('{Enter}')
    await user.click(b)
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('takes a ref and the states, and keeps the Pressable rule against interactive content', () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <CardButton ref={ref} selected lifted size="sm" aria-pressed>
        Pick
      </CardButton>
    )
    const b = screen.getByRole('button', { name: 'Pick' })
    expect(ref.current).toBe(b)
    expect(b.hasAttribute('data-selected')).toBe(true)
    expect(b.hasAttribute('data-lifted')).toBe(true)
    expect(b.className).toContain('ui-card--sm')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(() =>
        render(
          <CardButton>
            Card <button type="button">nested</button>
          </CardButton>
        )
      ).toThrow(/must not contain interactive content/)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not fire when disabled', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <CardButton disabled onClick={onClick}>
        Off
      </CardButton>
    )
    await user.click(screen.getByRole('button', { name: 'Off' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('ActionRow card', () => {
  it('wears the interactive card look and keeps its actions as siblings of the main button', () => {
    const { container } = render(
      <ActionRow
        card
        selected
        onPress={() => undefined}
        actions={
          <IconButton label="More">
            <svg />
          </IconButton>
        }
      >
        Task
      </ActionRow>
    )
    const row = container.firstElementChild!
    expect(row.className).toBe('ui-action-row ui-card ui-card--interactive')
    expect(row.hasAttribute('data-selected')).toBe(true)
    expect(screen.getByRole('button', { name: 'Task' }).contains(screen.getByRole('button', { name: 'More' }))).toBe(false)
  })
})

describe('card.css', () => {
  const css = readCss('card')
  const before = (a: string, b: string) => expect(ruleIndex(css, a), `${a} before ${b}`).toBeLessThan(ruleIndex(css, b))

  it('draws each state with the tokens: the neutral selected edge for selected and target, dashed for empty and lifted, a raised ghost', () => {
    expect(ruleBody(css, '.ui-card[data-selected]')).toMatch(/border-color:\s*var\(--selected-border\)[\s\S]*background:\s*var\(--selected-bg\)/)
    expect(ruleBody(css, '.ui-card[data-target]')).toMatch(/border-color:\s*var\(--selected-border\)/)
    expect(ruleBody(css, '.ui-card[data-empty]')).toMatch(/dashed var\(--border-control\)/)
    expect(ruleBody(css, '.ui-card[data-lifted]')).toMatch(/border-style:\s*dashed/)
    expect(ruleBody(css, '.ui-card[data-ghost]')).toMatch(/pointer-events:\s*none/)
    expect(ruleBody(css, '.ui-card[data-ghost]')).toMatch(/box-shadow:\s*0 14px 34px var\(--shadow\)/)
    expect(ruleBody(css, ".ui-card[data-tone='danger']")).toMatch(/border-color:\s*var\(--red\)/)
  })

  it('lets a stronger state win over a weaker one by order: a danger ghost is red, a drop target over an empty slot is lit', () => {
    before('.ui-card[data-selected]', ".ui-card[data-tone='danger']")
    before('.ui-card[data-empty]', '.ui-card[data-empty][data-target]')
    before('.ui-card[data-selected]', ".ui-card[data-stripe='neutral']")
  })

  it('never marks a state with the accent, which is too close to the error red', () => {
    expect(css).not.toMatch(/--accent/)
  })

  it('does not hover-highlight a disabled, lifted, ghost or empty card', () => {
    expect(css).toMatch(/:hover:not\(:disabled, \[data-lifted\], \[data-ghost\], \[data-empty\]\)/)
  })

  it('shows the selected and target outline under forced colours', () => {
    expect(css).toMatch(/forced-colors: active\)[\s\S]*data-selected[\s\S]*Highlight/)
  })

  it('has no animation of its own, only transitions, which Reduce Motion ends', () => {
    expect(css).not.toMatch(/@keyframes|animation:/)
  })
})
