// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  keepOnScreen,
  Menu,
  MenuButton,
  MenuCheckboxItem,
  MenuControlRow,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioItem,
  MenuSeparator,
  menuPlacement
} from '../../src/renderer/src/ui/Menu'

afterEach(cleanup)

type DemoProps = { onOpen?: () => void; onRename?: () => void; onRemove?: () => void; portal?: boolean }

function Demo({ onOpen = () => {}, onRename = () => {}, onRemove = () => {}, portal }: DemoProps) {
  return (
    <>
      <button>before</button>
      <MenuButton label="File actions" trigger="Actions" portal={portal}>
        <MenuItem onSelect={onOpen}>Open</MenuItem>
        <MenuItem onSelect={onRename} hint="F2">
          Rename
        </MenuItem>
        <MenuItem disabled>Reveal</MenuItem>
        <MenuSeparator />
        <MenuItem variant="danger" onSelect={onRemove}>
          Remove
        </MenuItem>
      </MenuButton>
      <button>after</button>
    </>
  )
}

const trigger = () => screen.getByRole('button', { name: 'Actions' })
const item = (name: string | RegExp) => screen.getByRole('menuitem', { name })

describe('MenuButton triggerClassName and tone', () => {
  it('puts triggerClassName on the trigger button and className on the wrapper', () => {
    const { container } = render(
      <MenuButton label="Add" look="icon" className="wrap-layout" triggerClassName="rail-add" trigger="+">
        <MenuItem>One</MenuItem>
      </MenuButton>
    )
    const trigger = screen.getByRole('button', { name: 'Add' })
    expect(trigger.className).toBe('ui-icon-btn rail-add')
    expect(container.querySelector('.ui-menu-wrap')?.className).toBe('ui-menu-wrap wrap-layout')
    expect(container.querySelectorAll('.rail-add')).toHaveLength(1)
  })

  it('look="dashed" is an icon trigger drawn as the dashed tile: named by the menu label', () => {
    render(
      <MenuButton label="Add a repository" look="dashed" triggerClassName="rail-add" trigger="+">
        <MenuItem>One</MenuItem>
      </MenuButton>
    )
    const trigger = screen.getByRole('button', { name: 'Add a repository' })
    expect(trigger.className).toBe('ui-icon-btn ui-icon-btn--dashed rail-add')
    expect(trigger.getAttribute('title')).toBe('Add a repository')
  })

  it('keeps the trigger class while the menu is open, and never puts it on the menu', async () => {
    render(
      <MenuButton label="Add" triggerClassName="rail-add" trigger="+">
        <MenuItem>One</MenuItem>
      </MenuButton>
    )
    await userEvent.click(screen.getByRole('button', { name: '+' }))
    expect(screen.getByRole('button', { name: '+' }).className).toBe('ui-btn rail-add')
    expect(screen.getByRole('menu').className).not.toContain('rail-add')
  })

  it('a chip trigger takes a tone, alone or with pill, and tone does nothing on other looks', () => {
    render(
      <>
        <MenuButton label="A" look="chip" tone="warn" trigger="warn chip">
          <MenuItem>x</MenuItem>
        </MenuButton>
        <MenuButton label="B" look="chip" tone="warn" pill trigger="warn pill">
          <MenuItem>x</MenuItem>
        </MenuButton>
        <MenuButton label="C" look="chip" tone="neutral" trigger="neutral chip">
          <MenuItem>x</MenuItem>
        </MenuButton>
        <MenuButton label="D" tone="warn" trigger="warn button">
          <MenuItem>x</MenuItem>
        </MenuButton>
      </>
    )
    expect(screen.getByRole('button', { name: 'warn chip' }).className).toBe('ui-chip-btn ui-chip-btn--warn')
    expect(screen.getByRole('button', { name: 'warn pill' }).className).toBe('ui-chip-btn ui-chip-btn--warn ui-chip-btn--pill')
    expect(screen.getByRole('button', { name: 'neutral chip' }).className).toBe('ui-chip-btn')
    expect(screen.getByRole('button', { name: 'warn button' }).className).toBe('ui-btn')
  })
})

