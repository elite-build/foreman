import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver, EXIT_GRACE_MS, NO_SHELL_REFUSAL } from '../src/main/agents/claude'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tempDir } from './helpers'
import { employeeRepoMcp, employeeUserSetup, envValue, expandVars } from '../src/main/agents/claude/employeeSetup'

// No Claude Code here: `query` is replaced by a fake whose messages each test pushes in.
const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

/**
 * A Claude Code stand-in: the test pushes its messages and sees when the input is closed. With `exits: false` the
 * process stays up after its input closes (as one held up on its way out does) until the driver aborts it.
 */
function fakeClaude(options: { exits?: boolean } = {}) {
  const queued: SDKMessage[] = []
  let wake: (() => void) | null = null
  let ended = false
  const state = { inputClosed: false, aborted: false, prompts: [] as SDKUserMessage[] }

  sdk.query.mockImplementation(({ prompt, options: opts }: { prompt: AsyncIterable<SDKUserMessage>; options: { abortController: AbortController } }) => {
    opts.abortController.signal.addEventListener('abort', () => {
      state.aborted = true
      ended = true
      wake?.()
    })
    void (async () => {
      for await (const message of prompt) state.prompts.push(message)
      state.inputClosed = true
      // Like Claude Code, the process exits once its input is closed (unless the test keeps it up).
      if (options.exits === false) return
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
          // As the SDK does: an aborted query ends with an AbortError from its iterator.
          if (state.aborted) throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' })
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
  ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent', description: task_id })), ...base }) as Partial<SDKMessage>
const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, duration_ms: 1000, num_turns: 1, result: 'ok', ...base } as Partial<SDKMessage>
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle', ...base } as Partial<SDKMessage>
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

afterEach(() => {
  vi.useRealTimers()
  sdk.query.mockReset()
})

describe('Claude turns with background work', () => {
  it('ends the turn at the result when nothing runs in the background', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(assistant('done'), result)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
    expect(claude.state.inputClosed).toBe(true)
  })

  it('reports an error result as a failure, not success', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push({ ...result, subtype: 'error_during_execution', is_error: true, errors: ['Prompt is too long'] } as Partial<SDKMessage>)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'Prompt is too long' })
  })

  // #11: a usage limit is read from the result's error fields, never from what Claude wrote.
  it('reads a usage limit and its reset time from the error result', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    const error = '5-hour limit reached ∙ resets 2:30pm (Europe/London)'
    claude.push({ ...result, subtype: 'success', is_error: true, result: error, api_error_status: 429 } as Partial<SDKMessage>)
    await run
    const finished = cb.finished.mock.calls[0][0]
    expect(finished).toMatchObject({ ok: false, error, limit: { source: 'resets 2:30pm (Europe/London)', timeZone: 'Europe/London' } })
    expect(Date.parse(finished.limit.resetAt) > Date.now()).toBe(true)
  })

  it('marks a 429 with no stated time as a limit with an unknown reset time', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push({ ...result, subtype: 'success', is_error: true, result: 'API Error: Request rejected', api_error_status: 429 } as Partial<SDKMessage>)
    await run
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'API Error: Request rejected', limit: {} })
  })

  it('ignores a reset time Claude wrote in its answer when the error says nothing of it', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(assistant('I hit my usage limit, it resets 2:30pm (Europe/London)'), { ...result, subtype: 'error_during_execution', is_error: true, errors: ['Tool failed'] } as Partial<SDKMessage>)
    await run
    expect(cb.finished.mock.calls[0][0]).toEqual({ ok: false, error: 'Tool failed' })
  })

  it('reports a crashed process as a failure', async () => {
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('spawn claude ENOENT')
      }
    }))
    const cb = callbacks()
    await claudeDriver.createTurn(request, cb).run()
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'spawn claude ENOENT' })
  })

  it('keeps the input open until a background agent reports back', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    claude.push(tasks('agent-1'), assistant('waiting for the agent'), result)
    await settle()
    expect(cb.finished).not.toHaveBeenCalled()
    expect(claude.state.inputClosed).toBe(false)
    expect(cb.item).toHaveBeenCalledWith(expect.objectContaining({ kind: 'notice', text: 'Waiting for 1 background task to finish.' }))
    // Follow-ups can still be steered in while it waits.
    expect(turn.steer('also check the tests')).toBe(true)

    // The agent finishes and Claude is woken to use its report.
    claude.push(tasks(), assistant('the agent found three things'), result)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(claude.state.inputClosed).toBe(true)
  })

  it('says it is waiting for background work in the app’s language', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn({ ...request, locale: 'de' }, cb).run()
    claude.push(tasks('agent-1', 'shell-1'), result)
    await settle()
    expect(cb.item).toHaveBeenCalledWith(expect.objectContaining({ kind: 'notice', text: 'Warte, bis 2 Hintergrundaufgaben fertig sind.' }))
    claude.push(tasks(), idle)
    await run
  })

  it('ends the turn when Claude goes idle after its background work', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(tasks('shell-1'), result)
    await settle()
    expect(cb.finished).not.toHaveBeenCalled()
    claude.push(tasks(), idle)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
  })

  it('gives up waiting when background work ends and Claude is never woken', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(tasks('agent-1'), result)
    await settle()
    vi.useFakeTimers()
    claude.push(tasks())
    await vi.advanceTimersByTimeAsync(29_000)
    expect(cb.finished).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    vi.useRealTimers()
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
  })

  // A follow-up sent mid-turn makes Claude Code cut off its request with this error, then answer the follow-up.
  const cut = {
    ...result,
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null']
  } as Partial<SDKMessage>

  it('keeps the turn going when a steered follow-up cuts off Claude’s request', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    expect(turn.steer('also check the tests')).toBe(true)
    claude.push(cut)
    await settle()
    expect(cb.finished).not.toHaveBeenCalled()
    expect(claude.state.inputClosed).toBe(false)
    expect(cb.item).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'notice', level: 'error' }))
    expect(cb.item).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'result' }))
    // Another follow-up still reaches the running turn rather than waiting for it to end.
    expect(turn.steer('and the docs')).toBe(true)

    claude.push(assistant('checked the tests and the docs'), result)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
    expect(claude.state.prompts.map((p) => p.message.content)).toEqual(['hello', 'also check the tests', 'and the docs'])
  })

  it('reports the same error when no follow-up was steered in', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(cut)
    await run
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null' })
  })

  it('reports the error once Claude has already answered the follow-up', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    turn.steer('also check the tests')
    claude.push(assistant('on it'), cut)
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished.mock.calls[0][0]).toMatchObject({ ok: false })
  })

  it('reports a different error after a follow-up', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    turn.steer('also check the tests')
    claude.push({ ...result, subtype: 'error_during_execution', is_error: true, errors: ['Prompt is too long'] } as Partial<SDKMessage>)
    await run
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'Prompt is too long' })
  })

  it('ignores ambient tasks such as watchers', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w', task_type: 'monitor', description: 'w', ambient: true }], ...base } as Partial<SDKMessage>,
      result
    )
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
  })
})

