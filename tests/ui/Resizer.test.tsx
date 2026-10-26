// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Resizer } from '../../src/renderer/src/ui/Resizer'

afterEach(cleanup)

type Edge = 'left' | 'right' | 'top' | 'bottom'

// Owns a size the way usePanelSize does, and records every report.
function Pane({ edge = 'right', start = 240, reports = [] }: { edge?: Edge; start?: number; reports?: [number, boolean][] }) {
  const [size, setSize] = useState(start)
  return (
    <Resizer
      label="Resize sidebar"
      edge={edge}
      value={size}
      min={160}
      max={400}
      onResize={(next, commit) => {
        reports.push([next, commit])
        setSize(next)
      }}
      onReset={() => setSize(240)}
    />
  )
}

describe('Resizer', () => {
  it('is a focusable separator with a name, an orientation and a value in range', () => {
    render(<Pane />)
    const bar = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(bar.tabIndex).toBe(0)
    expect(bar.getAttribute('aria-orientation')).toBe('vertical')
    expect(bar.getAttribute('aria-valuenow')).toBe('240')
    expect(bar.getAttribute('aria-valuemin')).toBe('160')
    expect(bar.getAttribute('aria-valuemax')).toBe('400')
  })

  it('is horizontal on a top or bottom edge', () => {
    render(<Pane edge="bottom" />)
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('changes size with ← → on a vertical edge: dragging away from the panel grows it', async () => {
    const user = userEvent.setup()
    const reports: [number, boolean][] = []
    // A panel's right edge: → makes it bigger.
    render(<Pane edge="right" reports={reports} />)
    screen.getByRole('separator').focus()
    await user.keyboard('{ArrowRight}')
    expect(reports.at(-1)).toEqual([256, true])
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(reports.at(-1)).toEqual([224, true])
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('224')
  })

  it('on a panel\'s left edge the arrows are mirrored', async () => {
    const user = userEvent.setup()
    const reports: [number, boolean][] = []
    render(<Pane edge="left" reports={reports} />)
    screen.getByRole('separator').focus()
    await user.keyboard('{ArrowLeft}')
    expect(reports.at(-1)).toEqual([256, true])
  })

  it('uses ↑ ↓ on a horizontal edge, and ignores the other arrows', async () => {
    const user = userEvent.setup()
    const reports: [number, boolean][] = []
    // The top edge of a bottom panel: ↑ makes it taller.
    render(<Pane edge="top" reports={reports} />)
    screen.getByRole('separator').focus()
    await user.keyboard('{ArrowLeft}{ArrowRight}')
    expect(reports).toEqual([])
    await user.keyboard('{ArrowUp}')
    expect(reports.at(-1)).toEqual([256, true])
  })

  it('never goes past the limits, and Home and End jump to them', async () => {
    const user = userEvent.setup()
    const reports: [number, boolean][] = []
    render(<Pane start={392} reports={reports} />)
    screen.getByRole('separator').focus()
    await user.keyboard('{ArrowRight}')
    expect(reports.at(-1)).toEqual([400, true])
    await user.keyboard('{Home}')
    expect(reports.at(-1)).toEqual([160, true])
    await user.keyboard('{End}')
    expect(reports.at(-1)).toEqual([400, true])
  })

  it('steps from the measured size when the pane is sized by CSS', async () => {
    const user = userEvent.setup()
    const onResize = vi.fn()
    render(<Resizer label="R" edge="right" value={240} min={160} max={400} measure={() => 300} onResize={onResize} />)
    screen.getByRole('separator').focus()
    await user.keyboard('{ArrowRight}')
    expect(onResize).toHaveBeenCalledWith(316, true)
  })

  it('double-click resets', async () => {
    const user = userEvent.setup()
    const reports: [number, boolean][] = []
    render(<Pane start={300} reports={reports} />)
    await user.dblClick(screen.getByRole('separator'))
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('240')
  })

  it('drags: live while moving, committed when released, and only if it moved', () => {
    const reports: [number, boolean][] = []
    render(<Pane reports={reports} />)
    const bar = screen.getByRole('separator')
    // jsdom has no PointerEvent coordinates unless given.
    fireEvent.pointerDown(bar, { button: 0, clientX: 100, pointerId: 1 })
    expect(document.body.classList.contains('ui-resizing-x')).toBe(true)
    fireEvent.pointerMove(bar, { clientX: 130, pointerId: 1 })
    fireEvent.pointerMove(bar, { clientX: 500, pointerId: 1 })
    fireEvent.pointerUp(bar, { clientX: 500, pointerId: 1 })
    expect(reports).toEqual([
      [270, false],
      [400, false],
      [400, true]
    ])
    expect(document.body.classList.contains('ui-resizing-x')).toBe(false)

    reports.length = 0
    fireEvent.pointerDown(bar, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerUp(bar, { clientX: 100, pointerId: 1 })
    expect(reports).toEqual([])
  })

  it('a drag from the left edge is mirrored, and a secondary button does nothing', () => {
    const reports: [number, boolean][] = []
    render(<Pane edge="left" reports={reports} />)
    const bar = screen.getByRole('separator')
    fireEvent.pointerDown(bar, { button: 2, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(bar, { clientX: 50, pointerId: 1 })
    expect(reports).toEqual([])
    fireEvent.pointerDown(bar, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(bar, { clientX: 50, pointerId: 1 })
    fireEvent.pointerUp(bar, { clientX: 50, pointerId: 1 })
    expect(reports).toEqual([
      [290, false],
      [290, true]
    ])
  })
})
