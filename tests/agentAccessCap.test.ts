// docs/agent-access.md §4: every path that starts a turn carries a cap, or inherits the cap of the turn it continues.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { AgentDriver, AgentTurn, TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import type { TurnHost } from '../src/main/sessions'
import { LimitResumeService } from '../src/main/limitResume'
import { StopSafely, type StopSafelyDeps } from '../src/main/stopSafely'
import { Store } from '../src/main/store'
import type { TurnCap } from '../src/shared/agentAccess'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'
import { fakeDriver, gate, setupSessions } from './sessionHarness'

afterEach(() => {
  registerDriver(claudeDriver)
  vi.restoreAllMocks()
})

const WAIT = { timeout: 10_000 }
const cap = (ceiling: TurnCap['ceiling'], grantId = 'grant-1'): TurnCap => ({ ceiling, grantId, name: 'Claude Code' })
const users = async (h: { store: Store }, sessionId: string) => (await h.store.readChat(sessionId)).filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')

/** A Claude stand-in that records each turn's request and the session's cap as it starts, and runs until released. */
function recording() {
  const requests: TurnRequest[] = []
  const g = gate()
  registerDriver(fakeDriver(async (req, cb, signal) => {
    requests.push(req)
    return g.script(req, cb, signal)
  }))
  return { requests, release: g.release }
}

/** As `recording`, with a turn that takes steering. */
function steerable() {
  const requests: TurnRequest[] = []
  const steered: string[] = []
  const g = gate()
  const driver: AgentDriver = {
    ...claudeDriver,
    createTurn: (req, cb) => {
      const abort = new AbortController()
      return {
        run: () => (requests.push(req), g.script(req, cb, abort.signal)),
        stop: async () => abort.abort(),
        steer: (text: string) => (steered.push(text), true),
        setPlanMode: async () => {},
        setModel: async () => {}
      }
    }
  }
  registerDriver(driver)
  return { requests, steered, release: g.release }
}

describe('a capped turn', () => {
  it('runs at the lower of its policy and the ceiling, marked on its message and on the session while it runs', async () => {
    const r = recording()
    const h = await setupSessions()
    h.store.state.settings.requireToolApprovals = false
    await h.sessions.send(h.session.id, 'Refactor the parser', { cap: cap('auto') })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(r.requests[0].approvals).toBe('auto')
    expect(h.session.turnCap).toEqual(cap('auto'))
    expect((await users(h, h.session.id))[0].cap).toEqual(cap('auto'))
    r.release()
    await vi.waitFor(() => expect(h.ended).toEqual(['completed']), WAIT)
    expect(h.session.turnCap).toBeUndefined()
    // The next message the user sends is the user's: no cap.
    await h.sessions.send(h.session.id, 'Thanks')
    await vi.waitFor(() => expect(h.ended).toHaveLength(2), WAIT)
    expect(r.requests[1].approvals).toBe('never-ask')
    expect((await users(h, h.session.id))[1].cap).toBeUndefined()
  })

  it('never raises a chat above the user’s settings', async () => {
    const r = recording()
    const h = await setupSessions()
    h.store.state.settings.requireToolApprovals = true
    h.store.state.settings.autoPermissionMode = false
    await h.sessions.send(h.session.id, 'go', { cap: cap('never-ask') })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(r.requests[0].approvals).toBe('ask')
    r.release()
  })

  it('leaves the git folder out and protects configuration below Never ask, not at it', async () => {
    const r = recording()
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'one', { cap: cap('ask-except-edits') })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    const [capped] = r.requests
    expect(capped.extraWritableDirs).toBeUndefined()
    expect(capped.capped).toEqual({ ceiling: 'ask-except-edits', gitDir: expect.stringMatching(/\.git$/) })
    r.release()
    await vi.waitFor(() => expect(h.ended).toHaveLength(1), WAIT)
    await h.sessions.send(h.session.id, 'two', { cap: cap('never-ask') })
    await vi.waitFor(() => expect(r.requests).toHaveLength(2), WAIT)
    expect(r.requests[1].extraWritableDirs).toEqual([capped.capped!.gitDir])
    expect(r.requests[1].capped).toBeUndefined()
  })

  it('is refused on an agent that can’t be held to its ceiling: when sent, and when a queued one starts there', async () => {
    const r = recording()
    const h = await setupSessions()
    h.session.agent = 'cursor'
    await expect(h.sessions.send(h.session.id, 'go', { cap: cap('ask') })).rejects.toThrow(/Cursor/)
    expect(h.session.queue).toEqual([])
    h.session.agent = 'claude'
    // Queued for Claude; the chat moved to Cursor before it started.
    h.session.queue.push({ id: 'q1', turnId: 'turn-q', text: 'later', attachments: [], cap: cap('ask') })
    h.session.agent = 'opencode'
    h.sessions.resumeQueue(h.session.id)
    await vi.waitFor(() => expect(h.ended).toEqual(['error']), WAIT)
    const chat = await h.store.readChat(h.session.id)
    expect(chat.find((i) => i.kind === 'notice' && i.level === 'error')).toMatchObject({ text: expect.stringContaining('OpenCode') })
    expect(r.requests).toHaveLength(0)
    expect(h.session.turnCap).toBeUndefined()
  })
})

