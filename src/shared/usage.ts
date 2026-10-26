// Usage per chat tab and per workspace, from the chat's items. Each turn counts
// once per turnId: a forked tab starts with a copy of its parent's items, so the
// workspace total must not count the shared turns twice.
import { AGENTS, type AgentKind } from './agents'
import { createT, type TFunction } from './i18n'
import { turnAuthors } from './switchAgent'
import type { ChatItem, TabUsage, WorkspaceUsage } from './types'

const enT = createT('en')

interface TurnFigures {
  agentMs: number
  costUsd?: number
}

/** One entry per turn: its duration (from how it ended, else the result item) and cost where reported. */
function turnsOf(items: ChatItem[]): Map<string, TurnFigures> {
  const turns = new Map<string, TurnFigures>()
  for (const item of items) {
    if (item.kind !== 'result' && item.kind !== 'turn-end') continue
    const entry = turns.get(item.turnId) ?? { agentMs: 0 }
    if (item.kind === 'turn-end') entry.agentMs = item.durationMs ?? entry.agentMs
    else {
      if (item.costUsd !== undefined) entry.costUsd = item.costUsd
      if (item.durationMs !== undefined && !entry.agentMs) entry.agentMs = item.durationMs
    }
    turns.set(item.turnId, entry)
  }
  return turns
}

function sum(turns: Iterable<TurnFigures>): TabUsage {
  let turnCount = 0
  let agentMs = 0
  let cost = 0
  let reported = false
  for (const t of turns) {
    turnCount++
    agentMs += t.agentMs
    if (t.costUsd !== undefined) {
      cost += t.costUsd
      reported = true
    }
  }
  return { turns: turnCount, agentMs, costUsd: reported ? cost : undefined }
}

export function tabUsage(items: ChatItem[]): TabUsage {
  return sum(turnsOf(items).values())
}

export function workspaceUsage(tabs: { id: string; agent: AgentKind; items: ChatItem[] }[], t: TFunction = enT): WorkspaceUsage {
  const out: WorkspaceUsage = { tabs: {}, total: { turns: 0, agentMs: 0, costUsd: undefined, partial: false } }
  const seen = new Map<string, TurnFigures>()
  for (const tab of tabs) {
    const turns = turnsOf(tab.items)
    const usage = sum(turns.values())
    // O1: a tab that switched agents names the agents whose turns reported no cost at all.
    const unpriced = unpricedAgents(tab.items, tab.agent, turns)
    out.tabs[tab.id] = { ...usage, costNote: unpriced.length ? t('usage.costNaFor', { agents: unpriced.map((a) => AGENTS[a]?.label ?? a).join(', ') }) : undefined }
    // A tab with turns but no reported cost (for some agent) makes the total partial.
    if (unpriced.length) out.total.partial = true
    for (const [turnId, figures] of turns) {
      const earlier = seen.get(turnId)
      // The copy with a reported cost wins, if the copies differ.
      if (!earlier || (earlier.costUsd === undefined && figures.costUsd !== undefined)) seen.set(turnId, figures)
    }
  }
  const total = sum(seen.values())
  out.total = { ...total, partial: out.total.partial }
  return out
}

/** The agents that ran turns in this tab but reported no cost for any of them (for a one-agent tab: its agent, when nothing was reported). */
function unpricedAgents(items: ChatItem[], agent: AgentKind, turns: Map<string, TurnFigures>): AgentKind[] {
  const authors = turnAuthors(items, { agent })
  const priced = new Map<AgentKind, boolean>()
  for (const [turnId, figures] of turns) {
    const by = authors.get(turnId)?.agent ?? agent
    priced.set(by, Boolean(priced.get(by)) || figures.costUsd !== undefined)
  }
  return [...priced].filter(([, p]) => !p).map(([a]) => a)
}

/** "3 turns · 4m 12s · $0.42" for a tab's tooltip, or the reason cost is missing. */
export function usageLines(usage: TabUsage & { costNote?: string }, formatDuration: (ms: number) => string, t: TFunction = enT): string {
  const parts = [t('usage.turns', { count: usage.turns }), formatDuration(usage.agentMs)]
  parts.push(usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(2)}` : usage.costNote ?? t('usage.costNa'))
  return parts.join(' · ')
}
