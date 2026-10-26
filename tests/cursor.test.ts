import type { ModelListItem, RunResult, SDKMessage } from '@cursor/sdk'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CursorStreamMapper, cursorDriver, modelSelection, toolView } from '../src/main/agents/cursor'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import type { ChatItem } from '../src/shared/types'

// No Cursor API key here: the SDK is replaced by fakes and nothing reaches Cursor.
const sdk = vi.hoisted(() => {
  class AgentNotFoundError extends Error {}
  class AuthenticationError extends Error {}
  return {
    Agent: { create: vi.fn(), resume: vi.fn() },
    Cursor: { models: { list: vi.fn() } },
    AgentNotFoundError,
    AuthenticationError
  }
})
vi.mock('@cursor/sdk', () => sdk)

const ids = { agent_id: 'agent-1', run_id: 'run-1' }

function text(t: string): SDKMessage {
  return { type: 'assistant', ...ids, message: { role: 'assistant', content: [{ type: 'text', text: t }] } }
}

function thinking(t: string, ms?: number): SDKMessage {
  return { type: 'thinking', ...ids, text: t, ...(ms !== undefined ? { thinking_duration_ms: ms } : {}) }
}

function tool(callId: string, name: string, status: 'running' | 'completed' | 'error', args?: unknown, result?: unknown): SDKMessage {
  return { type: 'tool_call', ...ids, call_id: callId, name, status, args, ...(result !== undefined ? { result } : {}) }
}

function usage(inputTokens: number, outputTokens: number): SDKMessage {
  return { type: 'usage', ...ids, usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens } }
}

function mapper() {
  const persisted: ChatItem[] = []
  const transient: ChatItem[] = []
  const m = new CursorStreamMapper('t1', '/repo', (item, isTransient) => (isTransient ? transient : persisted).push(item))
  return { m, persisted, transient }
}

function fakeRun(messages: SDKMessage[], result: Partial<RunResult> = {}) {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    stream: async function* () {
      yield* messages
    },
    wait: vi.fn(async () => ({ id: 'run-1', status: 'finished', durationMs: 1200, ...result })),
    cancel: vi.fn(async () => undefined)
  }
}

function fakeAgent(run: unknown, agentId = 'agent-1') {
  return { agentId, send: vi.fn<(message: string, options?: unknown) => Promise<unknown>>(async () => run), close: vi.fn() }
}

function callbacks() {
  const items: { item: ChatItem; transient?: boolean }[] = []
  const cb = {
    item: (item: ChatItem, transient?: boolean) => items.push({ item, transient }),
    sessionStarted: vi.fn(),
    assistantMessage: vi.fn(),
    approveTool: vi.fn(),
    reviewPlan: vi.fn(),
    ask: vi.fn(),
    planModeChanged: vi.fn(),
    autoAcceptEdits: vi.fn(),
    usage: vi.fn(),
    finished: vi.fn()
  }
  const persisted = () => items.filter((i) => !i.transient).map((i) => i.item)
  return { cb: cb as unknown as TurnCallbacks & typeof cb, persisted }
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: 't1',
    prompt: 'Fix the bug',
    cwd: '/repo',
    env: { CURSOR_API_KEY: 'key' },
    model: 'auto',
    fastMode: false,
    planMode: false,
    approvals: 'never-ask',
    systemPromptAppend: 'Work in /repo.',
    ...overrides
  }
}

