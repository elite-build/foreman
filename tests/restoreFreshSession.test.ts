// Restore on an agent whose record says conversationRollback is the checkpoint-fresh-session fallback (docs/agents.md 2.5):
// the files come back, the agent's session is dropped, the next turn starts a new session given the chat up to the restore
// point (a rewound Cursor, OpenCode or ACP chat used to resume the session with every later turn in it, or start with nothing),
// and the chat says "Context restarted". An agent that rolls back natively keeps what it did.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { cursorProcessDriver } from '../src/main/agents/cursor/process'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import type { AgentKind } from '../src/shared/agents'
import type { ChatItem } from '../src/shared/types'
import { fakeDriver, setupSessions } from './sessionHarness'

vi.setConfig({ testTimeout: 90_000 })

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
  registerDriver(cursorProcessDriver)
})

type Harness = Awaited<ReturnType<typeof setupSessions>>
type User = Extract<ChatItem, { kind: 'user' }>
type Notice = Extract<ChatItem, { kind: 'notice' }>

/** An agent that opens `native-<n>` the first time and resumes what it is given; each turn answers with its number. */
function agent(kind: AgentKind) {
  const requests: TurnRequest[] = []
  registerDriver({
    ...fakeDriver(async (req, cb) => {
      requests.push(req)
      cb.sessionStarted(req.resume ?? `session-${requests.length}`)
      cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: `answer ${requests.length}` })
      cb.assistantMessage(`a${requests.length}`)
      cb.item({ kind: 'result', id: `${req.turnId}:r`, turnId: req.turnId, ok: true })
      cb.finished({ ok: true })
    }),
    kind
  })
  return requests
}

const tab = (h: Harness) => h.store.state.sessions.find((s) => s.id === h.session.id)!
const idle = (h: Harness) => vi.waitFor(() => expect(tab(h).status === 'idle' && !tab(h).turnId).toBe(true), { timeout: 10_000 })

async function converse(h: Harness, ...texts: string[]) {
  for (const text of texts) {
    await h.sessions.send(h.session.id, text)
    await idle(h)
  }
  return (await h.store.readChat(h.session.id)).filter((i): i is User => i.kind === 'user')
}

describe.each(['cursor', 'opencode', 'gemini'] as const)('Restore on %s (checkpoint-fresh-session)', (kind) => {
  it('restores the files, drops the session and seeds the next turn with the chat up to the restore point', async () => {
    const requests = agent(kind)
    const h = await setupSessions()
    await h.sessions.updateSession(h.session.id, { agent: kind, model: kind === 'cursor' ? 'auto' : '' })
    const users = await converse(h, 'first question', 'second question', 'third question')
    expect(requests.map((r) => r.resume)).toEqual([undefined, 'session-1', 'session-1'])

    await h.sessions.restore(h.session.id, users[2].turnId)
    // The session is gone and nothing says where to cut: there is nothing to roll back.
    expect(tab(h)).toMatchObject({ agentSessionId: undefined, resumeAt: undefined, rewound: undefined, seedHistory: 'restore' })
    const notices = (await h.store.readChat(h.session.id)).filter((i): i is Notice => i.kind === 'notice')
    expect(notices.at(-1)?.text).toMatch(/Context restarted/)
    expect(notices.at(-1)?.text).toMatch(/third question/)

    await h.sessions.send(h.session.id, 'third question, again')
    await idle(h)
    const sent = requests.at(-1)!
    // A new conversation, which carries the two turns that were kept, and not the one that was undone.
    expect(sent.resume).toBeUndefined()
    expect(sent.resumeAt).toBeUndefined()
    expect(sent.rewind).toBeUndefined()
    expect(sent.prompt).toContain('first question')
    expect(sent.prompt).toContain('second question')
    expect(sent.prompt).toContain('answer 2')
    expect(sent.prompt).not.toContain('answer 3')
    expect(sent.prompt).toContain('restored this chat')
    expect(sent.prompt.endsWith('third question, again')).toBe(true)
    // Said once: the session that started is continued from here on.
    expect(tab(h).seedHistory).toBeUndefined()
    expect(tab(h).agentSessionId).toBe('session-4')
    await h.sessions.send(h.session.id, 'fourth')
    await idle(h)
    expect(requests.at(-1)).toMatchObject({ resume: 'session-4' })
    expect(requests.at(-1)!.prompt).toBe('fourth')
  })

  it('Restore to the first message starts clean: nothing to carry, still a fresh session', async () => {
    const requests = agent(kind)
    const h = await setupSessions()
    await h.sessions.updateSession(h.session.id, { agent: kind, model: kind === 'cursor' ? 'auto' : '' })
    const users = await converse(h, 'one', 'two')
    await h.sessions.restore(h.session.id, users[0].turnId)
    expect(tab(h).seedHistory).toBeUndefined()
    await h.sessions.send(h.session.id, 'one, differently')
    await idle(h)
    expect(requests.at(-1)!.resume).toBeUndefined()
    expect(requests.at(-1)!.prompt).toBe('one, differently')
  })
})

describe('Restore on an agent that rolls its conversation back itself', () => {
  it('keeps the session and cuts it in place, with the old notice and no seeded history', async () => {
    const requests = agent('codex')
    const h = await setupSessions()
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    const users = await converse(h, 'one', 'two')
    await h.sessions.restore(h.session.id, users[1].turnId)
    expect(tab(h)).toMatchObject({ agentSessionId: 'session-1', rewound: true })
    expect(tab(h).seedHistory).toBeUndefined()
    const notices = (await h.store.readChat(h.session.id)).filter((i): i is Notice => i.kind === 'notice')
    expect(notices.at(-1)?.text).toMatch(/Restored files and conversation/)
    await h.sessions.send(h.session.id, 'two again')
    await idle(h)
    expect(requests.at(-1)).toMatchObject({ resume: 'session-1', rewind: true, prompt: 'two again' })
  })
})
