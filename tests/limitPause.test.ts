// Limits that recover (docs/agents.md 7.2, issue #131): a turn that stops at a usage limit pauses its chat and, with "Resume by
// itself", resumes with no click when the limit resets. 12 chats hit a limit together and come back on a fake clock; the resume
// carries how the stopped turn was started (a flow step's persona, write scope and read-only hold, a schedule run's unattended
// flag); an unknown reset time and "Ask me first" leave the offer; Continue on account moves a paused chat, never by itself.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { LimitResumeService, type LimitResumeDeps } from '../src/main/limitResume'
import { Store } from '../src/main/store'
import { waitingOnLimit, type AccountLimits } from '../src/shared/limits'
import type { ChatItem, Session, UsageLimit } from '../src/shared/types'
import { limitCardView, RESUME_TEXT } from '../src/shared/usageLimit'
import type { Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'
import { fakeDriver, setupSessions, type Script } from './sessionHarness'

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

const T0 = Date.parse('2026-10-22T10:52:00Z')
const RESET = '2026-10-22T13:30:00.000Z'
const AT = Date.parse(RESET) + 60_000
const LIMIT: UsageLimit = { resetAt: RESET, source: 'five_hour', timeZone: 'UTC', from: 'event' }

async function until(check: () => boolean | Promise<boolean>, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Every chat's first message hits the limit; the resume's message completes. What each turn was started with is kept. */
function limitScript(limit: UsageLimit | undefined = LIMIT, seen: { req: TurnRequest; unattended: unknown }[] = []) {
  const script = (getSession: () => Session | undefined): Script => async (req, cb) => {
    seen.push({ req, unattended: getSession()?.unattended })
    if (req.prompt.includes(RESUME_TEXT)) return cb.finished({ ok: true })
    cb.finished({ ok: false, error: 'You have reached your usage limit', ...(limit ? { limit } : {}) })
  }
  return { script, seen }
}

/** The chats and the resume service wired as core.ts wires them (send through the unattended marks), on a clock we move by hand. */
async function rig(options: { limit?: UsageLimit | undefined; resumeAfterLimit?: 'auto' | 'ask'; workspaces?: number } = {}) {
  const limit = 'limit' in options ? options.limit : LIMIT
  const clock = { now: T0 }
  const { script, seen } = limitScript(limit)
  let current: Session | undefined
  registerDriver(fakeDriver(script(() => current)))
  const notified: { kind?: string; sessionId: string }[] = []
  const resumed: string[] = []
  let service!: LimitResumeService
  let mode = options.resumeAfterLimit ?? 'auto'
  // A workspace holds ten chats at most, so many chats means many workspaces (each in a repository of its own: checkpoints are git).
  const wsById = new Map<string, Workspace>()
  const h = await setupSessions({
    workspaces: { workspace: (id: string) => wsById.get(id) ?? [...wsById.values()][0] },
    events: {
      activity: (id) => service.activity(id),
      limitPaused: (id, turnId, l, cap) => void service.autoArm(id, turnId, l, cap),
      notify: (_ws, sessionId, _title, _body, kind) => void notified.push({ sessionId, kind }),
      turnEnded() {}
    }
  })
  service = new LimitResumeService({
    sessions: () => h.store.state.sessions,
    readChat: (id) => h.store.readChat(id),
    // As core.ts: a flow step or a schedule run starts its resumed turn under the mark it was started with.
    send: async (id, text, origin, cap, unattended) => {
      const turnId = `resume-${id}-${Date.now()}`
      if (unattended && ('flowRunId' in unattended || 'occurrenceId' in unattended)) h.sessions.markUnattended(turnId, unattended)
      current = h.store.state.sessions.find((s) => s.id === id)
      return h.sessions.deliver(id, text, { mode: 'queue', origin, turnId, ...(cap ? { cap } : {}) })
    },
    resumeAfterLimit: () => mode,
    moveAccount: (id, to) => h.sessions.updateSession(id, { instanceId: to }),
    resumed: (s) => void resumed.push(s.id),
    flush: () => h.store.flush(),
    changed: () => {},
    now: () => clock.now
  })
  wsById.set(h.ws.id, h.ws)
  const chats = [h.session]
  const extra = Math.max(0, (options.workspaces ?? 1) - 1)
  const paths = await Promise.all(Array.from({ length: extra }, () => makeRepo()))
  for (let i = 0; i < extra; i++) {
    const w: Workspace = { ...h.ws, id: `ws-${i + 2}`, name: `ws-${i + 2}`, path: paths[i], portBase: 50050 + i * 10 }
    wsById.set(w.id, w)
    h.store.state.workspaces.push(w)
    chats.push(h.sessions.createSession(w.id, { agent: 'claude', title: `chat ${i + 2}` }))
  }
  return { ...h, chats, service, clock, seen, notified, resumed, setMode: (m: 'auto' | 'ask') => (mode = m) }
}

const endOf = (items: ChatItem[]) => items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')!
const paused = (s: Session) => s.lastTurn?.outcome === 'limit'

describe('12 chats hit a usage limit', () => {
  it('pause, are armed with no click, and resume together when the limit resets', async () => {
    const r = await rig({ workspaces: 12 })
    const arm = vi.spyOn(r.service, 'arm')
    const resumeNow = vi.spyOn(r.service, 'resumeNow')
    const sessions = r.chats
    await Promise.all(sessions.map((s, i) => r.sessions.send(s.id, `work ${i + 1}`)))
    await until(() => sessions.every(paused))

    // Paused, not failed, and armed by Foreman for the reset plus the buffer: nobody clicked anything.
    for (const s of sessions) {
      expect(s.lastTurn).toMatchObject({ outcome: 'limit', resetAt: RESET })
      expect(s.limitResume).toMatchObject({ resetAt: RESET, at: new Date(AT).toISOString(), auto: true, text: RESUME_TEXT })
      expect(waitingOnLimit(s)).toBe(true)
    }
    // Each turn's own record still says it ended with an error and a limit, for the card and the Lineage.
    expect(endOf(await r.store.readChat(sessions[0].id))).toMatchObject({ outcome: 'error', limit: LIMIT })
    // A paused chat that waits for the clock is no "needs you" notification.
    expect(r.notified.filter((n) => n.kind === 'attention')).toEqual([])

    // Before the time: nothing is sent. At it: every chat resumes by itself, once, and the person hears of it per chat.
    r.clock.now = AT - 1000
    await r.service.tick()
    expect(sessions.every(paused)).toBe(true)
    r.clock.now = AT + 1000
    await r.service.tick()
    await until(() => sessions.every((s) => s.lastTurn?.outcome === 'completed'))
    for (const s of sessions) expect(s.limitResume).toBeUndefined()
    expect(r.resumed.sort()).toEqual(sessions.map((s) => s.id).sort())
    expect(r.seen.filter((x) => x.req.prompt.includes(RESUME_TEXT))).toHaveLength(12)
    expect(arm).not.toHaveBeenCalled()
    expect(resumeNow).not.toHaveBeenCalled()
    // A second tick sends nothing more.
    await r.service.tick()
    expect(r.seen).toHaveLength(24)
  }, 180_000)
})

describe('when it arms, and when it only offers', () => {
  it('"Ask me first" leaves the offer: nothing armed, the card offers the time unticked, the tab is a failure to look at', async () => {
    const r = await rig({ resumeAfterLimit: 'ask' })
    await r.sessions.send(r.session.id, 'work')
    await until(() => paused(r.session))
    expect(r.session.limitResume).toBeUndefined()
    expect(waitingOnLimit(r.session)).toBe(false)
    const end = endOf(await r.store.readChat(r.session.id))
    expect(limitCardView(end, r.session, true, T0)).toMatchObject({ kind: 'offer', armed: false })
    expect(r.notified.some((n) => n.kind === 'attention')).toBe(true)
    // Ticking it is still the person's word.
    await r.service.arm(r.session.id, r.session.lastTurn!.turnId!)
    expect(r.session.limitResume).toMatchObject({ resetAt: RESET })
    expect(r.session.limitResume?.auto).toBeUndefined()
  })

  it('an unknown reset time is an offer under either setting, and nothing is sent by itself', async () => {
    const r = await rig({ limit: {} })
    await r.sessions.send(r.session.id, 'work')
    await until(() => paused(r.session))
    expect(r.session.limitResume).toBeUndefined()
    expect(r.session.lastTurn?.resetAt).toBeUndefined()
    r.clock.now = AT + 86_400_000
    await r.service.tick()
    expect(r.seen).toHaveLength(1)
    expect(limitCardView(endOf(await r.store.readChat(r.session.id)), r.session, true, T0)).toEqual({ kind: 'unknown', stated: true })
    // "Resume now" is the person's word: it sends the one message.
    await r.service.resumeNow(r.session.id)
    await until(() => r.session.lastTurn?.outcome === 'completed')
    expect(r.seen.at(-1)!.req.prompt).toContain(RESUME_TEXT)
  })

  it('a reset time already past is an offer too (Retry), not a resume in the past', async () => {
    const r = await rig({ limit: { ...LIMIT, resetAt: new Date(T0 - 60_000).toISOString() } })
    await r.sessions.send(r.session.id, 'work')
    await until(() => paused(r.session))
    expect(r.session.limitResume).toBeUndefined()
  })

  it('Dismiss puts the tab back to a failed turn that asks for you, and a send first cancels the resume', async () => {
    const r = await rig()
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    r.service.cancel(r.session.id)
    expect(r.session.limitResume).toBeUndefined()
    expect(r.session.lastTurn?.outcome).toBe('error')

    const t = await rig()
    await t.sessions.send(t.session.id, 'work')
    await until(() => waitingOnLimit(t.session))
    await t.sessions.send(t.session.id, 'do this instead')
    expect(t.session.limitResume).toBeUndefined()
  })
})

describe('a resume starts the turn the way it was started', () => {
  const flowMark = (persona: object) => ({ flowRunId: 'run-1', step: 'build', persona }) as NonNullable<Session['unattended']>

  it('a flow step keeps its persona, write scope and unattended flag', async () => {
    const r = await rig()
    r.session.unattended = flowMark({ name: 'developer', instructions: 'Build it.', writes: ['docs/**'] })
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    // Held through the turn's end, and carried by the armed resume.
    expect(r.session.unattended).toBeUndefined()
    expect(r.session.limitHeld).toMatchObject({ unattended: { flowRunId: 'run-1', step: 'build' } })
    expect(r.session.limitResume?.unattended).toMatchObject({ flowRunId: 'run-1', step: 'build', persona: { name: 'developer', writes: ['docs/**'] } })
    r.clock.now = AT + 1000
    await r.service.tick()
    await until(() => r.session.lastTurn?.outcome === 'completed')
    const resumed = r.seen.at(-1)!
    expect(resumed.req.writeScope).toEqual(['docs/**'])
    expect(resumed.req.approvals).toBe('auto')
    expect(resumed.unattended).toMatchObject({ flowRunId: 'run-1', persona: { name: 'developer' } })
    // The tab is an ordinary one again once that turn ended.
    expect(r.session.unattended).toBeUndefined()
    expect(r.session.limitHeld).toBeUndefined()
  })

  it('a read-only step stays read-only', async () => {
    const r = await rig()
    r.session.unattended = flowMark({ name: 'reviewer', readOnly: true })
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    r.clock.now = AT + 1000
    await r.service.tick()
    await until(() => r.session.lastTurn?.outcome === 'completed')
    expect(r.seen.at(-1)!.req.readOnly).toBe(true)
  })

  it('a schedule run resumes unattended, as the run’s own', async () => {
    const r = await rig()
    r.session.unattended = { occurrenceId: 'occ-1' }
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    expect(r.session.limitResume?.unattended).toEqual({ occurrenceId: 'occ-1' })
    r.clock.now = AT + 1000
    await r.service.tick()
    await until(() => r.session.lastTurn?.outcome === 'completed')
    const resumed = r.seen.at(-1)!
    expect(resumed.unattended).toEqual({ occurrenceId: 'occ-1' })
    expect(resumed.req.approvals).toBe('auto')
  })

  it('an attended chat resumes attended, as before', async () => {
    const r = await rig()
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    expect(r.session.limitResume?.unattended).toBeUndefined()
    r.clock.now = AT + 1000
    await r.service.tick()
    await until(() => r.session.lastTurn?.outcome === 'completed')
    expect(r.seen.at(-1)!.unattended).toBeUndefined()
  })

  it('a resume whose run has ended doesn’t start the turn: it comes back missed, saying why', async () => {
    const r = await rig()
    r.session.unattended = flowMark({ name: 'developer' })
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    // The run ended: the send that core makes refuses.
    const send = vi.fn().mockRejectedValue(new Error('The run this turn belonged to has ended, so it wasn’t resumed.'))
    const service = new LimitResumeService({ ...((r.service as unknown as { deps: LimitResumeDeps }).deps), send })
    r.clock.now = AT + 1000
    await service.tick()
    expect(r.session.limitResume).toMatchObject({ missed: true, failed: 'The run this turn belonged to has ended, so it wasn’t resumed.' })
    expect(r.seen).toHaveLength(1)
  })
})

describe('Continue on account', () => {
  const work = { id: 'ai-work', agent: 'claude' as const, label: 'Work', auth: 'cli' as const }
  const limits = (): AccountLimits[] => [
    { agent: 'claude', windows: [{ kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: RESET }], updatedAt: new Date(T0).toISOString() },
    { agent: 'claude', instance: 'ai-work', windows: [{ kind: 'session', usedPercent: 22, state: 'ok' }], updatedAt: new Date(T0).toISOString() }
  ]

  it('moves the paused chat to the other account and resumes it there at once', async () => {
    const r = await rig()
    r.store.state.settings.agentInstances = [work]
    r.store.state.limits = limits()
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    await r.service.continueOnAccount(r.session.id, 'ai-work')
    await until(() => r.session.lastTurn?.outcome === 'completed')
    expect(r.session.instanceId).toBe('ai-work')
    expect(r.session.limitResume).toBeUndefined()
    expect(r.seen.at(-1)!.req.prompt).toContain(RESUME_TEXT)
  })

  it('is never automatic: the armed resume stays on the blocked account until the person chooses', async () => {
    const r = await rig()
    r.store.state.settings.agentInstances = [work]
    r.store.state.limits = limits()
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    expect(r.session.instanceId).toBeUndefined()
    expect(r.session.limitResume).toBeDefined()
  })

  it('refuses a chat that isn’t paused, and a turn that belongs to a run', async () => {
    const r = await rig()
    r.store.state.settings.agentInstances = [work]
    await expect(r.service.continueOnAccount(r.session.id, 'ai-work')).rejects.toThrow('isn’t paused')
    r.session.unattended = { occurrenceId: 'occ-1' }
    await r.sessions.send(r.session.id, 'work')
    await until(() => waitingOnLimit(r.session))
    await expect(r.service.continueOnAccount(r.session.id, 'ai-work')).rejects.toThrow('belongs to a run')
  })
})

describe('the account’s windows', () => {
  it('a turn’s rate-limit windows are kept per account, merged, and saved with the state', async () => {
    const script: Script = async (_req, cb) => {
      cb.limits?.([{ kind: 'session', usedPercent: 60, state: 'ok', resetsAt: RESET }])
      cb.limits?.([{ kind: 'weekly', usedPercent: 85, state: 'warning' }])
      cb.limits?.([{ kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: RESET }])
      cb.finished({ ok: true })
    }
    registerDriver(fakeDriver(script))
    const root = await tempDir('foreman-limits-')
    const store = new Store(root)
    await store.load()
    const h = await setupSessions({ store })
    await h.sessions.send(h.session.id, 'go')
    await until(() => h.session.lastTurn?.outcome === 'completed')
    const entry = store.state.limits?.find((l) => l.agent === 'claude' && !l.instance)
    expect(entry?.windows).toEqual([
      { kind: 'session', usedPercent: 100, state: 'blocked', resetsAt: RESET },
      { kind: 'weekly', usedPercent: 85, state: 'warning' }
    ])
    // A chat on another account reports under that account.
    store.state.settings.agentInstances = [{ id: 'ai-work', agent: 'claude', label: 'Work', auth: 'cli' }]
    h.session.instanceId = 'ai-work'
    await h.sessions.send(h.session.id, 'again')
    await until(() => store.state.limits?.some((l) => l.instance === 'ai-work') === true)
    expect(store.state.limits).toHaveLength(2)
    store.flush()
    const reloaded = new Store(root)
    await reloaded.load()
    expect(reloaded.state.limits).toEqual(store.state.limits)
  }, 120_000)
})