describe('a revoked sign-in’s cap (docs/agent-access.md §4, “Revoking”)', () => {
  it('is refused when sent, and when a message it queued (a cloud continuation, say) comes to start', async () => {
    const r = recording()
    const h = await setupSessions()
    const live = new Set(['grant-1'])
    h.sessions.grantExists = (id) => live.has(id)
    // A sign-in that no longer exists: refused at once, nothing queued.
    await expect(h.sessions.send(h.session.id, 'go', { cap: cap('ask', 'gone') })).rejects.toThrow('revoked or has ended')
    expect(h.session.queue).toEqual([])
    // Queued while it existed (as a cloud rollover queues its continuation), then revoked: it doesn't start.
    h.session.queue.push({ id: 'q1', turnId: 'turn-q', text: 'Continue', attachments: [], cap: cap('ask') })
    live.delete('grant-1')
    h.sessions.resumeQueue(h.session.id)
    await vi.waitFor(() => expect(h.ended).toEqual(['error']), WAIT)
    const chat = await h.store.readChat(h.session.id)
    expect(chat.find((i) => i.kind === 'notice' && i.level === 'error')).toMatchObject({ text: expect.stringContaining('revoked or has ended') })
    expect(r.requests).toHaveLength(0)
    // The user's own messages go ahead as ever.
    await h.sessions.send(h.session.id, 'Mine')
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    r.release()
  })

  it('goes ahead when there is no way to look sign-ins up', async () => {
    const r = recording()
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'go', { cap: cap('ask', 'unknown') })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    r.release()
  })

  it('clears an armed usage-limit resume whose cap names it, and no other', () => {
    const resume = (grantId?: string) => ({ turnId: 't', resetAt: '', at: new Date(Date.now() + 60_000).toISOString(), source: 's', text: 'Continue', armedAt: '', ...(grantId ? { cap: cap('auto', grantId) } : {}) })
    const sessions = [
      { id: 'a', limitResume: resume('g1') },
      { id: 'b', limitResume: resume('g2') },
      { id: 'c', limitResume: resume() },
      { id: 'd', limitResume: { ...resume('g1'), missed: true } }
    ] as unknown as Session[]
    const flush = vi.fn()
    const service = new LimitResumeService({ sessions: () => sessions, readChat: async () => [], send: async () => undefined, flush, changed: () => {}, now: () => Date.now() })
    expect(service.dropFromGrant('g1')).toBe(2)
    expect(sessions.map((s) => s.limitResume?.cap?.grantId ?? (s.limitResume ? 'none' : 'cleared'))).toEqual(['cleared', 'g2', 'none', 'cleared'])
    expect(flush).toHaveBeenCalledTimes(1)
    expect(service.dropFromGrant('g1')).toBe(0)
  })
})

