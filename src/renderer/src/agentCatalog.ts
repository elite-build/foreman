// #22: the renderer's copy of the agent catalog view (what's installed, what
// Chat agents declared, key names in the shell) and of the Terminal agents
// running now. Both are asked for when a page needs them, not pushed: the
// catalog once per session and again on "Check again", the runs every couple of
// seconds while any Terminal agent tab is open.
import { useEffect, useSyncExternalStore } from 'react'
import type { AgentCatalogView, TerminalAgentRun } from '../../shared/agentCatalog'
import { api } from './store'

type Listener = () => void

function createSlice<T>(initial: T) {
  let value = initial
  const listeners = new Set<Listener>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      for (const l of listeners) l()
    },
    subscribe(l: Listener) {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
}

// ---- catalog view ----

const catalog = createSlice<{ view: AgentCatalogView | null; loading: boolean; error: string | null }>({ view: null, loading: false, error: null })
let inflight: Promise<void> | null = null

/** Fetch the view (the main process checks every agent the first time, and again with `refresh`). */
export function loadAgentCatalog(refresh = false): Promise<void> {
  if (inflight && !refresh) return inflight
  catalog.set({ ...catalog.get(), loading: true })
  const work = api
    .agentCatalog(refresh)
    .then((view) => catalog.set({ view, loading: false, error: null }))
    .catch((err: unknown) => catalog.set({ ...catalog.get(), loading: false, error: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      if (inflight === work) inflight = null
    })
  inflight = work
  return work
}

export function useAgentCatalog() {
  const state = useSyncExternalStore(catalog.subscribe, catalog.get)
  useEffect(() => {
    if (!catalog.get().view && !inflight) void loadAgentCatalog()
  }, [])
  return { ...state, refresh: () => loadAgentCatalog(true) }
}

// ---- Terminal agent runs ----

const runs = createSlice<TerminalAgentRun[]>([])
let timer: ReturnType<typeof setInterval> | null = null
const POLL_MS = 2000

async function pollRuns(): Promise<void> {
  const next = await api.terminalAgentRuns().catch(() => null)
  if (!next) return
  runs.set(next)
  if (!next.length && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Ask again now (after starting or closing one), and keep asking while any run is open. */
export function refreshTerminalAgentRuns(): void {
  void pollRuns()
  timer ??= setInterval(() => void pollRuns(), POLL_MS)
}

let started = false

export function useTerminalAgentRuns(): TerminalAgentRun[] {
  useEffect(() => {
    if (started) return
    started = true
    refreshTerminalAgentRuns()
  }, [])
  return useSyncExternalStore(runs.subscribe, runs.get)
}

/** A clock that ticks every second while anything shows a live time, for "output 2s ago". */
const clock = createSlice(Date.now())
let ticking = 0
let tick: ReturnType<typeof setInterval> | null = null
export function useSecondClock(on: boolean): number {
  useEffect(() => {
    if (!on) return
    if (ticking++ === 0) tick = setInterval(() => clock.set(Date.now()), 1000)
    return () => {
      if (--ticking === 0 && tick) {
        clearInterval(tick)
        tick = null
      }
    }
  }, [on])
  return useSyncExternalStore(clock.subscribe, clock.get)
}
