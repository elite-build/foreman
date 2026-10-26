import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from 'react'

// The drag handle on a panel's edge (the sidebar, the side panel, the terminal panel; from components/resize.tsx
// `ResizeHandle`). A `separator` with a value, so it is a slider for keyboard and screen-reader users: ← → (or ↑ ↓
// for a horizontal edge) change the size by `step`, Home and End go to the limits, double-click resets. The panel
// size lives with the owner (usePanelSize); this reports sizes. The parent must be `position: relative`.

export type ResizerProps = Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'children' | 'onKeyDown' | 'onDoubleClick' | 'aria-label' | 'aria-valuenow'> & {
  // The accessible name ("Resize sidebar").
  label: string
  // The panel edge it sits on: dragging away from the panel makes it bigger.
  edge: 'left' | 'right' | 'top' | 'bottom'
  // The panel's size in px, and its limits.
  value: number
  min: number
  max: number
  // The new size. `commit` is false while dragging (live) and true when the drag, or a key press, is done.
  onResize: (size: number, commit: boolean) => void
  onReset?: () => void
  // The panel's real size when it can differ from `value` (a pane nobody has resized is sized by CSS).
  measure?: (handle: HTMLElement) => number
  // Pixels per arrow press.
  step?: number
}

export function Resizer({ label, edge, value, min, max, onResize, onReset, measure, step = 16, className, ...rest }: ResizerProps) {
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ at: number; size: number; last: number } | null>(null)
  const vertical = edge === 'left' || edge === 'right'
  const direction = edge === 'right' || edge === 'bottom' ? 1 : -1
  const cursor = vertical ? 'ui-resizing-x' : 'ui-resizing-y'
  const clamp = (size: number) => Math.round(Math.min(Math.max(size, min), max))
  const sizeOf = (handle: HTMLElement) => measure?.(handle) ?? value
  // Unmounted mid-drag: don't leave the resize cursor on <body>.
  useEffect(() => () => document.body.classList.remove('ui-resizing-x', 'ui-resizing-y'), [])

  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    // A click without a move changes nothing.
    if (d.last !== d.size) onResize(d.last, true)
    setDragging(false)
    document.body.classList.remove(cursor)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    let next: number
    if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    else if (keys.includes(e.key)) next = sizeOf(e.currentTarget) + (e.key === keys[1] ? 1 : -1) * direction * step
    else return
    e.preventDefault()
    onResize(clamp(next), true)
  }

  return (
    <div
      {...rest}
      className={['ui-resizer', className].filter(Boolean).join(' ')}
      data-edge={edge}
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        const size = sizeOf(e.currentTarget)
        drag.current = { at: vertical ? e.clientX : e.clientY, size, last: size }
        setDragging(true)
        document.body.classList.add(cursor)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const next = clamp(d.size + ((vertical ? e.clientX : e.clientY) - d.at) * direction)
        if (next === d.last) return
        d.last = next
        onResize(next, false)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  )
}