const agentCall = (id: string) =>
  ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Survey the code', run_in_background: true } }] },
    ...base
  }) as Partial<SDKMessage>
const launched = (id: string) =>
  ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched' }] }, ...base }) as Partial<SDKMessage>
const taskEvent = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, task_id: 'task-1', ...fields, ...base }) as Partial<SDKMessage>
const started = taskEvent('task_started', { tool_use_id: 'call-1', description: 'Survey the code', is_backgrounded: true })
const progress = (toolUses: number, summary?: string) =>
  taskEvent('task_progress', { description: 'Survey the code', usage: { total_tokens: 100, tool_uses: toolUses, duration_ms: 5000 }, last_tool_name: 'Grep', summary })
const notification = taskEvent('task_notification', { status: 'completed', summary: 'Found three things', output_file: '', usage: { total_tokens: 900, tool_uses: 7, duration_ms: 42_000 } })

/** Every update of one tool call, with whether it was transient. */
function toolUpdates(cb: ReturnType<typeof callbacks>, id: string) {
  return cb.item.mock.calls.filter(([item]) => item.kind === 'tool' && item.id === id).map(([item, transient]) => ({ ...item, transient: Boolean(transient) }))
}

// The SDK ends Claude Code's stdin only once it reports idle (waiting up to ten minutes for that), and never closes a
// process that stays up after; a poor connection can hold up the exit. A process that outlives its turn is closed
// after a grace, with the turn's result as it was.
describe('Claude Code outliving its turn', () => {
  const notices = (cb: ReturnType<typeof callbacks>) => cb.item.mock.calls.map(([item]) => item).filter((item) => item.kind === 'notice')

  it('leaves a process that exits on its own alone', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(assistant('done'), result)
    await run
    expect(claude.state.inputClosed).toBe(true)
    expect(claude.state.aborted).toBe(false)
  })

  it('closes a process still up after the grace, keeping the result and saying nothing', async () => {
    const claude = fakeClaude({ exits: false })
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    vi.useFakeTimers()
    claude.push(assistant('done'), result)
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS - 1_000)
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
    expect(claude.state.inputClosed).toBe(true)
    expect(claude.state.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(claude.state.aborted).toBe(true)
    vi.useRealTimers()
    await run
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(notices(cb)).toEqual([])
  })

  it('stops a turn that has ended by closing its process, with nothing to interrupt and no "Stopped."', async () => {
    const claude = fakeClaude({ exits: false })
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    claude.push(assistant('done'), result)
    await settle()
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
    await turn.stop()
    await run
    expect(claude.state.aborted).toBe(true)
    expect(sdk.query.mock.results[0].value.interrupt).not.toHaveBeenCalled()
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(notices(cb)).toEqual([])
  })

  it('still says "Stopped." when a running turn is stopped', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    claude.push(assistant('working'))
    await settle()
    await turn.stop()
    await run
    expect(notices(cb).map((n) => n.kind === 'notice' && n.text)).toEqual(['Stopped.'])
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'Stopped.' })
  })
})

describe('Claude background agents in the chat', () => {
  it('shows a background agent on its tool call until it reports back', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(tasks('task-1'), agentCall('call-1'), started, launched('call-1'), progress(3, 'Reading the router'), result)
    await settle()

    const updates = toolUpdates(cb, 'call-1')
    // The call returned, but its agent is still working in the background.
    expect(updates.at(-1)).toMatchObject({
      status: 'done',
      transient: true,
      task: { status: 'running', background: true, toolUses: 3, lastTool: 'Grep', summary: 'Reading the router' }
    })
    expect(updates.find((u) => u.task)?.task.startedAt).toEqual(expect.any(String))

    claude.push(notification, tasks(), assistant('the agent found three things'), result)
    await run
    // Its report is saved, not just shown.
    expect(toolUpdates(cb, 'call-1').at(-1)).toMatchObject({
      transient: false,
      task: { status: 'completed', background: true, toolUses: 7, durationMs: 42_000, summary: 'Found three things' }
    })
  })

  it('attaches a task that starts before its tool call arrives', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(started, agentCall('call-1'), launched('call-1'), notification, result)
    await run
    expect(toolUpdates(cb, 'call-1')[0]).toMatchObject({ status: 'running', task: { status: 'running', background: true } })
  })

  it('ignores progress that arrives after the task ended', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(agentCall('call-1'), started, launched('call-1'), notification, progress(9), result)
    await run
    expect(toolUpdates(cb, 'call-1').at(-1)).toMatchObject({ task: { status: 'completed', toolUses: 7 } })
  })

  it('marks background work stopped when the turn ends without it', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const turn = claudeDriver.createTurn(request, cb)
    const run = turn.run()
    claude.push(tasks('task-1'), agentCall('call-1'), started, launched('call-1'), result)
    await settle()
    await turn.stop()
    await run
    expect(toolUpdates(cb, 'call-1').at(-1)).toMatchObject({ status: 'done', transient: false, task: { status: 'stopped' } })
  })

  it('leaves ambient tasks off the chat', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(agentCall('call-1'), taskEvent('task_started', { tool_use_id: 'call-1', description: 'watch', ambient: true }), result)
    await run
    expect(toolUpdates(cb, 'call-1').every((u) => !u.task)).toBe(true)
  })

  it('sends progress ticks at most once every 50 ms, the latest each time', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(request, cb).run()
    claude.push(tasks('task-1'), agentCall('call-1'), started, launched('call-1'), ...Array.from({ length: 30 }, (_, i) => progress(i + 1)))
    await settle()
    const ticks = () => toolUpdates(cb, 'call-1').filter((u) => u.transient)
    // The first at once; the rest wait for the window to end.
    expect(ticks().map((u) => u.task.toolUses)).toEqual([1])
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(ticks().map((u) => u.task.toolUses)).toEqual([1, 30])
    // A tick pending when the task reports back never follows its saved end.
    claude.push(progress(31), notification, tasks(), assistant('done'), result)
    await run
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(toolUpdates(cb, 'call-1').at(-1)).toMatchObject({ transient: false, task: { status: 'completed', toolUses: 7 } })
  })
})

