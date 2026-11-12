// Switching agents with a recorded hand-off (docs/agents.md 5): the pure builder, the text, the strategies, read_chat_history.
import { describe, expect, it } from 'vitest'
import {
  buildHandOff,
  chatTurns,
  chooseStrategy,
  clampBudget,
  CONDENSED_CHARS,
  describeHandOff,
  estimateTokens,
  HAND_OFF_BUDGET,
  handOffRecord,
  numberRanges,
  readChatHistory,
  renderHandOff
} from '../src/shared/chatHandOff'
import type { AgentKind } from '../src/shared/agents'
import type { ChatItem } from '../src/shared/types'

type Spec = { text: string; answer?: string; agent?: AgentKind; model?: string; tools?: number }

/** A chat of these turns: the user's message, then the agent's answer (turn ids t1, t2, …). */
function chat(turns: Spec[]): ChatItem[] {
  const items: ChatItem[] = []
  turns.forEach((spec, i) => {
    const id = `t${i + 1}`
    items.push({ kind: 'user', id: `${id}:u`, turnId: id, text: spec.text, at: '2026-11-11T10:00:00.000Z', agent: spec.agent ?? 'claude', model: spec.model ?? 'claude-opus-5-5[1m]' } as ChatItem)
    for (let n = 0; n < (spec.tools ?? 0); n++) items.push({ kind: 'tool', id: `${id}:tool${n}`, turnId: id, name: 'Bash', input: { command: 'ls' }, status: 'done' })
    if (spec.answer !== undefined) items.push({ kind: 'assistant', id: `${id}:a`, turnId: id, text: spec.answer })
    items.push({ kind: 'turn-end', id: `${id}:end`, turnId: id, outcome: 'completed' } as ChatItem)
  })
  return items
}

const many = (n: number, size = 200): Spec[] => Array.from({ length: n }, (_, i) => ({ text: `question ${i + 1} ${'q'.repeat(size)}`, answer: `answer ${i + 1} ${'a'.repeat(size)}` }))
const target = { agent: 'codex' as AgentKind }

