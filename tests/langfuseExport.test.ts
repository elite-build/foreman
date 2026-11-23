import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Connection } from '../src/shared/integrations'
import type { ChatItem, Repo, Session, Workspace } from '../src/shared/types'
import type { DiagnosticEvent } from '../src/shared/diagnostics'
import { staticCapabilities } from '../src/shared/agentCatalog'
import { ForemanDb } from '../src/main/db'
import { codexTokens } from '../src/main/agents/codex'
import { LangfuseExport } from '../src/main/langfuseExport'
import { apportion, claudeTurnParts, eventSpan, exportedEvent, turnSpans, usageDetails, type OtlpRequest, type SenderFacts, type TurnFacts } from '../src/main/langfuseTrace'
import { tempDir } from './helpers'

const sender: SenderFacts = { device: { id: 'dev-1', name: 'desk' }, version: '1.2.9', platform: 'win32', environment: 'production' }
const attr = (span: { attributes: { key: string; value: Record<string, unknown> }[] }, key: string) => {
  const v = span.attributes.find((a) => a.key === key)?.value
  return v ? Object.values(v)[0] : undefined
}

const assistantEntry = (id: string, at: string, usage: object, content: object[], extra: object = {}) => ({
  type: 'assistant',
  timestamp: at,
  uuid: `${id}-${at}`,
  message: { id, model: 'claude-opus-5-5', usage, content },
  ...extra
})

