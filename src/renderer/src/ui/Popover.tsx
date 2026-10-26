import { useEffect, useId, useRef, useState, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode, type RefCallback } from 'react'
import { createPortal } from 'react-dom'
import { keepOnScreen, usePlaced } from './Menu'

// A non-modal pop-up beside its trigger (the model picker, the template picker, the phone pill, the repo icon
// picker). Controlled: the owner holds `open`. Escape closes and returns focus to the trigger; so does any other
// close that leaves focus nowhere (choosing an item removes the focused row). A click outside, or Tab to something
// outside, closes without taking focus back. With `portal` the panel is drawn in <body> (fixed, beside the trigger,
// kept on screen) so a scrolling or clipping container, such as a dialog's body, can't cut it off; React still
// bubbles its events through the Popover, and a Dialog around it treats it as its own.

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

// Document order (jsdom answers a selector list grouped by selector).
const focusables = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))

export type PopoverTriggerProps = {
  // Attach to the trigger element.
  ref: RefCallback<HTMLElement>
  onClick: () => void
  'aria-haspopup': 'dialog'
  'aria-expanded': boolean
  'aria-controls': string | undefined
}

export type PopoverProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role' | 'onKeyDown' | 'onBlur'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Renders the trigger; spread the props onto one button.
  trigger: (props: PopoverTriggerProps) => ReactNode
  // The panel's accessible name.
  label: string
  // Which side of the trigger it opens on, and which edge it lines up with.
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  // Layout for the panel (its width).
  panelClassName?: string
  // Draw the panel in <body> instead of beside the trigger: for triggers inside a scrolling or clipping container.
  portal?: boolean
  children: ReactNode
}

const GAP = 8

// Where a fixed panel of `size` goes next to an anchor rectangle: on `side`, flipped to the other when it doesn't fit
// there and the other has more room, and lined up with the `align` edge. Pure, so it is tested without a layout.
export function popoverPlacement(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: 'top' | 'bottom',
  align: 'start' | 'end'
): { left: number; top: number } {
  const room = { top: anchor.top, bottom: viewport.height - anchor.bottom }
  const other = side === 'top' ? 'bottom' : 'top'
  const at = size.height + GAP > room[side] && room[other] > room[side] ? other : side
  return keepOnScreen(
    { left: align === 'start' ? anchor.left : anchor.right - size.width, top: at === 'top' ? anchor.top - size.height - GAP : anchor.bottom + GAP },
    size,
    viewport
  )
}

export function Popover({ open, onOpenChange, trigger, label, side = 'top', align = 'start', className, panelClassName, portal, children, ...rest }: PopoverProps) {
  const id = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const setAnchor: RefCallback<HTMLElement> = (el) => {
    anchor.current = el
  }

  // The portalled panel is measured and placed on every render, and again when the page scrolls or resizes.
  const none = useRef<HTMLDivElement>(null)
  const [, moved] = useState(0)
  const at = usePlaced(portal ? panel : none, (size) => {
    const rect = anchor.current?.getBoundingClientRect() ?? { left: 0, right: 0, top: 0, bottom: 0 }
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    return popoverPlacement(rect, size, viewport, side, align)
  })
  useEffect(() => {
    if (!open || !portal) return
    const move = (e: Event) => !(e.target instanceof Node && panel.current?.contains(e.target)) && moved((n) => n + 1)
    window.addEventListener('resize', move)
    window.addEventListener('scroll', move, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', move)
      window.removeEventListener('scroll', move, { capture: true })
    }
  }, [open, portal])

  // The panel is outside the wrapper's DOM when portalled.
  const owns = (node: Node) => !!wrap.current?.contains(node) || !!panel.current?.contains(node)

  // Focus goes into the panel when it opens (an autoFocus inside it wins).
  useEffect(() => {
    if (!open) return
    const el = panel.current
    if (el && !el.contains(document.activeElement)) (focusables(el)[0] ?? el).focus()
  }, [open])

  // A close that left focus on <body> (the panel, and the row that had focus, are gone) goes back to the trigger.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement
      if (!active || active === document.body) anchor.current?.focus()
    }
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !owns(e.target)) onOpenChange(false)
    }
    // Capture: a dialog or row behind may stop mousedown from bubbling.
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open, onOpenChange])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (open && portal && e.key === 'Tab' && !e.defaultPrevented && e.target instanceof Node && panel.current?.contains(e.target)) {
      // The panel sits at the end of <body>: leaving it either way goes back to the trigger. Forward Tab then moves
      // on from there; Shift+Tab stays on the trigger.
      const items = focusables(panel.current)
      const edge = e.shiftKey ? items[0] : items[items.length - 1]
      if (!items.length || e.target === edge || e.target === panel.current) {
        if (e.shiftKey) e.preventDefault()
        onOpenChange(false)
        anchor.current?.focus()
      }
      return
    }
    if (e.key !== 'Escape' || !open || e.defaultPrevented || e.nativeEvent.isComposing) return
    // Don't also close a dialog behind it or stop the agent.
    e.preventDefault()
    e.stopPropagation()
    onOpenChange(false)
    anchor.current?.focus()
  }
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (open && e.relatedTarget instanceof Node && !owns(e.relatedTarget)) onOpenChange(false)
  }

  const panelEl = open && (
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={['ui-popover__panel', panelClassName].filter(Boolean).join(' ')}
      data-side={side}
      data-align={align}
      data-portal={portal || undefined}
      style={portal ? { left: at.left, top: at.top } : undefined}
    >
      {children}
    </div>
  )

  return (
    <div {...rest} ref={wrap} className={['ui-popover', className].filter(Boolean).join(' ')} onKeyDown={onKeyDown} onBlur={onBlur}>
      {trigger({ ref: setAnchor, onClick: () => onOpenChange(!open), 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? id : undefined })}
      {portal && panelEl ? createPortal(panelEl, document.body) : panelEl}
    </div>
  )
}
