// "Interrupt and send" for an agent that can't take a message mid-turn (turns.steer is the interrupt-restart fallback,
// docs/agents.md 2.5), through the real SessionService with a fake Cursor: the default follow-up is still Queue, the explicit
// choice stops the turn, waits for its end, marks it and starts the next turn on the same session with the message first;
// a marked turn is neither attention nor a failure, nor a notification, and the chat says why it ended.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { cursorProcessDriver } from '../src/main/agents/cursor/process'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { lookAt } from '../src/shared/attention'
import { effectiveMode, oppositeMode, planDelivery } from '../src/shared/delivery'
import { triageAll } from '../src/renderer/src/triage'
import type { AppSnapshot, ChatItem, Session, Workspace } from '../src/shared/types'
import { defaultSettings } from '../src/main/store'
import { fakeDriver, setupSessions } from './sessionHarness'

vi.setConfig({ testTimeout: 90_000 })

afterEach(() => {
  registerDriver(claudeDriver)
  registerDriver(cursorProcessDriver)
})

type Harness = Awaited<ReturnType<typeof setupSessions>>
type End = Extract<ChatItem, { kind: 'turn-end' }>
type User = Extract<ChatItem, { kind: 'user' }>

/** A Cursor whose held turns run until stopped (a stop ends them as stopped); the others finish at once. */
function cursor(options: { hold: (n: number) => boolean } = { hold: (n) => n === 1 }) {
  const requests: TurnRequest[] = []
  const stopped: number[] = []
  registerDriver({
    ...fakeDriver(async (req, cb, signal) => {
      requests.push(req)
      const n = requests.length
      cb.sessionStarted('agent-1')
      cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: `answer ${n}` })
      if (options.hold(n)) {
        await new Promise((resolve) => (signal.aborted ? resolve(undefined) : signal.addEventListener('abort', resolve)))
        stopped.push(n)
        cb.finished({ ok: false, error: 'Stopped.' })
        return
      }
      cb.finished({ ok: true })
    }),
    kind: 'cursor'
  })
  return { requests, stopped }
}

const tab = (h: Harness) => h.store.state.sessions.find((s) => s.id === h.session.id)!
const idle = (h: Harness) => vi.waitFor(() => expect(tab(h).status === 'idle' && !tab(h).turnId).toBe(true), { timeout: 10_000 })
const started = (n: number, requests: unknown[]) => vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(n), { timeout: 10_000 })

async function onCursor(options?: Parameters<typeof cursor>[0]) {
  const agent = cursor(options)
  const notified: string[] = []
  const h = await setupSessions({ events: { notify: (_w, _s, _t, _b, kind) => void notified.push(kind ?? '') } })
  await h.sessions.updateSession(h.session.id, { agent: 'cursor', model: 'auto' })
  return { h, ...agent, notified }
}

