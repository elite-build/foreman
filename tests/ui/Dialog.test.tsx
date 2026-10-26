// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog, Sheet } from '../../src/renderer/src/ui/Dialog'

afterEach(cleanup)

// A page with an opener, so focus return and the inert background have something to act on.
function Page({ children, onClose = () => {} }: { children?: (close: () => void) => React.ReactNode; onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const close = () => {
    onClose()
    setOpen(false)
  }
  return (
    <>
      <main>
        <button onClick={() => setOpen(true)}>Open</button>
        <button>Behind</button>
      </main>
      <div role="status">Saved</div>
      {open && (children?.(close) ?? (
        <Dialog title="Rename" closeLabel="Close" onClose={close}>
          <input aria-label="Name" />
          <button>Save</button>
        </Dialog>
      ))}
    </>
  )
}

describe('Dialog', () => {
  it('is a modal dialog named by its title, with an optional description', () => {
    render(
      <Dialog title="Rename" description="Pick a new name" onClose={() => {}}>
        body
      </Dialog>
    )
    const dialog = screen.getByRole('dialog', { name: 'Rename' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('Pick a new name').id)
  })

  it('refuses to render without a name', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Dialog title="  " onClose={() => {}}>x</Dialog>)).toThrow(/needs a title/)
    error.mockRestore()
  })

  it('hides the title visually without dropping the name', () => {
    render(
      <Dialog title="Quiet" hideTitle onClose={() => {}}>
        body
      </Dialog>
    )
    expect(screen.getByRole('dialog', { name: 'Quiet' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Quiet' }).hasAttribute('data-hidden')).toBe(true)
  })

  it('moves focus in on open and back to the opener on close', async () => {
    const user = userEvent.setup()
    render(<Page />)
    const opener = screen.getByRole('button', { name: 'Open' })
    await user.click(opener)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps an autofocused field focused', async () => {
    const user = userEvent.setup()
    render(<Page>{(close) => <Dialog title="Rename" onClose={close}><input aria-label="Name" autoFocus /></Dialog>}</Page>)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  })

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const close = screen.getByRole('button', { name: 'Close' })
    const save = screen.getByRole('button', { name: 'Save' })
    await user.tab()
    expect(document.activeElement).toBe(close)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
    await user.tab()
    expect(document.activeElement).toBe(save)
    await user.tab()
    expect(document.activeElement).toBe(close)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(save)
  })

  it('makes the page behind inert while open, but not announcements, and restores it on close', async () => {
    const user = userEvent.setup()
    render(<Page />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('status').hasAttribute('inert')).toBe(false)
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false)
  })

  it('closes on a mousedown on the backdrop, not inside the dialog, unless turned off', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Dialog title="A" onClose={onClose}>body</Dialog>)
    fireEvent.mouseDown(screen.getByText('body'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<Dialog title="A" closeOnBackdrop={false} onClose={onClose}>body</Dialog>)
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has a close button only when it is given a name', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { rerender } = render(<Dialog title="A" onClose={onClose}>body</Dialog>)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<Dialog title="A" closeLabel="Close dialog" onClose={onClose}>body</Dialog>)
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('lets an inner widget take Escape first (a combobox closing its list)', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Dialog title="A" onClose={onClose}>
        <input
          aria-label="Search"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
        />
      </Dialog>
    )
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes only the topmost of nested dialogs on Escape, then the next', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    const inner = vi.fn()
    function Nested() {
      const [open, setOpen] = useState(true)
      return (
        <Dialog title="Outer" onClose={outer}>
          <button>Outer button</button>
          {open && (
            <Dialog
              title="Inner"
              onClose={() => {
                inner()
                setOpen(false)
              }}
            >
              <button>Inner button</button>
            </Dialog>
          )}
        </Dialog>
      )
    }
    render(<Nested />)
    // The outer dialog is inert behind the inner one.
    expect(screen.getByRole('dialog', { name: 'Outer', hidden: true }).closest('[inert]')).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Outer' }).closest('[inert]')).toBeNull()
    await user.keyboard('{Escape}')
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('does not trap Tab for a portal it owns, and takes focus back when that portal drops it', async () => {
    const user = userEvent.setup()
    function WithMenu() {
      const [menu, setMenu] = useState(false)
      return (
        <Dialog title="Host" onClose={() => {}}>
          <button onClick={() => setMenu(true)}>Menu</button>
          <button>Last</button>
          {menu && createPortal(<button>Owned item</button>, document.body)}
        </Dialog>
      )
    }
    render(<WithMenu />)
    const trigger = screen.getByRole('button', { name: 'Menu' })
    await user.click(trigger)
    const item = screen.getByRole('button', { name: 'Owned item' })
    await act(async () => item.focus())
    // Tab inside the portal is not intercepted by the dialog's trap.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => void item.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(false)
    // The portal lets go of focus (a menu closing on Tab): it comes back to where it was in the dialog.
    await act(async () => {
      item.blur()
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('draws a preview in place, without taking the page over', () => {
    render(
      <main>
        <Dialog title="Preview" preview onClose={() => {}}>
          body
        </Dialog>
        <button>Other</button>
      </main>
    )
    expect(screen.getByRole('dialog', { name: 'Preview' }).hasAttribute('aria-modal')).toBe(false)
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false)
    expect(screen.getByRole('main').contains(screen.getByRole('dialog'))).toBe(true)
  })
})

describe('Sheet', () => {
  it('is a dialog with a title, description, close button and footer', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Sheet title="Add variable" description="Name and value" closeLabel="Close" footer={<button>Save</button>} onClose={onClose}>
        body
      </Sheet>
    )
    const sheet = screen.getByRole('dialog', { name: 'Add variable' })
    expect(sheet.getAttribute('aria-describedby')).toBe(screen.getByText('Name and value').id)
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders into a container, and makes everything outside it inert except its own ancestors', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    function View() {
      const [host, setHost] = useState<HTMLElement | null>(null)
      return (
        <div>
          <button>Title bar</button>
          <section ref={setHost} aria-label="view">
            <button>In view</button>
            {host && (
              <Sheet title="Edit" container={host} onClose={onClose}>
                <button>Inside</button>
              </Sheet>
            )}
          </section>
        </div>
      )
    }
    render(<View />)
    const view = screen.getByLabelText('view')
    expect(view.contains(screen.getByRole('dialog'))).toBe(true)
    // Siblings along the path to the sheet are inert; the sheet and its ancestors are not.
    expect(screen.getByRole('button', { name: 'In view', hidden: true }).hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('button', { name: 'Title bar', hidden: true }).hasAttribute('inert')).toBe(true)
    expect(view.hasAttribute('inert')).toBe(false)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('refuses to render without a name', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Sheet title="" onClose={() => {}}>x</Sheet>)).toThrow(/needs a title/)
    error.mockRestore()
  })
})