describe('the Foreman assistant turn', () => {
  const tools = {
    searchSettings: () => 'found',
    getSettings: () => '{}',
    showSetting: () => 'shown',
    agentStatus: async () => 'ready',
    listWorkspaces: () => '<data></data>',
    cliHelp: () => 'help',
    cliStatus: async () => 'installed',
    runForeman: () => 'Waiting for the user to click Run'
  }
  const assistantRequest: TurnRequest = { ...request, approvals: 'ask', cwd: '/data/assistant', assistant: { systemPrompt: 'You are the Foreman assistant.', tools } }

  it('runs with its own prompt, no built-in tools and none of the user’s settings, hooks, skills or MCP servers', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn(assistantRequest, callbacks()).run()
    claude.push(assistant('Settings › Appearance.'), result)
    await run
    const options = sdk.query.mock.calls[0][0].options
    expect(options.systemPrompt).toBe('You are the Foreman assistant.')
    expect(options.tools).toEqual([])
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.skills).toEqual([])
    expect(options.plugins).toEqual([])
    expect(Object.keys(options.mcpServers)).toEqual(['foreman_assistant'])
    expect(options.permissionMode).toBe('default')
    expect(options.cwd).toBe('/data/assistant')
    for (const key of ['additionalDirectories', 'extraArgs', 'sessionStore', 'disallowedTools', 'allowDangerouslySkipPermissions']) expect(options[key]).toBeUndefined()
  })

  it('allows its own tools and refuses everything else without asking', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(assistantRequest, cb).run()
    const { canUseTool } = sdk.query.mock.calls[0][0].options
    const signal = new AbortController().signal
    expect(await canUseTool('mcp__foreman_assistant__search_settings', { query: 'theme' }, { signal })).toMatchObject({ behavior: 'allow' })
    for (const name of ['Bash', 'Read', 'WebFetch', 'mcp__foreman__report', 'mcp__evil__exfiltrate', 'ExitPlanMode']) {
      expect(await canUseTool(name, {}, { signal })).toMatchObject({ behavior: 'deny' })
    }
    expect(cb.approveTool).not.toHaveBeenCalled()
    claude.push(result)
    await run
  })

  it('offers exactly the assistant’s eight tools', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn(assistantRequest, callbacks()).run()
    claude.push(result)
    await run
    const names = (sdk.tool.mock.calls as unknown as [string][]).map((c) => c[0])
    expect(names).toEqual(expect.arrayContaining(['search_settings', 'get_settings', 'show_setting', 'agent_status', 'list_workspaces', 'cli_help', 'cli_status', 'run_foreman']))
    const server = (sdk.createSdkMcpServer.mock.calls as unknown as [{ name: string; tools: unknown[] }][]).find(([c]) => c.name === 'foreman_assistant')![0]
    expect(server.tools).toHaveLength(8)
  })
})

describe('Foreman app tools in a Claude turn', () => {
  it('registers the in-process foreman-app server as an sdk server beside stdio ones, and still asks before its tools run', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    cb.approveTool.mockResolvedValue({ kind: 'tool', allow: false })
    const instance = { name: 'stand-in McpServer' }
    const run = claudeDriver.createTurn({
      ...request,
      approvals: 'ask',
      mcpServers: { 'foreman-linear': { command: '/app', args: ['bridge.js', 'mcp-bridge', 'linear'], env: { FOREMAN_BRIDGE_GRANT: 'g' } } },
      inProcessMcp: { 'foreman-app': instance as never }
    }, cb).run()
    claude.push(result)
    await run
    const { mcpServers, canUseTool } = sdk.query.mock.calls[0][0].options
    expect(mcpServers['foreman-app']).toEqual({ type: 'sdk', name: 'foreman-app', instance })
    expect(mcpServers['foreman-linear']).toMatchObject({ type: 'stdio', command: '/app' })
    expect(Object.keys(mcpServers)).toEqual(['foreman-linear', 'foreman-app', 'foreman'])
    // Same approval path as the bridge's tools: only Claude's own `foreman` server is allowed without asking.
    const signal = new AbortController().signal
    expect(await canUseTool('mcp__foreman-app__run_checks', {}, { signal })).toMatchObject({ behavior: 'deny' })
    expect(cb.approveTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'mcp__foreman-app__run_checks' }), signal)
  })
})

