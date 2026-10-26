// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverCard, placeCard } from '../../src/renderer/src/ui/HoverCard'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Glyph({ onRefresh = () => {}, openDelay = 300, closeDelay = 200 }: { onRefresh?: () => void; openDelay?: number; closeDelay?: number }) {
  return (
    <div>
      <button>Before</button>
      <HoverCard label="PR 42" openDelay={openDelay} closeDelay={closeDelay} trigger={(props) => <button {...props}>PR glyph</button>}>
        <span>CI failing</span>
        <button onClick={onRefresh}>Refresh</button>
      </HoverCard>
      <button>After</button>
    </div>
  )
}

describe('HoverCard: keyboard', () => {
  it('opens on focus, with the trigger pointing at the card, and closes when focus leaves', async () => {
    const user = userEvent.setup()
    render(<Glyph />)
    const trigger = screen.getByRole('button', { name: 'PR glyph' })
    expect(screen.queryByRole('group')).toBeNull()
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(trigger)
    const card = screen.getByRole('group', { name: 'PR 42' })
    expect(trigger.getAttribute('aria-details')).toBe(card.id)
    // The card is real content in the page: portalled to <body>, so Tab is steered by the component.
    expect(card.parentElement).toBe(document.body)
    await user.click(screen.getByRole('button', { name: 'After' }))
    await act(async () => void (await new Promise((r) => setTimeout(r, 260))))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('Tab goes from the trigger into the card, and on past the trigger when it ends', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    render(<Glyph onRefresh={onRefresh} />)
    screen.getByRole('button', { name: 'PR glyph' }).focus()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }))
    await user.keyboard('{Enter}')
    expect(onRefresh).toHaveBeenCalled()
    // Tab at the end of the card closes it and continues to what follows the trigger.
    await user.tab()
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))
  })

  it('Shift+Tab from the card goes back to the trigger and keeps the card open', async () => {
    const user = userEvent.setup()
    render(<Glyph />)
    const trigger = screen.getByRole('button', { name: 'PR glyph' })
    trigger.focus()
    await user.tab()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('group')).toBeTruthy()
  })

  it('Escape dismisses it, wherever focus is, and returns focus to the trigger from inside the card', async () => {
    const user = userEvent.setup()
    render(<Glyph />)
    const trigger = screen.getByRole('button', { name: 'PR glyph' })
    trigger.focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    // It doesn't open again just because focus stays on the trigger; leaving and coming back does.
    await user.tab()
    await user.tab({ shift: true })
    expect(screen.getByRole('group')).toBeTruthy()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('HoverCard: pointer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('opens after the delay, stays while the pointer is on the card, closes after leaving', () => {
    render(<Glyph />)
    const trigger = screen.getByRole('button', { name: 'PR glyph' })
    fireEvent.mouseEnter(trigger)
    act(() => void vi.advanceTimersByTime(299))
    expect(screen.queryByRole('group')).toBeNull()
    act(() => void vi.advanceTimersByTime(2))
    const card = screen.getByRole('group')
    // Moving from trigger to card: the close timer is cancelled by entering the card.
    fireEvent.mouseLeave(trigger)
    act(() => void vi.advanceTimersByTime(100))
    fireEvent.mouseEnter(card)
    act(() => void vi.advanceTimersByTime(500))
    expect(screen.getByRole('group')).toBeTruthy()
    fireEvent.mouseLeave(card)
    act(() => void vi.advanceTimersByTime(201))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('stays open after the pointer leaves while keyboard focus is on the trigger', () => {
    render(<Glyph />)
    const trigger = screen.getByRole('button', { name: 'PR glyph' })
    act(() => trigger.focus())
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(trigger)
    act(() => void vi.advanceTimersByTime(1000))
    expect(screen.getByRole('group')).toBeTruthy()
  })

  it('a quick pass over the trigger never opens it', () => {
    render(<Glyph />)
    const trigger = screen.getByRole('button', { name: 'PR glyph' })
    fireEvent.mouseEnter(trigger)
    act(() => void vi.advanceTimersByTime(100))
    fireEvent.mouseLeave(trigger)
    act(() => void vi.advanceTimersByTime(1000))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('can be controlled', () => {
    const onOpenChange = vi.fn()
    render(
      <HoverCard label="Card" open onOpenChange={onOpenChange} trigger={(props) => <button {...props}>T</button>}>
        shown
      </HoverCard>
    )
    expect(screen.getByRole('group', { name: 'Card' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('placeCard', () => {
  const viewport = { width: 1000, height: 700 }
  const size = { width: 260, height: 120 }

  it('goes below the anchor, lined up with its left edge', () => {
    expect(placeCard({ left: 100, right: 120, top: 100, bottom: 120 }, size, viewport, 'bottom')).toEqual({ left: 100, top: 126 })
  })

  it('flips above when there is no room below, and stays inside the window sideways', () => {
    expect(placeCard({ left: 900, right: 920, top: 650, bottom: 670 }, size, viewport, 'bottom')).toEqual({ left: 732, top: 524 })
  })

  it('goes beside the anchor, and to its left when the right is full', () => {
    expect(placeCard({ left: 100, right: 200, top: 50, bottom: 90 }, size, viewport, 'right')).toEqual({ left: 208, top: 50 })
    expect(placeCard({ left: 800, right: 950, top: 600, bottom: 640 }, size, viewport, 'right')).toEqual({ left: 532, top: 572 })
  })
})
