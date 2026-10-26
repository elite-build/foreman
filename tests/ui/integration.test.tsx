// @vitest-environment jsdom
// Behaviour across batches: the overlays (2d) have to cooperate with the menus (2c) they host.
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog } from '../../src/renderer/src/ui/Dialog'
import { MenuButton, MenuItem } from '../../src/renderer/src/ui/Menu'

afterEach(cleanup)

function Page({ portal = false }: { portal?: boolean }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState('')
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <span>{picked}</span>
      {open && (
        <Dialog title="Settings" closeLabel="Close" onClose={() => setOpen(false)}>
          <MenuButton label="Branch actions" trigger="Actions" portal={portal}>
            <MenuItem onSelect={() => setPicked('renamed')}>Rename</MenuItem>
            <MenuItem onSelect={() => setPicked('deleted')}>Delete</MenuItem>
          </MenuButton>
          <button>Save</button>
        </Dialog>
      )}
    </>
  )
}

describe.each([false, true])('a menu inside a dialog (portal: %s)', (portal) => {
  it('Escape closes the menu first, then the dialog, returning focus each time', async () => {
    const user = userEvent.setup()
    render(<Page portal={portal} />)
    await user.click(screen.getByText('Open'))
    const trigger = screen.getByRole('button', { name: 'Actions' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menu', { name: 'Branch actions' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(document.activeElement).toBe(trigger)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByText('Open'))
  })

  it('choosing an item runs it and keeps the dialog open, with focus back on the trigger', async () => {
    const user = userEvent.setup()
    render(<Page portal={portal} />)
    await user.click(screen.getByText('Open'))
    const trigger = screen.getByRole('button', { name: 'Actions' })
    trigger.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(screen.getByText('deleted')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(document.activeElement).toBe(trigger)
  })
})
