// A background task (or tool call) the log still calls running only runs while its turn does: one left behind by a
// turn that Foreman quit or crashed during shows as stopped, not in "Running in the background" for hours.
import { describe, expect, it } from 'vitest'
import { settleItems } from '../src/shared/liveItems'
import type { ChatItem } from '../src/shared/types'

type Tool = Extract<ChatItem, { kind: 'tool' }>

const tool = (id: string, turnId: string, patch: Partial<Tool> = {}): Tool => ({ kind: 'tool', id, turnId, name: 'Bash', input: {}, status: 'done', ...patch })
const bg = { status: 'running' as const, background: true, startedAt: '2026-10-24T10:00:00Z' }

describe('settleItems', () => {
  it('stops a background task left running by a turn that ended', () => {
    const items: ChatItem[] = [tool('a', 't1', { task: bg }), { kind: 'turn-end', id: 'turn-end:t1', turnId: 't1', outcome: 'interrupted' } as ChatItem]
    const [a] = settleItems(items, undefined) as Tool[]
    expect(a.task).toEqual({ ...bg, status: 'stopped' })
    // Also when a later turn is the one running.
    expect((settleItems(items, 't2')[0] as Tool).task?.status).toBe('stopped')
  })

  it('leaves the running turn alone', () => {
    const items: ChatItem[] = [tool('a', 't2', { task: bg, status: 'running' })]
    expect(settleItems(items, 't2')).toBe(items)
  })

  it('ends a tool call its turn never answered', () => {
    const [a] = settleItems([tool('a', 't1', { status: 'running' })], 't2') as Tool[]
    expect(a.status).toBe('error')
    expect(a.output).toBe('Interrupted.')
  })

  it('returns the same array when nothing was left running', () => {
    const items: ChatItem[] = [tool('a', 't1', { task: { ...bg, status: 'completed' } }), tool('b', 't1')]
    expect(settleItems(items, undefined)).toBe(items)
  })
})
