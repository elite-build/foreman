// #11 (G4): a limit only a crashed process reported, the SDK's rate_limit_event as a second labelled
// source, and arming from the command line (`foreman resume-at <turn>`) and the phone.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import { handleRequest, resumeAt, type CliHost } from '../src/main/cliServer'
import { LimitResumeService } from '../src/main/limitResume'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import type { ChatItem, Session } from '../src/shared/types'
import { claudeLimit, limitCardView, limitFromEvent } from '../src/shared/usageLimit'
import { createT } from '../src/shared/i18n'
import { fakeDriver, setupSessions } from './sessionHarness'

const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

afterEach(() => {
  sdk.query.mockReset()
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

const NOW = Date.parse('2026-10-22T10:52:00Z')
const IN_2H = Math.floor((NOW + 2 * 3600_000) / 1000)

describe('the rate-limit event as a second source', () => {
  it('reads only a rejected event with a plausible reset time, labelled as the event', () => {
    expect(limitFromEvent({ status: 'rejected', resetsAt: IN_2H, rateLimitType: 'five_hour' }, NOW)).toEqual({
      resetAt: new Date(IN_2H * 1000).toISOString(),
      source: 'five_hour',
      timeZone: 'UTC',
      from: 'event'
    })
    expect(limitFromEvent({ status: 'allowed_warning', resetsAt: IN_2H }, NOW)).toBeUndefined()
    expect(limitFromEvent({ status: 'rejected' }, NOW)).toBeUndefined()
    // Far in the future or long past is a misreading.
    expect(limitFromEvent({ status: 'rejected', resetsAt: IN_2H + 90 * 86400 }, NOW)).toBeUndefined()
    expect(limitFromEvent({ status: 'rejected', resetsAt: IN_2H - 86400 }, NOW)).toBeUndefined()
  })

  it('the error’s own words win; the event fills in only when they state no time', () => {
    const event = { status: 'rejected', resetsAt: IN_2H, rateLimitType: 'seven_day' }
    const fromError = claudeLimit('5-hour limit reached ∙ resets 2:30pm (Europe/London)', null, event, NOW, 'UTC')
    expect(fromError).toMatchObject({ source: 'resets 2:30pm (Europe/London)', timeZone: 'Europe/London' })
    expect(fromError?.from).toBeUndefined()
    expect(claudeLimit('API Error: Request rejected', 429, event, NOW, 'UTC')).toMatchObject({ from: 'event', source: 'seven_day' })
    // A rejected event marks a failure as a limit even when the words don't say so.
    expect(claudeLimit('Claude Code process exited with code 1', undefined, event, NOW, 'UTC')).toMatchObject({ from: 'event' })
    // No event and no limit words: not a limit.
    expect(claudeLimit('Tool failed', undefined, undefined, NOW, 'UTC')).toBeUndefined()
    // A limit with neither a stated time nor an event: time unknown.
    expect(claudeLimit('usage limit reached', undefined, undefined, NOW, 'UTC')).toEqual({})
  })

  it('the card says where the time came from', () => {
    const view = limitCardView({ turnId: 't', limit: { resetAt: new Date(IN_2H * 1000).toISOString(), source: 'five_hour', from: 'event' } }, { agent: 'claude' }, true, NOW)
    expect(view).toMatchObject({ kind: 'offer', from: 'event', source: 'five_hour' })
    expect(createT('en')('usageLimit.card.sourceEvent', { agent: 'Claude', type: '5-hour limit' })).toBe('from Claude’s rate-limit event (5-hour limit); its error didn’t say')
    expect(createT('es')('usageLimit.type.weekly')).toBe('límite semanal')
  })
})

// ---- the Claude adapter ----

const request: TurnRequest = { turnId: 't1', prompt: 'hello', cwd: '/repo', env: {}, model: 'claude-opus-5-5', fastMode: false, planMode: false, approvals: 'never-ask', systemPromptAppend: '' }
const callbacks = () =>
  ({
    item: vi.fn(),
    sessionStarted: vi.fn(),
    assistantMessage: vi.fn(),
    approveTool: vi.fn(),
    reviewPlan: vi.fn(),
    ask: vi.fn(),
    planModeChanged: vi.fn(),
    autoAcceptEdits: vi.fn(),
    usage: vi.fn(),
    finished: vi.fn()
  }) satisfies TurnCallbacks
const base = { uuid: 'u', session_id: 's1' }

/** Claude Code stand-in that yields `messages`, writes `stderr`, then optionally dies. */
function scripted(messages: Partial<SDKMessage>[], options: { stderr?: string; crash?: string } = {}) {
  sdk.query.mockImplementation(({ options: o }: { options: { stderr?: (d: string) => void } }) => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
      if (options.stderr) o.stderr?.(options.stderr)
      if (options.crash) throw new Error(options.crash)
    },
    interrupt: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100 }))
  }))
}

