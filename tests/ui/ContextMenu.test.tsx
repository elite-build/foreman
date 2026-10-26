// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu } from '../../src/renderer/src/ui/ContextMenu'
import { MenuItem, MenuSeparator } from '../../src/renderer/src/ui/Menu'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Host({ onCopy = () => {}, onClose = () => {} }: { onCopy?: () => void; onClose?: () => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button>before</button>
      <div
        role="textbox"
        aria-label="Output"
        aria-multiline
        tabIndex={0}
        onContextMenu={(e) => {
          e.preventDefault()
          setAt({ x: e.clientX, y: e.clientY })
        }}
      >
        output
      </div>
      <button>after</button>
      {at && (
        <ContextMenu
          x={at.x}
          y={at.y}
          label="Terminal output"
          onClose={() => {
            setAt(null)
            onClose()
          }}
        >
          <MenuItem onSelect={onCopy}>Copy</MenuItem>
          <MenuSeparator />
          <MenuItem>Select all</MenuItem>
        </ContextMenu>
      )}
    </>
  )
}

const output = () => screen.getByRole('textbox', { name: 'Output' })

async function open(user: ReturnType<typeof userEvent.setup>) {
  output().focus()
  await user.pointer({ keys: '[MouseRight]', target: output() })
}

describe('ContextMenu', () => {
  it('opens in <body> as a named menu with focus on its first item', async () => {
    const user = userEvent.setup()
    const { container } = render(<Host />)
    await open(user)
    const menu = screen.getByRole('menu', { name: 'Terminal output' })
    expect(container.contains(menu)).toBe(false)
    expect(menu.parentElement).toBe(document.body)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy' }))
  })

  it('is placed at the pointer', async () => {
    const user = userEvent.setup()
    render(<Host />)
    output().focus()
    await user.pointer({ keys: '[MouseRight]', target: output(), coords: { clientX: 40, clientY: 60 } })
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('60px')
  })

  it('is kept on screen', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const user = userEvent.setup()
    render(<Host />)
    output().focus()
    await user.pointer({ keys: '[MouseRight]', target: output(), coords: { clientX: window.innerWidth - 10, clientY: window.innerHeight - 10 } })
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe(`${window.innerWidth - 200 - 4}px`)
    expect(menu.style.top).toBe(`${window.innerHeight - 100 - 4}px`)
  })

  it('Escape closes it and returns focus to the element that had focus when it opened', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Host onClose={onClose} />)
    await open(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(output())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('activating an item closes it, returns focus, then runs the action', async () => {
    const user = userEvent.setup()
    const focusAtAction: (Element | null)[] = []
    render(<Host onCopy={() => focusAtAction.push(document.activeElement)} />)
    await open(user)
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(focusAtAction).toEqual([output()])
  })

  it('arrows move between items and skip the separator', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await open(user)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Select all' }))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Copy' }))
  })

  it('Tab closes it without sending focus back to a trigger: focus moves on from where it was', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await open(user)
    await user.tab()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('a click outside closes it and does not steal focus', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await open(user)
    await user.click(screen.getByRole('button', { name: 'before' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'before' }))
  })

  it('closes when the window is resized or loses focus', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await open(user)
    act(() => void window.dispatchEvent(new Event('resize')))
    expect(screen.queryByRole('menu')).toBeNull()
    await open(user)
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does not show the browser menu on a right-click inside it', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await open(user)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByRole('menu').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await user.keyboard('{Escape}')
  })
})
