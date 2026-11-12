import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import type { ChatItem } from '../src/shared/types'

// Subagents as first-class (docs/agents.md 6), through the same stand-in for Claude Code as tests/claude.test.ts.
// A recorded Claude subagent fixture replaces these hand-written frames once the replay branch (slice 2) is merged.
const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

type CanUseTool = (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>

function fakeClaude() {
  const queued: SDKMessage[] = []
  let wake: (() => void) | null = null
  let ended = false
  const stopTask = vi.fn(async (_taskId: string) => undefined)
  const state = { inputClosed: false, aborted: false, canUseTool: undefined as CanUseTool | undefined }

  sdk.query.mockImplementation(({ prompt, options: opts }: { prompt: AsyncIterable<SDKUserMessage>; options: { abortController: AbortController; canUseTool: CanUseTool } }) => {
    state.canUseTool = opts.canUseTool
    opts.abortController.signal.addEventListener('abort', () => {
      state.aborted = true
      ended = true
      wake?.()
    })
    void (async () => {
      for await (const message of prompt) void message
      state.inputClosed = true
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
          if (state.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          if (ended) return
          await new Promise<void>((resolve) => (wake = resolve))
          wake = null
        }
      },
      interrupt: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100 })),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      stopTask
    }
  })

  return {
    state,
    stopTask,
    push(...messages: Record<string, unknown>[]) {
      queued.push(...(messages as unknown as SDKMessage[]))
      wake?.()
    }
  }
}

const base = { uuid: 'u', session_id: 's1' }
const request: TurnRequest = {
  turnId: 't1',
  prompt: 'hello',
  cwd: '/repo',
  env: {},
  model: 'claude-opus-5-5',
  fastMode: false,
  planMode: false,
  approvals: 'ask',
  systemPromptAppend: ''
}

