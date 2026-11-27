import { describe, expect, it } from 'vitest'
import { ownCost, tabUsage, turnCosts, usageLines, workspaceUsage } from '../src/shared/usage'
import type { ChatItem } from '../src/shared/types'

const turn = (turnId: string, durationMs: number, costUsd?: number): ChatItem[] => [
  { kind: 'result', id: `r:${turnId}`, turnId, ok: true, costUsd, durationMs },
  { kind: 'turn-end', id: `e:${turnId}`, turnId, outcome: 'completed', durationMs }
]
const fmt = (ms: number) => `${Math.round(ms / 1000)}s`

describe('usage', () => {
  it('sums turns, time and cost for a tab, counting a turn once', () => {
    const items = [...turn('a', 10_000, 0.1), ...turn('b', 5_000, 0.25), ...turn('a', 10_000, 0.1)]
    expect(tabUsage(items)).toEqual({ turns: 2, agentMs: 15_000, costUsd: 0.35 })
  })

  it('uses the result duration for chats from before turn-end items', () => {
    const items: ChatItem[] = [{ kind: 'result', id: 'r', turnId: 'a', ok: true, costUsd: 1, durationMs: 4000 }]
    expect(tabUsage(items)).toEqual({ turns: 1, agentMs: 4000, costUsd: 1 })
  })

  it('does not double count a forked tab that carries its parent\'s turns', () => {
    // Claude's costs are the conversation's running total: the turns cost 0.1, 0.2 and 0.05.
    const parent = [...turn('a', 10_000, 0.1), ...turn('b', 5_000, 0.3)]
    const fork = [...turn('a', 10_000, 0.1), ...turn('b', 5_000, 0.3), ...turn('c', 1_000, 0.35)]
    const usage = workspaceUsage([
      { id: 'p', agent: 'claude', items: parent },
      { id: 'f', agent: 'claude', items: fork }
    ])
    expect(usage.tabs.f).toMatchObject({ turns: 3 })
    expect(usage.total).toMatchObject({ turns: 3, agentMs: 16_000, partial: false })
    expect(usage.total.costUsd).toBeCloseTo(0.35)
  })

  it('labels the total partial when a tab with turns has no cost, and says why for the tab', () => {
    const usage = workspaceUsage([
      { id: 'c', agent: 'claude', items: turn('a', 2_000, 0.5) },
      { id: 'x', agent: 'codex', items: turn('b', 3_000) },
      { id: 'empty', agent: 'codex', items: [] }
    ])
    expect(usage.tabs.x).toMatchObject({ turns: 1, costUsd: undefined, costNote: 'Cost: n/a for Codex' })
    expect(usage.tabs.empty.costNote).toBeUndefined()
    expect(usage.total).toMatchObject({ turns: 2, agentMs: 5_000, costUsd: 0.5, partial: true })
  })

  it('counts what each Claude turn added to its running total, not the total again', () => {
    const items = [...turn('a', 1_000, 0.5), ...turn('b', 1_000, 1.25), ...turn('c', 1_000, 2)]
    expect(tabUsage(items, 'claude').costUsd).toBeCloseTo(2)
    expect([...turnCosts(items, 'claude').values()].map((c) => c?.toFixed(2))).toEqual(['0.50', '0.75', '0.75'])
    expect(workspaceUsage([{ id: 't', agent: 'claude', items }]).total.costUsd).toBeCloseTo(2)
    // An agent that reports each turn's own cost adds them up as they are.
    expect(tabUsage(items, 'opencode').costUsd).toBeCloseTo(3.75)
  })

  it('takes a Claude turn from Claude’s previous total, past another agent’s turns and a turn with two results', () => {
    const items: ChatItem[] = [
      { kind: 'user', id: 'u:a', turnId: 'a', text: 'one', at: '1', agent: 'claude', model: 'opus' },
      ...turn('a', 1_000, 1),
      { kind: 'user', id: 'u:b', turnId: 'b', text: 'two', at: '2', agent: 'opencode', model: 'x' },
      ...turn('b', 1_000, 0.2),
      { kind: 'user', id: 'u:c', turnId: 'c', text: 'three', at: '3', agent: 'claude', model: 'opus' },
      // A message steered in: two results in one turn, each the running total.
      { kind: 'result', id: 'r:c1', turnId: 'c', ok: true, costUsd: 1.5 },
      ...turn('c', 1_000, 1.75)
    ]
    const costs = turnCosts(items, 'claude')
    expect(costs.get('a')).toBe(1)
    expect(costs.get('b')).toBe(0.2)
    expect(costs.get('c')).toBeCloseTo(0.75)
  })

  it('reads a total that went down as a conversation that started again', () => {
    expect(ownCost(0.4, 2)).toBe(0.4)
    expect(ownCost(2.5, 2)).toBe(0.5)
    expect(ownCost(undefined, 2)).toBeUndefined()
    expect(ownCost(0.3, undefined)).toBe(0.3)
  })

  it('is not partial when no tab has turns', () => {
    expect(workspaceUsage([{ id: 'x', agent: 'codex', items: [] }]).total).toMatchObject({ turns: 0, partial: false })
  })

  it('formats tooltip lines', () => {
    expect(usageLines({ turns: 1, agentMs: 4000, costUsd: 0.5 }, fmt)).toBe('1 turn · 4s · $0.50')
    expect(usageLines({ turns: 2, agentMs: 4000, costNote: 'Cost: n/a for Codex' }, fmt)).toBe('2 turns · 4s · Cost: n/a for Codex')
  })
})
