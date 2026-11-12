// The issue's hand-off check (docs/agents.md 14): a chat moved Claude → Codex → Claude keeps its thread; the third turn
// answers about the first; both switches are recorded and the record is in Lineage. It runs the real SessionService with
// stand-in agents that remember only what they were given, so an answer about the first turn can only come from a
// conversation they kept or from the text Foreman handed them. These are stand-in drivers, not recorded fixtures: a switch spans
// two agents and no recording holds both. Each agent's own half (resume, fork) is proven by its fixtures, in claude.test.ts and codex.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../../src/main/agents/claude'
import { codexDriver } from '../../src/main/agents/codex'
import { registerDriver } from '../../src/main/agents/registry'
import type { TurnRequest } from '../../src/main/agents/types'
import type { AgentKind } from '../../src/shared/agents'
import type { ChatHandOff } from '../../src/shared/chatHandOff'
import { lineageGraph } from '../../src/shared/lineage'
import type { ChatItem } from '../../src/shared/types'
import { fakeDriver, setupSessions } from '../sessionHarness'

// Each test makes a real Git repository, which is slow when the whole suite is running.
vi.setConfig({ testTimeout: 90_000 })

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

type Harness = Awaited<ReturnType<typeof setupSessions>>
type User = Extract<ChatItem, { kind: 'user' }>
type Notice = Extract<ChatItem, { kind: 'notice' }>

/**
 * Stand-ins for Claude and Codex. Each keeps a conversation per thread id: a resumed turn sees what that thread already
 * held plus the prompt, a new one only the prompt. A question "what did we decide in the first turn" is answered by the
 * first request it can find in what it holds, and with whatever it learns about the turns in between.
 */
function agents() {
  const threads = new Map<string, string[]>()
  const requests: (TurnRequest & { agent: AgentKind; held: string })[] = []
  for (const agent of ['claude', 'codex'] as const) {
    registerDriver({
      ...fakeDriver(async (req, cb) => {
        const thread = req.resume ?? `${agent}-thread-${threads.size + 1}`
        const memory = threads.get(thread) ?? []
        const seen = [...memory, req.prompt].join('\n')
        requests.push({ ...req, agent, held: seen })
        const ask = /what did we decide about (\w+)/i.exec(req.prompt.split("The user's new message:").at(-1)!)
        // The answer: the decision in the earliest turn that mentions the topic, from whatever this agent holds.
        const topic = ask?.[1]
        const decision = topic ? new RegExp(`decide[d]? (?:on )?([^.\\n]*${topic}[^.\\n]*)`, 'i').exec(seen) : undefined
        const answer = topic ? (decision ? `We decided: ${decision[1]}` : `I don't have anything about ${topic}.`) : `${agent} noted: ${req.prompt.split("The user's new message:").at(-1)!.trim()}. We decided on the plan.`
        threads.set(thread, [...memory, req.prompt, answer])
        cb.sessionStarted(thread)
        cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: answer })
        if (agent === 'claude') cb.assistantMessage(`${thread}:${threads.get(thread)!.length}`)
        cb.item({ kind: 'result', id: `${req.turnId}:r`, turnId: req.turnId, ok: true })
        cb.finished({ ok: true })
      }),
      kind: agent
    })
  }
  return requests
}

const tab = (h: Harness) => h.store.state.sessions.find((s) => s.id === h.session.id)!
async function say(h: Harness, text: string) {
  await h.sessions.send(h.session.id, text)
  await vi.waitFor(() => {
    expect(tab(h).status).toBe('idle')
    expect(tab(h).turnId).toBeUndefined()
  }, { timeout: 10_000 })
  const items = await h.store.readChat(h.session.id)
  return { user: items.filter((i): i is User => i.kind === 'user').at(-1)!, answer: items.filter((i) => i.kind === 'assistant').at(-1) as Extract<ChatItem, { kind: 'assistant' }> }
}

