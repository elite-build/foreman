// The renderer's copy of Claude's and Codex's sign-in status, for the picker, New workspace and the in-chat sign-in
// card. Asked for when a component needs it (not pushed): on first use, when a saved key changes, when the window
// regains focus, and whenever Settings → Agents re-checks (it records its answer here).
import { useEffect, useSyncExternalStore } from 'react'
import { agentReadiness, type AgentReadiness } from '../../shared/agentReadiness'
import { AGENTS, preferAgentLoadout, type AgentKind } from '../../shared/agents'
import type { AgentStatus } from '../../shared/types'
import { t } from './i18n'
import { api, attempt, getState, showToast, useStore } from './store'

type Statuses = Partial<Record<AgentKind, AgentStatus>>

// The agents whose sign-in the main process can check from outside a turn.
const CHECKED: AgentKind[] = ['claude', 'codex']
// A status this fresh is reused when another component mounts.
const FRESH_MS = 30_000

let statuses: Statuses = {}
let checkedAt = 0
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: Statuses): void {
  statuses = next
  for (const listener of listeners) listener()
}

/** Settings → Agents' own re-check (after a sign-in) shares its answer with everything else. */
export function recordAgentStatus(status: AgentStatus | null | undefined): void {
  if (!status || !CHECKED.includes(status.agent)) return
  publish({ ...statuses, [status.agent]: status })
  checkedAt = Date.now()
}

/** Asks for Claude's and Codex's status again. Without `force`, an answer under 30 s old stands. */
export function refreshAgentStatuses(force = false): Promise<void> {
  if (inflight) return inflight
  if (!force && Date.now() - checkedAt < FRESH_MS && Object.keys(statuses).length > 0) return Promise.resolve()
  const work = Promise.all(CHECKED.map((agent) => Promise.resolve(api.agentStatus(agent)).catch(() => undefined)))
    .then((answers) => {
      const next: Statuses = { ...statuses }
      for (const answer of answers) if (answer) next[answer.agent] = answer
      checkedAt = Date.now()
      publish(next)
    })
    .finally(() => {
      inflight = null
    })
  inflight = work
  return work
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Claude's and Codex's last known status; asks on first use and again when a saved key changes or the window is focused. */
export function useAgentStatuses(): Statuses {
  // A saved key changes the answer (Foreman hands it to the agent).
  const keys = useStore((s) => `${s.snapshot?.agentKeys?.ANTHROPIC_API_KEY ?? ''}|${s.snapshot?.agentKeys?.CODEX_API_KEY ?? ''}`)
  useEffect(() => {
    void refreshAgentStatuses(true)
  }, [keys])
  useEffect(() => {
    const onFocus = () => void refreshAgentStatuses()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return useSyncExternalStore(subscribe, () => statuses)
}

/** What the evidence says about one agent (see shared/agentReadiness.ts). */
export function useAgentReadiness(agent: AgentKind): AgentReadiness {
  const all = useAgentStatuses()
  const keySaved = useStore((s) => s.snapshot?.agentKeys?.CURSOR_API_KEY !== undefined)
  const installed = useStore((s) => s.opencodeInstalled)
  return agentReadiness(agent, { status: all[agent], keySaved, installed })
}

/** "Use for new workspaces": the agent's first loadout moves to the top, so new workspaces start with it. */
export async function setAgentForNewWorkspaces(agent: AgentKind): Promise<boolean> {
  const loadouts = getState().snapshot?.settings.loadouts ?? []
  const next = preferAgentLoadout(loadouts, agent)
  if (next !== loadouts) {
    const saved = await attempt(() => api.updateSettings({ loadouts: next }))
    if (!saved) return false
  }
  showToast(t('agentSettings.useForNew.done', { agent: AGENTS[agent].label }), 'info')
  return true
}

/** Whether the agent's first loadout is already the top one (nothing to move), or it has none. */
export function isFirstLoadout(loadouts: { agent: string }[], agent: AgentKind): boolean {
  return loadouts[0]?.agent === agent
}

/** Test seam: forget what was asked. */
export function resetAgentStatuses(): void {
  statuses = {}
  checkedAt = 0
  inflight = null
  for (const listener of listeners) listener()
}
