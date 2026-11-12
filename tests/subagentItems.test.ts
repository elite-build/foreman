// Subagents as first-class (docs/agents.md 6): a subagent's own calls and messages are items with `parentToolUseId`, kept in the
// chat for its Task row and left out of everything that reads the chat as the parent agent's.
import { describe, expect, it } from 'vitest'
import { readTurn } from '../src/main/cli/ask'
import { chatTurns } from '../src/shared/chatHandOff'
import { carriedHistory } from '../src/shared/fork'
import { lastAnswer, turnAnswer } from '../src/shared/handOff'
import { itemText } from '../src/shared/itemText'
import { chatItemsOut, renderChat } from '../src/shared/cli/tabs'
import { reviewFromChat } from '../src/shared/stopSafely'
import { childItemsOf, isChildItem, isSubagentCall, subagentName, withoutChildren } from '../src/shared/subagents'
import { chatToMarkdown } from '../src/shared/transcript'
import { stepsIn } from '../src/shared/agentHost'
import { settleItems } from '../src/shared/liveItems'
import type { ChatItem } from '../src/shared/types'

const at = '2026-10-27T10:00:00.000Z'
const items: ChatItem[] = [
  { kind: 'user', id: 'u1', turnId: 't1', text: 'Fix the tests', at },
  { kind: 'assistant', id: 'a1', turnId: 't1', text: 'I will split this up' },
  { kind: 'tool', id: 'tu1', turnId: 't1', name: 'Task', input: { description: 'explore-tests' }, status: 'done', output: 'They share a tmpdir', childId: 'task-1', task: { status: 'completed' } },
  { kind: 'tool', id: 'c1', turnId: 't1', name: 'Grep', input: { pattern: 'secret-needle' }, status: 'done', output: 'a hit in a child', parentToolUseId: 'tu1' },
  { kind: 'assistant', id: 'm1', turnId: 't1', text: 'child said this', parentToolUseId: 'tu1' },
  { kind: 'assistant', id: 'a2', turnId: 't1', text: 'The failures share a tmpdir' },
  { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed' }
]

describe('a subagent’s items', () => {
  it('are told from the parent’s, and grouped under the call that started them', () => {
    expect(items.filter(isChildItem).map((i) => i.id)).toEqual(['c1', 'm1'])
    expect(withoutChildren(items).map((i) => i.id)).toEqual(['u1', 'a1', 'tu1', 'a2', 'e1'])
    expect([...childItemsOf(items)].map(([id, list]) => [id, list.map((i) => i.id)])).toEqual([['tu1', ['c1', 'm1']]])
    // No subagent: the same array, so a memo that reads it stays equal.
    const plain = items.filter((i) => !isChildItem(i))
    expect(withoutChildren(plain)).toBe(plain)
  })

  it('make a Task call a subagent only when the agent said a task started, or items hang under it', () => {
    const [, , call] = items as [ChatItem, ChatItem, Extract<ChatItem, { kind: 'tool' }>]
    expect(isSubagentCall(call)).toBe(true)
    expect(isSubagentCall({ ...call, childId: undefined })).toBe(false)
    expect(isSubagentCall({ ...call, childId: undefined }, true)).toBe(true)
    expect(isSubagentCall({ ...call, name: 'Bash' })).toBe(false)
  })

  it('name the subagent by what it was asked to do, else its type', () => {
    expect(subagentName({ description: ' explore-tests ', subagent_type: 'Explore' })).toBe('explore-tests')
    expect(subagentName({ subagent_type: 'Explore' })).toBe('Explore')
    expect(subagentName(undefined, 'fallback')).toBe('fallback')
  })

  it('are not searched: no hit would have a row of its own to jump to', () => {
    expect(itemText(items[3])).toEqual({ text: null, toolText: null })
    expect(itemText(items[4])).toEqual({ text: null, toolText: null })
    expect(itemText(items[5]).text).toBe('The failures share a tmpdir')
  })

  it('are not the parent’s last answer, nor part of the turn’s answer', () => {
    expect(lastAnswer(items)?.id).toBe('a2')
    // Even as the last thing in the log.
    expect(lastAnswer([...items.slice(0, 2), items[4]])?.id).toBe('a1')
    expect(turnAnswer(items, 't1')).toBe('I will split this up\n\nThe failures share a tmpdir')
    expect(readTurn(items).answer).toBe('I will split this up\n\nThe failures share a tmpdir')
  })

  it('stay out of a copy, an export, a hand-off, the CLI’s text and JSON, and the counts', () => {
    expect(chatToMarkdown(items, { toolOutput: true })).not.toMatch(/secret-needle|child said/)
    expect(chatToMarkdown(items, { toolOutput: true })).toContain('They share a tmpdir')
    expect(carriedHistory(items, 'switch').text).not.toMatch(/child said/)
    expect(renderChat(items, { toolOutput: true })).not.toMatch(/secret-needle|child said/)
    expect(chatItemsOut(items, true).map((i) => i.id)).toEqual(['u1', 'a1', 'tu1', 'a2', 'e1'])
    expect(chatTurns(items, { agent: 'claude' })[0]).toMatchObject({ answers: ['I will split this up', 'The failures share a tmpdir'], tools: 1 })
    expect(reviewFromChat('t1', items).lastStep?.name).toBe('Task')
    expect(stepsIn(items)).toBe(1)
  })

  it('are settled with their turn: a call left running by an earlier turn reads as stopped', () => {
    const running = { ...(items[3] as Extract<ChatItem, { kind: 'tool' }>), status: 'running' as const }
    const settled = settleItems([running], 't2')
    expect(settled[0]).toMatchObject({ status: 'error', parentToolUseId: 'tu1' })
  })
})