describe('MenuButton look', () => {
  it('a chip trigger is fully rounded with pill, and pill alone changes nothing on other looks', () => {
    render(
      <>
        <MenuButton label="Cloud" look="chip" pill trigger="Cloud pill">
          <MenuItem>Wake</MenuItem>
        </MenuButton>
        <MenuButton label="Plain" look="chip" trigger="Plain chip">
          <MenuItem>Wake</MenuItem>
        </MenuButton>
        <MenuButton label="Btn" pill trigger="Button">
          <MenuItem>Wake</MenuItem>
        </MenuButton>
      </>
    )
    expect(screen.getByRole('button', { name: 'Cloud pill' }).className).toBe('ui-chip-btn ui-chip-btn--pill')
    expect(screen.getByRole('button', { name: 'Plain chip' }).className).toBe('ui-chip-btn')
    expect(screen.getByRole('button', { name: 'Button' }).className).toBe('ui-btn')
  })
})

describe('MenuButton', () => {
  it('announces itself as a menu button and opens a named menu with focus on the first item', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(trigger())
    const menu = screen.getByRole('menu', { name: 'File actions' })
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('aria-controls')).toBe(menu.id)
    expect(document.activeElement).toBe(item('Open'))
  })

  it('moves with the arrows, wraps, skips disabled items and honours Home and End', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(item(/Rename/))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(item('Remove'))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(item('Open'))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(item('Remove'))
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(item('Open'))
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(item('Remove'))
  })

  it('does not use left and right', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.keyboard('{ArrowRight}{ArrowLeft}')
    expect(document.activeElement).toBe(item('Open'))
  })

  it('opens from the keyboard: ArrowDown on the first item, ArrowUp on the last', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    trigger().focus()
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(item('Remove'))
    await user.keyboard('{Escape}')
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(item('Open'))
  })

  it('typeahead finds an item by its label, not by its hint', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.keyboard('r')
    expect(document.activeElement).toBe(item(/Rename/))
    await user.keyboard('r')
    expect(document.activeElement).toBe(item('Remove'))
    // The query resets after a pause; "o" then starts afresh, and typed together "re" + "m" narrows to Remove.
    await new Promise((resolve) => setTimeout(resolve, 600))
    await user.keyboard('o')
    expect(document.activeElement).toBe(item('Open'))
    await new Promise((resolve) => setTimeout(resolve, 600))
    await user.keyboard('rem')
    expect(document.activeElement).toBe(item('Remove'))
  })

  it('Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('Escape does not reach a handler outside the menu (a dialog around it stays open)', async () => {
    const user = userEvent.setup()
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    render(<Demo />)
    await user.click(trigger())
    await user.keyboard('{Escape}')
    window.removeEventListener('keydown', outer)
    expect(outer).not.toHaveBeenCalled()
  })

  it('activating an item closes the menu, returns focus, then runs the action', async () => {
    const user = userEvent.setup()
    const seen: { open: boolean; focus: Element | null }[] = []
    render(
      <Demo
        onRename={() =>
          seen.push({ open: screen.queryByRole('menu') !== null, focus: document.activeElement })
        }
      />
    )
    await user.click(trigger())
    await user.keyboard('{ArrowDown}{Enter}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(seen).toHaveLength(1)
    // The action ran with focus already back on the trigger, so a dialog it opens returns here.
    expect(seen[0].focus).toBe(trigger())
  })

  it('activates with the mouse and with Space', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    render(<Demo onOpen={onOpen} onRemove={onRemove} />)
    await user.click(trigger())
    await user.click(item('Open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    await user.click(trigger())
    await user.keyboard('{End}{ }')
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('does not activate a disabled item', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.click(item('Reveal'))
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('Tab closes the menu without moving focus back: it goes on to the next control', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.keyboard('{ArrowDown}')
    await user.tab()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('Shift+Tab goes on to the control before the trigger', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.tab({ shift: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'before' }))
  })

  it('a click elsewhere closes it and leaves focus where the click put it', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.click(screen.getByRole('button', { name: 'after' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('clicking the trigger again closes it', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(trigger())
    await user.click(trigger())
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('can draw the menu in <body> for a clipped trigger', async () => {
    const user = userEvent.setup()
    const { container } = render(<Demo portal />)
    await user.click(trigger())
    const menu = screen.getByRole('menu')
    expect(container.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    expect(menu.className).toContain('ui-menu--fixed')
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(trigger())
  })

  it('reports open state for a menu whose items load on open', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <MenuButton label="Source" trigger="Source" onOpenChange={onOpenChange}>
        <MenuItem>One</MenuItem>
      </MenuButton>
    )
    await user.click(screen.getByRole('button', { name: 'Source' }))
    await user.keyboard('{Escape}')
    expect(onOpenChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  it('names an icon-only trigger from label', () => {
    render(
      <MenuButton label="Row actions" look="icon" trigger={<svg />}>
        <MenuItem>Reset</MenuItem>
      </MenuButton>
    )
    const b = screen.getByRole('button', { name: 'Row actions' })
    expect(b.getAttribute('title')).toBe('Row actions')
    expect(b.className).toContain('ui-icon-btn')
  })
})

describe('menu items', () => {
  function Options() {
    const [wrap, setWrap] = useState(false)
    const [target, setTarget] = useState('a')
    return (
      <MenuButton label="View" trigger="View">
        <MenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
          Wrap lines
        </MenuCheckboxItem>
        <MenuLabel>Send to</MenuLabel>
        <MenuGroup label="Send to">
          <MenuRadioItem checked={target === 'a'} onSelect={() => setTarget('a')} indent>
            Chat A
          </MenuRadioItem>
          <MenuRadioItem checked={target === 'b'} onSelect={() => setTarget('b')} indent>
            Chat B
          </MenuRadioItem>
        </MenuGroup>
      </MenuButton>
    )
  }

  it('checkbox and radio items carry their state and toggle it', async () => {
    const user = userEvent.setup()
    render(<Options />)
    await user.click(screen.getByRole('button', { name: 'View' }))
    const wrap = screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' })
    expect(wrap.getAttribute('aria-checked')).toBe('false')
    await user.click(wrap)
    await user.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('group', { name: 'Send to' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'Chat A' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Chat B' }).getAttribute('aria-checked')).toBe('false')
    await user.click(screen.getByRole('menuitemradio', { name: 'Chat B' }))
    await user.click(screen.getByRole('button', { name: 'View' }))
    expect(screen.getByRole('menuitemradio', { name: 'Chat B' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Chat A' }).getAttribute('aria-checked')).toBe('false')
  })

  it('closeOnSelect={false} keeps the menu open and focus on the item', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <MenuButton label="Zoom" trigger="Zoom">
        <MenuItem closeOnSelect={false} onSelect={onSelect}>
          Bigger
        </MenuItem>
        <MenuItem>Done</MenuItem>
      </MenuButton>
    )
    await user.click(screen.getByRole('button', { name: 'Zoom' }))
    await user.keyboard('{Enter}{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bigger' }))
  })

  it('fails loudly outside a Menu', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<MenuItem>Orphan</MenuItem>)).toThrow(/inside a <Menu>/)
    expect(() => render(<MenuCheckboxItem checked onCheckedChange={() => {}}>Orphan</MenuCheckboxItem>)).toThrow(/inside a <Menu>/)
    expect(() => render(<MenuRadioItem checked onSelect={() => {}}>Orphan</MenuRadioItem>)).toThrow(/inside a <Menu>/)
    quiet.mockRestore()
  })
})

describe('MenuControlRow', () => {
  function Zoom() {
    const [zoom, setZoom] = useState(100)
    return (
      <MenuButton label="Terminal" trigger="Terminal">
        <MenuItem>Rename</MenuItem>
        <MenuControlRow label="Zoom">
          <MenuItem aria-label="Zoom out" onSelect={() => setZoom(zoom - 10)}>
            -
          </MenuItem>
          <MenuItem aria-label="Reset zoom" variant="value" onSelect={() => setZoom(100)}>
            {zoom}%
          </MenuItem>
          <MenuItem aria-label="Zoom in" onSelect={() => setZoom(zoom + 10)}>
            +
          </MenuItem>
        </MenuControlRow>
        <MenuItem>Find</MenuItem>
      </MenuButton>
    )
  }

  it('is one stop for up and down, and left and right move inside it', async () => {
    const user = userEvent.setup()
    render(<Zoom />)
    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Zoom out' }))
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Reset zoom' }))
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Zoom in' }))
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Reset zoom' }))
    // Down and Up leave the row, to its neighbours.
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Find' }))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Zoom out' }))
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
  })

  it('keeps the menu open when a control is used, so the change can be watched', async () => {
    const user = userEvent.setup()
    render(<Zoom />)
    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    await user.click(screen.getByRole('menuitem', { name: 'Zoom in' }))
    await user.click(screen.getByRole('menuitem', { name: 'Zoom in' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Reset zoom' }).textContent).toBe('120%')
    await user.click(screen.getByRole('menuitem', { name: 'Reset zoom' }))
    expect(screen.getByRole('menuitem', { name: 'Reset zoom' }).textContent).toBe('100%')
  })

  it('can be found by typeahead on its label, and Escape still closes from inside it', async () => {
    const user = userEvent.setup()
    render(<Zoom />)
    await user.click(screen.getByRole('button', { name: 'Terminal' }))
    await user.keyboard('z')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Zoom out' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Terminal' }))
  })

  it('skips the row when all its controls are disabled', async () => {
    const user = userEvent.setup()
    render(
      <MenuButton label="T" trigger="T">
        <MenuItem>One</MenuItem>
        <MenuControlRow label="Zoom">
          <MenuItem aria-label="Out" disabled>
            -
          </MenuItem>
        </MenuControlRow>
        <MenuItem>Two</MenuItem>
      </MenuButton>
    )
    await user.click(screen.getByRole('button', { name: 'T' }))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Two' }))
  })
})

describe('Menu on its own', () => {
  it('reports why it closed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <>
        <button>outside</button>
        <Menu label="Plain" onClose={onClose}>
          <MenuItem>One</MenuItem>
        </Menu>
      </>
    )
    await user.keyboard('{Enter}')
    await user.keyboard('{Escape}')
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'outside' }))
    expect(onClose.mock.calls.map((c) => c[0])).toEqual(['select', 'escape', 'tab', 'outside'])
  })

  it('initialFocus none leaves focus alone', () => {
    render(
      <Menu label="Plain" onClose={() => {}} initialFocus="none">
        <MenuItem>One</MenuItem>
      </Menu>
    )
    expect(document.activeElement).toBe(document.body)
  })

  it('focuses the menu itself when it has no enabled item', () => {
    render(
      <Menu label="Empty" onClose={() => {}}>
        <MenuItem disabled>Nothing</MenuItem>
      </Menu>
    )
    expect(document.activeElement).toBe(screen.getByRole('menu'))
  })
})

describe('placement', () => {
  const anchor = { left: 100, right: 160, top: 50, bottom: 74 }
  const size = { width: 200, height: 120 }

  it('places a menu under, over or beside its anchor', () => {
    expect(menuPlacement(anchor, size, 'bottom-start')).toEqual({ left: 100, top: 78 })
    expect(menuPlacement(anchor, size, 'bottom-end')).toEqual({ left: -40, top: 78 })
    expect(menuPlacement(anchor, size, 'top-start')).toEqual({ left: 100, top: -74 })
    expect(menuPlacement(anchor, size, 'top-end')).toEqual({ left: -40, top: -74 })
    expect(menuPlacement(anchor, size, 'right-start')).toEqual({ left: 168, top: 50 })
  })

  it('keeps a menu inside the viewport', () => {
    const viewport = { width: 1000, height: 700 }
    expect(keepOnScreen({ left: 950, top: 650 }, size, viewport)).toEqual({ left: 796, top: 576 })
    expect(keepOnScreen({ left: -40, top: -74 }, size, viewport)).toEqual({ left: 4, top: 4 })
    expect(keepOnScreen({ left: 300, top: 200 }, size, viewport)).toEqual({ left: 300, top: 200 })
  })
})
