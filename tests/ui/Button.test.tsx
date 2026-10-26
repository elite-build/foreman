// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from '../../src/renderer/src/ui/Button'

afterEach(cleanup)

describe('Button', () => {
  it('is a button named by its text and never submits a form', () => {
    render(
      <form onSubmit={(e) => e.preventDefault()}>
        <Button>Save</Button>
      </form>
    )
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('button')
  })

  it('does not let callers override type or role', () => {
    // @ts-expect-error type and role are not props
    render(<Button type="submit" role="link">Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('button')
  })

  it('maps variant and size to classes', () => {
    render(
      <>
        <Button>a</Button>
        <Button variant="primary" size="sm">b</Button>
        <Button variant="danger">c</Button>
        <Button variant="ghost">d</Button>
      </>
    )
    expect(screen.getByText('a').className).toBe('ui-btn')
    expect(screen.getByText('b').className).toBe('ui-btn ui-btn--primary ui-btn--sm')
    expect(screen.getByText('c').className).toContain('ui-btn--danger')
    expect(screen.getByText('d').className).toContain('ui-btn--ghost')
  })

  it('keeps a layout className and passes native props and ref through', async () => {
    const ref = createRef<HTMLButtonElement>()
    const onClick = vi.fn()
    render(<Button ref={ref} className="mine" onClick={onClick} title="hint" data-x="1">Go</Button>)
    const b = screen.getByRole('button')
    expect(ref.current).toBe(b)
    expect(b.className).toBe('ui-btn mine')
    expect(b.getAttribute('title')).toBe('hint')
    await userEvent.click(b)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('hides the icon from assistive tech and leaves the name alone', () => {
    render(<Button icon={<svg data-testid="i" />}>Add</Button>)
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy()
    expect(screen.getByTestId('i').parentElement?.getAttribute('aria-hidden')).toBe('true')
  })

  it('is reachable by keyboard, and a disabled one is skipped and does not fire', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <Button onClick={onClick}>One</Button>
        <Button disabled onClick={onClick}>Two</Button>
      </>
    )
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'One' }))
    await user.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Two' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    await user.tab()
    // The disabled button is skipped: Tab wraps back to the first.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'One' }))
  })
})
