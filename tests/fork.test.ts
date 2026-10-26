import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { forkCut, forkHistoryBlock, MAX_FORK_HISTORY_CHARS } from '../src/shared/fork'
import type { ChatItem } from '../src/shared/types'
import { fakeDriver, gate, setupSessions } from './sessionHarness'

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

type Harness = Awaited<ReturnType<typeof setupSessions>>
type User = Extract<ChatItem, { kind: 'user' }>

/** Each turn answers "answer N" as agent session `native-1`, reporting assistant uuid `a<N>`; requests are collected. */
function answering(kind: 'claude' | 'codex' = 'claude') {
  const requests: TurnRequest[] = []
  registerDriver({
    ...fakeDriver(async (req, cb) => {
      requests.push(req)
      const n = requests.length
      cb.sessionStarted(req.resume ?? 'native-1')
      cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: `answer ${n}` })
      cb.assistantMessage(`a${n}`)
      cb.finished({ ok: true })
    }),
    kind
  })
  return requests
}

const idle = (h: Harness, id = h.session.id) =>
  vi.waitFor(() => {
    const s = h.store.state.sessions.find((x) => x.id === id)!
    expect(s.status).toBe('idle')
    expect(s.turnId).toBeUndefined()
  }, { timeout: 10_000 })

async function converse(h: Harness, ...messages: string[]) {
  for (const text of messages) {
    await h.sessions.send(h.session.id, text)
    await idle(h)
  }
  return (await h.store.readChat(h.session.id)).filter((i): i is User => i.kind === 'user')
}

describe('where a fork cuts the chat', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', turnId: 't1', text: 'one', at: '' },
    { kind: 'assistant', id: 'a1', turnId: 't1', text: 'first' },
    { kind: 'user', id: 'u1s', turnId: 't1', text: 'also', at: '', steered: true },
    { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed' },
    { kind: 'user', id: 'u2', turnId: 't2', text: 'two', at: '', resumeFrom: { sessionId: 's', messageUuid: 'a1' } },
    { kind: 'assistant', id: 'a2', turnId: 't2', text: 'second' }
  ]

  it('keeps a turn with its steered messages and resumes where the next message started from', () => {
    const cut = forkCut(items, 't1')
    expect(cut.items.map((i) => i.id)).toEqual(['u1', 'a1', 'u1s', 'e1'])
    expect(cut.resumeFrom).toEqual({ sessionId: 's', messageUuid: 'a1' })
  })

  it('takes the whole chat without a turn, and refuses a turn that has not finished', () => {
    expect(forkCut(items)).toEqual({ items, resumeFrom: 'latest' })
    expect(() => forkCut(items, 't2')).toThrow('hasn’t finished')
    expect(() => forkCut(items, 'nope')).toThrow('Message not found')
  })

  it('carries messages only, and the newest part of a long history', () => {
    const block = forkHistoryBlock([...items, { kind: 'tool', id: 'x', turnId: 't2', name: 'Bash', input: { command: 'secret-cmd' }, status: 'done', output: 'out' }])
    expect(block).toContain('<earlier_conversation>')
    expect(block).toContain('second')
    expect(block).not.toContain('secret-cmd')
    expect(forkHistoryBlock([])).toBe('')
    const long = forkHistoryBlock([{ kind: 'user', id: 'u', turnId: 't', text: `OLDEST${'x'.repeat(MAX_FORK_HISTORY_CHARS)}NEWEST`, at: '' }])
    expect(long).toContain('NEWEST')
    expect(long).not.toContain('OLDEST')
    expect(long).toContain('oldest part was left out')
  })
})

describe('forking a chat', () => {
  it('Claude: forks after an earlier answer, branching its own conversation at that reply', async () => {
    const requests = answering()
    const h = await setupSessions()
    const users = await converse(h, 'one', 'two', 'three')

    const fork = await h.sessions.forkSession(h.session.id, users[0].turnId)
    expect(fork).toMatchObject({ agentSessionId: 'native-1', resumeAt: 'a1', title: 'chat (fork)', forkedFrom: { sessionId: h.session.id, turnId: users[0].turnId } })
    expect(fork.seedHistory).toBeUndefined()
    const items = await h.store.readChat(fork.id)
    expect(items.filter((i) => i.kind === 'user').map((i) => (i as User).text)).toEqual(['one'])
    expect(items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('continues the same conversation') })

    await h.sessions.send(fork.id, 'instead, do this')
    await idle(h, fork.id)
    expect(requests.at(-1)).toMatchObject({ resume: 'native-1', resumeAt: 'a1', prompt: 'instead, do this' })
    // The original is untouched.
    expect((await h.store.readChat(h.session.id)).filter((i) => i.kind === 'user')).toHaveLength(3)
    expect(h.store.state.sessions.find((s) => s.id === fork.id)!.title).toBe('chat (fork)')
  })

  it('Claude: without a turn, forks at the latest answer', async () => {
    answering()
    const h = await setupSessions()
    await converse(h, 'one', 'two')
    const fork = await h.sessions.forkSession(h.session.id)
    expect(fork).toMatchObject({ agentSessionId: 'native-1', resumeAt: 'a2' })
    expect((await h.store.readChat(fork.id)).filter((i) => i.kind === 'user')).toHaveLength(2)
  })

  it('other agents: the fork starts a new conversation and its first message carries the history', async () => {
    const requests = answering('codex')
    const h = await setupSessions()
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    const users = await converse(h, 'one', 'two')

    const fork = await h.sessions.forkSession(h.session.id, users[0].turnId)
    expect(fork).toMatchObject({ agent: 'codex', seedHistory: true })
    expect(fork.agentSessionId).toBeUndefined()
    expect((await h.store.readChat(fork.id)).at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('carries the history above') })

    await h.sessions.send(fork.id, 'go another way')
    await idle(h, fork.id)
    const first = requests.at(-1)!
    expect(first.resume).toBeUndefined()
    expect(first.prompt).toContain('<earlier_conversation>')
    expect(first.prompt).toContain('answer 1')
    expect(first.prompt).not.toContain('two')
    expect(first.prompt.endsWith('go another way')).toBe(true)
    const sent = (await h.store.readChat(fork.id)).filter((i): i is User => i.kind === 'user').at(-1)!
    expect(sent.text).toBe('go another way')
    expect(sent.added?.map((p) => p.kind)).toContain('history')
    expect(h.store.state.sessions.find((s) => s.id === fork.id)!.seedHistory).toBeUndefined()

    await h.sessions.send(fork.id, 'and then')
    await idle(h, fork.id)
    expect(requests.at(-1)!.prompt).toBe('and then')
  })

  it('refuses an empty chat, and the latest answer while a turn runs', async () => {
    const h = await setupSessions()
    await expect(h.sessions.forkSession(h.session.id)).rejects.toThrow('Send a message before forking')
    const { release, script } = gate()
    registerDriver(fakeDriver(script))
    await h.sessions.send(h.session.id, 'long one')
    await vi.waitFor(() => expect(h.session.status).toBe('running'))
    await expect(h.sessions.forkSession(h.session.id)).rejects.toThrow('Wait for this turn to finish')
    release()
    await idle(h)
  })
})