describe('a flow step with scoped writes', () => {
  const scoped: TurnRequest = { ...request, approvals: 'auto', writeScope: ['docs/features/**'] }
  const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u1', session_id: 's1', transcript_path: '', cwd: '/repo' })

  it('decides file tools and shells in a hook before any permission mode, and the turn carries on', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(scoped, cb).run()
    const options = sdk.query.mock.calls[0][0].options
    const hook = options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    expect(await hook(pre('Write', { file_path: '/repo/docs/features/search/requirements.md' }), 'u1', { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } })
    expect(await hook(pre('Edit', { file_path: 'src/index.ts' }), 'u1', { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('may only write inside docs/features/**') }
    })
    expect(await hook(pre('Bash', { command: 'rm -rf src' }), 'u1', { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(await hook(pre('Read', { file_path: 'src/index.ts' }), 'u1', { signal })).toEqual({})
    // The permission prompt says the same, should a call get there; neither asks anyone.
    expect(await options.canUseTool('Edit', { file_path: 'src/index.ts' }, { signal })).toMatchObject({ behavior: 'deny' })
    expect(await options.canUseTool('Bash', { command: 'ls' }, { signal })).toMatchObject({ behavior: 'deny' })
    expect(cb.approveTool).not.toHaveBeenCalled()
    claude.push(assistant('Wrote the requirements.'), result)
    await run
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
  })

  it('adds no hook to a turn without scoped writes', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn(request, callbacks()).run()
    expect(sdk.query.mock.calls[0][0].options.hooks).toBeUndefined()
    claude.push(result)
    await run
  })
})

describe('a turn capped below Never ask (docs/agent-access.md §3)', () => {
  const capped: TurnRequest = { ...request, approvals: 'ask-except-edits', capped: { ceiling: 'ask-except-edits', gitDir: '/repos/app/.git' } }
  const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u1', session_id: 's1', transcript_path: '', cwd: '/repo' })

  it('asks before a file tool writes agent or git configuration, even where edits go ahead, and leaves the rest to the mode', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    cb.approveTool.mockResolvedValue({ kind: 'tool', allow: true })
    const run = claudeDriver.createTurn(capped, cb).run()
    const options = sdk.query.mock.calls[0][0].options
    const hook = options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    for (const file_path of ['/repo/.claude/settings.json', '.codex/config.toml', '/repo/.mcp.json', '/repo/.foreman/settings.toml', '/repo/.git', '/repos/app/.git/hooks/pre-commit']) {
      expect(await hook(pre('Write', { file_path }), 'u1', { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: expect.stringContaining('outside agent') } })
    }
    expect(await hook(pre('Edit', { file_path: '/repo/src/index.ts' }), 'u1', { signal })).toEqual({})
    expect(await hook(pre('Read', { file_path: '/repo/.claude/settings.json' }), 'u1', { signal })).toEqual({})
    // The hook's ask reaches the person.
    expect(await options.canUseTool('Write', { file_path: '/repo/.claude/settings.json' }, { signal })).toMatchObject({ behavior: 'allow' })
    expect(cb.approveTool).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'Write' }), signal)
    // Its permission mode is the capped policy; the git folder isn't a writable directory.
    expect(options.permissionMode).toBe('acceptEdits')
    expect(options.additionalDirectories).toBeUndefined()
    expect(options.settings?.permissions).toBeUndefined()
    claude.push(result)
    await run
  })

  it('asks before running `foreman` at an Auto ceiling', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...request, approvals: 'auto', capped: { ceiling: 'auto' } }, callbacks()).run()
    const options = sdk.query.mock.calls[0][0].options
    expect(options.permissionMode).toBe('auto')
    expect(options.settings).toEqual({ permissions: { ask: ['Bash(foreman:*)'] } })
    claude.push(result)
    await run
  })

  it('adds neither hook nor rule to an uncapped turn', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...request, approvals: 'auto' }, callbacks()).run()
    const options = sdk.query.mock.calls[0][0].options
    expect(options.hooks).toBeUndefined()
    expect(options.settings).toBeUndefined()
    claude.push(result)
    await run
  })
})

