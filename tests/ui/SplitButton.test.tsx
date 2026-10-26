// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MenuItem } from '../../src/renderer/src/ui/Menu'
import { SplitButton } from '../../src/renderer/src/ui/SplitButton'

afterEach(cleanup)

function Demo({ onOpen = () => {}, onEditor = () => {}, ...rest }: { onOpen?: () => void; onEditor?: () => void; disabled?: boolean; menuDisabled?: boolean; menuOpen?: boolean; onMenuOpenChange?: (open: boolean) => void; variant?: 'default' | 'primary' | 'ghost' }) {
  return (
    <>
      <SplitButton label="Open" menuLabel="Open in" onClick={onOpen} {...rest}>
        <MenuItem onSelect={onEditor}>Editor</MenuItem>
        <MenuItem>Terminal</MenuItem>
      </SplitButton>
      <button>after</button>
    </>
  )
}

describe('SplitButton', () => {
  it('is two buttons: the action and a named menu arrow', () => {
    render(<Demo />)
    expect(screen.getByRole('button', { name: 'Open' }).getAttribute('type')).toBe('button')
    const arrow = screen.getByRole('button', { name: 'Open in' })
    expect(arrow.getAttribute('aria-haspopup')).toBe('menu')
    expect(arrow.getAttribute('aria-expanded')).toBe('false')
  })

  it('runs the primary action without opening the menu', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<Demo onOpen={onOpen} />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the menu from the arrow; picking an item closes it and returns focus to the arrow', async () => {
    const user = userEvent.setup()
    const onEditor = vi.fn()
    render(<Demo onEditor={onEditor} />)
    const arrow = screen.getByRole('button', { name: 'Open in' })
    await user.click(arrow)
    expect(screen.getByRole('menu', { name: 'Open in' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Editor' }))
    await user.keyboard('{Enter}')
    expect(onEditor).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(arrow)
  })

  it('has a Tab stop on each half', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open in' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('Escape returns focus to the arrow; Tab moves on', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    const arrow = screen.getByRole('button', { name: 'Open in' })
    await user.click(arrow)
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(arrow)
    await user.click(arrow)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('can disable just the arrow, or both halves', () => {
    const { unmount } = render(<Demo menuDisabled />)
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Open in' }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    render(<Demo disabled />)
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Open in' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('wears the Button look for its variant on both halves', () => {
    render(<Demo variant="primary" />)
    expect(screen.getByRole('button', { name: 'Open' }).className).toContain('ui-btn--primary')
    expect(screen.getByRole('button', { name: 'Open in' }).className).toContain('ui-btn--primary')
  })

  it('menuDisabled={false} keeps the arrow usable while the primary is disabled, and menuDisabled disables it alone', async () => {
    const user = userEvent.setup()
    render(<Demo disabled menuDisabled={false} />)
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true)
    const arrow = screen.getByRole('button', { name: 'Open in' }) as HTMLButtonElement
    expect(arrow.disabled).toBe(false)
    await user.click(arrow)
    expect(screen.getByRole('menu', { name: 'Open in' })).toBeTruthy()
    cleanup()
    render(<Demo disabled={false} menuDisabled />)
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Open in' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens from code with menuOpen and reports the arrow and item closing through onMenuOpenChange', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <SplitButton label="Open" menuLabel="Open in" onClick={() => setOpen(true)} menuOpen={open} onMenuOpenChange={setOpen}>
          <MenuItem>Editor</MenuItem>
        </SplitButton>
      )
    }
    render(<Controlled />)
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('menu', { name: 'Open in' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open in' }).getAttribute('aria-expanded')).toBe('true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open in' }))
    await user.click(screen.getByRole('button', { name: 'Open in' }))
    expect(screen.getByRole('menu')).toBeTruthy()
  })
})
