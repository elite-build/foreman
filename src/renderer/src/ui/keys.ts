// Keyboard logic shared by the design system's composite widgets (Segmented, Tabs, Menu, Listbox, …).
// Pure functions over indexes, so they're tested without a DOM. Widgets that hand keys to a text input
// (a combobox) call these only for the keys they own; Home, End and typing stay with the input.

export type Orientation = 'horizontal' | 'vertical' | 'both'

export type RovingOptions = {
  // Which arrows move: horizontal ← →, vertical ↑ ↓, both all four.
  orientation?: Orientation
  // Past the last item, wrap to the first (and back). Menus and radio groups wrap; tabs do too.
  wrap?: boolean
  // Items that can't take focus; arrows, Home and End step over them.
  disabled?: (index: number) => boolean
}

const STEPS: Record<string, { step: 1 | -1; axis: 'h' | 'v' }> = {
  ArrowRight: { step: 1, axis: 'h' },
  ArrowLeft: { step: -1, axis: 'h' },
  ArrowDown: { step: 1, axis: 'v' },
  ArrowUp: { step: -1, axis: 'v' }
}

// The index a key moves to from `current`, or undefined when the key isn't a navigation key for this
// widget (the caller then lets the event through). Returns `current` when nothing else is enabled.
// `current` may be -1 (nothing focused yet): an arrow then lands on the first or last enabled item.
export function nextIndex(key: string, current: number, count: number, options: RovingOptions = {}): number | undefined {
  const { orientation = 'both', wrap = true, disabled = () => false } = options
  if (count <= 0) return undefined
  const enabled = (i: number) => !disabled(i)
  const first = () => firstEnabled(count, enabled)
  const last = () => lastEnabled(count, enabled)
  if (key === 'Home') return first()
  if (key === 'End') return last()
  const move = STEPS[key]
  if (!move) return undefined
  if (orientation === 'horizontal' && move.axis === 'v') return undefined
  if (orientation === 'vertical' && move.axis === 'h') return undefined
  if (current < 0 || current >= count) return move.step === 1 ? first() : last()
  for (let tries = 1, i = current; tries <= count; tries++) {
    i += move.step
    if (i >= count || i < 0) {
      if (!wrap) return current
      i = (i + count) % count
    }
    if (enabled(i)) return i
  }
  return current
}

function firstEnabled(count: number, enabled: (i: number) => boolean): number | undefined {
  for (let i = 0; i < count; i++) if (enabled(i)) return i
  return undefined
}

function lastEnabled(count: number, enabled: (i: number) => boolean): number | undefined {
  for (let i = count - 1; i >= 0; i--) if (enabled(i)) return i
  return undefined
}

// The roving tab stop: the selected item when it can take focus, else the first enabled one.
// Fixes the old Segmented, which put the only Tab stop on a disabled selected option.
export function tabStop(selected: number, count: number, disabled: (index: number) => boolean = () => false): number | undefined {
  if (selected >= 0 && selected < count && !disabled(selected)) return selected
  return firstEnabled(count, (i) => !disabled(i))
}

// Typeahead: the next item, after `current`, whose label starts with what was typed. Repeating one
// letter cycles through the items that start with it, as menus and listboxes do on every platform.
export function typeahead(query: string, labels: string[], current: number, disabled: (index: number) => boolean = () => false): number | undefined {
  const q = query.toLocaleLowerCase()
  if (!q || !labels.length) return undefined
  const repeated = q.length > 1 && [...q].every((c) => c === q[0])
  const needle = repeated ? q[0] : q
  // A fresh multi-letter query may still match the current item; a single letter moves on.
  const start = needle.length > 1 ? Math.max(current, 0) : current + 1
  for (let n = 0; n < labels.length; n++) {
    const i = (start + n + labels.length) % labels.length
    if (!disabled(i) && labels[i].toLocaleLowerCase().startsWith(needle)) return i
  }
  return undefined
}

// Collects typed characters into a query that resets after a pause, so "re" finds "Rename" before "Remove"
// only when typed together. One instance per open widget.
export function createTypeahead(timeoutMs = 500) {
  let query = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    // Returns the query so far, or undefined when the key isn't a printable character.
    push(key: string): string | undefined {
      if (key.length !== 1 || key === ' ' && !query) return undefined
      query += key
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => (query = ''), timeoutMs)
      return query
    },
    reset() {
      query = ''
      if (timer) clearTimeout(timer)
    }
  }
}