describe('an AI employee’s run (docs/ai-employees.md §9)', () => {
  const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u1', session_id: 's1', transcript_path: '', cwd: '/repo' })
  // No user settings unless a test writes some: the person's real ~/.claude never reaches these tests.
  const noUserSettings = path.join(os.tmpdir(), 'foreman-test-no-claude-config')
  const employee: TurnRequest = { ...request, env: { CLAUDE_CONFIG_DIR: noUserSettings }, approvals: 'never-ask', employee: true }

  it('never asks and has no hook refusing agent or git configuration, but leaves out the person’s own setup', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn(employee, callbacks()).run()
    const options = sdk.query.mock.calls[0][0].options
    // The repository's settings and Foreman's servers only: no user settings (their hooks, plugins), no other MCP config.
    expect(options.settingSources).toEqual(['project', 'local'])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(options.hooks).toBeUndefined()
    claude.push(result)
    await run
  })

  it('hands over the repository’s approved .mcp.json servers, less Slack, Linear and what is rejected or switched off', async () => {
    const dir = await tempDir()
    const root = await tempDir()
    await mkdir(path.join(dir, '.claude'))
    await mkdir(path.join(root, '.claude'))
    await writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: { command: 'node', args: ['${DOCS_HOME:-tools}/docs.js'], env: { TOKEN: '${DOCS_TOKEN}' } },
          api: { type: 'http', url: 'https://mcp.example.com/${REGION}', headers: { Authorization: 'Bearer ${API_KEY:-none}' } },
          slack: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
          tracker: { type: 'http', url: 'https://mcp.linear.app/sse' },
          quiet: { command: 'quiet-mcp' },
          rejected: { command: 'rejected-mcp' },
          pending: { command: 'pending-mcp' },
          gh: { command: 'github-mcp-server' },
          broken: { args: ['no command'] }
        }
      })
    )
    // The committed settings approve some; the person's own approvals and rejections are in the repository's folder.
    await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['docs', 'slack', 'tracker', 'gh', 'broken'] }))
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ disabledMcpjsonServers: ['quiet'] }))
    await writeFile(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['api', 'quiet', 'rejected'], disabledMcpjsonServers: ['rejected'] }))
    const claude = fakeClaude()
    const turn: TurnRequest = { ...employee, cwd: dir, repoRoot: root, env: { ...employee.env, DOCS_TOKEN: 't1', REGION: 'eu' }, disabledMcp: ['gh'], mcpServers: { 'foreman-slack': { command: 'foreman', args: ['mcp-bridge', 'slack'], env: {} } } }
    const run = claudeDriver.createTurn(turn, callbacks()).run()
    const servers = sdk.query.mock.calls[0][0].options.mcpServers
    expect(servers.docs).toEqual({ type: 'stdio', command: 'node', args: ['tools/docs.js'], env: { TOKEN: 't1' } })
    expect(servers.api).toEqual({ type: 'http', url: 'https://mcp.example.com/eu', headers: { Authorization: 'Bearer none' } })
    // Slack and Linear only through Foreman's connections; its bridge is still there.
    expect(servers.slack).toBeUndefined()
    expect(servers.tracker).toBeUndefined()
    expect(servers['foreman-slack']).toMatchObject({ command: 'foreman' })
    // Rejected here or in the repository's folder, never approved, switched off by the integrations, or not startable.
    for (const name of ['quiet', 'rejected', 'pending', 'gh', 'broken']) expect(servers[name]).toBeUndefined()
    expect(servers.foreman).toBeDefined()
    claude.push(result)
    await run
  })

  it('expands .mcp.json variables from the turn’s own environment only, and says which aren’t set', async () => {
    const dir = await tempDir()
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp', env: { TOKEN: '${FOREMAN_TEST_SECRET}', HOME_DIR: '${MISSING_TOO}' } } } }))
    await mkdir(path.join(dir, '.claude'))
    await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }))
    process.env.FOREMAN_TEST_SECRET = 'from-the-app'
    try {
      const claude = fakeClaude()
      const cb = callbacks()
      const run = claudeDriver.createTurn({ ...employee, cwd: dir }, cb).run()
      expect(sdk.query.mock.calls[0][0].options.mcpServers.docs).toEqual({ type: 'stdio', command: 'docs-mcp', args: [], env: { TOKEN: '', HOME_DIR: '' } })
      claude.push(result)
      await run
      const notice = cb.item.mock.calls.map(([item]) => item).find((item) => item.kind === 'notice')
      expect(notice.text).toBe('The repository’s MCP servers use FOREMAN_TEST_SECRET, MISSING_TOO, which this run’s environment doesn’t set, so they start with it empty.')
    } finally {
      delete process.env.FOREMAN_TEST_SECRET
    }
  })

  it('keeps what signs Claude Code in and the person’s own limits from their user settings, and leaves the rest out', async () => {
    const config = await tempDir()
    await writeFile(
      path.join(config, 'settings.json'),
      JSON.stringify({
        env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'work', ANTHROPIC_BASE_URL: 'https://gateway.example.com', SHARED: 'user' },
        apiKeyHelper: '~/bin/key.sh',
        awsAuthRefresh: 'aws sso login',
        forceLoginMethod: 'console',
        permissions: { deny: ['Bash(rm -rf:*)'], ask: ['Bash(git push:*)'], allow: ['Bash(*)'] },
        sandbox: { enabled: true },
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'gate' }] }] },
        enabledPlugins: { 'gate@market': true },
        mcpServers: { mine: { command: 'mine' } },
        model: 'claude-haiku-5-5'
      })
    )
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...employee, env: { CLAUDE_CONFIG_DIR: config, SHARED: 'turn' }, capped: { ceiling: 'auto' } }, callbacks()).run()
    const options = sdk.query.mock.calls[0][0].options
    // Its env goes under the turn's own, which wins; the model is worded for Bedrock, as the person's chats are.
    expect(options.env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'work', ANTHROPIC_BASE_URL: 'https://gateway.example.com', SHARED: 'turn' })
    expect(options.model).toBe('opus')
    expect(options.settings).toEqual({
      apiKeyHelper: '~/bin/key.sh',
      awsAuthRefresh: 'aws sso login',
      forceLoginMethod: 'console',
      sandbox: { enabled: true },
      permissions: { deny: ['Bash(rm -rf:*)'], ask: ['Bash(git push:*)', 'Bash(foreman:*)'] }
    })
    expect(options.settingSources).toEqual(['project', 'local'])
    claude.push(result)
    await run
    // Another turn reads none of it.
    const other = fakeClaude()
    const plain = claudeDriver.createTurn({ ...request, env: { CLAUDE_CONFIG_DIR: config } }, callbacks()).run()
    expect(sdk.query.mock.calls[1][0].options.env.AWS_PROFILE).toBeUndefined()
    expect(sdk.query.mock.calls[1][0].options.settings).toBeUndefined()
    other.push(result)
    await plain
  })

  it('keeps the calls refused in the turn on its result: its own hooks’ denies and the result’s denials, each once', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn({ ...employee, writeScope: ['notes/**'], writeScopeSubject: 'AI employee’s run' }, cb).run()
    const hook = sdk.query.mock.calls[0][0].options.hooks.PreToolUse[0].hooks[0]
    await hook(pre('Bash', { command: 'npm publish\nnpm test' }), 'call-1', { signal: new AbortController().signal })
    // The repository's own hook refused another call: the result's denials say so, and the call's result says why.
    claude.push(
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm-2', content: [{ type: 'tool_use', id: 'call-2', name: 'Write', input: { file_path: '/repo/.env', content: 'x' } }] }, ...base } as Partial<SDKMessage>,
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'Secrets stay out. Ask first.', is_error: true }] }, ...base } as Partial<SDKMessage>,
      { ...result, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'call-1', tool_input: {} }, { tool_name: 'Write', tool_use_id: 'call-2', tool_input: { file_path: '/repo/.env' } }] } as Partial<SDKMessage>
    )
    await run
    const said = cb.item.mock.calls.map(([item]) => item).find((item) => item.kind === 'result')
    expect(said.refused).toEqual([
      { tool: 'Bash', what: 'npm publish', reason: expect.stringMatching(/^This AI employee’s run may only write inside notes\/\*\*/) },
      { tool: 'Write', what: 'Write .env', reason: 'Secrets stay out. Ask first.' }
    ])
  })

  it('keeps the publisher guard’s and the no-shell refusals on its result too', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn({ ...employee, noPublish: 'Foreman refused this: only “Build” publishes.', noShell: true, readOnly: true, planMode: true }, cb).run()
    const hooks = sdk.query.mock.calls[0][0].options.hooks.PreToolUse[0].hooks
    const signal = new AbortController().signal
    for (const hook of hooks) await hook(pre('Bash', { command: 'git push origin main' }), 'call-9', { signal })
    claude.push(result)
    await run
    const said = cb.item.mock.calls.map(([item]) => item).find((item) => item.kind === 'result')
    // One call, refused by the first hook that denied it (each call goes on the record once).
    expect(said.refused).toEqual([{ tool: 'Bash', what: 'git push origin main', reason: expect.any(String) }])
    // The guard on its own, as a writing run without a shell limit has it.
    const claude2 = fakeClaude()
    const cb2 = callbacks()
    const run2 = claudeDriver.createTurn({ ...employee, noPublish: 'Foreman refused this: only “Build” publishes.' }, cb2).run()
    const guard = sdk.query.mock.calls[1][0].options.hooks.PreToolUse[0].hooks[0]
    await guard(pre('Bash', { command: 'gh pr create --fill' }), 'call-10', { signal })
    claude2.push(result)
    await run2
    expect(cb2.item.mock.calls.map(([item]) => item).find((item) => item.kind === 'result').refused).toEqual([{ tool: 'Bash', what: 'gh pr create --fill', reason: 'Foreman refused this: only “Build” publishes.' }])
  })

  it('says nothing refused on a turn that isn’t an employee’s', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn({ ...request, writeScope: ['notes/**'] }, cb).run()
    const hook = sdk.query.mock.calls[0][0].options.hooks.PreToolUse[0].hooks[0]
    await hook(pre('Bash', { command: 'ls' }), 'call-1', { signal: new AbortController().signal })
    claude.push({ ...result, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'call-1', tool_input: {} }] } as Partial<SDKMessage>)
    await run
    expect(cb.item.mock.calls.map(([item]) => item).find((item) => item.kind === 'result').refused).toBeUndefined()
  })

  it('names itself in a scope’s refusals when it has no shell', async () => {
    const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u1', session_id: 's1', transcript_path: '', cwd: '/repo' })
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...employee, writeScope: ['**'], writeScopeSubject: 'AI employee’s run' }, callbacks()).run()
    const hooks = sdk.query.mock.calls[0][0].options.hooks.PreToolUse[0].hooks
    const signal = new AbortController().signal
    const decided = (await hooks[0](pre('Bash', { command: 'ls' }), 'u1', { signal })) as { hookSpecificOutput?: { permissionDecisionReason: string } }
    expect(decided.hookSpecificOutput?.permissionDecisionReason).toMatch(/^This AI employee’s run may only write inside \*\*, so it has no shell/)
    expect(((await hooks[0](pre('Write', { file_path: '/repo/.claude/settings.json' }), 'u1', { signal })) as { hookSpecificOutput?: { permissionDecision: string } }).hookSpecificOutput?.permissionDecision).toBe('allow')
    claude.push(result)
    await run
  })

  it('allows its own Foreman tools without asking, even read-only in plan mode, and nothing else of the app server', async () => {
    // Without this, a read-only employee's ask_person reached the prompt and the unattended run was stopped.
    const claude = fakeClaude()
    const cb = callbacks()
    const readOnly: TurnRequest = { ...employee, readOnly: true, planMode: true, writeScope: undefined }
    const run = claudeDriver.createTurn(readOnly, cb).run()
    const options = sdk.query.mock.calls[0][0].options
    const signal = new AbortController().signal
    for (const tool of ['ask_person', 'remember', 'memory_search', 'finish_task', 'report_no_update']) {
      expect(await options.canUseTool(`mcp__foreman-app__${tool}`, {}, { signal })).toMatchObject({ behavior: 'allow' })
    }
    expect(cb.approveTool).not.toHaveBeenCalled()
    // A tool of the app server that isn't an employee tool still goes to the prompt like any other call.
    cb.approveTool.mockResolvedValue({ allow: false })
    expect(await options.canUseTool('mcp__foreman-app__start_task', {}, { signal })).toMatchObject({ behavior: 'deny' })
    expect(cb.approveTool).toHaveBeenCalledTimes(1)
    claude.push(result)
    await run
  })

  it('lets its bridged Slack, Linear and Langfuse calls reach Foreman’s broker without asking, and nothing else', async () => {
    // docs/ai-employees.md §9: the bridge records the post and holds it for a person (or sends or refuses it as the
    // definition says); asking here would deny the unattended run first.
    const claude = fakeClaude()
    const cb = callbacks()
    const run = claudeDriver.createTurn(employee, cb).run()
    const options = sdk.query.mock.calls[0][0].options
    const signal = new AbortController().signal
    for (const tool of ['mcp__foreman-slack__slack_post', 'mcp__foreman-linear__save_comment', 'mcp__foreman-linear__get_issue', 'mcp__foreman-langfuse__list_traces']) {
      expect(await options.canUseTool(tool, {}, { signal })).toMatchObject({ behavior: 'allow' })
    }
    expect(cb.approveTool).not.toHaveBeenCalled()
    // Another server's tool (one its definition keeps) still goes to the prompt: it isn't brokered, so it can't be held.
    cb.approveTool.mockResolvedValue({ allow: false })
    expect(await options.canUseTool('mcp__github__create_pull_request', {}, { signal })).toMatchObject({ behavior: 'deny' })
    expect(cb.approveTool).toHaveBeenCalledTimes(1)
    claude.push(result)
    await run
    // A turn that isn't an employee's asks as it always has.
    const cb2 = callbacks()
    cb2.approveTool.mockResolvedValue({ allow: false })
    const claude2 = fakeClaude()
    const run2 = claudeDriver.createTurn({ ...request, approvals: 'auto' }, cb2).run()
    const options2 = sdk.query.mock.calls[1][0].options
    expect(await options2.canUseTool('mcp__foreman-slack__slack_post', {}, { signal })).toMatchObject({ behavior: 'deny' })
    expect(cb2.approveTool).toHaveBeenCalledTimes(1)
    claude2.push(result)
    await run2
  })

  it('asks about the app server’s employee tools on a turn that isn’t an employee’s', async () => {
    const claude = fakeClaude()
    const cb = callbacks()
    cb.approveTool.mockResolvedValue({ allow: false })
    const run = claudeDriver.createTurn({ ...request, readOnly: true, planMode: true }, cb).run()
    const options = sdk.query.mock.calls[0][0].options
    expect(await options.canUseTool('mcp__foreman-app__ask_person', {}, { signal: new AbortController().signal })).toMatchObject({ behavior: 'deny' })
    expect(cb.approveTool).toHaveBeenCalledTimes(1)
    claude.push(result)
    await run
  })

  it('leaves the user’s settings and MCP configuration alone for any other turn', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn(request, callbacks()).run()
    expect(sdk.query.mock.calls[0][0].options.strictMcpConfig).toBeUndefined()
    expect(sdk.query.mock.calls[0][0].options.settingSources).toEqual(['user', 'project', 'local'])
    claude.push(result)
    await run
  })
})

