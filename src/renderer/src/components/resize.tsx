// Drag-to-resize for the sidebar, the side panel and the terminal panel.
// Sizes are shared by every component that uses the same key and survive
// restarts. A pane nobody has resized follows its default.
import { useSyncExternalStore } from 'react'
import { useT } from '../i18n'
import { Resizer } from '../ui'

const STEP = 16
// null: no remembered size, use the default.
const sizes = new Map<string, number | null>()
const listeners = new Set<() => void>()

// Every size lives under this key, widths and heights alike (the name predates heights).
function storageKey(key: string): string {
  return `switchyard:width:${key}`
}

function readSize(key: string): number | null {
  const known = sizes.get(key)
  if (known !== undefined) return known
  let value: number | null = null
  try {
    const raw = localStorage.getItem(storageKey(key))
    const parsed = raw === null ? NaN : Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) value = parsed
  } catch {
    // Storage unavailable; use the default.
  }
  sizes.set(key, value)
  return value
}

function writeSize(key: string, value: number | null, persist: boolean): void {
  sizes.set(key, value)
  for (const listener of listeners) listener()
  if (!persist) return
  try {
    if (value === null) localStorage.removeItem(storageKey(key))
    else localStorage.setItem(storageKey(key), String(value))
  } catch {
    // Not persisted; fine.
  }
}

/** Forgets every remembered pane size, so each pane goes back to its default. */
export function resetPanelSizes(): void {
  for (const key of ['sidebar', 'side-panel', 'terminal-height', 'bottom-height']) writeSize(key, null, true)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribeWindow(listener: () => void): () => void {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

/** The window's width, re-rendering when it changes. */
export function useWindowWidth(): number {
  return useSyncExternalStore(subscribeWindow, () => window.innerWidth)
}

/** The window's height, re-rendering when it changes. */
export function useWindowHeight(): number {
  return useSyncExternalStore(subscribeWindow, () => window.innerHeight)
}

export interface PanelSize {
  size: number
  min: number
  max: number
  // Nobody has resized it: `size` is the default, and the pane may size itself with CSS instead.
  isDefault: boolean
  // Live while dragging; persist once the drag ends.
  set: (size: number, persist: boolean) => void
  reset: () => void
}

/**
 * A remembered panel size (width or height). `max` may change between renders
 * (window size); the remembered value is kept and clamped for display, so it
 * comes back when there is room again.
 */
export function usePanelSize(key: string, fallback: number, min: number, max: number): PanelSize {
  const preferred = useSyncExternalStore(subscribe, () => readSize(key))
  const ceiling = Math.max(min, max)
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, min), ceiling))
  return {
    size: clamp(preferred ?? fallback),
    min,
    max: ceiling,
    isDefault: preferred === null,
    set: (value, persist) => writeSize(key, clamp(value), persist),
    reset: () => writeSize(key, null, true)
  }
}

/**
 * A drag handle on a panel's edge. `edge` is the panel edge it sits on:
 * dragging away from the panel makes it bigger.
 */
export function ResizeHandle({ panel, edge, label }: { panel: PanelSize; edge: 'left' | 'right' | 'top' | 'bottom'; label: string }) {
  const t = useT()
  const vertical = edge === 'left' || edge === 'right'
  // The panel's size on screen: a default-sized pane may be sized by CSS rather than `panel.size`.
  const measure = (handle: HTMLElement) => {
    const box = handle.parentElement?.getBoundingClientRect()
    return box ? Math.round(vertical ? box.width : box.height) : panel.size
  }
  return (
    <Resizer
      label={label}
      edge={edge}
      value={panel.size}
      min={panel.min}
      max={panel.max}
      step={STEP}
      measure={measure}
      title={t('resize.title')}
      // Resizer reports nothing for a click without a move, so a default-sized pane stays on its default.
      onResize={panel.set}
      onReset={panel.reset}
    />
  )
}