describe('queued messages carry the cap to the turn they start', () => {
  it('behind a running turn', async () => {
    const r = recording()
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'first')
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(await h.sessions.send(h.session.id, 'second', { cap: cap('ask'), mode: 'queue' })).toBe('queued')
    expect(h.session.queue[0].cap).toEqual(cap('ask'))
    r.release()
    await vi.waitFor(() => expect(r.requests).toHaveLength(2), WAIT)
    expect(r.requests[1].approvals).toBe('ask')
    expect(h.session.turnCap).toEqual(cap('ask'))
    expect((await users(h, h.session.id))[1].cap).toEqual(cap('ask'))
  })

  it('waiting for an agent slot', async () => {
    const r = recording()
    const h = await setupSessions()
    h.store.state.settings.maxRunningAgents = 1
    const other = h.sessions.createSession(h.ws.id, { agent: 'claude', title: 'other' })
    await h.sessions.send(other.id, 'busy')
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(await h.sessions.send(h.session.id, 'waits', { cap: cap('auto') })).toBe('queued')
    expect(h.session.queue[0].cap).toEqual(cap('auto'))
    r.release()
    await vi.waitFor(() => expect(r.requests).toHaveLength(2), WAIT)
    expect(h.session.turnCap).toEqual(cap('auto'))
  })

  it('a cloud rollover’s continuation, ahead of the queue', async () => {
    const r = recording()
    const h = await setupSessions()
    h.sessions.queueContinuation(h.session.id, 'Continue.', cap('ask-except-edits'))
    h.sessions.resumeQueue(h.session.id)
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(h.session.turnCap).toEqual(cap('ask-except-edits'))
    r.release()
  })
  it('a cloud host is told the cap of the turn that ended, so its rollover can carry it', async () => {
    const ended: [string, string, TurnCap | undefined][] = []
    const host: TurnHost = {
      keeps: () => true,
      createTurn: (_session, _ws, _req: TurnRequest, callbacks: TurnCallbacks) => {
        const turn: AgentTurn = { run: async () => callbacks.finished({ ok: true }), stop: async () => {}, steer: () => false, setPlanMode: async () => {}, setModel: async () => {} }
        return Object.assign(turn, { hosted: true })
      },
      ended: (sessionId, turnId, carried) => void ended.push([sessionId, turnId, carried])
    }
    const h = await setupSessions({ turnHost: host })
    await h.sessions.send(h.session.id, 'capped', { cap: cap('auto'), turnId: 'turn-a' })
    await vi.waitFor(() => expect(ended).toHaveLength(1), WAIT)
    await h.sessions.send(h.session.id, 'mine', { turnId: 'turn-b' })
    await vi.waitFor(() => expect(ended).toHaveLength(2), WAIT)
    expect(ended).toEqual([[h.session.id, 'turn-a', cap('auto')], [h.session.id, 'turn-b', undefined]])
  })

  it('a hand-off asked for from a capped turn (a git review action) starts the new tab’s turn under the cap', async () => {
    const r = recording()
    const h = await setupSessions()
    const target = await h.sessions.handOff(h.session.id, { model: { agent: 'claude', model: 'claude-opus-5-5[1m]', fast: false }, text: 'Review this', title: 'Code review', cap: cap('ask') })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(target.turnCap).toEqual(cap('ask'))
    expect((await users(h, target.id))[0].cap).toEqual(cap('ask'))
    r.release()
  })
})

describe('steering', () => {
  it('a capped message queues instead of steering into a turn held less (or not at all), and steers into one held as low or lower', async () => {
    const r = steerable()
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'uncapped work')
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(await h.sessions.send(h.session.id, 'capped', { mode: 'steer', cap: cap('never-ask') })).toBe('queued')
    expect(r.steered).toEqual([])
    // The user's own message steers as ever.
    expect(await h.sessions.send(h.session.id, 'mine', { mode: 'steer' })).toBe('steered')
    expect(r.steered).toEqual(['mine'])
  })

  it('compares ceilings when the running turn is capped', async () => {
    const r = steerable()
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'capped work', { cap: cap('auto') })
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(await h.sessions.send(h.session.id, 'lower', { mode: 'steer', cap: cap('ask') })).toBe('queued')
    expect(await h.sessions.send(h.session.id, 'higher', { mode: 'steer', cap: cap('never-ask') })).toBe('steered')
    expect(await h.sessions.send(h.session.id, 'same', { mode: 'steer', cap: cap('auto', 'other') })).toBe('steered')
    expect(r.steered).toEqual(['higher', 'same'])
    // Steered, it runs under the running turn's cap.
    expect(h.session.turnCap).toEqual(cap('auto'))
  })

  it('steerQueued sends a queued message with its own cap, lowered by a capped caller’s', async () => {
    const r = recording()
    const h = await setupSessions()
    h.session.queue.push({ id: 'q1', turnId: 'turn-1', text: 'now', attachments: [], cap: cap('never-ask') })
    await h.sessions.steerQueued(h.session.id, 'q1', cap('ask'))
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    expect(h.session.turnCap).toEqual(cap('ask'))
    r.release()
    await vi.waitFor(() => expect(h.ended).toHaveLength(1), WAIT)
    h.session.queue.push({ id: 'q2', turnId: 'turn-2', text: 'again', attachments: [], cap: cap('auto') })
    await h.sessions.steerQueued(h.session.id, 'q2')
    await vi.waitFor(() => expect(r.requests).toHaveLength(2), WAIT)
    expect(h.session.turnCap).toEqual(cap('auto'))
  })

  it('steerQueued refuses a capped message into a turn held less, and leaves it where it was in the queue', async () => {
    const r = steerable()
    const h = await setupSessions()
    await h.sessions.send(h.session.id, 'uncapped work')
    await vi.waitFor(() => expect(r.requests).toHaveLength(1), WAIT)
    h.session.queue.push({ id: 'q1', turnId: 'turn-1', text: 'capped', attachments: [], cap: cap('ask') }, { id: 'q2', turnId: 'turn-2', text: 'next', attachments: [] })
    await expect(h.sessions.steerQueued(h.session.id, 'q1')).rejects.toThrow(/can’t join the running turn/)
    expect(h.session.queue.map((m) => m.id)).toEqual(['q1', 'q2'])
    expect(r.steered).toEqual([])
  })
})