describe('Claude adapter', () => {
  it('a process that dies with the limit on stderr still reports the limit, with its time', async () => {
    scripted([], { stderr: 'Claude AI usage limit reached ∙ resets 11pm (UTC)', crash: 'Claude Code process exited with code 1' })
    const cb = callbacks()
    await claudeDriver.createTurn(request, cb).run()
    const finished = cb.finished.mock.calls[0][0]
    expect(finished.ok).toBe(false)
    expect(finished.error).toContain('usage limit reached')
    expect(finished.limit).toMatchObject({ source: 'resets 11pm (UTC)', timeZone: 'UTC' })
  })

  it('a crash that isn’t a limit gets no card', async () => {
    scripted([], { stderr: 'segfault', crash: 'Claude Code process exited with code 139' })
    const cb = callbacks()
    await claudeDriver.createTurn(request, cb).run()
    expect(cb.finished.mock.calls[0][0].limit).toBeUndefined()
  })

  it('an error result with no stated time takes the time from the last rejected rate-limit event', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    scripted([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' }, ...base } as Partial<SDKMessage>,
      { type: 'result', subtype: 'success', is_error: true, result: 'API Error: Request rejected', api_error_status: 429, total_cost_usd: 0, duration_ms: 1, num_turns: 1, ...base } as Partial<SDKMessage>
    ])
    const cb = callbacks()
    await claudeDriver.createTurn(request, cb).run()
    expect(cb.finished.mock.calls[0][0]).toMatchObject({ ok: false, limit: { resetAt: new Date(resetsAt * 1000).toISOString(), source: 'five_hour', from: 'event' } })
  })
})

// ---- sessions: another agent's crash ----

const turnEnd = (items: ChatItem[]) => items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('a crash with no result', () => {
  it('Codex dying with a limit on stderr gets the card, time unknown', async () => {
    registerDriver({
      ...fakeDriver(async () => {
        throw new Error('Codex Exec exited with code 1: ERROR: You’ve hit your usage limit. Try again later.')
      }),
      kind: 'codex'
    })
    const h = await setupSessions()
    const tab = h.sessions.createSession(h.ws.id, { agent: 'codex', title: 'codex' })
    await h.sessions.send(tab.id, 'go')
    await until(async () => Boolean(turnEnd(await h.store.readChat(tab.id))))
    expect(turnEnd(await h.store.readChat(tab.id))).toMatchObject({ outcome: 'error', limit: {} })
  })
})

// ---- arming from the command line ----

const RESET = new Date(Date.now() + 3 * 3600_000).toISOString()

async function limitedTab(limit: { resetAt: string; source: string; from?: 'event' } = { resetAt: RESET, source: 'resets 2:30pm (Europe/London)' }) {
  registerDriver(fakeDriver(async (_req, cb) => cb.finished({ ok: false, error: 'limit reached', limit })))
  const h = await setupSessions()
  await h.sessions.send(h.session.id, 'go')
  await until(async () => Boolean(turnEnd(await h.store.readChat(h.session.id))))
  const service = new LimitResumeService({
    sessions: () => h.store.state.sessions,
    readChat: (id) => h.store.readChat(id),
    send: async () => undefined,
    flush: () => {},
    changed: () => {},
    now: () => Date.now()
  })
  const turnId = h.session.lastTurn!.turnId!
  const host = {
    state: () => h.store.state,
    turnStatus: (id: string) => h.sessions.turnStatus(id),
    armLimitResume: (s: string, t: string) => service.arm(s, t),
    cancelLimitResume: (s: string) => service.cancel(s),
    identifyCaller: () => null,
    agentsMayStart: () => false
  } as unknown as CliHost
  return { ...h, service, turnId, host }
}

describe('foreman resume-at', () => {
  it('arms the turn’s resume with the card’s rules and says when it sends; --cancel disarms it', async () => {
    const { host, turnId, session } = await limitedTab()
    const armed = await resumeAt(host, { turn: turnId })
    expect(armed).toMatchObject({ armed: true, session: session.id, turn: turnId })
    expect(armed.message).toContain('sends “Continue where you left off.” once')
    expect(armed.message).toContain('from Claude: “…resets 2:30pm (Europe/London)”')
    expect((session as Session).limitResume?.turnId).toBe(turnId)
    const cancelled = await resumeAt(host, { turn: turnId, cancel: true })
    expect(cancelled).toMatchObject({ armed: false })
    expect(session.limitResume).toBeUndefined()
    expect((await resumeAt(host, { turn: turnId, cancel: true })).message).toContain('nothing to cancel')
  })

  it('a time from the rate-limit event says so, and the resume keeps that label', async () => {
    const { host, turnId, session } = await limitedTab({ resetAt: RESET, source: 'five_hour', from: 'event' })
    const armed = await resumeAt(host, { turn: turnId })
    expect(armed.message).toContain('Claude’s rate-limit event (five_hour)')
    expect(session.limitResume).toMatchObject({ from: 'event', source: 'five_hour' })
  })

  it('refuses an unknown turn, and an agent call without the repo’s opt-in', async () => {
    const { host, turnId } = await limitedTab()
    await expect(resumeAt(host, { turn: 'nope' })).rejects.toThrow('No turn with the id')
    const refused = await handleRequest(host, { method: 'resume-at', params: { turn: turnId }, caller: { sessionId: 's', turnId: 't', token: 'x' } })
    expect(refused.ok).toBe(false)
  })
})
