import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'

// "Stop waiting for background tasks": no Claude Code here, `query` is a fake whose messages each test pushes in.
const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

function fakeClaude() {
  const queued: SDKMessage[] = []
  let wake: (() => void) | null = null
  let ended = false
  const state = { inputClosed: false }
  sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    void (async () => {
      for await (const _message of prompt) void _message
      state.inputClosed = true
      // Like Claude Code, the process (and its background work) exits once its input is closed.
      ended = true
      wake?.()
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = queued.shift()
          if (next) {
            yield next
            continue
          }
          if (ended) return
          await new Promise<void>((resolve) => (wake = resolve))
          wake = null
        }
      },
      interrupt: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100 })),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined)
    }
  })
  return {
    state,
    push(...messages: Partial<SDKMessage>[]) {
      queued.push(...(messages as SDKMessage[]))
      wake?.()
    }
  }
}

const base = { uuid: 'u', session_id: 's1' }
const tasks = (...ids: string[]) =>
  ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_bash', description: task_id })), ...base }) as Partial<SDKMessage>
const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, duration_ms: 1000, num_turns: 1, result: 'ok', ...base } as Partial<SDKMessage>
const assistant = (text: string) =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${text}`, content: [{ type: 'text', text }] }, ...base }) as Partial<SDKMessage>

const request: TurnRequest = {
  turnId: 't1',
  prompt: 'hello',
  cwd: '/repo',
  env: {},
  model: 'claude-opus-5-5',
  fastMode: false,
  planMode: false,
  approvals: 'never-ask',
  systemPromptAppend: ''
}

function callbacks() {
  return {
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
  } satisfies TurnCallbacks
}

const NOTICE = 'Stopped waiting for background tasks after 1 minute.'

afterEach(() => {
  vi.useRealTimers()
  sdk.query.mockReset()
})

describe('Stop waiting for background tasks', () => {
  it('ends a turn whose background work outlasts the setting, saying so, and closes the agent', async () => {
    vi.useFakeTimers()
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn({ ...request, backgroundWait: { ms: 60_000, notice: NOTICE } }, cb).run()
    claude.push(tasks('dev-server'), assistant('started the dev server'), result)
    await vi.advanceTimersByTimeAsync(10)
    expect(cb.finished).not.toHaveBeenCalled()
    // Claude waking in between (and answering again) doesn't reset the wait.
    claude.push(assistant('still serving'), result)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(cb.finished).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    await run
    expect(cb.item).toHaveBeenCalledWith(expect.objectContaining({ kind: 'notice', level: 'info', text: NOTICE }))
    // It ends as Claude reported it (the answer arrived), and the process with its background work is closed.
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
    expect(claude.state.inputClosed).toBe(true)
  })

  it('waits as long as the work runs when it is off (the default)', async () => {
    vi.useFakeTimers()
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(tasks('dev-server'), result)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(cb.finished).not.toHaveBeenCalled()
    expect(claude.state.inputClosed).toBe(false)
    // The work ends and Claude reports back: the turn ends as before.
    claude.push(tasks(), assistant('done'), result)
    await vi.advanceTimersByTimeAsync(10)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.item).not.toHaveBeenCalledWith(expect.objectContaining({ text: NOTICE }))
  })

  it('says nothing when the background work finishes in time', async () => {
    vi.useFakeTimers()
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn({ ...request, backgroundWait: { ms: 60_000, notice: NOTICE } }, cb).run()
    claude.push(tasks('agent-1'), result)
    await vi.advanceTimersByTimeAsync(10)
    claude.push(tasks(), assistant('the agent reported'), result)
    await vi.advanceTimersByTimeAsync(10)
    await run
    await vi.advanceTimersByTimeAsync(120_000)
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.item).not.toHaveBeenCalledWith(expect.objectContaining({ text: NOTICE }))
  })
})
