import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import { LimitResumeService, type LimitResumeDeps } from '../src/main/limitResume'
import { Store } from '../src/main/store'
import type { ChatItem, LimitResume, Session } from '../src/shared/types'
import { limitCardView, RESUME_TEXT } from '../src/shared/usageLimit'
import { fakeDriver, gate, setupSessions, type Script } from './sessionHarness'

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
  vi.useRealTimers()
})

// The error arrives at 11:52 London time; the limit resets at 14:30 London time.
const T0 = Date.parse('2026-10-22T10:52:00Z')
const RESET = '2026-10-22T13:30:00.000Z'
const AT = Date.parse(RESET) + 60_000
const SOURCE = 'resets 2:30pm (Europe/London)'
const LIMIT_ERROR = `5-hour limit reached ∙ ${SOURCE}`

// A Claude turn that stops at the limit, as the adapter reports it; later turns complete.
const limitThenOk = (): Script => {
  let n = 0
  return async (_req, cb) => {
    n += 1
    cb.finished(n === 1 ? { ok: false, error: LIMIT_ERROR, limit: { resetAt: RESET, source: SOURCE, timeZone: 'Europe/London' } } : { ok: true })
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A tab whose first turn hit the limit, with the resume service wired to it as core.ts does. */
async function setup(script: Script = limitThenOk()) {
  registerDriver(fakeDriver(script))
  const clock = { now: T0 }
  const log: string[] = []
  let service!: LimitResumeService
  const h = await setupSessions({ events: { activity: (id) => service.activity(id) } })
  const missed: string[] = []
  service = new LimitResumeService({
    sessions: () => h.store.state.sessions,
    readChat: (id) => h.store.readChat(id),
    send: (id, text) => {
      log.push(`send:${text}`)
      return h.sessions.deliver(id, text, { mode: 'queue' })
    },
    flush: () => {
      log.push(`flush:${h.store.state.sessions.find((s) => s.id === h.session.id)?.limitResume ? 'armed' : 'none'}`)
      h.store.flush()
    },
    changed: () => {},
    now: () => clock.now,
    missed: (s) => void missed.push(s.id)
  })
  await h.sessions.send(h.session.id, 'Persist the sidebar filters')
  await until(() => h.ended.length === 1)
  const turnId = h.session.lastTurn!.turnId!
  await until(async () => (await h.store.readChat(h.session.id)).some((i) => i.kind === 'turn-end'))
  return { ...h, service, clock, turnId, log, missed }
}

const turnEnd = (items: ChatItem[]) => items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')!

describe('a turn that stops at a usage limit', () => {
  it('keeps what the error said on its turn-end, and offers the unticked resume', async () => {
    const { store, session, turnId } = await setup()
    const end = turnEnd(await store.readChat(session.id))
    expect(end).toMatchObject({ outcome: 'error', error: LIMIT_ERROR, limit: { resetAt: RESET, source: SOURCE } })
    expect(session.limitResume).toBeUndefined()
    expect(limitCardView(end, session, true, T0)).toEqual({ kind: 'offer', resetAt: Date.parse(RESET), source: SOURCE, armed: false })
    expect(turnId).toBe(end.turnId)
  })

  it('marks a Codex limit error with an unknown reset time, whatever the words say', async () => {
    registerDriver({ ...fakeDriver(async (_r, cb) => cb.finished({ ok: false, error: `You've hit your usage limit · ${SOURCE}` })), kind: 'codex' })
    const h = await setupSessions()
    const codexTab = h.sessions.createSession(h.ws.id, { agent: 'codex', title: 'codex' })
    await h.sessions.send(codexTab.id, 'go')
    await until(async () => (await h.store.readChat(codexTab.id)).some((i) => i.kind === 'turn-end'))
    const end = turnEnd(await h.store.readChat(codexTab.id))
    expect(end.limit).toEqual({})
    expect(limitCardView(end, codexTab, true, T0)).toEqual({ kind: 'unknown', stated: false })
  })
})

describe('arming', () => {
  it('writes one resume to disk with the exact text, and it survives a restart', async () => {
    const { root, store, session, service, turnId } = await setup()
    await service.arm(session.id, turnId)
    expect(session.limitResume).toEqual({ turnId, resetAt: RESET, at: new Date(AT).toISOString(), source: SOURCE, text: RESUME_TEXT, armedAt: new Date(T0).toISOString() })

    // Foreman restarts before the reset time: still armed.
    const reopened = new Store(root)
    await reopened.load()
    const again = reopened.state.sessions.find((s) => s.id === session.id)!
    expect(again.limitResume).toEqual(session.limitResume)
    const sent: string[] = []
    const later = new LimitResumeService({
      sessions: () => reopened.state.sessions,
      readChat: (id) => reopened.readChat(id),
      send: async (_id, text) => void sent.push(text),
      flush: () => reopened.flush(),
      changed: () => {},
      now: () => T0 + 60_000
    })
    later.start()
    later.stopTimer()
    expect(again.limitResume?.missed).toBeUndefined()
    await later.tick()
    expect(sent).toEqual([])
    reopened.close()
  })

  it('refuses when the chat moved on, the time is unknown or past, or the agent can’t say', async () => {
    const { session, service, turnId, clock, store } = await setup()
    await expect(service.arm(session.id, 'other-turn')).rejects.toThrow('Something newer happened')
    clock.now = Date.parse(RESET)
    await expect(service.arm(session.id, turnId)).rejects.toThrow('The reset time has passed')
    clock.now = T0
    session.agent = 'codex'
    await expect(service.arm(session.id, turnId)).rejects.toThrow('doesn’t say when its limits reset')
    session.agent = 'claude'
    const end = turnEnd(await store.readChat(session.id))
    await store.appendChat(session.id, { ...end, limit: {} })
    await expect(service.arm(session.id, turnId)).rejects.toThrow('didn’t say when the limit resets')
    expect(session.limitResume).toBeUndefined()
  })
})

describe('anything done in that tab first cancels it', () => {
  const armed = async () => {
    const t = await setup()
    await t.service.arm(t.session.id, t.turnId)
    expect(t.session.limitResume).toBeDefined()
    return t
  }

  it('a send', async () => {
    const t = await armed()
    await t.sessions.send(t.session.id, 'actually, do this instead')
    expect(t.session.limitResume).toBeUndefined()
  })

  it('a queued message', async () => {
    const t = await armed()
    await t.sessions.deliver(t.session.id, 'after that, this', { mode: 'queue' })
    expect(t.session.limitResume).toBeUndefined()
  })

  it('a steer', async () => {
    const t = await armed()
    await t.sessions.deliver(t.session.id, 'steer this way', { mode: 'steer' })
    expect(t.session.limitResume).toBeUndefined()
  })

  it('a message queued behind a running turn', async () => {
    const running = gate()
    const t = await setup(limitThenOk())
    // A resume can't stay armed while a turn runs (that turn's send cancelled it), so this one is set by hand
    // to see a message queued behind a running turn cancel it too.
    registerDriver(fakeDriver(running.script))
    await t.sessions.send(t.session.id, 'long job')
    t.session.limitResume = { turnId: t.turnId, resetAt: RESET, at: new Date(AT).toISOString(), source: SOURCE, text: RESUME_TEXT, armedAt: 'x' }
    await t.sessions.deliver(t.session.id, 'queued', { mode: 'queue' })
    expect(t.session.queue).toHaveLength(1)
    expect(t.session.limitResume).toBeUndefined()
    running.release()
  })

  it('a rewind or restore to before a message', async () => {
    const t = await armed()
    await t.sessions.restore(t.session.id, t.turnId)
    expect(t.session.limitResume).toBeUndefined()
  })

  it('a model change (or effort or fast mode), but not a rename', async () => {
    const t = await armed()
    await t.sessions.updateSession(t.session.id, { title: 'Renamed' })
    expect(t.session.limitResume).toBeDefined()
    await t.sessions.updateSession(t.session.id, { model: t.session.model })
    expect(t.session.limitResume).toBeDefined()
    await t.sessions.updateSession(t.session.id, { model: t.session.model === 'claude-sonnet-5-5[1m]' ? 'claude-opus-5-5[1m]' : 'claude-sonnet-5-5[1m]' })
    expect(t.session.limitResume).toBeUndefined()

    const e = await armed()
    await e.sessions.updateSession(e.session.id, { effort: e.session.effort === 'low' ? 'high' : 'low' })
    expect(e.session.limitResume).toBeUndefined()
  })

  it('archiving the workspace, or closing the tab', async () => {
    const t = await armed()
    await t.sessions.disposeWorkspaceSessions(t.ws.id, t.ws.path!)
    expect(t.session.limitResume).toBeUndefined()

    const c = await armed()
    await c.sessions.closeSession(c.session.id)
    expect(c.session.limitResume).toBeUndefined()
  })

  it('but not activity in another tab', async () => {
    const t = await armed()
    const other = t.sessions.createSession(t.ws.id, { agent: 'claude', title: 'other' })
    await t.sessions.send(other.id, 'unrelated work')
    expect(t.session.limitResume).toBeDefined()
  })

  it('Cancel (or unticking) removes it, on disk', async () => {
    const t = await armed()
    t.service.cancel(t.session.id)
    expect(t.session.limitResume).toBeUndefined()
    expect(t.log.at(-1)).toBe('flush:none')
  })
})

describe('at the reset time', () => {
  it('sends the exact text once through the tab’s queue, written to disk as gone first', async () => {
    const t = await setup()
    await t.service.arm(t.session.id, t.turnId)
    t.clock.now = AT - 1000
    await t.service.tick()
    expect(t.log.filter((l) => l.startsWith('send'))).toEqual([])
    t.clock.now = AT + 1000
    await t.service.tick()
    expect(t.log.slice(-2)).toEqual(['flush:none', `send:${RESUME_TEXT}`])
    await until(() => t.ended.length === 2)
    const users = (await t.store.readChat(t.session.id)).filter((i) => i.kind === 'user')
    expect(users.map((u) => (u as { text: string }).text)).toEqual(['Persist the sidebar filters', RESUME_TEXT])
    expect(t.session.limitResume).toBeUndefined()
    await t.service.tick()
    expect(t.log.filter((l) => l.startsWith('send'))).toHaveLength(1)
  })
})

// ---- the clock, with fake timers and a stand-in for the tabs ----

function stubbed(resume: Partial<LimitResume> = {}, patch: Partial<Session> = {}) {
  const session = {
    id: 's1', workspaceId: 'ws', agent: 'claude', model: 'm', status: 'idle', queue: [{ id: 'q1', text: 'queued before', attachments: [] }], createdAt: 'x',
    limitResume: { turnId: 't1', resetAt: new Date(AT - 60_000).toISOString(), at: new Date(AT).toISOString(), source: SOURCE, text: RESUME_TEXT, armedAt: 'x', ...resume },
    ...patch
  } as Session
  const sent: string[] = []
  const missed: string[] = []
  const flushed: (LimitResume | undefined)[] = []
  const deps: LimitResumeDeps = {
    sessions: () => [session],
    readChat: async () => [],
    send: async (_id, text) => void sent.push(text),
    flush: () => void flushed.push(session.limitResume && { ...session.limitResume }),
    changed: () => {},
    now: () => Date.now(),
    missed: (s) => void missed.push(s.id)
  }
  return { session, sent, missed, flushed, deps }
}

describe('the clock', () => {
  it('fires at the reset time plus the buffer, once, and leaves the queue alone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const s = stubbed()
    const service = new LimitResumeService(s.deps)
    service.start()
    await vi.advanceTimersByTimeAsync(AT - T0 - 20_000)
    expect(s.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    expect(s.sent).toEqual([RESUME_TEXT])
    expect(s.session.limitResume).toBeUndefined()
    expect(s.session.queue.map((m) => m.id)).toEqual(['q1'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(s.sent).toEqual([RESUME_TEXT])
    service.stopTimer()
  })

  it('asks instead of firing when the computer slept past the time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const s = stubbed()
    const service = new LimitResumeService(s.deps)
    service.start()
    await vi.advanceTimersByTimeAsync(60_000)
    // Asleep from here until a minute after the resume was due: no timer ran meanwhile.
    vi.setSystemTime(AT + 60_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(s.sent).toEqual([])
    expect(s.session.limitResume?.missed).toBe(true)
    expect(s.missed).toEqual(['s1'])
    expect(s.flushed.at(-1)?.missed).toBe(true)
    // It stays missed; nothing goes later on its own.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(s.sent).toEqual([])
    service.stopTimer()
  })

  it('asks on wake (the power monitor), and a sleep that ends before the time changes nothing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const early = stubbed()
    const a = new LimitResumeService(early.deps)
    a.start()
    vi.setSystemTime(AT - 10 * 60_000)
    a.woke()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(early.session.limitResume?.missed).toBeUndefined()
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(early.sent).toEqual([RESUME_TEXT])
    a.stopTimer()

    const late = stubbed()
    const b = new LimitResumeService(late.deps)
    b.start()
    vi.setSystemTime(AT + 1000)
    b.woke()
    expect(late.session.limitResume?.missed).toBe(true)
    expect(late.sent).toEqual([])
    b.stopTimer()
  })

  it('asks at launch when Foreman was closed at the time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(AT + 5 * 60_000)
    const s = stubbed()
    const service = new LimitResumeService(s.deps)
    service.start()
    service.stopTimer()
    expect(s.session.limitResume?.missed).toBe(true)
    expect(s.missed).toEqual(['s1'])
    expect(s.sent).toEqual([])
  })

  it('Resume now sends a missed one once; Dismiss drops it', async () => {
    const s = stubbed({ missed: true })
    const service = new LimitResumeService(s.deps)
    await service.resumeNow('s1')
    expect(s.sent).toEqual([RESUME_TEXT])
    expect(s.flushed.at(-1)).toBeUndefined()
    await expect(service.resumeNow('s1')).rejects.toThrow('no resume waiting')

    const d = stubbed({ missed: true })
    new LimitResumeService(d.deps).cancel('s1')
    expect(d.session.limitResume).toBeUndefined()
    expect(d.sent).toEqual([])
  })

  it('a send that fails comes back as missed, saying why', async () => {
    const s = stubbed()
    s.deps.send = async () => {
      throw new Error('The workspace is not ready yet')
    }
    s.deps.now = () => AT + 1000
    const service = new LimitResumeService(s.deps)
    await service.tick()
    expect(s.session.limitResume).toMatchObject({ missed: true, failed: 'The workspace is not ready yet', text: RESUME_TEXT })
  })
})

describe('the card', () => {
  const end = { turnId: 't1', limit: { resetAt: RESET, source: SOURCE } }
  const claude = { agent: 'claude' as const }

  it('offers the checkbox only on the latest turn of an idle chat, before the time', () => {
    expect(limitCardView(end, claude, true, T0).kind).toBe('offer')
    expect(limitCardView(end, claude, false, T0)).toEqual({ kind: 'source', resetAt: Date.parse(RESET), source: SOURCE, passed: false })
    expect(limitCardView(end, claude, true, AT)).toMatchObject({ kind: 'source', passed: true })
  })

  it('shows it ticked when armed, and asks when missed', () => {
    const resume: LimitResume = { turnId: 't1', resetAt: RESET, at: new Date(AT).toISOString(), source: SOURCE, text: RESUME_TEXT, armedAt: 'x' }
    expect(limitCardView(end, { ...claude, limitResume: resume }, true, T0)).toMatchObject({ kind: 'offer', armed: true })
    expect(limitCardView(end, { ...claude, limitResume: { ...resume, missed: true } }, true, AT)).toMatchObject({ kind: 'missed' })
    // A resume for another turn doesn't tick this one.
    expect(limitCardView(end, { ...claude, limitResume: { ...resume, turnId: 't0' } }, true, T0)).toMatchObject({ kind: 'offer', armed: false })
  })

  it('says unknown, with no checkbox, when no time was stated or the agent can’t say', () => {
    expect(limitCardView({ turnId: 't1', limit: {} }, claude, true, T0)).toEqual({ kind: 'unknown', stated: true })
    expect(limitCardView(end, { agent: 'codex' }, true, T0)).toEqual({ kind: 'unknown', stated: false })
    expect(limitCardView(end, { agent: 'cursor' }, true, T0)).toEqual({ kind: 'unknown', stated: false })
    expect(limitCardView({ turnId: 't1' }, claude, true, T0)).toEqual({ kind: 'none' })
  })
})
