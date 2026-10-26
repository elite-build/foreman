// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from '../../src/renderer/src/ui/Dialog'
import { Popover, popoverPlacement } from '../../src/renderer/src/ui/Popover'

afterEach(cleanup)

function Picker({ onChange }: { onChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button>Before</button>
      <Popover
        open={open}
        onOpenChange={(next) => {
          onChange?.(next)
          setOpen(next)
        }}
        label="Model"
        trigger={(props) => <button {...props}>Model</button>}
      >
        <input aria-label="Search" />
        <button onClick={() => setOpen(false)}>Pick one</button>
      </Popover>
      <button>After</button>
    </div>
  )
}

describe('Popover', () => {
  it('opens from its trigger with the ARIA state, and the panel is a named dialog', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    const trigger = screen.getByRole('button', { name: 'Model' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(trigger)
    const panel = screen.getByRole('dialog', { name: 'Model' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    // Not modal.
    expect(panel.hasAttribute('aria-modal')).toBe(false)
  })

  it('moves focus to the first focusable thing inside', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    await user.click(screen.getByRole('button', { name: 'Model' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Search'))
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    const trigger = screen.getByRole('button', { name: 'Model' })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps Escape from also closing a dialog behind it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Dialog title="Host" onClose={onClose}>
        <Picker />
      </Dialog>
    )
    await user.click(screen.getByRole('button', { name: 'Model' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Model' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // With the popover closed, the next Escape reaches the dialog.
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the trigger when choosing an item removes the focused row', async () => {
    const user = userEvent.setup()
    render(<Picker />)
    const trigger = screen.getByRole('button', { name: 'Model' })
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Pick one' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on a click outside without taking focus back, and on Tab out', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Picker onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Model' })
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'After' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))

    await user.click(trigger)
    // Tab from the last control inside moves to "After" and closes.
    screen.getByRole('button', { name: 'Pick one' }).focus()
    await user.tab()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))
  })

  it('toggles from the trigger', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Picker onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: 'Model' })
    await user.click(trigger)
    await user.click(trigger)
    expect(onChange.mock.calls).toEqual([[true], [false]])
  })

  it('records the side and alignment for the stylesheet', async () => {
    const user = userEvent.setup()
    function Placed() {
      const [open, setOpen] = useState(false)
      return (
        <Popover open={open} onOpenChange={setOpen} label="Where" side="bottom" align="end" trigger={(props) => <button {...props}>Where</button>}>
          content
        </Popover>
      )
    }
    render(<Placed />)
    await user.click(screen.getByRole('button', { name: 'Where' }))
    const panel = screen.getByRole('dialog')
    expect(panel.getAttribute('data-side')).toBe('bottom')
    expect(panel.getAttribute('data-align')).toBe('end')
  })

  describe('portal', () => {
    function Portalled({ onChange }: { onChange?: (open: boolean) => void }) {
      const [open, setOpen] = useState(false)
      return (
        <div data-testid="host" style={{ overflow: 'auto' }}>
          <Popover
            portal
            open={open}
            onOpenChange={(next) => {
              onChange?.(next)
              setOpen(next)
            }}
            label="Model"
            side="bottom"
            trigger={(props) => <button {...props}>Model</button>}
          >
            <input aria-label="Search" />
            <button>Pick one</button>
          </Popover>
          <button>After</button>
        </div>
      )
    }

    it('draws the panel in <body>, outside a clipping container, placed with fixed coordinates', async () => {
      const user = userEvent.setup()
      render(<Portalled />)
      await user.click(screen.getByRole('button', { name: 'Model' }))
      const panel = screen.getByRole('dialog', { name: 'Model' })
      expect(panel.parentElement).toBe(document.body)
      expect(screen.getByTestId('host').contains(panel)).toBe(false)
      expect(panel.hasAttribute('data-portal')).toBe(true)
      expect(panel.style.left).not.toBe('')
      expect(panel.style.top).not.toBe('')
      expect(screen.getByRole('button', { name: 'Model' }).getAttribute('aria-controls')).toBe(panel.id)
      expect(document.activeElement).toBe(screen.getByLabelText('Search'))
    })

    it('stays open for clicks and keys inside the panel, and closes on a click outside', async () => {
      const user = userEvent.setup()
      render(<Portalled />)
      await user.click(screen.getByRole('button', { name: 'Model' }))
      await user.click(screen.getByRole('button', { name: 'Pick one' }))
      expect(screen.getByRole('dialog', { name: 'Model' })).toBeTruthy()
      await user.click(screen.getByRole('button', { name: 'After' }))
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('Escape closes it and returns focus to the trigger', async () => {
      const user = userEvent.setup()
      render(<Portalled />)
      const trigger = screen.getByRole('button', { name: 'Model' })
      await user.click(trigger)
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })

    it('Tab past the last control closes it and moves on from the trigger; Shift+Tab from the first stays on the trigger', async () => {
      const user = userEvent.setup()
      render(<Portalled />)
      const trigger = screen.getByRole('button', { name: 'Model' })
      await user.click(trigger)
      screen.getByRole('button', { name: 'Pick one' }).focus()
      await user.tab()
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))

      await user.click(trigger)
      expect(document.activeElement).toBe(screen.getByLabelText('Search'))
      await user.tab({ shift: true })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })

    it('works inside a Dialog: the panel is not inert, Tab inside it is its own, and Escape closes only the popover', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <Dialog title="Host" onClose={onClose}>
          <Portalled />
        </Dialog>
      )
      await user.click(screen.getByRole('button', { name: 'Model' }))
      const panel = screen.getByRole('dialog', { name: 'Model' })
      expect(panel.closest('[inert]')).toBeNull()
      expect(document.activeElement).toBe(screen.getByLabelText('Search'))
      // The dialog's trap doesn't pull Tab back from the portalled panel.
      await user.tab()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pick one' }))
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: 'Model' })).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Model' }))
      await user.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('a click inside the panel does not count as outside the Dialog', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <Dialog title="Host" onClose={onClose}>
          <Portalled />
        </Dialog>
      )
      await user.click(screen.getByRole('button', { name: 'Model' }))
      await user.click(screen.getByRole('button', { name: 'Pick one' }))
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog', { name: 'Model' })).toBeTruthy()
    })
  })

  describe('popoverPlacement', () => {
    const viewport = { width: 1000, height: 800 }
    const size = { width: 300, height: 200 }
    const anchor = { left: 400, right: 500, top: 300, bottom: 330 }

    it('opens below or above the anchor, lined up with its start or end edge', () => {
      expect(popoverPlacement(anchor, size, viewport, 'bottom', 'start')).toEqual({ left: 400, top: 338 })
      expect(popoverPlacement(anchor, size, viewport, 'bottom', 'end')).toEqual({ left: 200, top: 338 })
      expect(popoverPlacement(anchor, size, viewport, 'top', 'start')).toEqual({ left: 400, top: 92 })
    })

    it('flips to the other side when it does not fit and the other has more room', () => {
      const high = { left: 400, right: 500, top: 20, bottom: 50 }
      expect(popoverPlacement(high, size, viewport, 'top', 'start').top).toBe(58)
      // Not enough room either way: stay on the requested side (then kept on screen).
      const tight = { width: 1000, height: 120 }
      expect(popoverPlacement({ left: 0, right: 10, top: 50, bottom: 70 }, size, tight, 'bottom', 'start').top).toBe(4)
    })

    it('keeps the panel on screen', () => {
      const edge = { left: 900, right: 990, top: 300, bottom: 330 }
      expect(popoverPlacement(edge, size, viewport, 'bottom', 'start').left).toBe(696)
      expect(popoverPlacement({ left: 0, right: 20, top: 300, bottom: 330 }, size, viewport, 'bottom', 'end').left).toBe(4)
    })
  })
})
