// O5: the Changes panel's diff source, remembered per workspace in localStorage
// (like the panel widths), with the commits picked for "Pick commits…".
import { useCallback, useState } from 'react'
import { DIFF_SOURCES } from '../../../shared/diffSource'
import type { DiffScope } from '../../../shared/types'

export interface DiffSourceChoice {
  scope: DiffScope
  picked: string[]
}

const KEY = 'foreman:diffSource'
const DEFAULT: DiffSourceChoice = { scope: 'all', picked: [] }

function readAll(): Record<string, Partial<DiffSourceChoice>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, Partial<DiffSourceChoice>>) : {}
  } catch {
    return {}
  }
}

export function loadDiffSource(workspaceId: string): DiffSourceChoice {
  const saved = readAll()[workspaceId]
  const scope = (DIFF_SOURCES as readonly string[]).includes(saved?.scope ?? '') ? saved!.scope! : DEFAULT.scope
  const picked = Array.isArray(saved?.picked) ? saved.picked.filter((s): s is string => typeof s === 'string') : []
  // A picked source with nothing picked would show nothing.
  return scope === 'picked' && !picked.length ? DEFAULT : { scope, picked }
}

function saveDiffSource(workspaceId: string, choice: DiffSourceChoice): void {
  try {
    const all = readAll()
    if (choice.scope === 'all' && !choice.picked.length) delete all[workspaceId]
    else all[workspaceId] = choice
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // Not persisted; fine.
  }
}

/** The workspace's source and a setter that remembers it. */
export function useDiffSource(workspaceId: string): [DiffSourceChoice, (next: DiffSourceChoice | ((prev: DiffSourceChoice) => DiffSourceChoice)) => void] {
  const [choice, setChoice] = useState(() => loadDiffSource(workspaceId))
  const set = useCallback(
    (next: DiffSourceChoice | ((prev: DiffSourceChoice) => DiffSourceChoice)) =>
      setChoice((prev) => {
        const value = typeof next === 'function' ? next(prev) : next
        saveDiffSource(workspaceId, value)
        return value
      }),
    [workspaceId]
  )
  return [choice, set]
}
