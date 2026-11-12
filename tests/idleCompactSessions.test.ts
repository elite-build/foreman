// Idle compaction through the session service (docs/agents.md 3): what a turn arms, what the person's activity cancels, and the
// "Compacted while idle" row the compaction leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import type { ChatItem } from '../src/shared/types'
import { fakeDriver, setupSessions } from './sessionHarness'

type Harness = Awaited<ReturnType<typeof setupSessions>>

const MINUTE = 60_000

afterEach(() => {
  registerDriver(claudeDriver)
  vi.useRealTimers()
})
beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))

/** Claude Code as the turns here see it: each answers with a 200,000-token context and a warm 5-minute cache; `/compact` compacts it. */
function claude(cache: { ttl: '5m' | '1h'; warm: boolean } | null = { ttl: '5m', warm: true }) {
  const requests: TurnRequest[] = []
  registerDriver(
    fakeDriver(async (req, cb) => {
      requests.push(req)
      cb.sessionStarted(req.resume ?? 'native-1')
      if (req.prompt === '/compact') {
        cb.item({ kind: 'notice', id: `${req.turnId}:n`, turnId: req.turnId, level: 'info', text: 'Conversation compacted to free up context.', divider: { kind: 'compact', before: 200_000, after: 22_000 } })
        cb.usage({ used: 22_000, limit: 1_000_000 })
      } else {
        cb.item({ kind: 'assistant', id: `${req.turnId}:a`, turnId: req.turnId, text: 'answer' })
        cb.assistantMessage(`a${requests.length}`)
        cb.usage({ used: 200_000, limit: 1_000_000 })
        if (cache) cb.cacheWindow?.(cache)
      }
      cb.finished({ ok: true })
    })
  )
  return requests
}

const idle = (h: Harness) =>
  vi.waitFor(() => {
    const s = h.store.state.sessions.find((x) => x.id === h.session.id)!
    expect(s.status).toBe('idle')
    expect(s.turnId).toBeUndefined()
  }, { timeout: 10_000 })

const compactor = (h: Harness) => (h.sessions as unknown as { idleCompact: { armed(id: string): boolean } }).idleCompact
const armed = (h: Harness) => compactor(h).armed(h.session.id)

/** A turn, and the moment its timer is (or isn't) armed. */
async function turn(h: Harness, text = 'hello') {
  await h.sessions.send(h.session.id, text)
  await idle(h)
  // Armed right after the end is recorded.
  await vi.waitFor(() => expect(h.store.state.sessions.find((s) => s.id === h.session.id)!.lastTurn?.outcome).toBe('completed'), { timeout: 10_000 })
  await Promise.resolve()
}