describe('claudeTurnParts', () => {
  const entries = [
    { subpath: '', json: { type: 'user', timestamp: '2026-11-20T10:00:00.000Z', message: { content: 'go' } } },
    // One response, written as two entries (a text block, then a tool call) with the same id and usage.
    { subpath: '', json: assistantEntry('msg_1', '2026-11-20T10:00:03.000Z', { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, [{ type: 'text', text: 'Looking' }]) },
    { subpath: '', json: assistantEntry('msg_1', '2026-11-20T10:00:04.000Z', { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }]) },
    { subpath: '', json: { type: 'user', timestamp: '2026-11-20T10:00:06.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'boom', is_error: true }] } } },
    { subpath: 'subagents/agent-a1', json: assistantEntry('msg_2', '2026-11-20T10:00:08.000Z', { input_tokens: 5, output_tokens: 7 }, [{ type: 'text', text: 'sub' }]) },
    // An error response Claude Code writes itself is not a model call.
    { subpath: '', json: assistantEntry('msg_3', '2026-11-20T10:00:09.000Z', {}, [], { message: { id: 'msg_3', model: '<synthetic>', content: [] } }) }
  ]

  it('makes one call per response id, with its tokens, and tool calls with their end and error', () => {
    const parts = claudeTurnParts(entries, true)
    expect(parts.calls).toHaveLength(2)
    expect(parts.calls[0]).toMatchObject({ id: 'msg_1', start: '2026-11-20T10:00:00.000Z', end: '2026-11-20T10:00:04.000Z', tokens: { input: 10, output: 50, cacheRead: 1000, cacheWrite: 200 }, output: 'Looking' })
    expect(parts.calls[1]).toMatchObject({ id: 'msg_2', subagent: 'subagents/agent-a1' })
    expect(parts.tools).toEqual([{ id: 'tu_1', name: 'Bash', start: '2026-11-20T10:00:04.000Z', end: '2026-11-20T10:00:06.000Z', error: true, input: { command: 'ls' }, output: 'boom' }])
    expect(parts.subagents).toEqual([{ key: 'subagents/agent-a1', name: 'agent-a1', start: '2026-11-20T10:00:08.000Z', end: '2026-11-20T10:00:08.000Z' }])
  })

  it('keeps no text, inputs or outputs without content', () => {
    const parts = claudeTurnParts(entries, false)
    expect(parts.calls[0].output).toBeUndefined()
    expect(parts.tools[0]).not.toHaveProperty('input')
    expect(parts.tools[0]).not.toHaveProperty('output')
  })
})

describe('turn spans', () => {
  const turn: TurnFacts = {
    turnId: 't1',
    chatId: 's1',
    workspace: { id: 'w1', name: 'marcuse' },
    repo: { id: 'r1', name: 'foreman' },
    agent: 'claude',
    model: 'claude-opus-5-5',
    startedAt: '2026-11-20T10:00:00.000Z',
    endedAt: '2026-11-20T10:01:00.000Z',
    outcome: 'error',
    error: 'Claude Code crashed',
    costUsd: 0.6,
    prompt: 'secret prompt',
    answer: 'secret answer',
    calls: [
      { id: 'a', model: 'claude-opus-5-5', start: '2026-11-20T10:00:00.000Z', end: '2026-11-20T10:00:10.000Z', tokens: { input: 100, output: 100 }, output: 'secret output' },
      { id: 'b', model: 'claude-opus-5-5', start: '2026-11-20T10:00:10.000Z', end: '2026-11-20T10:00:20.000Z', tokens: { input: 0, output: 0, cacheRead: 6000 } }
    ],
    tools: [{ id: 'x', name: 'Read', start: '2026-11-20T10:00:05.000Z', end: '2026-11-20T10:00:06.000Z', error: false, input: { file: 'secret.ts' } }],
    subagents: []
  }

  it('shares the reported cost across calls at Claude’s relative prices, adding up to it', () => {
    const shares = apportion(0.6, turn.calls)
    expect(shares[0] + shares[1]).toBeCloseTo(0.6, 10)
    // 100 input + 100 output × 5 = 600 against 6000 cache reads × 0.1 = 600.
    expect(shares[0]).toBeCloseTo(0.3, 10)
  })

  it('puts the trace’s attributes on every span and marks an errored turn', () => {
    const spans = turnSpans(turn, sender, false)
    expect(spans).toHaveLength(4)
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
      expect(attr(span, 'langfuse.session.id')).toBe('s1')
      expect(attr(span, 'langfuse.user.id')).toBe('desk')
      expect(attr(span, 'langfuse.trace.metadata.device_id')).toBe('dev-1')
    }
    const [root, ...rest] = spans
    expect(root.parentSpanId).toBeUndefined()
    expect(rest.every((s) => s.parentSpanId === root.spanId)).toBe(true)
    expect(attr(root, 'langfuse.observation.level')).toBe('ERROR')
    expect(root.status).toEqual({ code: 2, message: 'Claude Code crashed' })
    const generation = spans.find((s) => attr(s, 'langfuse.observation.type') === 'generation')!
    expect(JSON.parse(String(attr(generation, 'langfuse.observation.usage_details')))).toEqual({ input: 100, output: 100 })
    expect(JSON.parse(String(attr(generation, 'langfuse.observation.cost_details'))).total).toBeCloseTo(0.3, 10)
  })

  it('sends no prompt, answer, model output or tool input without content, and all of them with it', () => {
    expect(JSON.stringify(turnSpans(turn, sender, false))).not.toContain('secret')
    const withContent = JSON.stringify(turnSpans(turn, sender, true))
    for (const text of ['secret prompt', 'secret answer', 'secret output', 'secret.ts']) expect(withContent).toContain(text)
  })

  it('names a Claude model’s cache buckets as Anthropic does and others as OpenAI does', () => {
    expect(usageDetails('claude-opus-5-5', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toEqual({ input: 1, output: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })
    expect(usageDetails('gpt-5.5', { input: 1, output: 2, cacheRead: 3 })).toEqual({ input: 1, output: 2, input_cached_tokens: 3 })
  })
})

describe('events', () => {
  it('sends crashes, stalls and errors, not turn starts or a library’s warnings', () => {
    const ev = (kind: string, fields: object = {}): DiagnosticEvent => ({ at: '2026-11-20T10:00:00.000Z', kind, ...fields })
    expect(exportedEvent(ev('exception', { message: 'x' }))).toBe(true)
    expect(exportedEvent(ev('stall'))).toBe(true)
    expect(exportedEvent(ev('turn.start'))).toBe(false)
    expect(exportedEvent(ev('error', { line: '(node:1) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked' }))).toBe(false)
    expect(exportedEvent(ev('error', { line: 'Error occurred in handler' }))).toBe(true)
  })

  it('says what a stall was running, slowest first, in its app run’s trace', () => {
    const stall: DiagnosticEvent = { at: '2026-11-20T10:00:00.000Z', kind: 'stall', maxMs: 13829.6, timings: { 'git.worktree': { count: 1, totalMs: 7336, maxMs: 7336 }, 'store.save': { count: 2, totalMs: 164, maxMs: 120 } } }
    const span = eventSpan(stall, '2026-11-20T09:00:00.000Z', sender)
    expect(attr(span, 'langfuse.observation.level')).toBe('WARNING')
    expect(attr(span, 'langfuse.observation.metadata.max_ms')).toBe('13830')
    expect(String(attr(span, 'langfuse.observation.metadata.timings'))).toMatch(/^git\.worktree 7336ms/)
    expect(eventSpan({ ...stall, at: '2026-11-20T11:00:00.000Z' }, '2026-11-20T09:00:00.000Z', sender).traceId).toBe(span.traceId)
  })
})

describe('codexTokens', () => {
  it('keeps cached input and cache writes out of input, and reasoning inside output', () => {
    expect(codexTokens({ totalTokens: 0, inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 50, outputTokens: 300, reasoningOutputTokens: 120 })).toEqual({ input: 150, output: 300, cacheRead: 800, cacheWrite: 50, reasoning: 120 })
    expect(codexTokens({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })).toBeUndefined()
  })
})

// ---- the service, against a real foreman.db ----

const NOW = Date.parse('2026-11-22T00:00:00.000Z')
const langfuse: Connection = { id: 'c1', service: 'langfuse', name: 'Mine', rev: 1, auth: { kind: 'token' }, agentAccess: 'off', langfuse: { host: 'https://cloud.langfuse.com', publicKey: 'pk-lf-1' }, createdAt: '2026-11-01T00:00:00.000Z' }
const github: Connection = { ...langfuse, id: 'g1', service: 'github', langfuse: undefined }

async function setup(options: { machine?: string } = {}) {
  const dir = await tempDir('foreman-langfuse-')
  const db = new ForemanDb(path.join(dir, 'foreman.db'))
  const state = {
    sessions: [{ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'claude-opus-5-5', agentSessionId: 'cs1' } as Session],
    workspaces: [{ id: 'w1', repoId: 'r1', name: 'marcuse' } as Workspace],
    repos: [{ id: 'r1', name: 'foreman' } as Repo],
    langfuseExport: undefined as undefined | { connectionId: string; content: boolean; machine: string; enabledAt: string }
  }
  const put = (item: ChatItem, at: string) => db.putItem('s1', item, at)
  // An earlier turn whose result says the conversation had cost $1.00 so far; this one brings it to $1.50.
  put({ kind: 'result', id: 'r0', turnId: 't0', ok: true, costUsd: 1 }, '2026-11-20T09:00:00.000Z')
  put({ kind: 'user', id: 'u1', turnId: 't1', text: 'private question', at: '2026-11-20T10:00:00.000Z', agent: 'claude', model: 'claude-opus-5-5' }, '2026-11-20T10:00:00.000Z')
  put({ kind: 'assistant', id: 'a1', turnId: 't1', text: 'private answer' }, '2026-11-20T10:00:30.000Z')
  put({ kind: 'result', id: 'r1', turnId: 't1', ok: true, costUsd: 1.5, agentSession: 'cs1' }, '2026-11-20T10:00:59.000Z')
  put({ kind: 'turn-end', id: 'te1', turnId: 't1', outcome: 'completed', durationMs: 60_000 }, '2026-11-20T10:01:00.000Z')
  db.mirrorAppend({ projectKey: 'p', sessionId: 'cs1' }, [assistantEntry('msg_1', '2026-11-20T10:00:20.000Z', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500 }, [{ type: 'text', text: 'private answer' }])])
  // How Langfuse answers: its project lookup (the startup check) and its OTLP endpoint (sends), each up, down or refusing.
  const net = { projects: 'ok' as Answer, otel: 'ok' as Answer }
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const otel = String(url).includes('/otel/')
    const answer = otel ? net.otel : net.projects
    if (answer === 'down') throw new TypeError('fetch failed')
    if (answer === 'refused') return new Response('{}', { status: 401 })
    return new Response(otel ? '{}' : JSON.stringify({ data: [{ id: 'p1', name: 'Foreman' }] }), { status: 200 })
  })
  const markProblem = vi.fn()
  const notify = vi.fn()
  const service = new LangfuseExport({
    store: { state, save: vi.fn() },
    db: () => db,
    capabilities: (agent) => staticCapabilities(agent as never),
    connection: (id) => [langfuse, github].find((c) => c.id === id),
    secret: () => 'sk-lf-1',
    markProblem,
    notify,
    device: () => ({ id: 'dev-1', name: 'desk' }),
    recentEvents: () => [],
    logsDir: path.join(dir, 'logs'),
    version: '1.2.9',
    packaged: true,
    platform: 'win32',
    machine: () => options.machine ?? 'desk',
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => NOW,
    changed: vi.fn()
  })
  // The trace sends only, leaving out the project lookups.
  const sends = () => fetch.mock.calls.filter((c) => String(c[0]).includes('/otel/'))
  return { service, state, fetch, sends, net, markProblem, notify, db }
}