describe('Interrupt and send on an agent that can only be interrupted', () => {
  it('queues by default, and only an explicit interrupt cuts the turn', () => {
    // The setting says steer; an agent that can't steer still queues, and the interrupt is never the default.
    expect(effectiveMode('steer', null, false, true)).toBe('queue')
    expect(effectiveMode('queue', 'interrupt', false, true)).toBe('interrupt')
    expect(effectiveMode('queue', 'interrupt', false, false)).toBe('queue')
    expect(effectiveMode('steer', 'interrupt', true, false)).toBe('steer')
    expect(oppositeMode('queue', true)).toBe('interrupt')
    expect(oppositeMode('interrupt', true)).toBe('queue')
    expect(oppositeMode('queue', false)).toBe('steer')
    const running = { starting: false, running: true, canSteer: false }
    expect(planDelivery({ ...running, mode: 'steer', canInterrupt: true })).toBe('queue')
    expect(planDelivery({ ...running, mode: 'queue', canInterrupt: true })).toBe('queue')
    expect(planDelivery({ ...running, mode: 'interrupt', canInterrupt: true })).toBe('interrupt')
    expect(planDelivery({ ...running, mode: 'interrupt', canInterrupt: false })).toBe('queue')
    expect(planDelivery({ ...running, mode: 'interrupt', canInterrupt: true, starting: true })).toBe('queue')
  })

  it('a plain follow-up waits for the turn, however the setting is set', async () => {
    const { h, requests } = await onCursor()
    h.store.state.settings.followUpMode = 'steer'
    await h.sessions.send(h.session.id, 'first')
    await started(1, requests)
    expect(await h.sessions.send(h.session.id, 'later')).toBe('queued')
    expect(tab(h).queue.map((m) => m.text)).toEqual(['later'])
    expect(requests).toHaveLength(1)
    await h.sessions.cancel(h.session.id)
  })

  it('stops the turn, marks it, and starts the next on the same session with the message first', async () => {
    const { h, requests, stopped, notified } = await onCursor()
    await h.sessions.send(h.session.id, 'first')
    await started(1, requests)
    // Something already waits in the queue: the interrupting message goes ahead of it.
    expect(await h.sessions.send(h.session.id, 'after')).toBe('queued')

    expect(await h.sessions.send(h.session.id, 'do it differently', { mode: 'interrupt' })).toBe('started')
    await started(2, requests)
    expect(stopped).toEqual([1])
    expect(requests[1].resume).toBe('agent-1')
    expect(requests[1].prompt.startsWith('do it differently')).toBe(true)
    await started(3, requests)
    await idle(h)
    // The turn it left is `cancelled` and marked with the message that restarted it; the queued message ran after.
    const chat = await h.store.readChat(h.session.id)
    const users = chat.filter((i): i is User => i.kind === 'user')
    expect(users.map((u) => u.text)).toEqual(['first', 'do it differently', 'after'])
    const ends = chat.filter((i): i is End => i.kind === 'turn-end')
    expect(ends[0]).toMatchObject({ outcome: 'cancelled', restartedBy: users[1].id })
    expect(ends[1].restartedBy).toBeUndefined()
    // Nobody is told a turn was stopped: it wasn't, it went on with the message.
    expect(notified.filter((k) => k === 'stopped' || k === 'attention')).toEqual([])
  })

  it('"Send now" on a queued message is the same explicit interrupt', async () => {
    const { h, requests, stopped } = await onCursor()
    await h.sessions.send(h.session.id, 'first')
    await started(1, requests)
    await h.sessions.send(h.session.id, 'the queued one')
    await h.sessions.steerQueued(h.session.id, tab(h).queue[0].id)
    await started(2, requests)
    expect(stopped).toEqual([1])
    expect(requests[1].prompt.startsWith('the queued one')).toBe(true)
    await idle(h)
    expect(tab(h).queue).toEqual([])
  })

  it('an agent whose record has no interrupt fallback is never interrupted by the mode', async () => {
    registerDriver({ ...fakeDriver(() => new Promise(() => undefined)), kind: 'claude' })
    const h = await setupSessions()
    void h.sessions.send(h.session.id, 'first')
    await vi.waitFor(() => expect(tab(h).status).toBe('running'))
    expect(await h.sessions.send(h.session.id, 'more', { mode: 'interrupt' })).toBe('queued')
    expect(tab(h).queue.map((m) => m.text)).toEqual(['more'])
  })

  it('a turn already being cut leaves the next message queued', async () => {
    const { h, requests } = await onCursor({ hold: (n) => n <= 2 })
    await h.sessions.send(h.session.id, 'first')
    await started(1, requests)
    const [a, b] = await Promise.all([h.sessions.send(h.session.id, 'one', { mode: 'interrupt' }), h.sessions.send(h.session.id, 'two', { mode: 'interrupt' })])
    expect([a, b].sort()).toEqual(['queued', 'started'])
    await h.sessions.cancel(h.session.id)
  })
})

describe('a turn cut by "Interrupt and send" in triage and the log', () => {
  const NOW = Date.parse('2026-01-01T12:00:00Z')
  const ws = { id: 'ws', repoId: 'r', name: 'lisbon', branch: 'b', baseBranch: 'main', path: '/x', portBase: 1, state: 'ready', createdAt: new Date(NOW - 6e6).toISOString() } as Workspace
  const tabWith = (lastTurn: Session['lastTurn']): Session =>
    ({ id: 's1', workspaceId: 'ws', agent: 'cursor', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: new Date(NOW - 5e6).toISOString(), lastTurn }) as Session
  const triage = (s: Session) => triageAll({ snapshot: { workspaces: [ws], sessions: [s] } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW }, null)[0]
  const endedAt = new Date(NOW - 1000).toISOString()

  it('is neither attention nor a failure, though the same turn failing would be', () => {
    expect(triage(tabWith({ outcome: 'error', turnId: 't1', endedAt })).bucket).toBe('attention')
    // Even an agent that reported an error while it was being cut: the restart already went on with the message.
    expect(triage(tabWith({ outcome: 'error', turnId: 't1', endedAt, restartedBy: 'user:t2' })).bucket).not.toBe('attention')
    expect(triage(tabWith({ outcome: 'cancelled', turnId: 't1', endedAt, restartedBy: 'user:t2' })).bucket).not.toBe('attention')
  })

  it('leaves no "Turn stopped" in the attention log', () => {
    const input = { snapshot: { workspaces: [ws], sessions: [] } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW, settings: defaultSettings() } as never
    expect(lookAt(ws, [tabWith({ outcome: 'cancelled', turnId: 't1', endedAt })], input).turns.s1).toMatchObject({ outcome: 'cancelled' })
    expect(lookAt(ws, [tabWith({ outcome: 'cancelled', turnId: 't1', endedAt, restartedBy: 'user:t2' })], input).turns.s1).toBeUndefined()
  })
})