describe('cursor stream mapping', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('streams text deltas as previews, then persists one item with the same id', () => {
    vi.useFakeTimers()
    const { m, persisted, transient } = mapper()
    m.handle(text('Hel'))
    m.handle(text('lo'))
    vi.advanceTimersByTime(60)
    expect(transient).toEqual([{ kind: 'assistant', id: 't1:assistant:0', turnId: 't1', text: 'Hello', streaming: true }])
    expect(persisted).toEqual([])

    m.handle(tool('c1', 'read', 'running', { path: 'src/a.ts' }))
    expect(persisted[0]).toEqual({ kind: 'assistant', id: 't1:assistant:0', turnId: 't1', text: 'Hello' })
    m.handle(text('Next'))
    m.finish(false)
    expect(persisted.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant', 'tool'])
    expect(persisted[2]).toMatchObject({ id: 't1:assistant:1', text: 'Next' })
    expect(persisted[3]).toMatchObject({ name: 'Read', status: 'error', output: 'No result.' })
  })

  it('keeps thinking separate from text and ends it on completion', () => {
    const { m, persisted } = mapper()
    m.handle(thinking('Let me'))
    m.handle(thinking(' look'))
    m.handle(thinking('', 900))
    m.handle(text('Done.'))
    m.finish(false)
    expect(persisted).toEqual([
      { kind: 'thinking', id: 't1:thinking:0', turnId: 't1', text: 'Let me look' },
      { kind: 'assistant', id: 't1:assistant:1', turnId: 't1', text: 'Done.' }
    ])
  })

  it('drops whitespace-only text blocks', () => {
    const { m, persisted } = mapper()
    m.handle(text('\n'))
    m.handle(tool('c1', 'shell', 'running', { command: 'ls' }))
    expect(persisted.map((i) => i.kind)).toEqual(['tool'])
  })

  it('maps a shell call to Bash and fills in its output', () => {
    const { m, persisted } = mapper()
    m.handle(tool('c1', 'shell', 'running', { command: 'npm test' }))
    m.handle(
      tool('c1', 'shell', 'completed', { command: 'npm test' }, { status: 'success', value: { exitCode: 0, signal: '', stdout: 'ok\n', stderr: '', executionTime: 5 } })
    )
    m.handle(
      tool('c2', 'shell', 'completed', { command: 'false' }, { status: 'success', value: { exitCode: 1, signal: '', stdout: '', stderr: 'boom', executionTime: 5 } })
    )
    expect(persisted).toEqual([
      { kind: 'tool', id: 't1:c1', turnId: 't1', name: 'Bash', input: { command: 'npm test' }, status: 'running' },
      { kind: 'tool', id: 't1:c1', turnId: 't1', name: 'Bash', input: { command: 'npm test' }, status: 'done', output: 'ok\n' },
      { kind: 'tool', id: 't1:c2', turnId: 't1', name: 'Bash', input: { command: 'false' }, status: 'error', output: 'boom\nExit code 1' }
    ])
  })

  it('reports tool errors and interrupted calls', () => {
    const { m, persisted } = mapper()
    m.handle(tool('c1', 'read', 'error', { path: 'missing.ts' }, { status: 'error', error: { message: 'File not found' } }))
    m.handle(tool('c2', 'grep', 'running', { pattern: 'TODO' }))
    m.finish(true)
    expect(persisted[0]).toMatchObject({ name: 'Read', status: 'error', output: 'File not found' })
    expect(persisted.at(-1)).toMatchObject({ id: 't1:c2', name: 'Grep', status: 'error', output: 'Interrupted.' })
  })

  it('shows argument updates without persisting them', () => {
    const { m, persisted, transient } = mapper()
    m.handle(tool('c1', 'edit', 'running', {}))
    m.handle(tool('c1', 'edit', 'running', { path: 'a.ts' }))
    m.handle(tool('c1', 'edit', 'running', { path: 'a.ts' }))
    expect(persisted).toHaveLength(1)
    expect(transient).toEqual([{ kind: 'tool', id: 't1:c1', turnId: 't1', name: 'Edit', input: { file_path: path.resolve('/repo/a.ts') }, status: 'running' }])
  })

  it('formats grep, glob, read and mcp results', () => {
    const { m, persisted } = mapper()
    const grep = {
      status: 'success',
      value: { workspaceResults: { '/repo': { type: 'content', output: { matches: [{ file: 'a.ts', lineNumber: 3, line: 'x()' }], totalMatches: 1 } } } }
    }
    m.handle(tool('c1', 'grep', 'completed', { pattern: 'x' }, grep))
    m.handle(tool('c2', 'glob', 'completed', { globPattern: '*.ts' }, { status: 'success', value: { files: ['a.ts', 'b.ts'], totalFiles: 2 } }))
    m.handle(tool('c3', 'read', 'completed', { path: 'a.ts' }, { status: 'success', value: { content: 'one\ntwo', totalLines: 2, fileSize: 7 } }))
    m.handle(
      tool('c4', 'mcp', 'completed', { providerIdentifier: 'linear', toolName: 'get_issue', args: { id: 'A-1' } }, {
        status: 'success',
        value: { content: [{ text: { text: 'Issue A-1' } }], isError: false }
      })
    )
    expect(persisted.map((i) => (i.kind === 'tool' ? [i.name, i.output] : []))).toEqual([
      ['Grep', 'a.ts:3:x()'],
      ['Glob', 'a.ts\nb.ts'],
      ['Read', 'one\ntwo'],
      ['mcp__linear__get_issue', 'Issue A-1']
    ])
  })

  it('notes a compacted conversation once', () => {
    const { m, persisted } = mapper()
    m.handle({ type: 'task', ...ids, text: 'Summary of earlier work' })
    m.handle({ type: 'task', ...ids, text: 'Another summary' })
    // O1 (G1): drawn as a divider.
    expect(persisted).toEqual([{ kind: 'notice', id: 't1:notice:0', turnId: 't1', level: 'info', text: 'Conversation compacted to free up context.', divider: { kind: 'compact' } }])
  })
})