describe('continuing or retrying a capped turn', () => {
  it('a usage-limit resume carries the stopped turn’s cap, lowered by the turn that armed it or resumes it', async () => {
    const reset = new Date(Date.now() + 3_600_000).toISOString()
    const session = { id: 's', workspaceId: 'w', agent: 'claude', status: 'idle', queue: [], lastTurn: { outcome: 'error', turnId: 't1', endedAt: '' } } as unknown as Session
    const chat: ChatItem[] = [
      { kind: 'user', id: 'user:t1', turnId: 't1', text: 'go', at: '', cap: cap('auto') },
      { kind: 'turn-end', id: 'turn-end:t1', turnId: 't1', outcome: 'error', limit: { resetAt: reset, source: 'resets 5pm' } } as ChatItem
    ]
    const sent: { cap?: TurnCap }[] = []
    const service = new LimitResumeService({
      sessions: () => [session],
      readChat: async () => chat,
      send: async (_id, _text, _origin, carried) => void sent.push({ cap: carried }),
      flush: () => {},
      changed: () => {},
      now: () => Date.now()
    })
    expect((await service.arm('s', 't1')).cap).toEqual(cap('auto'))
    expect((await service.arm('s', 't1', cap('ask', 'cli'))).cap).toEqual(cap('ask', 'cli'))
    await service.resumeNow('s')
    expect(sent.at(-1)).toEqual({ cap: cap('ask', 'cli') })
    await service.arm('s', 't1')
    await service.resumeNow('s', cap('ask-except-edits', 'now'))
    expect(sent.at(-1)).toEqual({ cap: cap('ask-except-edits', 'now') })
    // An uncapped stopped turn's resume is uncapped.
    delete (chat[0] as { cap?: TurnCap }).cap
    expect((await service.arm('s', 't1')).cap).toBeUndefined()
  })

  it('Stop safely’s Retry sends the stopped message again under its cap', async () => {
    const g = gate()
    const requests: TurnRequest[] = []
    registerDriver(fakeDriver(async (req, cb, signal) => (requests.push(req), g.script(req, cb, signal))))
    const h = await setupSessions()
    const deps: StopSafelyDeps = {
      store: h.store, sessions: h.sessions, workspaces: {} as never, terminals: () => [], stopChecks: async () => {}, killTerminals: () => {},
      forgetTerminals: () => {}, stopSpotlight: async () => {}, disposeSessions: async () => {}, quit: () => {}, changed: () => {}
    }
    const stop = new StopSafely(deps)
    await h.sessions.send(h.session.id, 'Do the thing', { cap: cap('ask') })
    await vi.waitFor(() => expect(requests).toHaveLength(1), WAIT)
    stop.recordQuit()
    await h.sessions.shutdown()
    const [row] = await stop.review()
    g.release()
    await stop.retry(row.key)
    await vi.waitFor(() => expect(h.ended).toEqual(['cancelled', 'completed']), WAIT)
    expect((await users(h, h.session.id)).map((u) => u.cap)).toEqual([cap('ask'), cap('ask')])
  })
})

describe('a restart', () => {
  const ws = (id: string): Workspace => ({ id, repoId: 'r', name: id, branch: id, baseBranch: 'main', portBase: 50000, state: 'ready', createdAt: '' }) as Workspace
  const session = (id: string, patch: Partial<Session>): Session =>
    ({ id, workspaceId: 'a', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '', ...patch }) as Session

  it('clears the cap of a turn it cut off, keeps a kept turn’s, and keeps queued messages’ caps', async () => {
    const root = await tempDir('foreman-cap-restart-')
    const first = new Store(root)
    await first.load()
    first.state.workspaces.push(ws('a'))
    first.state.sessions.push(
      session('cut', { status: 'running', turnId: 't1', turnCap: cap('ask'), queue: [{ id: 'q', turnId: 'tq', text: 'next', attachments: [], cap: cap('auto') }] }),
      session('kept', { status: 'running', turnId: 't2', turnCap: cap('auto') })
    )
    first.state.hostedTurns = [{ turnId: 't2', sessionId: 'kept', workspaceId: 'a' } as never]
    first.flush()
    first.close()
    const store = new Store(root)
    await store.load()
    const [cut, kept] = store.state.sessions
    expect(cut.turnId).toBeUndefined()
    expect(cut.turnCap).toBeUndefined()
    expect(cut.queue[0].cap).toEqual(cap('auto'))
    expect(kept.turnCap).toEqual(cap('auto'))
    store.close()
  })

  it('a kept turn that can’t be adopted ends without its cap', async () => {
    const h = await setupSessions()
    Object.assign(h.session, { status: 'running', turnId: 't9', turnCap: cap('ask') })
    await h.sessions.interrupted(h.session.id, 't9', 'The host stopped.')
    expect(h.session.turnCap).toBeUndefined()
  })
})
