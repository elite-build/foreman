// #22: Terminal agent tabs in a workspace's tab strip, next to its chats. Pure
// state so the renderer and tests share it. Tabs aren't kept across restarts:
// the agent's process ends with the app, and Foreman never restarts it.

export interface AgentTab {
  key: string
  agent: string
  // Bumped by Restart: a new process in the same tab.
  run: number
}

export interface WorkspaceAgentTabs {
  tabs: AgentTab[]
  // The tab shown instead of the chat, or null when a chat is shown.
  active: string | null
}

export type AgentTabsState = Record<string, WorkspaceAgentTabs>

const EMPTY: WorkspaceAgentTabs = { tabs: [], active: null }

export function tabsOf(state: AgentTabsState, workspaceId: string): WorkspaceAgentTabs {
  return state[workspaceId] ?? EMPTY
}

/** Opens a new tab for the agent and shows it. Each open is its own process, so two Aider tabs are two Aiders. */
export function openAgentTab(state: AgentTabsState, workspaceId: string, agent: string, key: string): AgentTabsState {
  const current = tabsOf(state, workspaceId)
  return { ...state, [workspaceId]: { tabs: [...current.tabs, { key, agent, run: 0 }], active: key } }
}

/** Shows a tab, or the chat with null. */
export function showAgentTab(state: AgentTabsState, workspaceId: string, key: string | null): AgentTabsState {
  const current = tabsOf(state, workspaceId)
  if (current.active === key || (key !== null && !current.tabs.some((t) => t.key === key))) return state
  return { ...state, [workspaceId]: { ...current, active: key } }
}

/** Closes a tab; if it was shown, the chat comes back. */
export function closeAgentTab(state: AgentTabsState, workspaceId: string, key: string): AgentTabsState {
  const current = tabsOf(state, workspaceId)
  const tabs = current.tabs.filter((t) => t.key !== key)
  const next = { ...state }
  if (!tabs.length) delete next[workspaceId]
  else next[workspaceId] = { tabs, active: current.active === key ? null : current.active }
  return next
}

export function restartAgentTab(state: AgentTabsState, workspaceId: string, key: string): AgentTabsState {
  const current = tabsOf(state, workspaceId)
  return { ...state, [workspaceId]: { ...current, tabs: current.tabs.map((t) => (t.key === key ? { ...t, run: t.run + 1 } : t)) } }
}

/** Closing a tab whose agent printed something in the last 10 seconds asks first: it may be mid-edit. */
export const CLOSE_CONFIRM_MS = 10_000

export function closeNeedsConfirm(lastOutputAt: number | undefined, exited: boolean, now: number): boolean {
  return !exited && lastOutputAt !== undefined && now - lastOutputAt < CLOSE_CONFIRM_MS
}