describe('a chat moved Claude → Codex → Claude', () => {
  it('keeps its thread: the third turn answers about the first, and both switches are recorded', async () => {
    const requests = agents()
    const h = await setupSessions()

    // 1. Claude: the decision is made here.
    const first = await say(h, 'Why does the cache key include the workspace path? We decide on hashing the key.')
    expect(first.answer.text).toContain('We decided on the plan')

    // 2. Switch to Codex, which has never seen this chat: it gets the first turn as attributed text, in full.
    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    const second = await say(h, 'Write the hash helper, and we decide on a test for the helper.')
    const toCodex = requests.at(-1)!
    expect(toCodex.agent).toBe('codex')
    expect(toCodex.resume).toBeUndefined()
    expect(toCodex.prompt).toContain('### Turn 1 · Claude Code (Opus 5.5)')
    expect(toCodex.prompt).toContain('hashing the key')

    // 3. Back to Claude: it resumes its own thread (turn 1 is in it) and is sent only what Codex did meanwhile.
    await h.sessions.updateSession(h.session.id, { agent: 'claude', model: 'claude-opus-5-5[1m]' })
    const third = await say(h, 'What did we decide about hashing?')
    const back = requests.at(-1)!
    expect(back.agent).toBe('claude')
    expect(back.resume).toBe(requests[0].resume ?? 'claude-thread-1')
    // The delta: Codex's turn is in the prompt, Claude's own first turn is not repeated to it...
    expect(back.prompt).toContain('### Turn 2 · Codex (GPT-6.1 Sol)')
    expect(back.prompt).toContain('we decide on a test for the helper')
    expect(back.prompt).not.toContain('Why does the cache key include')
    // ...and it still answers about the first turn, from its own thread.
    expect(third.answer.text).toContain('We decided: ')
    expect(third.answer.text).toContain('hashing the key')

    // Both switches are on their notices, with the strategy each used and the turns each was given.
    const notices = (await h.store.readChat(h.session.id)).filter((i): i is Notice => i.kind === 'notice' && Boolean(i.switched))
    const records = notices.map((n) => n.switched!.handOff as ChatHandOff)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ strategy: 'prompt-full', turnId: second.user.turnId, full: [first.user.turnId], omitted: [], from: { agent: 'claude' }, to: { agent: 'codex', model: 'gpt-6.1-sol' } })
    expect(records[1]).toMatchObject({ strategy: 'resume-delta', turnId: third.user.turnId, sinceTurn: first.user.turnId, full: [second.user.turnId], from: { agent: 'codex' }, to: { agent: 'claude' } })
    expect(records.every((r) => r.usedTokens > 0 && r.usedTokens <= r.budgetTokens)).toBe(true)
    // Without the delta Claude's resumed thread holds only its own turn: nothing Codex said would have reached it.
    expect(back.held).toContain('we decide on a test for the helper')

    // The records are in Lineage: a switch edge each way, opening the record.
    const items = await h.store.readChat(h.session.id)
    const graph = lineageGraph({ workspace: h.ws, sessions: [tab(h)], chats: new Map([[h.session.id, items]]) }, 'run')
    const received = graph.nodes.filter((n) => n.id.startsWith('received:'))
    expect(received.map((n) => n.label)).toEqual(['What Codex received', 'What Claude Code received'])
    expect(received.map((n) => n.ref)).toEqual([expect.objectContaining({ kind: 'received', handOff: records[0] }), expect.objectContaining({ kind: 'received', handOff: records[1] })])
    expect(graph.edges.filter((e) => e.label?.startsWith('switched:')).map((e) => e.label)).toEqual(['switched: Claude Code → Codex', 'switched: Codex → Claude Code'])
  })

  it('answers about the first turn on the first arrival too, from the text alone', async () => {
    const requests = agents()
    const h = await setupSessions()
    await say(h, 'Why the cache key? We decide on hashing the key.')
    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    const answer = await say(h, 'What did we decide about hashing?')
    expect(requests.at(-1)!.resume).toBeUndefined()
    expect(answer.answer.text).toContain('hashing the key')
  })

  it('a long chat keeps the newest turns and says which were left out, which the agent can read by number', async () => {
    const requests = agents()
    const h = await setupSessions()
    h.store.state.settings.handOffTokenBudget = 1_024
    await say(h, 'Early on we decide on a salted key.')
    for (let n = 2; n <= 9; n++) await say(h, `Step ${n}: ${'detail '.repeat(120)}`)
    await h.sessions.updateSession(h.session.id, { agent: 'codex', model: 'gpt-6.1-sol' })
    await say(h, 'Go on.')
    const record = ((await h.store.readChat(h.session.id)).find((i): i is Notice => i.kind === 'notice' && Boolean(i.switched))!.switched!.handOff) as ChatHandOff
    expect(record.omitted.length).toBeGreaterThan(0)
    // The first turn is among those left out, so the text names the tool; reading it by number returns the decision.
    expect(record.omitted).toContain(record.turns[0].id)
    expect(requests.at(-1)!.prompt).toContain('read_chat_history')
    expect(requests.at(-1)!.prompt).not.toContain('salted key')
    const read = await h.sessions.readChatHistory(h.session.id, { turns: [1] })
    expect(read.text).toContain('we decide on a salted key')
  })
})
