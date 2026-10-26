// #16 Edit and resend: fork from just before a message, with its text waiting in the new tab's composer.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { editResendBlock, forkCutBefore, forkTabTitle, quoteMessage } from '../src/shared/fork'
import type { AppSnapshot, ChatItem, Session } from '../src/shared/types'
import { fakeDriver, setupSessions } from './sessionHarness'

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

const texts = (items: ChatItem[]) => items.filter((i): i is User => i.kind === 'user').map((i) => i.text)

describe('where Edit and resend cuts the chat', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', turnId: 't1', text: 'one', at: '' },
    { kind: 'assistant', id: 'a1', turnId: 't1', text: 'first' },
    { kind: 'user', id: 'u1s', turnId: 't1', text: 'also', at: '', steered: true },
    { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed' },
    { kind: 'user', id: 'u2', turnId: 't2', text: 'two', at: '', resumeFrom: { sessionId: 's', messageUuid: 'a1' } },
    { kind: 'assistant', id: 'a2', turnId: 't2', text: 'second' }
  ]

  it('cuts just before the message, resuming where that message started from', () => {
    const cut = forkCutBefore(items, 't2')
    expect(cut.first).toBeFalsy()
    if (cut.first) return
    expect(cut.items.map((i) => i.id)).toEqual(['u1', 'a1', 'u1s', 'e1'])
    expect(cut.resumeFrom).toEqual({ sessionId: 's', messageUuid: 'a1' })
    expect(cut.message.text).toBe('two')
  })

  it('the first message has nothing before it, so it opens a new chat', () => {
    expect(forkCutBefore(items, 't1')).toMatchObject({ first: true, message: { id: 'u1', text: 'one' } })
    expect(() => forkCutBefore(items, 'nope')).toThrow('Message not found')
  })

  it('a steered message has no turn boundary before it: disabled with the reason; so is a running chat', () => {
    expect(editResendBlock(items[2] as User, false)).toBe('steered')
    expect(editResendBlock(items[4] as User, true)).toBe('running')
    expect(editResendBlock(items[4] as User, false)).toBeNull()
    expect(editResendBlock(items[0] as User, false)).toBeNull()
  })

  it('quotes the message on one line, cut to fit; fork tabs drop the suffix for their icon', () => {
    expect(quoteMessage('fix\n  the   flake')).toBe('fix the flake')
    expect(quoteMessage('x'.repeat(80))).toHaveLength(60)
    expect(quoteMessage('x'.repeat(80)).endsWith('…')).toBe(true)
    expect(forkTabTitle('Persist sidebar filters (fork)')).toBe('Persist sidebar filters')
    expect(forkTabTitle('Persist (fork) (fork)')).toBe('Persist')
    expect(forkTabTitle('(fork)')).toBe('(fork)')
    expect(forkTabTitle('No suffix')).toBe('No suffix')
  })
})