function callbacks() {
  return {
    item: vi.fn(),
    sessionStarted: vi.fn(),
    assistantMessage: vi.fn(),
    approveTool: vi.fn(async (_request: unknown, _signal?: unknown) => ({ kind: 'tool' as const, allow: true })),
    reviewPlan: vi.fn(),
    ask: vi.fn(async () => ({ kind: 'question' as const, answers: { 'Which?': 'A' } })),
    planModeChanged: vi.fn(),
    autoAcceptEdits: vi.fn(),
    usage: vi.fn(),
    finished: vi.fn()
  } satisfies TurnCallbacks
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const main = (...content: Record<string, unknown>[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m${content.length}-${JSON.stringify(content).length}`, content }, ...base })
const inside = (parent: string, id: string, ...content: Record<string, unknown>[]) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content }, ...base })
const taskCall = { type: 'tool_use', id: 'tu1', name: 'Task', input: { description: 'explore-tests', subagent_type: 'Explore', prompt: 'Find what the failures share' } }
const started = { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tu1', description: 'explore-tests', task_type: 'local_agent', is_backgrounded: false, ...base }
const ended = (status: 'completed' | 'stopped') => ({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'tu1', status, summary: '', output_file: '', ...base })
const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, duration_ms: 1000, num_turns: 1, result: 'ok', ...base }

/** The items the turn handed out, the last version of each. */
function lastItems(cb: ReturnType<typeof callbacks>): Map<string, ChatItem> {
  const out = new Map<string, ChatItem>()
  for (const [item] of cb.item.mock.calls as [ChatItem][]) out.set(item.id, item)
  return out
}

afterEach(() => {
  sdk.query.mockReset()
  sdk.tool.mockClear()
})

describe('a Claude subagent as children of its Task call', () => {
  it('keeps the subagent’s own calls and messages under the call, and the call gets its task id', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(
      main(taskCall),
      started,
      inside('tu1', 'sub-m1', { type: 'text', text: 'Reading the tests' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'tests/sessions.test.ts' } }),
      // Its streaming previews are not kept: only the finished message is.
      { type: 'stream_event', parent_tool_use_id: 'tu1', event: { type: 'message_start', message: { id: 'sub-m2' } }, ...base },
      { type: 'user', parent_tool_use_id: 'tu1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file text' }] }, ...base }
    )
    await settle()
    const items = lastItems(cb)
    expect(items.get('tu1')).toMatchObject({ kind: 'tool', name: 'Task', childId: 'task-1', task: { status: 'running' } })
    expect(items.get('tu1')).not.toHaveProperty('parentToolUseId')
    const said = [...items.values()].find((i) => i.kind === 'assistant')
    expect(said).toMatchObject({ text: 'Reading the tests', parentToolUseId: 'tu1' })
    expect(items.get('c1')).toMatchObject({ kind: 'tool', name: 'Read', parentToolUseId: 'tu1', status: 'done', output: 'file text' })
    expect(cb.item.mock.calls.some(([, transient]) => transient === true)).toBe(false)
    // The subagent's message is not the conversation Restore rewinds to.
    expect(cb.assistantMessage).toHaveBeenCalledTimes(1)
    claude.push(result)
    await run
  })

  it('keeps a Task call’s childId when its task started before the call arrived', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(started, main(taskCall))
    await settle()
    expect(lastItems(cb).get('tu1')).toMatchObject({ childId: 'task-1', task: { status: 'running' } })
    claude.push(result)
    await run
  })

  it('names the subagent on an approval it asks for, by its agent id, and on a nested call by the call it was made in', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(main(taskCall), started, inside('tu1', 'sub-m1', { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' } }))
    await settle()
    const signal = new AbortController().signal
    await claude.state.canUseTool!('Bash', { command: 'npm test' }, { signal, toolUseID: 'c1', agentID: 'task-1' })
    expect(cb.approveTool).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tool', toolName: 'Bash', subagent: { id: 'task-1', name: 'explore-tests' } }), signal)
    // No agent id, but the call was one the subagent made.
    await claude.state.canUseTool!('Bash', { command: 'npm test' }, { signal, toolUseID: 'c1' })
    expect(cb.approveTool).toHaveBeenLastCalledWith(expect.objectContaining({ subagent: { id: 'task-1', name: 'explore-tests' } }), signal)
    // The main agent's own ask carries none.
    await claude.state.canUseTool!('Bash', { command: 'ls' }, { signal, toolUseID: 'm1' })
    expect(cb.approveTool.mock.calls.at(-1)![0]).not.toHaveProperty('subagent')
    // An agent id Foreman never saw start is still a subagent, just unnamed.
    await claude.state.canUseTool!('Bash', { command: 'ls' }, { signal, toolUseID: 'x', agentID: 'unknown' })
    expect(cb.approveTool.mock.calls.at(-1)![0]).toMatchObject({ subagent: { id: 'unknown', name: '' } })
    claude.push(result)
    await run
  })

  it('carries the subagent on a question it asks through AskUserQuestion', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(main(taskCall), started)
    await settle()
    const handler = (sdk.tool.mock.calls as unknown as [string, string, unknown, (args: unknown) => Promise<unknown>][]).find((c) => c[0] === 'AskUserQuestion')![3]
    const questions = [{ question: 'Which?', options: [{ label: 'A' }] }]
    const signal = new AbortController().signal
    await claude.state.canUseTool!('mcp__foreman__AskUserQuestion', { questions }, { signal, toolUseID: 'q1', agentID: 'task-1' })
    await handler({ questions })
    expect(cb.ask).toHaveBeenLastCalledWith(questions, expect.anything(), { id: 'task-1', name: 'explore-tests' })
    // The next question, from the main agent, is not the subagent's.
    await claude.state.canUseTool!('mcp__foreman__AskUserQuestion', { questions }, { signal, toolUseID: 'q2' })
    await handler({ questions })
    expect(cb.ask).toHaveBeenLastCalledWith(questions, expect.anything(), undefined)
    claude.push(result)
    await run
  })

  it('stops one subagent with stopTask, and the turn carries on', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    claude.push(main(taskCall), started)
    await settle()
    await turn.stopChild!('task-1')
    expect(claude.stopTask).toHaveBeenCalledWith('task-1')
    // The SDK then reports it stopped; the Task call says so, and the turn is not over.
    claude.push(ended('stopped'))
    await settle()
    expect(lastItems(cb).get('tu1')).toMatchObject({ childId: 'task-1', task: { status: 'stopped' } })
    expect(cb.finished).not.toHaveBeenCalled()
    expect(claude.state.inputClosed).toBe(false)
    claude.push(main({ type: 'text', text: 'check-windows was stopped, so I will look myself' }), result)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
  })

  it('does not end the turn when a subagent finishes or its own frames stop', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(main(taskCall), started, inside('tu1', 'sub-m1', { type: 'text', text: 'Done looking' }), ended('completed'))
    await settle()
    expect(cb.finished).not.toHaveBeenCalled()
    expect(lastItems(cb).get('tu1')).toMatchObject({ task: { status: 'completed' } })
    claude.push(result)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
  })

  it('refuses to stop a subagent it never saw, or once the turn is over', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    claude.push(main(taskCall), started)
    await settle()
    await expect(turn.stopChild!('nope')).rejects.toThrow('not running')
    expect(claude.stopTask).not.toHaveBeenCalled()
    claude.push(result)
    await run
    await expect(turn.stopChild!('task-1')).rejects.toThrow('not running')
  })

  it('closes a subagent’s unfinished calls with the turn, as it does the parent’s', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(main(taskCall), started, inside('tu1', 'sub-m1', { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'sleep 99' } }), result)
    await run
    expect(lastItems(cb).get('c1')).toMatchObject({ status: 'error', parentToolUseId: 'tu1' })
  })
})
