// Settings → Usage: cost, turns and agent time across every workspace for the
// last 7, 30 or 90 days, grouped by repository and by model. Pure aggregation
// over per-item rows, so it can be tested without a database.
//
// Honesty rules: a cost nobody reported stays unknown (never 0), and a total that
// leaves any turn out is partial. A turn that exists in several chats (a fork
// carries its parent's turns; an imported copy carries the original's) counts once.
import type { AgentKind } from './agents'

/** One chat item that bears on usage: who wrote it, which turn, when, and what it says about cost and time. */
export interface UsageRow {
  sessionId: string
  turnId: string
  kind: 'user' | 'result' | 'turn-end'
  at: string
  costUsd?: number
  durationMs?: number
  // O1: on a message, the agent and model it was sent to (a tab can switch agents).
  agent?: AgentKind
  model?: string
}

export interface UsageSession {
  id: string
  workspaceId: string
  agent: AgentKind
  model: string
  createdAt: string
}

export interface UsageWorkspace {
  id: string
  repoId: string
  // Came from an export file: the original wins when both are here.
  imported: boolean
  createdAt: string
}

export interface UsageFigures {
  turns: number
  agentMs: number
  // The sum of the costs that were reported; null when none were.
  costUsd: number | null
  // Turns whose cost the agent reported, and those it did not.
  costKnownTurns: number
  costUnknownTurns: number
  // Some turn is missing its cost, so costUsd is a lower bound.
  partial: boolean
  workspaceIds: string[]
}

export interface UsageReport {
  days: number
  since: string
  total: UsageFigures
  byRepo: (UsageFigures & { repoId: string })[]
  byModel: (UsageFigures & { agent: AgentKind; model: string })[]
}

interface Turn {
  turnId: string
  sessionId: string
  startedAt: string
  agentMs: number
  costUsd?: number
  // O1: who answered it, when its message recorded that.
  by?: { agent: AgentKind; model: string }
}

/** The turns in these rows, once each, from the chat that owns them. */
function collectTurns(rows: UsageRow[], sessions: Map<string, UsageSession>, workspaces: Map<string, UsageWorkspace>): Turn[] {
  const byTurn = new Map<string, { owners: Map<string, { start?: string; first: string; agentMs: number; cost?: number; ended: boolean; by?: Turn['by'] }> }>()
  for (const row of rows) {
    const turn = byTurn.get(row.turnId) ?? { owners: new Map() }
    byTurn.set(row.turnId, turn)
    const own = turn.owners.get(row.sessionId) ?? { first: row.at, agentMs: 0, ended: false }
    turn.owners.set(row.sessionId, own)
    if (row.at < own.first) own.first = row.at
    if (row.kind === 'user' && (!own.start || row.at < own.start)) own.start = row.at
    if (row.kind === 'user' && row.agent && row.model) own.by = { agent: row.agent, model: row.model }
    if (row.kind !== 'user') own.ended = true
    if (row.kind === 'turn-end') own.agentMs = row.durationMs ?? own.agentMs
    if (row.kind === 'result') {
      if (row.costUsd !== undefined) own.cost = row.costUsd
      if (row.durationMs !== undefined && !own.agentMs) own.agentMs = row.durationMs
    }
  }
  const out: Turn[] = []
  for (const [turnId, { owners }] of byTurn) {
    // Only chats that still exist, and of those the original: a native chat before an imported copy, then the oldest.
    const candidates = [...owners].filter(([sessionId]) => sessions.has(sessionId))
    if (!candidates.length) continue
    candidates.sort(([a], [b]) => {
      const sa = sessions.get(a)!
      const sb = sessions.get(b)!
      const ia = workspaces.get(sa.workspaceId)?.imported ? 1 : 0
      const ib = workspaces.get(sb.workspaceId)?.imported ? 1 : 0
      return ia - ib || sa.createdAt.localeCompare(sb.createdAt) || a.localeCompare(b)
    })
    const [sessionId, owner] = candidates[0]
    // A copy with a reported cost beats one without, if copies disagree.
    const cost = candidates.map(([, o]) => o.cost).find((c) => c !== undefined)
    // A turn needs its end or result to count (the same rule as a tab's usage).
    if (!candidates.some(([, o]) => o.ended)) continue
    out.push({ turnId, sessionId, startedAt: owner.start ?? owner.first, agentMs: Math.max(...candidates.map(([, o]) => o.agentMs)), costUsd: cost, by: owner.by })
  }
  return out
}

function figures(turns: Turn[], sessions: Map<string, UsageSession>): UsageFigures {
  let cost = 0
  let known = 0
  let agentMs = 0
  const ws = new Set<string>()
  for (const t of turns) {
    agentMs += t.agentMs
    if (t.costUsd !== undefined) {
      cost += t.costUsd
      known++
    }
    ws.add(sessions.get(t.sessionId)!.workspaceId)
  }
  return { turns: turns.length, agentMs, costUsd: known ? cost : null, costKnownTurns: known, costUnknownTurns: turns.length - known, partial: known < turns.length, workspaceIds: [...ws] }
}

function group<K>(turns: Turn[], keyOf: (t: Turn) => K, id: (k: K) => string): Map<string, { key: K; turns: Turn[] }> {
  const groups = new Map<string, { key: K; turns: Turn[] }>()
  for (const t of turns) {
    const key = keyOf(t)
    const g = groups.get(id(key)) ?? { key, turns: [] }
    g.turns.push(t)
    groups.set(id(key), g)
  }
  return groups
}

/** Most spend first; groups with no reported cost after those, biggest by turns. */
const byImportance = (a: UsageFigures, b: UsageFigures) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.turns - a.turns

export function usageReport(input: { rows: UsageRow[]; sessions: UsageSession[]; workspaces: UsageWorkspace[]; days: number; now: Date }): UsageReport {
  const sessions = new Map(input.sessions.map((s) => [s.id, s]))
  const workspaces = new Map(input.workspaces.map((w) => [w.id, w]))
  const since = new Date(input.now.getTime() - input.days * 24 * 3600 * 1000).toISOString()
  const turns = collectTurns(input.rows, sessions, workspaces).filter((t) => t.startedAt >= since && t.startedAt <= input.now.toISOString())
  const repoOf = (t: Turn) => workspaces.get(sessions.get(t.sessionId)!.workspaceId)?.repoId ?? ''
  // O1: the model that answered the turn, when recorded; older turns count under the chat's current model.
  const modelOf = (t: Turn) => {
    const s = sessions.get(t.sessionId)!
    return t.by ?? { agent: s.agent, model: s.model }
  }
  return {
    days: input.days,
    since,
    total: figures(turns, sessions),
    byRepo: [...group(turns, repoOf, (k) => k).values()].map((g) => ({ repoId: g.key, ...figures(g.turns, sessions) })).sort(byImportance),
    byModel: [...group(turns, modelOf, (k) => `${k.agent}\u0000${k.model}`).values()].map((g) => ({ ...g.key, ...figures(g.turns, sessions) })).sort(byImportance)
  }
}

/** "$84.20+" for a partial total, "$84.20" for a complete one, null when no cost was reported (show "unknown", never $0). */
export function costText(f: Pick<UsageFigures, 'costUsd' | 'partial'>): string | null {
  if (f.costUsd === null) return null
  return `$${f.costUsd.toFixed(2)}${f.partial ? '+' : ''}`
}
