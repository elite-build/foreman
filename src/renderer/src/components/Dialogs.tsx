import { useEffect, useState, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'

// Each open dialog's opener. A dialog opened from inside another one (which
// may close at the same time) falls back to that dialog's opener.
const openers = new WeakMap<Element, Element | null>()

function restoreTarget(el: Element | null): HTMLElement | null {
  for (let hops = 0; el && !el.isConnected && hops < 10; hops++) {
    // closest() still works inside the removed dialog's detached tree.
    const dialog = el.closest('[role="dialog"]')
    el = dialog ? (openers.get(dialog) ?? null) : null
  }
  return el instanceof HTMLElement && el.isConnected ? el : null
}

/**
 * Focus handling every dialog shares: focus moves into the dialog when it
 * opens, Tab and Shift+Tab stay inside it, and focus goes back to whatever
 * had it (usually the button that opened the dialog) when it closes.
 * The dialog element needs role="dialog" and tabIndex={-1}.
 * Kept for the Tour card, the one dialog that can't use `ui/Dialog` (it is positioned, and its own spotlight is the dim).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  // Read during render: autoFocus inside the dialog runs before effects.
  const [opener] = useState(() => document.activeElement)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    openers.set(node, opener)
    if (!node.contains(document.activeElement)) node.focus()
    // On document, so it runs after React's handlers and sees their preventDefault().
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      // Only Tab inside this dialog, not inside one nested in it.
      if (!(e.target instanceof Element) || e.target.closest('[role="dialog"]') !== node) return
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
      if (!items.length) return e.preventDefault()
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Still in the page: StrictMode replaying effects, not a real close.
      if (node.isConnected) return
      // Unless whatever closed the dialog already moved focus somewhere on purpose.
      const active = document.activeElement
      const lost = !active || active === document.body || node.contains(active)
      if (lost) restoreTarget(opener)?.focus()
    }
  }, [])
}