describe('cursor tool names', () => {
  it('uses Claude Code names and absolute paths where the meaning matches', () => {
    expect(toolView('read', { path: 'src/a.ts' }, undefined, '/repo')).toEqual({ name: 'Read', input: { file_path: path.resolve('/repo/src/a.ts') } })
    expect(toolView('read', { path: '/abs/b.ts' }, undefined, '/repo')).toEqual({ name: 'Read', input: { file_path: path.resolve('/abs/b.ts') } })
    expect(toolView('write', { path: 'n.ts', fileText: 'x' }, undefined, '/repo')).toEqual({ name: 'Write', input: { file_path: path.resolve('/repo/n.ts'), content: 'x' } })
    expect(toolView('grep', { pattern: 'foo', path: 'src' }, undefined, '/repo')).toEqual({ name: 'Grep', input: { pattern: 'foo', path: path.resolve('/repo/src') } })
    expect(toolView('glob', { globPattern: '**/*.ts' }, undefined, '/repo')).toEqual({ name: 'Glob', input: { pattern: '**/*.ts' } })
    expect(toolView('task', { description: 'Explore', prompt: 'Look around' }, undefined, '/repo')).toEqual({
      name: 'Task',
      input: { description: 'Explore', prompt: 'Look around' }
    })
    expect(toolView('semSearch', { query: 'auth' }, undefined, '/repo')).toEqual({ name: 'semSearch', input: { query: 'auth' } })
  })

  it('maps todos to TodoWrite with Claude statuses', () => {
    const todos = [
      { content: 'Read code', status: 'completed' },
      { content: 'Fix bug', status: 'inProgress' },
      { content: 'Test', status: 'pending' }
    ]
    expect(toolView('updateTodos', { todos }, undefined, '/repo')).toEqual({
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Read code', status: 'completed' },
          { content: 'Fix bug', status: 'in_progress' },
          { content: 'Test', status: 'pending' }
        ]
      }
    })
  })

  it('turns an edit diff into old and new text', () => {
    const result = { status: 'success', value: { linesAdded: 1, linesRemoved: 1, diffString: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old line\n+new line' } }
    expect(toolView('edit', { path: 'a.ts' }, result, '/repo')).toEqual({
      name: 'Edit',
      input: { file_path: path.resolve('/repo/a.ts'), old_string: 'old line', new_string: 'new line' }
    })
  })
})