describe('what an employee’s Claude run takes from outside Foreman (docs/ai-employees.md §9)', () => {
  it('finds variables whatever their case on Windows, as Claude Code does, and by exact name elsewhere', () => {
    const env = { Path: 'C:\\bin', ClAuDe_CoNfIg_DiR: 'C:\\cfg' }
    expect(envValue(env, 'PATH', 'win32')).toBe('C:\\bin')
    expect(envValue(env, 'PATH', 'linux')).toBeUndefined()
    const missing = new Set<string>()
    expect(expandVars('${PATH};${NOPE:-x};${GONE}', env, missing, 'win32')).toBe('C:\\bin;x;')
    expect([...missing]).toEqual(['GONE'])
    expect(expandVars('${PATH}', env, undefined, 'darwin')).toBe('')
  })

  it('reads the user settings where CLAUDE_CONFIG_DIR says, whatever its case on Windows, and keeps the person’s own approvals of project servers', async () => {
    const config = await tempDir()
    await writeFile(path.join(config, 'settings.json'), JSON.stringify({ apiKeyHelper: 'key.sh', enabledMcpjsonServers: ['docs'], disabledMcpjsonServers: ['noisy'], hooks: { Stop: [] } }))
    const setup = employeeUserSetup({ claude_config_dir: config }, '/nowhere', 'win32')
    expect(setup.settings).toEqual({ apiKeyHelper: 'key.sh' })
    expect(setup.mcpApproval).toEqual({ enabledMcpjsonServers: ['docs'], disabledMcpjsonServers: ['noisy'] })
    const dir = await tempDir()
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' }, noisy: { command: 'noisy-mcp' }, other: { command: 'other-mcp' } } }))
    // Approved by the person's own settings only: docs starts; noisy they rejected; other nobody approved.
    expect(Object.keys(employeeRepoMcp({ cwd: dir, env: {}, user: setup.mcpApproval }).servers)).toEqual(['docs'])
    expect(employeeRepoMcp({ cwd: dir, env: {} }).servers).toEqual({})
  })
})

