import { describe, expect, it } from 'vitest'
import { tabUsage, usageLines, workspaceUsage } from '../src/shared/usage'
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
    const parent = [...turn('a', 10_000, 0.1), ...turn('b', 5_000, 0.2)]
    const fork = [...turn('a', 10_000, 0.1), ...turn('b', 5_000, 0.2), ...turn('c', 1_000, 0.05)]
    const usage = workspaceUsage([
      { id: 'p', agent: 'claude', items: parent },
      { id: 'f', agent: 'claude', items: fork }
    ])
    expect(usage.tabs.f).toMatchObject({ turns: 3 })
    expect(usage.total).toEqual({ turns: 3, agentMs: 16_000, costUsd: 0.35000000000000003, partial: false })
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

  it('is not partial when no tab has turns', () => {
    expect(workspaceUsage([{ id: 'x', agent: 'codex', items: [] }]).total).toMatchObject({ turns: 0, partial: false })
  })

  it('formats tooltip lines', () => {
    expect(usageLines({ turns: 1, agentMs: 4000, costUsd: 0.5 }, fmt)).toBe('1 turn · 4s · $0.50')
    expect(usageLines({ turns: 2, agentMs: 4000, costNote: 'Cost: n/a for Codex' }, fmt)).toBe('2 turns · 4s · Cost: n/a for Codex')
  })
})
