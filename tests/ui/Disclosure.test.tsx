// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Disclosure } from '../../src/renderer/src/ui/Disclosure'

afterEach(cleanup)

const button = () => screen.getByRole('button', { name: 'Setup prompt' })

describe('Disclosure', () => {
  it('starts closed: aria-expanded false, the panel hidden and linked by aria-controls', () => {
    const { container } = render(<Disclosure label="Setup prompt">Runs once.</Disclosure>)
    expect(button().getAttribute('aria-expanded')).toBe('false')
    const panel = container.querySelector('.ui-disclosure__panel') as HTMLElement
    expect(panel.hidden).toBe(true)
    expect(button().getAttribute('aria-controls')).toBe(panel.id)
    expect(screen.queryByText('Runs once.')).toBeTruthy()
    expect(screen.queryByText('Runs once.', { ignore: 'none' })).toBeTruthy()
  })

  it('opens and closes with click, Enter and Space', async () => {
    const user = userEvent.setup()
    const { container } = render(<Disclosure label="Setup prompt">Runs once.</Disclosure>)
    const panel = container.querySelector('.ui-disclosure__panel') as HTMLElement
    await user.click(button())
    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(panel.hidden).toBe(false)
    await user.keyboard('{Enter}')
    expect(button().getAttribute('aria-expanded')).toBe('false')
    await user.keyboard('{ }')
    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(panel.hidden).toBe(false)
  })

  it('can start open', () => {
    render(
      <Disclosure label="Setup prompt" defaultOpen>
        Runs once.
      </Disclosure>
    )
    expect(button().getAttribute('aria-expanded')).toBe('true')
  })

  it('is controlled when open is given', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <Disclosure label="Setup prompt" open={false} onOpenChange={onOpenChange}>
        Runs once.
      </Disclosure>
    )
    await user.click(button())
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(button().getAttribute('aria-expanded')).toBe('false')
    rerender(
      <Disclosure label="Setup prompt" open onOpenChange={onOpenChange}>
        Runs once.
      </Disclosure>
    )
    expect(button().getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the panel content mounted while closed, so state inside it survives', async () => {
    const user = userEvent.setup()
    function Draft() {
      const [text, setText] = useState('')
      return <input aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />
    }
    render(
      <Disclosure label="Setup prompt">
        <Draft />
      </Disclosure>
    )
    await user.click(button())
    await user.type(screen.getByRole('textbox', { name: 'Draft' }), 'hello')
    await user.click(button())
    await user.click(button())
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLInputElement).value).toBe('hello')
  })

  it('has a quiet look and takes layout classes on the wrapper', () => {
    const { container } = render(
      <Disclosure label="Setup prompt" quiet className="mine">
        Runs once.
      </Disclosure>
    )
    expect(button().className).toContain('ui-disclosure__button--quiet')
    expect((container.firstElementChild as HTMLElement).className).toContain('mine')
  })
})
