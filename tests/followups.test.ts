import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDriver } from '../src/main/agents/registry'
import { claudeDriver } from '../src/main/agents/claude'
import type { HostTools, TurnRequest } from '../src/main/agents/types'
import { MAX_FOLLOWUP_CHARS, MAX_FOLLOWUPS, validateFollowups } from '../src/shared/followups'
import type { ChatItem } from '../src/shared/types'
import { fakeDriver, setupSessions } from './sessionHarness'

const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn((...args: unknown[]) => ({ args })), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

afterEach(() => {
  registerDriver(claudeDriver)
  sdk.query.mockReset()
  sdk.tool.mockClear()
})

describe('validateFollowups', () => {
  it('accepts up to three short suggestions and tidies them', () => {
    expect(validateFollowups(['  Add a test ', 'Open a PR', 'Add a test'])).toEqual({ ok: true, items: ['Add a test', 'Open a PR'] })
  })
  it('refuses more than three', () => {
    const r = validateFollowups(['a', 'b', 'c', 'd'])
    expect(r.ok).toBe(false)
    expect(MAX_FOLLOWUPS).toBe(3)
  })
  it('refuses a long suggestion, an empty list and non-text', () => {
    expect(validateFollowups(['x'.repeat(MAX_FOLLOWUP_CHARS + 1)]).ok).toBe(false)
    expect(validateFollowups(['x'.repeat(MAX_FOLLOWUP_CHARS)]).ok).toBe(true)
    expect(validateFollowups([' ', '']).ok).toBe(false)
    expect(validateFollowups([1]).ok).toBe(false)
    expect(validateFollowups('hi').ok).toBe(false)
  })
})

describe('suggest_followups tool', () => {
  const request: TurnRequest = {
    turnId: 't', prompt: 'p', cwd: '/r', env: {}, model: 'claude-opus-5-5', fastMode: false, planMode: false, approvals: 'never-ask', systemPromptAppend: ''
  }
  const run = async (hostTools?: Partial<HostTools>) => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1, result: 'ok', uuid: 'u', session_id: 's' } as unknown as SDKMessage
      },
      interrupt: vi.fn(), getContextUsage: vi.fn(async () => ({ totalTokens: 1, maxTokens: 2 })), setPermissionMode: vi.fn(), setModel: vi.fn()
    }))
    const cb = { item: vi.fn(), sessionStarted: vi.fn(), assistantMessage: vi.fn(), approveTool: vi.fn(), reviewPlan: vi.fn(), ask: vi.fn(), planModeChanged: vi.fn(), autoAcceptEdits: vi.fn(), usage: vi.fn(), finished: vi.fn() }
    await claudeDriver.createTurn({ ...request, hostTools: hostTools as HostTools }, cb).run()
  }
  const registered = () => sdk.tool.mock.calls.find((c) => c[0] === 'suggest_followups') as unknown as [string, string, unknown, (a: { suggestions: unknown }) => Promise<{ content: { text: string }[] }>] | undefined

  it('is only offered when the repo allows it', async () => {
    await run({})
    expect(registered()).toBeUndefined()
  })

  it('hands valid suggestions to the host and refuses invalid ones without a model call', async () => {
    const seen: string[][] = []
    await run({ suggestFollowups: (items) => (seen.push(items), 'ok') })
    const call = registered()!
    expect((await call[3]({ suggestions: ['one', 'two'] })).content[0].text).toBe('ok')
    expect(seen).toEqual([['one', 'two']])
    const refused = await call[3]({ suggestions: ['a', 'b', 'c', 'd'] })
    expect(refused.content[0].text).toMatch(/at most 3/)
    expect(seen).toHaveLength(1)
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })
})

describe('chips on the turn', () => {
  const lastEnd = async (store: { readChat(id: string): Promise<ChatItem[]> }, id: string) => {
    let end: Extract<ChatItem, { kind: 'turn-end' }> | undefined
    await vi.waitFor(async () => {
      end = (await store.readChat(id)).find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
      expect(end).toBeDefined()
    }, { timeout: 10_000 })
    return end!
  }

  it('stores the last suggestions on a completed turn', async () => {
    const { sessions, session, store } = await setupSessions()
    let offered = false
    registerDriver(fakeDriver(async (req, cb) => {
      offered = Boolean(req.hostTools?.suggestFollowups)
      req.hostTools?.suggestFollowups?.(['first'])
      req.hostTools?.suggestFollowups?.(['Add a test', 'Open a PR'])
      cb.finished({ ok: true })
    }))
    await sessions.send(session.id, 'go')
    const end = await lastEnd(store, session.id)
    expect(offered).toBe(true)
    expect(end.suggestions).toEqual(['Add a test', 'Open a PR'])
  })

  it('drops them when the turn fails, and when the repo turned them off', async () => {
    const failing = await setupSessions()
    registerDriver(fakeDriver(async (req, cb) => {
      req.hostTools?.suggestFollowups?.(['x'])
      cb.finished({ ok: false, error: 'boom' })
    }))
    await failing.sessions.send(failing.session.id, 'go')
    expect((await lastEnd(failing.store, failing.session.id)).suggestions).toBeUndefined()

    const off = await setupSessions()
    ;(off.sessions as unknown as { workspaces: { settingsFor: () => unknown } }).workspaces.settingsFor = () => ({ prompts: { general: '' }, sensitivePaths: [], suggestFollowups: false })
    let offered = true
    registerDriver(fakeDriver(async (req, cb) => {
      offered = Boolean(req.hostTools?.suggestFollowups)
      cb.finished({ ok: true })
    }))
    await off.sessions.send(off.session.id, 'go')
    await lastEnd(off.store, off.session.id)
    expect(offered).toBe(false)
  })
})