describe('buildHandOff', () => {
  it('gives a short chat in full, every turn headed with the agent and model that answered it', () => {
    const items = chat([
      { text: 'first', answer: 'one', agent: 'claude', model: 'claude-opus-5-5[1m]' },
      { text: 'second', answer: 'two', agent: 'codex', model: 'gpt-6.1-sol' }
    ])
    const build = buildHandOff(items, { agent: 'claude' }, undefined, 16_000)
    expect(build).toMatchObject({ delta: false, full: ['t1', 't2'], condensed: [], omitted: [], budgetTokens: 16_000 })
    const text = renderHandOff(build, { reason: 'switch', canRead: true })
    expect(text).toContain('### Turn 1 · Claude Code (Opus 5.5)')
    expect(text).toContain('### Turn 2 · Codex (GPT-6.1 Sol)')
    expect(text).toContain('**You:** first')
    expect(text).toContain('**Codex (GPT-6.1 Sol):** two')
    expect(text).toContain('switched it to you')
    expect(text).not.toContain('read_chat_history')
    expect(text.endsWith("The user's new message:\n\n")).toBe(true)
  })

  it('splits the budget: newest turns in full up to 60%, older condensed up to the whole, the rest left out', () => {
    // Each full turn is ~320 tokens (two 600-character messages plus headings); a condensed one at most ~220.
    const items = chat(many(40, 600))
    const budget = 3_000
    const build = buildHandOff(items, target, undefined, budget)
    const tokens = (ids: string[]) => ids.map((id) => build.turns.find((t) => t.id === id)!.tokens)
    // Full: the newest ones, contiguous, within 60% of the budget.
    expect(build.full.at(-1)).toBe('t40')
    expect(tokens(build.full).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(budget * 0.6)
    // Condensed: the ones just before, each far smaller than a full turn.
    expect(build.condensed.length).toBeGreaterThan(0)
    expect(build.condensed.at(-1)).toBe(`t${40 - build.full.length}`)
    for (const t of tokens(build.condensed)) expect(t).toBeLessThan(tokens(build.full)[0])
    // Left out: the oldest ones, so the three lists are contiguous and cover every turn once.
    expect(build.omitted.length).toBeGreaterThan(0)
    expect(build.omitted[0]).toBe('t1')
    expect([...build.omitted, ...build.condensed, ...build.full]).toEqual(Array.from({ length: 40 }, (_, i) => `t${i + 1}`))
    // Never over the budget, and used tokens are the sum of what went in.
    expect(build.usedTokens).toBeLessThanOrEqual(budget)
    expect(build.usedTokens).toBe([...build.full, ...build.condensed].reduce((sum, id) => sum + build.turns.find((t) => t.id === id)!.tokens, 0))
    expect(build.omittedNumbers).toEqual(build.omitted.map((id) => Number(id.slice(1))))
    // Left-out turns are named by number, with the tool that reads them.
    const text = renderHandOff(build, { reason: 'switch', canRead: true })
    expect(text).toContain(`Turns ${numberRanges(build.omittedNumbers)} are left out. Read them with read_chat_history.`)
    expect(renderHandOff(build, { reason: 'switch', canRead: false })).not.toContain('read_chat_history')
  })

  it('condenses a turn to its request and final answer, 400 characters each', () => {
    const items = chat([{ text: `OLDEST ${'x'.repeat(5_000)}`, answer: `FIRST ${'y'.repeat(5_000)}` }, ...many(30, 150)])
    const build = buildHandOff(items, target, undefined, 4_000)
    const block = build.blocks.find((b) => b.turn.id === 't1')
    expect(block?.level).toBe('condensed')
    expect(block!.text).toContain('· condensed')
    const youLine = block!.text.split('\n').find((l) => l.startsWith('**You:**'))!
    expect(youLine.length).toBeLessThanOrEqual('**You:** '.length + CONDENSED_CHARS)
    expect(youLine.endsWith('…')).toBe(true)
  })

  it('a turn bigger than the full share is condensed, not sent whole', () => {
    const build = buildHandOff(chat([{ text: 'small', answer: 'ok' }, { text: 'huge', answer: 'z'.repeat(20_000) }]), target, undefined, 1_024)
    expect(build.full).toEqual([])
    expect(build.condensed).toContain('t2')
  })

  it('is a delta when the target saw the chat up to a turn, and full when it did not (or the turn is gone)', () => {
    const items = chat(many(6, 40))
    const delta = buildHandOff(items, target, 't3', 16_000)
    expect(delta).toMatchObject({ delta: true, sinceTurn: 't3', full: ['t4', 't5', 't6'] })
    expect(delta.turns.map((t) => t.n)).toEqual([4, 5, 6])
    const text = renderHandOff(delta, { reason: 'return', canRead: true })
    expect(text).toContain('While you were away')
    expect(text).toContain('<messages_in_between>')
    expect(text).not.toContain('question 3')
    // Nothing new since its last turn: nothing to say.
    expect(renderHandOff(buildHandOff(items, target, 't6', 16_000), { reason: 'return', canRead: true })).toBe('')
    // A last-seen turn the chat no longer has (it was rewound) is not a delta: the whole chat.
    expect(buildHandOff(items, target, 'gone', 16_000)).toMatchObject({ delta: false, full: ['t1', 't2', 't3', 't4', 't5', 't6'] })
    expect(buildHandOff(items, target, undefined, 16_000).delta).toBe(false)
  })

  it('is deterministic: the same chat gives the same record and text', () => {
    const items = chat(many(25))
    const a = buildHandOff(items, target, undefined, 2_000)
    const b = buildHandOff(JSON.parse(JSON.stringify(items)), target, undefined, 2_000)
    expect(b).toEqual(a)
    expect(renderHandOff(b, { reason: 'switch', canRead: true })).toBe(renderHandOff(a, { reason: 'switch', canRead: true }))
  })

  it('keeps the budget inside its limits, and estimates tokens as characters / 4', () => {
    expect(clampBudget(undefined)).toBe(HAND_OFF_BUDGET.default)
    expect(clampBudget(10)).toBe(1_024)
    expect(clampBudget(1_000_000)).toBe(64_000)
    expect(clampBudget(16_000.4)).toBe(16_000)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(buildHandOff(chat(many(3)), target, undefined, 5).budgetTokens).toBe(1_024)
  })

  it('leaves steered messages with their turn, and counts a turn once', () => {
    const items = chat([{ text: 'start', answer: 'done' }])
    items.splice(1, 0, { kind: 'user', id: 'steer', turnId: 't1', text: 'also this', at: '', steered: true } as ChatItem)
    const turns = chatTurns(items, target)
    expect(turns).toHaveLength(1)
    expect(turns[0].user).toEqual(['start', '(while it worked) also this'])
  })

  it('writes the record with who, how and the turns it considered', () => {
    const build = buildHandOff(chat(many(3, 20)), { agent: 'claude' }, undefined, 16_000)
    const record = handOffRecord(build, { from: { agent: 'claude', model: 'claude-opus-5-5[1m]' }, to: { agent: 'codex', model: 'gpt-6.1-sol' }, strategy: 'prompt-full', turnId: 'next' })
    expect(record).toMatchObject({ turnId: 'next', strategy: 'prompt-full', budgetTokens: 16_000, full: ['t1', 't2', 't3'], condensed: [], omitted: [], from: { agent: 'claude' }, to: { agent: 'codex' } })
    expect(record.turns.map((t) => t.n)).toEqual([1, 2, 3])
    expect(record.turns[0].request).toContain('question 1')
    expect(describeHandOff(record)).toContain('What Codex received (prompt-full): 3 turns in full, 0 condensed, 0 left out')
    // A preview has no turn id yet.
    expect(handOffRecord(build, { from: record.from, to: record.to, strategy: 'prompt-full' })).not.toHaveProperty('turnId')
  })
})

describe('chooseStrategy', () => {
  const base = { sameAgent: false, sameHome: false, forkNative: false, parked: false, resumeNative: true }
  it('picks the strategy for each case in docs/agents.md 5.3', () => {
    // Same agent, same home, and a fork the agent does itself.
    expect(chooseStrategy({ ...base, sameAgent: true, sameHome: true, forkNative: true })).toBe('native-fork')
    // The same agent on another home can't fork its own conversation: its chat goes as text.
    expect(chooseStrategy({ ...base, sameAgent: true, sameHome: false, forkNative: true })).toBe('prompt-full')
    expect(chooseStrategy({ ...base, sameAgent: true, sameHome: true, forkNative: false })).toBe('prompt-full')
    // Returning to an agent that saw the chat: resume it and send the delta; as text when its thread can't be resumed.
    expect(chooseStrategy({ ...base, parked: true })).toBe('resume-delta')
    expect(chooseStrategy({ ...base, parked: true, resumeNative: false })).toBe('prompt-delta')
    // Everyone else, Codex included until a recorded fixture proves injected items.
    expect(chooseStrategy(base)).toBe('prompt-full')
  })
})

describe('readChatHistory', () => {
  const items = chat([
    { text: 'one', answer: 'first answer', tools: 2 },
    { text: 'two', answer: 'second answer', agent: 'codex', model: 'gpt-6.1-sol' },
    { text: 'three', answer: 'third answer' }
  ])

  it('returns turns by number, in full and attributed, in order', () => {
    const result = readChatHistory(items, { turns: [3, 1] }, { agent: 'claude' })
    expect(result.returned).toEqual([1, 3])
    expect(result.total).toBe(3)
    expect(result.text).toContain('### Turn 1 · Claude Code (Opus 5.5)')
    expect(result.text).toContain('first answer')
    expect(result.text).toContain('2 tool calls not shown')
    expect(result.text).not.toContain('second answer')
  })

  it('reads a range, from one end alone, and reports what the chat does not have', () => {
    expect(readChatHistory(items, { from: 2, to: 3 }, { agent: 'claude' }).returned).toEqual([2, 3])
    expect(readChatHistory(items, { from: 2 }, { agent: 'claude' }).returned).toEqual([2, 3])
    expect(readChatHistory(items, { to: 1 }, { agent: 'claude' }).returned).toEqual([1])
    const missing = readChatHistory(items, { turns: [2, 9] }, { agent: 'claude' })
    expect(missing).toMatchObject({ returned: [2], missing: [9] })
    expect(missing.text).toContain('has no turn 9 (it has 3)')
    expect(() => readChatHistory(items, { from: 3, to: 1 }, { agent: 'claude' })).toThrow('after to')
  })

  it('lists the turns when nothing is selected', () => {
    const result = readChatHistory(items, {}, { agent: 'claude' })
    expect(result.returned).toEqual([])
    expect(result.text).toContain('This chat has 3 turns')
    expect(result.text).toContain('Turn 2 · Codex (GPT-6.1 Sol): two')
  })

  it('returns at most the limit per call and lists what did not fit', () => {
    const big = chat(many(10, 4_000))
    const result = readChatHistory(big, { from: 1, to: 10 }, { agent: 'claude' }, 5_000)
    expect(result.returned.length).toBeGreaterThan(0)
    expect(result.returned.length).toBeLessThan(10)
    expect(result.notReturned).toEqual(Array.from({ length: 10 - result.returned.length }, (_, i) => result.returned.length + i + 1))
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(5_000 + 100)
    expect(result.text).toContain("didn't fit in one call")
    // A single turn over the limit is cut so it can still be read.
    const one = readChatHistory(chat([{ text: 'x', answer: 'y'.repeat(100_000) }]), { turns: [1] }, { agent: 'claude' }, 1_000)
    expect(one.returned).toEqual([1])
    expect(one.text).toContain('cut to fit')
  })
})
