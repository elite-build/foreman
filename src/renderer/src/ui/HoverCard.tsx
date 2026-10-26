import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefCallback } from 'react'
import { createPortal } from 'react-dom'

// A card with extra detail about its trigger (a PR glyph's CI state with Refresh, a board card's "why"). It replaces
// `role="tooltip"` cards that held buttons: those can't be reached by keyboard. This one opens on hover and on
// focus, can hold focusable content, is reachable with Tab (from the trigger into the card, and on past it), stays
// open while the pointer or focus is on the trigger or the card, and Escape dismisses it wherever focus is.

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
const MARGIN = 8

type Box = { left: number; top: number; right: number; bottom: number }

/** Where a card of `size` goes next to `anchor`, on whichever side has room, kept inside the viewport. */
export function placeCard(anchor: Box, size: { width: number; height: number }, viewport: { width: number; height: number }, side: 'bottom' | 'right', gap = 6): { left: number; top: number } {
  if (side === 'right') {
    const left = anchor.right + MARGIN + size.width < viewport.width ? anchor.right + MARGIN : Math.max(MARGIN, anchor.left - size.width - MARGIN)
    return { left, top: Math.max(MARGIN, Math.min(anchor.top, viewport.height - size.height - MARGIN)) }
  }
  const below = anchor.bottom + gap
  return {
    left: Math.max(MARGIN, Math.min(anchor.left, viewport.width - size.width - MARGIN)),
    top: below + size.height < viewport.height - MARGIN ? below : Math.max(MARGIN, anchor.top - gap - size.height)
  }
}

// Document order (jsdom answers a selector list grouped by selector).
const focusables = (el: HTMLElement | null) =>
  [...(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))

export type HoverCardTriggerProps = {
  // Attach to the trigger element.
  ref: RefCallback<HTMLElement>
  onMouseEnter: (e: MouseEvent<HTMLElement>) => void
  onMouseLeave: (e: MouseEvent<HTMLElement>) => void
  onFocus: (e: FocusEvent<HTMLElement>) => void
  onBlur: (e: FocusEvent<HTMLElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  // Points at the card while it is open.
  'aria-details': string | undefined
}

export type HoverCardProps = {
  // Renders the trigger; spread the props onto one focusable element.
  trigger: (props: HoverCardTriggerProps) => ReactNode
  // The card's accessible name.
  label: string
  // Optional control; without it the card opens and closes itself.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // Below the trigger (flips above when short of room), or beside it (flips to the left).
  side?: 'bottom' | 'right'
  width?: number
  openDelay?: number
  closeDelay?: number
  // Layout for the card.
  className?: string
  children: ReactNode
}

export function HoverCard({ trigger, label, open: controlled, onOpenChange, side = 'bottom', width, openDelay = 300, closeDelay = 200, className, children }: HoverCardProps) {
  const id = useId()
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const setOpen = useCallback(
    (next: boolean) => {
      setOwn(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )
  const anchor = useRef<HTMLElement | null>(null)
  const setAnchor: RefCallback<HTMLElement> = (el) => {
    anchor.current = el
  }
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hover = useRef(false)
  const focus = useRef(false)
  // Focus returned to the trigger on purpose (Escape, Tab out of the card): that mustn't open the card again.
  const quiet = useRef(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const later = (next: boolean, delay: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), delay)
  }
  const enter = () => {
    hover.current = true
    if (open) clearTimeout(timer.current)
    else later(true, openDelay)
  }
  const leave = () => {
    hover.current = false
    if (!focus.current) later(false, closeDelay)
  }
  const focused = () => {
    if (quiet.current) {
      quiet.current = false
      focus.current = true
      return
    }
    focus.current = true
    clearTimeout(timer.current)
    setOpen(true)
  }
  const blurred = (e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget
    if (next instanceof Node && (anchor.current?.contains(next) || card.current?.contains(next))) return
    focus.current = false
    if (!hover.current) later(false, closeDelay)
  }
  const focusTrigger = () => {
    quiet.current = true
    anchor.current?.focus()
    // The focus event is synchronous; if none came (already focused, not focusable) don't leave the flag armed.
    quiet.current = false
  }

  // Escape dismisses it wherever focus is (WCAG 1.4.13). Window capture: the card is the topmost thing on screen.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      clearTimeout(timer.current)
      hover.current = false
      if (card.current?.contains(document.activeElement)) focusTrigger()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  // The card is portalled to <body>, so Tab is steered by hand: trigger into card, card back out past the trigger.
  const triggerKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || e.shiftKey || !open) return
    const first = focusables(card.current)[0]
    if (!first) return
    e.preventDefault()
    first.focus()
  }
  const cardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const items = focusables(card.current)
    const active = document.activeElement
    if (e.shiftKey && (active === items[0] || active === card.current)) {
      // Back to the trigger, which keeps the card open.
      e.preventDefault()
      anchor.current?.focus()
    } else if (!e.shiftKey && (items.length === 0 || active === items[items.length - 1])) {
      // Close, and let this Tab carry on from the trigger to whatever follows it.
      hover.current = false
      focus.current = false
      clearTimeout(timer.current)
      focusTrigger()
      setOpen(false)
    }
  }

  useLayoutEffect(() => {
    if (!open) return setAt(null)
    const place = () => {
      const el = card.current
      const from = anchor.current?.getBoundingClientRect()
      if (!el || !from) return
      const box = el.getBoundingClientRect()
      setAt(placeCard(from, { width: width ?? box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight }, side))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, side, width])

  return (
    <>
      {trigger({ ref: setAnchor, onMouseEnter: enter, onMouseLeave: leave, onFocus: focused, onBlur: blurred, onKeyDown: triggerKey, 'aria-details': open ? id : undefined })}
      {open &&
        createPortal(
          <div
            ref={card}
            id={id}
            role="group"
            aria-label={label}
            tabIndex={-1}
            className={['ui-hovercard', className].filter(Boolean).join(' ')}
            data-side={side}
            style={{ left: at?.left ?? 0, top: at?.top ?? 0, width, visibility: at ? undefined : 'hidden' }}
            onMouseEnter={enter}
            onMouseLeave={leave}
            onFocus={focused}
            onBlur={blurred}
            onKeyDown={cardKey}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  )
}