type Answer = 'ok' | 'down' | 'refused'
const sentSpans = (call: unknown[]) => (JSON.parse(String((call[1] as RequestInit).body)) as OtlpRequest).resourceSpans[0].scopeSpans[0].spans

describe('LangfuseExport', () => {
  it('is off until a Langfuse connection is chosen, and refuses any other kind', async () => {
    const { service } = await setup()
    expect(service.status().connectionId).toBeNull()
    expect(() => service.sendEarlier(7)).toThrow(/Turn on/)
    expect(() => service.configure({ connectionId: 'g1', content: false })).toThrow(/Langfuse connection/)
  })

  it('counts as off on another computer than the one it was turned on at', async () => {
    const { service, state } = await setup({ machine: 'laptop' })
    state.langfuseExport = { connectionId: 'c1', content: false, machine: 'desk', enabledAt: '2026-11-21T00:00:00.000Z' }
    expect(service.status()).toMatchObject({ connectionId: null, otherMachine: 'desk' })
  })

  it('sends turns that ended before it was turned on only when asked, once each, to the OTLP endpoint', async () => {
    const { service, sends } = await setup()
    service.configure({ connectionId: 'c1', content: false })
    await service.idle()
    expect(sends()).toHaveLength(0)

    service.sendEarlier(7)
    await service.idle()
    expect(sends()).toHaveLength(1)
    const [url, init] = sends()[0]
    expect(url).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces')
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('pk-lf-1:sk-lf-1').toString('base64')}`)
    expect(headers['x-langfuse-ingestion-version']).toBe('4')

    const spans = sentSpans(sends()[0])
    const generation = spans.find((s) => attr(s, 'langfuse.observation.type') === 'generation')!
    expect(JSON.parse(String(attr(generation, 'langfuse.observation.usage_details')))).toEqual({ input: 10, output: 20, cache_read_input_tokens: 500 })
    // The turn's own cost: $1.50 so far less the $1.00 before it.
    expect(JSON.parse(String(attr(generation, 'langfuse.observation.cost_details'))).total).toBeCloseTo(0.5, 10)
    expect(String((init as RequestInit).body)).not.toContain('private')
    expect(service.status()).toMatchObject({ sentTurns: 1, lastSentAt: new Date(NOW).toISOString() })

    service.sendEarlier(7)
    await service.idle()
    expect(sends()).toHaveLength(1)
  })

  it('marks the connection when Langfuse refuses the keys, and sends again once it takes them', async () => {
    const { service, sends, net, markProblem } = await setup()
    service.configure({ connectionId: 'c1', content: true })
    await service.idle()
    net.otel = 'refused'
    service.sendEarlier(7)
    await service.idle()
    expect(markProblem).toHaveBeenCalledWith('c1', expect.stringMatching(/refused/))
    expect(service.status()).toMatchObject({ lastError: expect.stringMatching(/refused/), reach: { state: 'refused' } })

    net.otel = 'ok'
    service.sendEarlier(7)
    await service.idle()
    expect(sends()).toHaveLength(2)
    expect(String((sends()[1][1] as RequestInit).body)).toContain('private question')
    expect(service.status().lastError).toBeUndefined()
    expect(service.status().reach?.state).toBe('ok')
  })
})

describe('LangfuseExport: the check when Foreman starts', () => {
  const on = { connectionId: 'c1', content: false, machine: 'desk', enabledAt: '2026-11-21T00:00:00.000Z' }

  it('asks nothing while sending is off', async () => {
    const { service, fetch, notify } = await setup()
    await service.check(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('tells the window when Langfuse doesn’t answer, and says so until a send gets through', async () => {
    const { service, state, net, notify, markProblem } = await setup()
    state.langfuseExport = on
    net.projects = 'down'
    await service.check(true)
    expect(notify).toHaveBeenCalledWith({ host: 'https://cloud.langfuse.com', refused: false })
    expect(markProblem).not.toHaveBeenCalled()
    expect(service.status().reach).toEqual({ state: 'unreachable', host: 'https://cloud.langfuse.com', at: new Date(NOW).toISOString() })

    // Back up: the earlier turns go, and the message goes with them.
    service.sendEarlier(7)
    await service.idle()
    expect(service.status()).toMatchObject({ sentTurns: 1, reach: { state: 'ok' } })
    expect(service.status().lastError).toBeUndefined()
  })

  it('says refused keys apart from no answer, and marks the connection', async () => {
    const { service, state, net, notify, markProblem } = await setup()
    state.langfuseExport = on
    net.projects = 'refused'
    await service.check(true)
    expect(notify).toHaveBeenCalledWith({ host: 'https://cloud.langfuse.com', refused: true })
    expect(markProblem).toHaveBeenCalledWith('c1', expect.stringMatching(/refused/))
    expect(service.status().reach?.state).toBe('refused')
  })

  it('checks a project as soon as it is chosen, without a toast', async () => {
    const { service, net, notify } = await setup()
    net.projects = 'down'
    service.configure({ connectionId: 'c1', content: false })
    await service.idle()
    expect(service.status().reach?.state).toBe('unreachable')
    expect(notify).not.toHaveBeenCalled()
  })
})