describe('idle compaction through the session service', () => {
  it('is off by default: a turn arms nothing', async () => {
    claude()
    const h = await setupSessions()
    expect(h.store.state.settings.idleCompactTokens).toBe(0)
    await turn(h)
    expect(armed(h)).toBe(false)
  })

  it('compacts the chat 30 seconds before its cache expires, with no message from the person, and says so in one row', async () => {
    const requests = claude()
    const h = await setupSessions()
    h.store.state.settings.idleCompactTokens = 150_000
    await turn(h)
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 31_000)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 15_000 })
    expect(requests[1]).toMatchObject({ prompt: '/compact', resume: 'native-1' })
    await idle(h)

    const chat = await h.store.readChat(h.session.id)
    const message = chat.filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user').at(-1)!
    expect(message.origin).toEqual({ kind: 'idle-compact' })
    const divider = chat.flatMap((i) => (i.kind === 'notice' && i.divider ? [i.divider] : []))
    expect(divider).toEqual([{ kind: 'compact', before: 200_000, after: 22_000, idle: true, at: expect.any(String) }])
  })

  it('does not arm for a context under the setting, or a cache that was not warm, or an agent that reports none', async () => {
    const under = await (async () => {
      claude()
      const h = await setupSessions()
      h.store.state.settings.idleCompactTokens = 250_000
      await turn(h)
      return armed(h)
    })()
    expect(under).toBe(false)
    claude({ ttl: '5m', warm: false })
    const cold = await setupSessions()
    cold.store.state.settings.idleCompactTokens = 150_000
    await turn(cold)
    expect(armed(cold)).toBe(false)
    claude(null)
    const none = await setupSessions()
    none.store.state.settings.idleCompactTokens = 150_000
    await turn(none)
    expect(armed(none)).toBe(false)
  })

  it('stands down once the person types, and once they send', async () => {
    const requests = claude()
    const h = await setupSessions()
    h.store.state.settings.idleCompactTokens = 150_000
    await turn(h)
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    h.sessions.noteTyping(h.session.id)
    expect(armed(h)).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(requests).toHaveLength(1)

    // Sending is activity too: the next turn arms its own.
    await turn(h, 'again')
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    expect(requests).toHaveLength(2)
  })

  it('skips a tab that is unattended or has a resume armed when the time comes', async () => {
    const requests = claude()
    const h = await setupSessions()
    h.store.state.settings.idleCompactTokens = 150_000
    await turn(h)
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    const tab = h.store.state.sessions.find((s) => s.id === h.session.id)!
    tab.unattended = { occurrenceId: 'o1' }
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(requests).toHaveLength(1)
    delete tab.unattended

    await turn(h, 'again')
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    tab.limitResume = { turnId: 't', resetAt: new Date(Date.now() + 3600_000).toISOString(), armedAt: new Date().toISOString() } as never
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(requests).toHaveLength(2)
  })

  it('is not armed by a compaction itself', async () => {
    claude()
    const h = await setupSessions()
    h.store.state.settings.idleCompactTokens = 150_000
    await turn(h)
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    await vi.waitFor(() => expect(h.store.state.sessions.find((s) => s.id === h.session.id)!.contextUsage?.used).toBe(22_000), { timeout: 15_000 })
    await idle(h)
    expect(armed(h)).toBe(false)
  })

  it('does not arm after an unattended turn, though the turn’s end clears its mark, nor in a scheduled run’s or a flow run’s workspace', async () => {
    claude()
    const h = await setupSessions()
    h.store.state.settings.idleCompactTokens = 150_000
    // A scheduled run's turn: unattended while it runs, an ordinary chat once it has ended (endTurn clears the mark).
    h.sessions.markUnattended('turn-sched', { occurrenceId: 'o1' })
    await h.sessions.send(h.session.id, 'run it', { turnId: 'turn-sched' })
    await idle(h)
    await vi.waitFor(() => expect(h.store.state.sessions.find((s) => s.id === h.session.id)!.lastTurn?.outcome).toBe('completed'), { timeout: 10_000 })
    await Promise.resolve()
    expect(h.store.state.sessions.find((s) => s.id === h.session.id)!.unattended).toBeUndefined()
    expect(armed(h)).toBe(false)

    // An attended turn in the workspace of a schedule's run, or of a flow run: nothing is armed there either.
    const ws = h.store.state.workspaces.find((w) => w.id === h.session.workspaceId)!
    ws.scheduled = { scheduleId: 's1', occurrenceId: 'o1' }
    await turn(h, 'again')
    expect(armed(h)).toBe(false)
    delete ws.scheduled
    ws.flowRun = { runId: 'r1' }
    await turn(h, 'and again')
    expect(armed(h)).toBe(false)
    delete ws.flowRun
    await turn(h, 'and once more')
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
  })

  it('is skipped when the timer fires in such a workspace, even if it was armed before the workspace became one', async () => {
    const requests = claude()
    const h = await setupSessions()
    h.store.state.settings.idleCompactTokens = 150_000
    await turn(h)
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    h.store.state.workspaces.find((w) => w.id === h.session.workspaceId)!.flowRun = { runId: 'r1' }
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(requests).toHaveLength(1)
  })

  it('is maintenance, not an answer: it does not mark what the agent reported as replied to, and it carries the cap of the turn it follows', async () => {
    const requests = claude()
    const h = await setupSessions()
    const replied: string[] = []
    ;(h.sessions as unknown as { reports: unknown }).reports = new Proxy({}, { get: (_t, name) => (name === 'replied' ? (id: string) => void replied.push(id) : name === 'turnEnv' ? () => ({}) : () => null) })
    h.store.state.settings.idleCompactTokens = 150_000
    const cap = { ceiling: 'ask' as const, grantId: 'grant-1', name: 'Claude Code' }
    await h.sessions.send(h.session.id, 'work on it', { cap })
    await idle(h)
    await vi.waitFor(() => expect(armed(h)).toBe(true), { timeout: 15_000 })
    expect(replied).toEqual([h.session.id])
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 15_000 })
    await idle(h)
    // Only the person's own message answered what the agent had reported.
    expect(replied).toEqual([h.session.id])
    expect(requests[1]).toMatchObject({ prompt: '/compact', capped: { ceiling: 'ask' } })
    const users = (await h.store.readChat(h.session.id)).filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user')
    expect(users.at(-1)).toMatchObject({ origin: { kind: 'idle-compact' }, cap })
  })
})