describe('cursor model selection', () => {
  const catalog: ModelListItem[] = [
    { id: 'auto', displayName: 'Auto' },
    {
      id: 'grok-4.7',
      displayName: 'Grok 4.7',
      parameters: [
        { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }, { value: 'extra_high', displayName: 'Extra high' }] },
        { id: 'fast', values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }] }
      ]
    },
    { id: 'composer-2.5', displayName: 'Composer 2.5', parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }] },
    { id: 'claude-x', displayName: 'Claude X', parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }] }
  ]

  it("lets Cursor choose when the model is 'auto' or empty", () => {
    expect(modelSelection('', undefined, false)).toEqual({ id: 'auto' })
    expect(modelSelection('auto', 'high', true, catalog)).toEqual({ id: 'auto' })
  })

  it('falls back to Cursor Router when the account has no plain Auto', () => {
    const router: ModelListItem[] = [
      { id: 'auto-smart', displayName: 'Auto', parameters: [{ id: 'optimize_for', values: [{ value: 'cost' }, { value: 'balanced' }, { value: 'intelligence' }] }] }
    ]
    expect(modelSelection('auto', undefined, false, router)).toEqual({ id: 'auto-smart', params: [{ id: 'optimize_for', value: 'balanced' }] })
  })

  it('passes effort and fast as model parameters when the model takes them', () => {
    expect(modelSelection('grok-4.7', 'xhigh', true, catalog)).toEqual({
      id: 'grok-4.7',
      params: [
        { id: 'reasoning_effort', value: 'extra_high' },
        { id: 'fast', value: 'true' }
      ]
    })
    expect(modelSelection('composer-2.5', undefined, false, catalog)).toEqual({ id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] })
    // Fast is only forced off where the app offers the toggle.
    expect(modelSelection('claude-x', 'high', false, catalog)).toEqual({ id: 'claude-x' })
    expect(modelSelection('unlisted', 'high', true, catalog)).toEqual({ id: 'unlisted' })
  })
})