describe('Edit and resend through the fork path', () => {
  it('Claude: forks natively from just before the message, says the files keep its changes, and sends nothing', async () => {
    const requests = answering()
    const h = await setupSessions()
    const users = await converse(h, 'one', 'two', 'three')

    const fork = await h.sessions.forkSession(h.session.id, users[1].turnId, { before: true })
    expect(fork).toMatchObject({
      agentSessionId: 'native-1',
      resumeAt: 'a1',
      title: 'chat (fork)',
      forkedFrom: { sessionId: h.session.id, turnId: users[1].turnId, before: true }
    })
    expect(fork.seedHistory).toBeUndefined()
    const items = await h.store.readChat(fork.id)
    expect(texts(items)).toEqual(['one'])
    const notice = items.at(-1)!
    expect(notice).toMatchObject({ kind: 'notice', text: expect.stringContaining('before your message “two”') })
    expect(notice).toMatchObject({ text: expect.stringContaining('continues the same conversation') })
    expect(notice).toMatchObject({ text: expect.stringContaining('anything that message changed is still in the files') })
    // Not sent: no turn started for the fork.
    expect(requests).toHaveLength(3)
    expect(h.store.state.sessions.find((s) => s.id === fork.id)!.status).toBe('idle')
    // The original is untouched.
    expect(texts(await h.store.readChat(h.session.id))).toEqual(['one', 'two', 'three'])

    // The edited text, once the user sends it, continues Claude's conversation from that point.
    await h.sessions.send(fork.id, 'two, but better')
    await idle(h, fork.id)
    expect(requests.at(-1)).toMatchObject({ resume: 'native-1', resumeAt: 'a1', prompt: 'two, but better' })
  })

  it('other agents: a new conversation that carries the visible history before the message', async () => {
    const requests = answering('codex')
    const h = await setupSessions()
    await h.sessions.updateSession(h.session.id, { agent: 'codex' })
    const users = await converse(h, 'one', 'two')

    const fork = await h.sessions.forkSession(h.session.id, users[1].turnId, { before: true })
    expect(fork).toMatchObject({ agent: 'codex', seedHistory: true, title: 'chat (fork)' })
    expect(fork.agentSessionId).toBeUndefined()
    const items = await h.store.readChat(fork.id)
    expect(texts(items)).toEqual(['one'])
    expect(items.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('carries the history above') })
    expect(items.at(-1)).toMatchObject({ text: expect.stringContaining('Files are shared with the other tabs in this worktree, so anything that message changed is still in the files.') })
    expect(requests).toHaveLength(2)

    await h.sessions.send(fork.id, 'two, edited')
    await idle(h, fork.id)
    const first = requests.at(-1)!
    expect(first.resume).toBeUndefined()
    expect(first.prompt).toContain('<earlier_conversation>')
    expect(first.prompt).toContain('answer 1')
    expect(first.prompt).not.toContain('answer 2')
    expect(first.prompt.endsWith('two, edited')).toBe(true)
  })

  it('the first message opens a plain new chat on the same model: no fork, nothing sent', async () => {
    const requests = answering()
    const h = await setupSessions()
    const users = await converse(h, 'one', 'two')
    await h.sessions.updateSession(h.session.id, { effort: 'max' })

    const fresh = await h.sessions.forkSession(h.session.id, users[0].turnId, { before: true })
    expect(fresh.id).not.toBe(h.session.id)
    expect(fresh).toMatchObject({ agent: 'claude', model: h.session.model, effort: 'max' })
    expect(fresh.forkedFrom).toBeUndefined()
    expect(fresh.agentSessionId).toBeUndefined()
    expect(fresh.seedHistory).toBeUndefined()
    expect(await h.store.readChat(fresh.id)).toEqual([])
    expect(requests).toHaveLength(2)
    expect(texts(await h.store.readChat(h.session.id))).toEqual(['one', 'two'])
  })

  it('a fork of a read-only chat stays read-only', async () => {
    answering()
    const h = await setupSessions()
    const users = await converse(h, 'one', 'two')
    h.session.readOnly = true
    expect((await h.sessions.forkSession(h.session.id, users[1].turnId, { before: true })).readOnly).toBe(true)
    expect((await h.sessions.forkSession(h.session.id, users[0].turnId, { before: true })).readOnly).toBe(true)
    expect((await h.sessions.forkSession(h.session.id, users[0].turnId)).readOnly).toBe(true)
  })
})

// The renderer store against a bridge stub that records every call into main.
describe('Edit and resend in the renderer store', () => {
  const calls: { name: string; args: unknown[] }[] = []
  const source = { id: 's1', workspaceId: 'w1', title: 'Persist sidebar filters', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '' } as unknown as Session
  const fork = { ...source, id: 's2', title: 'Persist sidebar filters (fork)' } as Session
  const snapshot = {
    repos: [{ id: 'r1', name: 'foreman', rootPath: '/repo' }],
    workspaces: [{ id: 'w1', repoId: 'r1', name: 'kigali', branch: 'b', baseBranch: 'main', path: '/w', portBase: 1, state: 'ready', createdAt: '' }],
    sessions: [source],
    settings: {},
    catalog: { agents: {} },
    platform: 'win32'
  } as unknown as AppSnapshot
  const answers: Record<string, () => unknown> = {
    getSnapshot: () => snapshot,
    pendingApprovals: () => [],
    agentStatus: () => ({ installed: false }),
    getChat: () => [],
    forkSession: () => fork
  }
  const invoke = new Proxy(
    {},
    {
      get: (_, name: string) =>
        async (...args: unknown[]) => {
          calls.push({ name, args })
          return answers[name]?.()
        }
    }
  )
  let store: typeof import('../src/renderer/src/store')

  beforeAll(async () => {
    vi.stubGlobal('window', { foreman: { invoke, send: { setUnread() {} }, onEvent() {} }, confirm: () => true, addEventListener() {}, dispatchEvent() {} })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
    vi.stubGlobal('document', { hasFocus: () => true })
    store = await import('../src/renderer/src/store')
    await store.initStore()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('forks from before the message and prefills the new tab’s composer with its text, sending nothing', async () => {
    calls.length = 0
    const result = await store.editAndResend('w1', 's1', { turnId: 't2', text: 'Also remember the selected workspace' })
    expect(result?.id).toBe('s2')
    expect(calls.map((c) => [c.name, ...c.args])).toEqual([['forkSession', 's1', 't2', { before: true }]])
    expect(calls.some((c) => c.name === 'sendMessage')).toBe(false)
    const state = store.getState()
    expect(state.activeSession.w1).toBe('s2')
    expect(state.composerFill).toMatchObject({
      sessionId: 's2',
      text: 'Also remember the selected workspace',
      edited: { from: 'Persist sidebar filters', original: 'Also remember the selected workspace' }
    })
    // The composer takes it once, with where it came from (for Show original / Discard).
    expect(store.takeComposerFill('s2')).toMatchObject({ text: 'Also remember the selected workspace', edited: { original: 'Also remember the selected workspace' } })
    expect(store.getState().composerFill).toBeNull()
  })
})
