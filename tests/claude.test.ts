import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'

// No Claude Code here: `query` is replaced by a fake whose messages each test pushes in.
const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

/** A Claude Code stand-in: the test pushes its messages and sees when the input is closed. */
function fakeClaude() {
  const queued: SDKMessage[] = []
  let wake: (() => void) | null = null
  let ended = false
  const state = { inputClosed: false, prompts: [] as SDKUserMessage[] }

  sdk.query.mockImplementation(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    void (async () => {
      for await (const message of prompt) state.prompts.push(message)
      state.inputClosed = true
      // Like Claude Code, the process exits once its input is closed.
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
