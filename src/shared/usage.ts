// Usage per chat tab and per workspace, from the chat's items. Each turn counts
// once per turnId: a forked tab starts with a copy of its parent's items, so the
// workspace total must not count the shared turns twice.
import { staticCapabilities } from './agentCatalog'
import type { AgentKind } from './agents'
import { createT, type TFunction } from './i18n'
import { turnAuthors } from './switchAgent'
import type { ChatItem, TabUsage, WorkspaceUsage } from './types'
import { historyAgentLabel } from './retiredAgents'

const enT = createT('en')

// ---- a turn's own cost ----

/** Whether the agent's result reports its conversation's running total rather than the turn's own cost (Claude: docs/telemetry.md). */
export function costIsRunningTotal(agent: string | undefined): boolean {
  return agent !== undefined && Boolean(staticCapabilities(agent)?.usage.costRunningTotal)
}

/**
 * A turn's own cost from the running total its result reported: what it added to `before`, the total its agent's previous
 * turn in the chat reported. A total below that one is a conversation that started again (a /clear, a fresh session after a
 * crash), so all of it is this turn's.
 */
export function ownCost(reported: number | undefined, before: number | undefined): number | undefined {
  if (reported === undefined) return undefined
  const added = reported - (before ?? 0)
  return added >= 0 ? added : reported
}

/**
 * Each turn's own cost in a chat, by turn id (undefined where its agent reported none). An agent that reports a running total
 * (Claude) has its turn's share taken from its own previous total in the chat, so another agent's turns in between, after a
 * switch, don't count; a turn with several results (a message steered in) is its last total less the one before the turn.
 * `agent` is the tab's agent, for turns whose message didn't record one.
 */
export function turnCosts(items: readonly ChatItem[], agent: AgentKind): Map<string, number | undefined> {
  const authors = turnAuthors(items as ChatItem[], { agent })
  const totals = new Map<AgentKind, number>()
  const turns = new Map<string, { reported?: number; before?: number; running: boolean }>()
  for (const item of items) {
    if (item.kind !== 'result') continue
    const by = authors.get(item.turnId)?.agent ?? agent
    let turn = turns.get(item.turnId)
    if (!turn) {
      const running = costIsRunningTotal(by)
      turn = { running, before: running ? totals.get(by) : undefined }
      turns.set(item.turnId, turn)
    }
    if (item.costUsd === undefined) continue
    turn.reported = item.costUsd
    if (turn.running) totals.set(by, item.costUsd)
  }
  return new Map([...turns].map(([turnId, t]) => [turnId, t.running ? ownCost(t.reported, t.before) : t.reported]))
}

// ---- usage per tab and workspace ----

interface TurnFigures {
  agentMs: number
  costUsd?: number
}

/** One entry per turn: its duration (from how it ended, else the result item) and its own cost where reported. */
function turnsOf(items: ChatItem[], agent?: AgentKind): Map<string, TurnFigures> {
  const costs = agent ? turnCosts(items, agent) : undefined
  const turns = new Map<string, TurnFigures>()
  for (const item of items) {
    if (item.kind !== 'result' && item.kind !== 'turn-end') continue
    const entry = turns.get(item.turnId) ?? { agentMs: 0 }
    if (item.kind === 'turn-end') entry.agentMs = item.durationMs ?? entry.agentMs
    else {
      const cost = costs ? costs.get(item.turnId) : item.costUsd
      if (cost !== undefined) entry.costUsd = cost
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

/** A tab's usage. With its agent, a running-total cost (Claude's) counts each turn's own share; without, costs count as reported. */
export function tabUsage(items: ChatItem[], agent?: AgentKind): TabUsage {
  return sum(turnsOf(items, agent).values())
}

export function workspaceUsage(tabs: { id: string; agent: AgentKind; items: ChatItem[] }[], t: TFunction = enT): WorkspaceUsage {
  const out: WorkspaceUsage = { tabs: {}, total: { turns: 0, agentMs: 0, costUsd: undefined, partial: false } }
  const seen = new Map<string, TurnFigures>()
  for (const tab of tabs) {
    const turns = turnsOf(tab.items, tab.agent)
    const usage = sum(turns.values())
    // O1: a tab that switched agents names the agents whose turns reported no cost at all.
    const unpriced = unpricedAgents(tab.items, tab.agent, turns)
    out.tabs[tab.id] = { ...usage, costNote: unpriced.length ? t('usage.costNaFor', { agents: unpriced.map((a) => historyAgentLabel(a)).join(', ') }) : undefined }
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
