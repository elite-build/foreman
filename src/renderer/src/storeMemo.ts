import { useRef } from 'react'
import { activeSessionId, useStore } from './store'

type StoreState = Parameters<Parameters<typeof useStore>[0]>[0]

/**
 * `useStore` for a value worked out from a few parts of the state. Every store event reads every selector, and the chats
 * stream hundreds of them: `derive` runs again only when one of `inputs` is a different value (compared by identity), so
 * an expensive selector costs a few comparisons on the events that don't touch what it reads. `derive` must read nothing
 * but its inputs (props it closes over go in `inputs` too).
 */
export function useStoreMemo<const I extends readonly unknown[], T>(inputs: (s: StoreState) => I, derive: (inputs: I, s: StoreState) => T): T {
  const cache = useRef<{ inputs: I; value: T } | null>(null)
  return useStore((s) => {
    const next = inputs(s)
    const was = cache.current
    if (was && was.inputs.length === next.length && was.inputs.every((v, i) => Object.is(v, next[i]))) return was.value
    const value = derive(next, s)
    cache.current = { inputs: next, value }
    return value
  })
}

/** The tab shown in a workspace (`activeSessionId`), worked out again only when the tabs or the remembered one change. */
export function useActiveSessionId(workspaceId: string): string | undefined {
  return useStoreMemo(
    (s) => [workspaceId, s.snapshot?.workspaces, s.snapshot?.sessions, s.activeSession?.[workspaceId]],
    (_, s) => activeSessionId(s, workspaceId)
  )
}
