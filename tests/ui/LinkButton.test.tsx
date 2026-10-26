// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkButton } from '../../src/renderer/src/ui/LinkButton'
import { readCss, ruleBody } from './cssRule'

afterEach(cleanup)

describe('LinkButton', () => {
  it('keeps an icon and its text apart with a gap, and renders both', () => {
    render(
      <LinkButton>
        <svg data-testid="icon" aria-hidden="true" /> New template
      </LinkButton>
    )
    const b = screen.getByRole('button', { name: 'New template' })
    expect(b.querySelector('[data-testid=icon]')).toBeTruthy()
    const rule = ruleBody(readCss('link-button'), '.ui-link-btn') ?? ''
    expect(rule).toMatch(/display:\s*inline-flex/)
    expect(rule).toMatch(/gap:\s*\d+px/)
  })

  it('is a button, not a link', () => {
    render(<LinkButton>Refresh</LinkButton>)
    expect(screen.getByRole('button', { name: 'Refresh' }).getAttribute('type')).toBe('button')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('has danger and small variants', () => {
    render(
      <>
        <LinkButton danger>Delete</LinkButton>
        <LinkButton size="sm">Small</LinkButton>
      </>
    )
    expect(screen.getByText('Delete').className).toBe('ui-link-btn ui-link-btn--danger')
    expect(screen.getByText('Small').className).toBe('ui-link-btn ui-link-btn--sm')
  })

  it('activates by keyboard and by click, not when disabled', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <LinkButton onClick={onClick}>Go</LinkButton>
        <LinkButton disabled onClick={onClick}>Off</LinkButton>
      </>
    )
    await user.tab()
    await user.keyboard('{Enter}')
    await user.click(screen.getByText('Go'))
    expect(onClick).toHaveBeenCalledTimes(2)
    await user.click(screen.getByText('Off'))
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('underline marks an inline link: always underlined, blue, and danger keeps its red', () => {
    render(
      <p>
        See <LinkButton underline>the docs</LinkButton> or <LinkButton underline danger>remove it</LinkButton>.
      </p>
    )
    expect(screen.getByRole('button', { name: 'the docs' }).className).toBe('ui-link-btn ui-link-btn--underline')
    expect(screen.getByRole('button', { name: 'remove it' }).className).toBe('ui-link-btn ui-link-btn--danger ui-link-btn--underline')
    const css = readCss('link-button')
    expect(ruleBody(css, '.ui-link-btn--underline')).toMatch(/text-decoration:\s*underline/)
    expect(ruleBody(css, '.ui-link-btn--underline:not(.ui-link-btn--danger)')).toMatch(/color:\s*var\(--blue\)/)
    expect(ruleBody(css, '.ui-link-btn--underline')).toMatch(/text-decoration-color:\s*color-mix\(in srgb, var\(--blue\)/)
  })

  it('mono sets the code font', () => {
    render(<LinkButton size="sm" mono>src/app.ts</LinkButton>)
    expect(screen.getByRole('button', { name: 'src/app.ts' }).className).toBe('ui-link-btn ui-link-btn--sm ui-link-btn--mono')
    expect(ruleBody(readCss('link-button'), '.ui-link-btn--mono')).toMatch(/font-family:\s*var\(--mono\)/)
  })

  it('sits in running text', () => {
    render(<p>Please <LinkButton>retry</LinkButton> now.</p>)
    expect(screen.getByRole('button', { name: 'retry' }).parentElement?.tagName).toBe('P')
  })
})