describe('Claude launch problems (docs/agents.md, 4.1)', () => {
  const fail = (message: string) =>
    sdk.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error(message)
      }
    }))
  const notice = (cb: ReturnType<typeof callbacks>) => cb.item.mock.calls.map(([item]) => item).find((item) => item.kind === 'notice')

  it('says the program is missing when it cannot be spawned, and points at Settings', async () => {
    fail('spawn claude ENOENT')
    const cb = callbacks()
    await claudeDriver.createTurn(request, cb).run()
    expect(notice(cb)).toMatchObject({ level: 'error', text: 'Claude Code is not installed or could not be found. Set its path in Settings → Agents → Claude Code.', action: 'open-settings' })
  })

  it('says not signed in with the sign-in button, and keeps Claude’s own words in the result', async () => {
    fail('Please run /login · API Error: 401')
    const cb = callbacks()
    await claudeDriver.createTurn(request, cb).run()
    expect(notice(cb)).toMatchObject({ level: 'error', text: 'Claude Code isn’t signed in, or its sign-in has expired.', action: 'sign-in' })
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'Please run /login · API Error: 401' })
  })

  it('shows Claude’s own error when nothing else matches, with no button', async () => {
    fail('Prompt is too long')
    const cb = callbacks()
    await claudeDriver.createTurn(request, cb).run()
    expect(notice(cb)).toMatchObject({ level: 'error', text: 'Prompt is too long' })
    expect(notice(cb)).not.toHaveProperty('action', expect.anything())
  })
})

