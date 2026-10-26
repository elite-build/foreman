// Flash: the jump-to highlight, drawn by ui/css/flash.css from a `data-ui-flash` attribute. Used wherever the app scrolls the
// user to something (a setting reached from search, a message reached from chat search) so they see where they landed.
// The look is the stylesheet's: a neutral wash a little outside the target, rounded to its corners, with no outline.
// This file only puts the attribute on, takes it off, and decides what to light when the target is tall.

export const FLASH_ATTR = 'data-ui-flash'
const RADIUS_VAR = '--ui-flash-radius'
// A target taller than this is a block of rows and controls, not one thing: light its title and description instead.
const TALL_PX = 120
const FLASH_MS = 1400
// With Reduce Motion the wash is static (no fade), so it needs a moment less to be seen and gone.
const STILL_MS = 1000

export type FlashOptions = {
  /** What to light instead of a tall target: its title and description. Elements missing from the result are skipped; none left means the target itself. */
  parts?: (target: HTMLElement) => (HTMLElement | null | undefined)[]
  /** Taller than this (px, default 120) counts as tall. */
  tall?: number
  /** How long the flash stays on, in ms. Default 1400 (1000 under Reduce Motion). */
  duration?: number
}

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/** The elements a flash on `target` lights: the target, or, when it is tall and `parts` finds a title, those parts. */
export function flashTargets(target: HTMLElement, { parts, tall = TALL_PX }: Pick<FlashOptions, 'parts' | 'tall'> = {}): HTMLElement[] {
  if (parts && target.getBoundingClientRect().height > tall) {
    const found = parts(target).filter((el): el is HTMLElement => Boolean(el))
    if (found.length) return found
  }
  return [target]
}

function clear(el: HTMLElement): void {
  clearTimeout(timers.get(el))
  timers.delete(el)
  // Only a flash in progress: a held flash (`data-ui-flash="hold"`, the screenshot tool's) stays.
  if (el.getAttribute(FLASH_ATTR) === 'on') {
    el.removeAttribute(FLASH_ATTR)
    el.style.removeProperty(RADIUS_VAR)
  }
}

/**
 * Flash `target` (see FlashOptions for tall ones). Starts again if it is already flashing. Returns a function that ends it
 * early; call it when the view goes away.
 */
export function flash(target: HTMLElement, options: FlashOptions = {}): () => void {
  const els = flashTargets(target, options)
  // The resolved Reduce Motion setting (theme.ts sets the attribute); before it exists, the OS preference.
  const resolved = document.documentElement.dataset.reduceMotion
  const still = resolved ? resolved === 'on' : typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const ms = options.duration ?? (still ? STILL_MS : FLASH_MS)
  for (const el of els) {
    clear(el)
    // The wash follows the target's own corners.
    el.style.setProperty(RADIUS_VAR, getComputedStyle(el).borderTopLeftRadius || '0px')
    // Restart the animation if the attribute was just removed.
    void el.offsetWidth
    el.setAttribute(FLASH_ATTR, 'on')
    timers.set(el, setTimeout(() => clear(el), ms))
  }
  return () => els.forEach(clear)
}