describe('cursor driver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.Cursor.models.list.mockResolvedValue([])
  })

  it('asks for an API key when none is configured', async () => {
    const { cb, persisted } = callbacks()
    await cursorDriver.createTurn(request({ env: {} }), cb).run()
    expect(persisted()).toEqual([
      { kind: 'notice', id: 't1:notice:0', turnId: 't1', level: 'error', text: 'Add a Cursor API key in Settings › Agents › Cursor.', action: 'open-settings' }
    ])
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'Add a Cursor API key in Settings › Agents › Cursor.' })
    expect(sdk.Agent.create).not.toHaveBeenCalled()
  })

  it('runs a new local agent and maps the run', async () => {
    const run = fakeRun([
      text('Looking.'),
      tool('c1', 'shell', 'running', { command: 'ls' }),
      tool('c1', 'shell', 'completed', { command: 'ls' }, { status: 'success', value: { exitCode: 0, signal: '', stdout: 'a.ts', stderr: '', executionTime: 1 } }),
      text('Found a.ts.'),
      usage(1000, 200)
    ])
    const agent = fakeAgent(run)
    sdk.Agent.create.mockResolvedValue(agent)
    const { cb, persisted } = callbacks()
    await cursorDriver.createTurn(request(), cb).run()

    expect(sdk.Agent.create).toHaveBeenCalledWith({ apiKey: 'key', model: { id: 'auto' }, local: { cwd: '/repo' } })
    expect(agent.send).toHaveBeenCalledWith('<instructions>\nWork in /repo.\n</instructions>\n\nFix the bug', { mode: 'agent' })
    expect(cb.sessionStarted).toHaveBeenCalledWith('agent-1')
    expect(persisted().map((i) => i.kind)).toEqual(['assistant', 'tool', 'tool', 'assistant', 'result'])
    expect(persisted().at(-1)).toMatchObject({ kind: 'result', ok: true, durationMs: 1200 })
    expect(cb.usage).toHaveBeenCalledWith({ used: 1200, limit: 200_000 })
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
    expect(agent.close).toHaveBeenCalled()
  })

  it('resumes the conversation without repeating the instructions', async () => {
    const agent = fakeAgent(fakeRun([text('Again.')]))
    sdk.Agent.resume.mockResolvedValue(agent)
    const { cb } = callbacks()
    await cursorDriver.createTurn(request({ resume: 'agent-1', model: 'composer-2.5', fastMode: true }), cb).run()
    expect(sdk.Agent.resume).toHaveBeenCalledWith('agent-1', expect.objectContaining({ apiKey: 'key', local: { cwd: '/repo' } }))
    expect(sdk.Agent.create).not.toHaveBeenCalled()
    expect(agent.send).toHaveBeenCalledWith('Fix the bug', { mode: 'agent' })
    expect(cb.sessionStarted).toHaveBeenCalledWith('agent-1')
  })

  it('starts over when the previous conversation is gone', async () => {
    sdk.Agent.resume.mockRejectedValue(new sdk.AgentNotFoundError('not found'))
    const agent = fakeAgent(fakeRun([]), 'agent-2')
    sdk.Agent.create.mockResolvedValue(agent)
    const { cb, persisted } = callbacks()
    await cursorDriver.createTurn(request({ resume: 'agent-1' }), cb).run()
    expect(cb.sessionStarted).toHaveBeenCalledWith('agent-2')
    expect(agent.send.mock.calls[0][0]).toContain('<instructions>')
    expect(persisted()[0]).toMatchObject({ kind: 'notice', level: 'info' })
  })

  it('points auth failures at settings', async () => {
    const agent = fakeAgent(null)
    agent.send.mockRejectedValue(new Error('401 Unauthorized: invalid API key'))
    sdk.Agent.create.mockResolvedValue(agent)
    const { cb, persisted } = callbacks()
    await cursorDriver.createTurn(request(), cb).run()
    expect(persisted()).toEqual([
      { kind: 'notice', id: 't1:notice:0', turnId: 't1', level: 'error', text: '401 Unauthorized: invalid API key', action: 'open-settings' }
    ])
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: '401 Unauthorized: invalid API key' })
  })

  it('reports a failed run', async () => {
    sdk.Agent.create.mockResolvedValue(fakeAgent(fakeRun([text('Trying.')], { status: 'error', error: { message: 'Model overloaded' } })))
    const { cb, persisted } = callbacks()
    await cursorDriver.createTurn(request(), cb).run()
    expect(persisted().slice(-2)).toEqual([
      { kind: 'result', id: 'result:t1:0', turnId: 't1', ok: false, durationMs: 1200 },
      { kind: 'notice', id: 't1:notice:1', turnId: 't1', level: 'error', text: 'Model overloaded', action: undefined }
    ])
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(cb.finished).toHaveBeenCalledWith({ ok: false, error: 'Model overloaded' })
  })

  it('stops a running turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const run = {
      ...fakeRun([], { status: 'cancelled' }),
      stream: async function* () {
        yield tool('c1', 'shell', 'running', { command: 'sleep 60' })
        await gate
      },
      cancel: vi.fn(async () => release())
    }
    sdk.Agent.create.mockResolvedValue(fakeAgent(run))
    const { cb, persisted } = callbacks()
    const turn = cursorDriver.createTurn(request(), cb)
    const done = turn.run()
    await vi.waitFor(() => expect(persisted().some((i) => i.kind === 'tool')).toBe(true))
    await turn.stop()
    await done
    expect(run.cancel).toHaveBeenCalled()
    expect(persisted().map((i) => (i.kind === 'notice' ? i.text : i.kind === 'tool' ? i.output ?? i.status : i.kind))).toEqual([
      'running',
      'Stopped.',
      'Interrupted.'
    ])
    expect(cb.finished).toHaveBeenCalledTimes(1)
    expect(turn.steer('more')).toBe(false)
  })

  it('maps approval policies to what the SDK supports', async () => {
    sdk.Agent.create.mockResolvedValue(fakeAgent(fakeRun([])))
    const auto = callbacks()
    await cursorDriver.createTurn(request({ approvals: 'auto' }), auto.cb).run()
    expect(sdk.Agent.create).toHaveBeenLastCalledWith(expect.objectContaining({ local: { cwd: '/repo', autoReview: true } }))

    const ask = callbacks()
    await cursorDriver.createTurn(request({ approvals: 'ask' }), ask.cb).run()
    expect(ask.persisted()[0]).toMatchObject({ kind: 'notice', level: 'info' })
    expect(ask.cb.approveTool).not.toHaveBeenCalled()
  })

  it('reports status from the configured key', async () => {
    expect(await cursorDriver.status({ CURSOR_API_KEY: 'key' })).toEqual({
      agent: 'cursor',
      installed: true,
      ready: true,
      method: 'API key',
      detail: undefined
    })
    expect(await cursorDriver.status({})).toEqual({
      agent: 'cursor',
      installed: true,
      ready: false,
      method: undefined,
      detail: 'No Cursor API key configured'
    })
    expect(sdk.Cursor.models.list).not.toHaveBeenCalled()
  })
})
