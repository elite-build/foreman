// The diff view's layout and wrap choice: one app-wide preference shared by
// every open diff and kept in localStorage across restarts (like the panel widths).
import { useSyncExternalStore } from 'react'
import type { DiffLayout } from '../../../shared/splitDiff'

export interface DiffPrefs {
  layout: DiffLayout
  wrap: boolean
  // G3 · O6: "Force split" keeps two columns below the width limit.
  forceSplit: boolean
}

const KEY = 'switchyard:diffView'
// Unified as before, so unified for a screen reader's user until they choose split (nothing here overrides a stored choice;
// the toggle says unified is the one to use). Long lines wrap as they always have.
const DEFAULTS: DiffPrefs = { layout: 'unified', wrap: true, forceSplit: false }

function load(): DiffPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DiffPrefs>
    return {
      layout: raw.layout === 'split' ? 'split' : 'unified',
      wrap: typeof raw.wrap === 'boolean' ? raw.wrap : DEFAULTS.wrap,
      forceSplit: raw.forceSplit === true
    }
  } catch {
    return DEFAULTS
  }
}

let prefs = load()
const listeners = new Set<() => void>()

export function setDiffPrefs(patch: Partial<DiffPrefs>): void {
  prefs = { ...prefs, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Not persisted; fine.
  }
  for (const listener of listeners) listener()
}

export function useDiffPrefs(): DiffPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => prefs
  )
}