describe('Claude update command', () => {
  it('runs Claude Code’s own `update` on the program the user set, else on the one on PATH (the bundled copy is never updated this way)', () => {
    expect(claudeDriver.updateCommand?.('/opt/my claude/claude')).toMatch(/^['"]?\/opt\/my claude\/claude['"]? update$/)
    expect(claudeDriver.updateCommand?.()).toMatch(/^['"]claude['"] update$/)
  })
})

describe('Claude’s always-allow names its rule', () => {
  const ask = async (suggestions: unknown[], toolName = 'Bash', input: Record<string, unknown> = { command: 'npm test -- session && git push origin main' }) => {
    const claude = fakeClaude()
    const cb = callbacks()
    cb.approveTool.mockResolvedValue({ kind: 'tool', allow: true, alternate: true })
    const run = claudeDriver.createTurn({ ...request, approvals: 'ask' }, cb).run()
    const { canUseTool } = sdk.query.mock.calls[0][0].options
    const answer = await canUseTool(toolName, input, { signal: new AbortController().signal, suggestions })
    claude.push(result)
    await run
    return { request: cb.approveTool.mock.calls[0][0], answer }
  }

  it('fills alwaysScope and alwaysRules from the SDK’s Bash rule, and sends back exactly that rule', async () => {
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }]
    const { request: asked, answer } = await ask(suggestions)
    expect(asked).toMatchObject({ alternate: 'always-allow', alwaysScope: 'npm test', alwaysRules: ['npm test:*'] })
    expect(answer).toMatchObject({ behavior: 'allow', updatedPermissions: suggestions })
  })

  it('names every rule it would add', async () => {
    const { request: asked } = await ask([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Bash', ruleContent: 'git push:*' }], behavior: 'allow', destination: 'session' }
    ])
    expect(asked).toMatchObject({ alwaysScope: 'npm test, git push', alwaysRules: ['npm test:*', 'git push:*'] })
  })

  it('names a fetch’s domain and a folder, with no command rules', async () => {
    const { request: asked } = await ask(
      [
        { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:github.com' }], behavior: 'allow', destination: 'session' },
        { type: 'addDirectories', directories: ['/data/shared'], destination: 'session' }
      ],
      'WebFetch',
      { url: 'https://github.com/x' }
    )
    expect(asked.alwaysScope).toBe('github.com, /data/shared')
    expect(asked).not.toHaveProperty('alwaysRules')
  })

  it('a mode change alone names nothing, and an edit never carries a scope', async () => {
    const { request: mode } = await ask([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    expect(mode).toMatchObject({ alternate: 'always-allow' })
    expect(mode).not.toHaveProperty('alwaysScope')
    sdk.query.mockReset()
    const { request: edit } = await ask([{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }], 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })
    expect(edit).toMatchObject({ alternate: 'edits-for-session' })
    expect(edit).not.toHaveProperty('alwaysScope')
  })
})

describe('a project’s run that doesn’t publish (docs/ai-employees.md §15)', () => {
  const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u1', session_id: 's1', transcript_path: '', cwd: '/repo' })
  const refusal = 'Foreman refused this: only the part “Open the PR” (pr) pushes.'

  it('refuses a shell command that pushes or opens a pull request with the project’s words, and leaves other commands to the mode', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...request, employee: true, noPublish: refusal }, callbacks()).run()
    const options = sdk.query.mock.calls[0][0].options
    const hook = options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    for (const command of ['git push -u origin HEAD', 'gh pr create --fill', 'npm test && gh pr merge 3']) {
      expect(await hook(pre('Bash', { command }), 'u1', { signal })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal } })
    }
    expect(await hook(pre('Bash', { command: 'git status' }), 'u1', { signal })).toEqual({})
    expect(await hook(pre('Edit', { file_path: '/repo/a.ts' }), 'u1', { signal })).toEqual({})
    // Should one reach the permission prompt past the hook, it is refused there too.
    expect(await options.canUseTool('Bash', { command: 'git push' }, { signal })).toEqual({ behavior: 'deny', message: refusal })
    claude.push(result)
    await run
  })

  it('adds no hook to a run that may publish', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...request, employee: true }, callbacks()).run()
    expect(sdk.query.mock.calls[0][0].options.hooks).toBeUndefined()
    claude.push(result)
    await run
  })
})

describe('an AI employee’s read-only run without a shell (docs/ai-employees.md §9)', () => {
  const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u1', session_id: 's1', transcript_path: '', cwd: '/repo' })

  it('refuses every shell command, read-only ones too, in plan mode, and leaves reading to the mode', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...request, employee: true, readOnly: true, planMode: true, noShell: true }, callbacks()).run()
    const options = sdk.query.mock.calls[0][0].options
    expect(options.permissionMode).toBe('plan')
    const hook = options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    const refused = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_SHELL_REFUSAL } }
    expect(await hook(pre('Bash', { command: 'git status' }), 'u1', { signal })).toEqual(refused)
    expect(await hook(pre('Bash', { command: 'ls -la' }), 'u1', { signal })).toEqual(refused)
    expect(await hook(pre('PowerShell', { command: 'Get-ChildItem' }), 'u1', { signal })).toEqual(refused)
    expect(await hook(pre('Read', { file_path: '/repo/a.ts' }), 'u1', { signal })).toEqual({})
    expect(await hook(pre('Grep', { pattern: 'x' }), 'u1', { signal })).toEqual({})
    // Should one reach the permission prompt past the hook, it is refused there too.
    expect(await options.canUseTool('Bash', { command: 'cat a.ts' }, { signal })).toEqual({ behavior: 'deny', message: NO_SHELL_REFUSAL })
    claude.push(result)
    await run
  })

  it('adds no shell hook to a read-only run with a shell', async () => {
    const claude = fakeClaude()
    const run = claudeDriver.createTurn({ ...request, employee: true, readOnly: true, planMode: true }, callbacks()).run()
    expect(sdk.query.mock.calls[0][0].options.hooks).toBeUndefined()
    claude.push(result)
    await run
  })
})
