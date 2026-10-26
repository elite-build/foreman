import * as acp from '@agentclientprotocol/sdk'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAcpDriver, listAcpModels, type AcpAgentConfig, type AcpConnector } from '../src/main/agents/acp'
import { opencodeDriver } from '../src/main/agents/opencode'
import type { ToolApprovalRequest, TurnCallbacks, TurnRequest, TurnResult } from '../src/main/agents/types'
import type { ApprovalResponse, ChatItem, ContextUsage } from '../src/shared/types'
import { tempDir } from './helpers'

type Send = (update: acp.SessionUpdate) => Promise<void>
interface FakeTurn {
  sessionId: string
  client: acp.AgentContext
  send: Send
  askPermission(toolCall: acp.ToolCallUpdate): Promise<acp.RequestPermissionOutcome>
  cancelled: Promise<void>
}
interface FakeLog {
  methods: string[]
  prompts: acp.ContentBlock[][]
  configs: { configId: string; value: unknown }[]
  permissions: acp.RequestPermissionOutcome[]
  cancelled: boolean
  results: unknown[]
}

const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
]

let workspace = ''
let outside = ''

beforeAll(async () => {
  workspace = await tempDir('switchyard-acp-')
  outside = await tempDir('switchyard-acp-outside-')
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n')
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await sleep(10)
  }
}

function configOptions(model = 'anthropic/claude-sonnet', effort = 'default'): acp.SessionConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'anthropic/claude-sonnet', name: 'anthropic/Claude Sonnet' },
        { value: 'openai/gpt-5', name: 'openai/GPT-5' }
      ]
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: effort,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'high', name: 'High' }
      ]
    }
  ]
}

/** An in-process ACP agent that runs `prompt` for each turn. */
function fakeAgent(options: { prompt?: (turn: FakeTurn, log: FakeLog) => Promise<acp.StopReason>; loadSession?: boolean; failNew?: Error; failLoad?: Error } = {}) {
  const log: FakeLog = { methods: [], prompts: [], configs: [], permissions: [], cancelled: false, results: [] }
  let onCancel = () => {}
  const app = acp
    .agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, () => {
      log.methods.push('initialize')
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: options.loadSession ?? true } }
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      log.methods.push('session/new')
      expect(params.mcpServers).toEqual([])
      if (options.failNew) throw options.failNew
      return { sessionId: 'sess-1', configOptions: configOptions() }
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      log.methods.push('session/load')
      if (options.failLoad) throw options.failLoad
      // Loading replays the earlier conversation.
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' } }
      })
      return { configOptions: configOptions() }
    })
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
      log.configs.push({ configId: params.configId, value: params.value })
      return { configOptions: configOptions() }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      log.prompts.push(params.prompt)
      const cancelled = new Promise<void>((resolve) => (onCancel = resolve))
      const send: Send = (update) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update })
      const askPermission = async (toolCall: acp.ToolCallUpdate) => {
        const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall,
          options: PERMISSION_OPTIONS
        })
        log.permissions.push(outcome)
        return outcome
      }
      const stopReason = await (options.prompt ?? standardTurn)({ sessionId: params.sessionId, client, send, askPermission, cancelled }, log)
      return { stopReason }
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      log.cancelled = true
      onCancel()
    })
  return { app, log }
}

/** Streams thinking and text, runs a command after asking, updates a plan and ends. */
async function standardTurn(turn: FakeTurn): Promise<acp.StopReason> {
  const { send } = turn
  await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking at the tests.' } })
  await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running ' } })
  // Long enough for a streaming preview to go out.
  await sleep(120)
  await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the tests.' } })
  await send({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'npm test',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'npm test', description: 'Run tests' }
  })
  const outcome = await turn.askPermission({ toolCallId: 'call-1' })
  const allowed = outcome.outcome === 'selected' && outcome.optionId.startsWith('allow')
  await send({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: allowed ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text: allowed ? '12 passed' : 'Rejected by the user' } }]
  })
  await send({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Run tests', priority: 'high', status: 'completed' },
      { content: 'Fix failures', priority: 'medium', status: 'in_progress' }
    ]
  })
  await send({
    sessionUpdate: 'plan',
    entries: [
      { content: 'Run tests', priority: 'high', status: 'completed' },
      { content: 'Fix failures', priority: 'medium', status: 'completed' }
    ]
  })
  await send({ sessionUpdate: 'usage_update', used: 1200, size: 200_000, cost: { amount: 0.05, currency: 'USD' } })
  await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All green.' } })
  return 'end_turn'
}

function inProcess(app: acp.AgentApp): AcpConnector {
  return () => {
    const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
    const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>()
    const conn = app.connect({ readable: toAgent.readable, writable: toClient.writable })
    return {
      stream: { readable: toClient.readable, writable: toAgent.writable },
      failure: () => ({ stderr: '' }),
      close: async () => conn.close()
    }
  }
}

function driverFor(app: acp.AgentApp, extra: Partial<AcpAgentConfig> = {}) {
  return createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'unused', args: [] }), connect: inProcess(app), ...extra })
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: 'turn-1',
    prompt: 'Fix the tests',
    cwd: workspace,
    env: {},
    model: '',
    fastMode: false,
    planMode: false,
    approvals: 'ask',
    systemPromptAppend: 'You are in a Foreman workspace.',
    ...overrides
  }
}

type ToolAnswer = Extract<ApprovalResponse, { kind: 'tool' }>

function recorder(answer: (request: ToolApprovalRequest) => Omit<ToolAnswer, 'kind'> = () => ({ allow: true })) {
  const items: { item: ChatItem; transient: boolean }[] = []
  const calls = {
    sessionStarted: [] as string[],
    finished: 0,
    results: [] as TurnResult[],
    approvals: [] as ToolApprovalRequest[],
    usage: [] as ContextUsage[],
    autoAcceptEdits: [] as boolean[]
  }
  const cb: TurnCallbacks = {
    item: (item, transient) => void items.push({ item, transient: Boolean(transient) }),
    sessionStarted: (id) => void calls.sessionStarted.push(id),
    assistantMessage: () => {},
    approveTool: async (req) => {
      calls.approvals.push(req)
      return { kind: 'tool', ...answer(req) }
    },
    reviewPlan: async () => ({ kind: 'plan', approve: true }),
    ask: async () => ({ kind: 'question', skipped: true }),
    planModeChanged: () => {},
    autoAcceptEdits: (on) => void calls.autoAcceptEdits.push(on),
    usage: (usage) => void calls.usage.push(usage),
    finished: (result) => {
      calls.finished++
      calls.results.push(result)
    }
  }
  // The chat as persisted: the last non-transient version of each item, in first-seen order.
  const persisted = (): ChatItem[] => {
    const byId = new Map<string, ChatItem>()
    for (const { item, transient } of items) if (!transient) byId.set(item.id, item)
    return [...byId.values()]
  }
  const find = <K extends ChatItem['kind']>(kind: K) => persisted().filter((i): i is Extract<ChatItem, { kind: K }> => i.kind === kind)
  return { cb, items, calls, persisted, find }
}

describe('ACP driver', () => {
  it('streams a turn into chat items and approves tools itself in never-ask mode', async () => {
    const { app, log } = fakeAgent()
    const rec = recorder()
    await driverFor(app).createTurn(request({ approvals: 'never-ask' }), rec.cb).run()

    expect(rec.calls.sessionStarted).toEqual(['sess-1'])
    expect(rec.calls.approvals).toEqual([])
    expect(log.permissions).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
    expect(rec.calls.finished).toBe(1)
    expect(rec.calls.results).toEqual([{ ok: true }])
    expect(rec.calls.usage).toEqual([{ used: 1200, limit: 200_000 }])

    // The system prompt rides along with the first message, for the model only.
    expect(log.prompts[0]).toEqual([
      { type: 'text', text: 'You are in a Foreman workspace.', annotations: { audience: ['assistant'] } },
      { type: 'text', text: 'Fix the tests' }
    ])

    expect(rec.persisted().map((i) => [i.kind, i.id])).toEqual([
      ['thinking', 'turn-1:thinking:0'],
      ['assistant', 'turn-1:assistant:1'],
      ['tool', 'turn-1:call-1'],
      ['tool', 'turn-1:todos'],
      ['assistant', 'turn-1:assistant:2'],
      ['result', expect.stringMatching(/^result:turn-1:/)]
    ])
    const [thinking, running] = rec.persisted()
    expect(thinking).toMatchObject({ kind: 'thinking', text: 'Looking at the tests.', streaming: false })
    expect(running).toMatchObject({ kind: 'assistant', text: 'Running the tests.', streaming: false })
    // The streaming preview used the same id as the final message.
    expect(rec.items).toContainEqual({
      item: { kind: 'assistant', id: 'turn-1:assistant:1', turnId: 'turn-1', text: 'Running ', streaming: true },
      transient: true
    })

    expect(rec.find('tool')[0]).toEqual({
      kind: 'tool',
      id: 'turn-1:call-1',
      turnId: 'turn-1',
      name: 'Bash',
      input: { command: 'npm test', description: 'Run tests' },
      status: 'done',
      output: '12 passed'
    })
    const todoVersions = rec.items.filter(({ item }) => item.id === 'turn-1:todos')
    expect(todoVersions).toHaveLength(2)
    expect(rec.find('tool')[1]).toMatchObject({
      name: 'TodoWrite',
      status: 'done',
      input: {
        todos: [
          { content: 'Run tests', status: 'completed' },
          { content: 'Fix failures', status: 'completed' }
        ]
      }
    })
    expect(rec.find('result')[0]).toMatchObject({ ok: true, costUsd: 0.05, turnId: 'turn-1' })
    expect(rec.find('notice')).toEqual([])
  })

  it('routes permission requests to the user otherwise', async () => {
    const { app, log } = fakeAgent()
    const rec = recorder(() => ({ allow: false }))
    await driverFor(app).createTurn(request({ approvals: 'ask' }), rec.cb).run()

    expect(rec.calls.approvals).toEqual([
      { kind: 'tool', toolName: 'Bash', input: { command: 'npm test', description: 'Run tests' }, alternate: 'always-allow' }
    ])
    expect(log.permissions).toEqual([{ outcome: 'selected', optionId: 'reject-once' }])
    expect(rec.find('tool')[0]).toMatchObject({ name: 'Bash', status: 'error', output: 'Rejected by the user' })

    // "Always" answers pick the agent's allow-always option.
    const always = fakeAgent()
    await driverFor(always.app).createTurn(request(), recorder(() => ({ allow: true, alternate: true })).cb).run()
    expect(always.log.permissions).toEqual([{ outcome: 'selected', optionId: 'allow-always' }])
  })

  it('approves edits itself in ask-except-edits mode but still asks about commands', async () => {
    const { app, log } = fakeAgent({
      prompt: async (turn) => {
        await turn.send({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit app.ts', kind: 'edit', status: 'pending', locations: [{ path: 'src/app.ts' }] })
        await turn.askPermission({ toolCallId: 'edit-1' })
        await turn.send({ sessionUpdate: 'tool_call', toolCallId: 'run-1', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } })
        await turn.askPermission({ toolCallId: 'run-1' })
        return 'end_turn'
      }
    })
    const rec = recorder()
    await driverFor(app).createTurn(request({ approvals: 'ask-except-edits' }), rec.cb).run()
    expect(rec.calls.approvals.map((a) => a.toolName)).toEqual(['Bash'])
    expect(log.permissions).toEqual([
      { outcome: 'selected', optionId: 'allow-once' },
      { outcome: 'selected', optionId: 'allow-once' }
    ])
  })

  it('maps ACP tool kinds onto the tool names the chat renders', async () => {
    const file = (name: string) => path.join(workspace, name)
    const { app } = fakeAgent({
      prompt: async ({ send }) => {
        await send({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read a.ts', kind: 'read', status: 'completed', locations: [{ path: 'src/a.ts' }], content: [{ type: 'content', content: { type: 'text', text: 'line 1\nline 2' } }] })
        await send({
          sessionUpdate: 'tool_call',
          toolCallId: 'edit',
          title: 'Edit b.ts',
          kind: 'edit',
          status: 'in_progress',
          locations: [{ path: file('b.ts') }],
          content: [{ type: 'diff', path: file('b.ts'), oldText: 'old', newText: 'new' }]
        })
        await send({ sessionUpdate: 'tool_call', toolCallId: 'write', title: 'c.ts', name: 'write', kind: 'edit', status: 'completed', rawInput: { filePath: file('c.ts'), content: 'hello\n' } })
        await send({ sessionUpdate: 'tool_call', toolCallId: 'grep', title: 'TODO', name: 'grep', kind: 'search', status: 'completed', rawInput: { pattern: 'TODO', path: 'src' } })
        await send({ sessionUpdate: 'tool_call', toolCallId: 'glob', title: '**/*.ts', name: 'glob', kind: 'search', status: 'completed', rawInput: { pattern: '**/*.ts' } })
        await send({ sessionUpdate: 'tool_call', toolCallId: 'fetch', title: 'https://example.com', kind: 'fetch', status: 'failed', rawInput: { url: 'https://example.com' }, rawOutput: { error: 'offline' } })
        await send({ sessionUpdate: 'tool_call', toolCallId: 'other', title: 'lsp_diagnostics', kind: 'other', status: 'completed', locations: [{ path: 'src/d.ts' }], rawInput: { severity: 'error' } })
        await send({ sessionUpdate: 'tool_call', toolCallId: 'todo', title: 'todowrite', name: 'todowrite', kind: 'other', status: 'completed', rawInput: { todos: [{ content: 'Ship it', status: 'pending', priority: 'high' }] } })
        // Edits arrive while the turn ends; it is closed out as unfinished.
        return 'end_turn'
      }
    })
    const rec = recorder()
    await driverFor(app).createTurn(request(), rec.cb).run()
    const tools = Object.fromEntries(rec.find('tool').map((t) => [t.id.replace('turn-1:', ''), t]))

    expect(tools.read).toMatchObject({ name: 'Read', input: { file_path: file('src/a.ts') }, status: 'done', output: 'line 1\nline 2' })
    expect(tools.edit).toMatchObject({ name: 'Edit', input: { file_path: file('b.ts'), old_string: 'old', new_string: 'new' }, status: 'error', output: 'No result.' })
    expect(tools.write).toMatchObject({ name: 'Write', input: { file_path: file('c.ts'), content: 'hello\n' } })
    expect(tools.grep).toMatchObject({ name: 'Grep', input: { pattern: 'TODO', path: 'src' } })
    expect(tools.glob).toMatchObject({ name: 'Glob', input: { pattern: '**/*.ts' } })
    expect(tools.fetch).toMatchObject({ name: 'WebFetch', input: { url: 'https://example.com' }, status: 'error', output: 'offline' })
    expect(tools.other).toMatchObject({ name: 'lsp_diagnostics', input: { severity: 'error', file_path: file('src/d.ts') } })
    // The agent's todo tool becomes the todo card.
    expect(tools.todo).toBeUndefined()
    expect(tools.todos).toMatchObject({ name: 'TodoWrite', input: { todos: [{ content: 'Ship it', status: 'pending' }] } })
  })

  it('selects the model and effort through session config options', async () => {
    const { app, log } = fakeAgent()
    await driverFor(app).createTurn(request({ model: 'openai/gpt-5', effort: 'high', approvals: 'never-ask' }), recorder().cb).run()
    expect(log.configs).toEqual([
      { configId: 'model', value: 'openai/gpt-5' },
      { configId: 'effort', value: 'high' }
    ])

    // Unknown models keep the agent's default and say so.
    const other = fakeAgent()
    const rec = recorder()
    await driverFor(other.app).createTurn(request({ model: 'gemini-9', approvals: 'never-ask' }), rec.cb).run()
    expect(other.log.configs).toEqual([])
    expect(rec.find('notice')[0]).toMatchObject({ level: 'info', text: expect.stringContaining('gemini-9') })
  })

  it('resumes with session/load without replaying history or resending the system prompt', async () => {
    const { app, log } = fakeAgent()
    const rec = recorder()
    await driverFor(app).createTurn(request({ resume: 'sess-1', approvals: 'never-ask' }), rec.cb).run()
    expect(log.methods).toEqual(['initialize', 'session/load'])
    expect(rec.calls.sessionStarted).toEqual(['sess-1'])
    expect(log.prompts[0]).toEqual([{ type: 'text', text: 'Fix the tests' }])
    expect(rec.find('assistant').map((i) => i.text)).toEqual(['Running the tests.', 'All green.'])

    // A conversation the agent can't load starts over.
    const broken = fakeAgent({ failLoad: acp.RequestError.resourceNotFound('sess-9') })
    const rec2 = recorder()
    await driverFor(broken.app).createTurn(request({ resume: 'sess-9', approvals: 'never-ask' }), rec2.cb).run()
    expect(broken.log.methods).toEqual(['initialize', 'session/load', 'session/new'])
    expect(rec2.calls.sessionStarted).toEqual(['sess-1'])
    expect(broken.log.prompts[0]).toHaveLength(2)
    expect(rec2.find('notice')[0]).toMatchObject({ level: 'info', text: expect.stringContaining('starts a new one') })
  })

  it('stop() cancels the prompt and reports Stopped', async () => {
    const { app, log } = fakeAgent({
      prompt: async ({ send, cancelled }) => {
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it' } })
        await cancelled
        return 'cancelled'
      }
    })
    const rec = recorder()
    const turn = driverFor(app).createTurn(request(), rec.cb)
    const running = turn.run()
    await until(() => log.prompts.length === 1)
    expect(turn.steer('also do this')).toBe(false)
    await turn.stop()
    await running
    expect(log.cancelled).toBe(true)
    expect(rec.find('assistant').map((i) => i.text)).toEqual(['Working on it'])
    expect(rec.find('notice')).toMatchObject([{ level: 'info', text: 'Stopped.' }])
    expect(rec.find('result')).toEqual([])
    expect(rec.calls.finished).toBe(1)
    expect(rec.calls.results).toEqual([{ ok: false, error: 'Stopped.' }])
  })

  it('reports agent errors, pointing auth failures at settings', async () => {
    const { app } = fakeAgent({ failNew: acp.RequestError.authRequired(undefined, 'run opencode auth login') })
    const rec = recorder()
    await driverFor(app).createTurn(request(), rec.cb).run()
    expect(rec.find('notice')).toMatchObject([{ level: 'error', action: 'open-settings', text: expect.stringContaining('Authentication required') }])
    expect(rec.calls.finished).toBe(1)
    expect(rec.calls.results).toMatchObject([{ ok: false, error: expect.stringContaining('Authentication required') }])
    expect(rec.calls.sessionStarted).toEqual([])
  })

  it('serves file reads and writes inside the workspace only', async () => {
    await mkdir(path.join(workspace, 'docs'), { recursive: true })
    await writeFile(path.join(workspace, 'docs', 'notes.md'), 'one\ntwo\nthree\nfour\n')
    await symlink(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const attempt = async (call: () => Promise<unknown>) => call().then((value) => ({ ok: value }), (err: Error) => ({ error: err.message }))
    const { app, log } = fakeAgent({
      prompt: async ({ client, sessionId }, log) => {
        log.results.push(await attempt(() => client.request(acp.methods.client.fs.readTextFile, { sessionId, path: path.join(workspace, 'docs', 'notes.md'), line: 2, limit: 2 })))
        log.results.push(await attempt(() => client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: path.join(workspace, 'new', 'file.txt'), content: 'written' })))
        log.results.push(await attempt(() => client.request(acp.methods.client.fs.readTextFile, { sessionId, path: path.join(outside, 'secret.txt') })))
        log.results.push(await attempt(() => client.request(acp.methods.client.fs.readTextFile, { sessionId, path: path.join(workspace, 'escape', 'secret.txt') })))
        log.results.push(await attempt(() => client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: path.join(workspace, '..', 'evil.txt'), content: 'x' })))
        return 'end_turn'
      }
    })
    await driverFor(app).createTurn(request({ approvals: 'never-ask' }), recorder().cb).run()
    expect(log.results[0]).toEqual({ ok: { content: 'two\nthree' } })
    expect(log.results[1]).toEqual({ ok: {} })
    expect(await readFile(path.join(workspace, 'new', 'file.txt'), 'utf8')).toBe('written')
    for (const result of log.results.slice(2)) expect(result).toEqual({ error: expect.stringContaining('outside the workspace') })
  })

  it('lists models from the session config options', async () => {
    const { app } = fakeAgent()
    const config: AcpAgentConfig = { kind: 'opencode', label: 'OpenCode', command: () => ({ file: 'unused', args: [] }), connect: inProcess(app) }
    expect(await listAcpModels(config, { cwd: workspace, env: {} })).toEqual([
      { id: 'anthropic/claude-sonnet', label: 'anthropic/Claude Sonnet' },
      { id: 'openai/gpt-5', label: 'openai/GPT-5' }
    ])
  })
})

describe('ACP agent processes', () => {
  // A tiny ACP agent run with node, talking over stdio like `opencode acp`.
  async function agentScript(): Promise<string> {
    const sdk = pathToFileURL(createRequire(import.meta.url).resolve('@agentclientprotocol/sdk')).href
    const file = path.join(await tempDir('switchyard-acp-agent-'), 'agent.mjs')
    await writeFile(
      file,
      `import * as acp from ${JSON.stringify(sdk)}
import { writeFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
const mode = process.argv[2]
process.stderr.write('fake agent starting\\n')
writeFileSync('agent.pid', String(process.pid))
acp.agent({ name: 'script' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', () => {
    if (mode === 'crash') process.exit(3)
    return { sessionId: 'proc-1' }
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = 'Hello from ' + process.env.FAKE_AGENT_NAME
    await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
    return { stopReason: 'end_turn' }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
`
    )
    return file
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('runs a turn against a spawned agent and ends the process afterwards', async () => {
    const script = await agentScript()
    const cwd = await tempDir('switchyard-acp-cwd-')
    const driver = createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: process.execPath, args: [script, 'ok'] }) })
    const rec = recorder()
    await driver.createTurn(request({ cwd, env: { ...process.env, FAKE_AGENT_NAME: 'the agent' } as Record<string, string> }), rec.cb).run()
    expect(rec.find('assistant').map((i) => i.text)).toEqual(['Hello from the agent'])
    expect(rec.find('result')[0]).toMatchObject({ ok: true })
    const pid = Number(await readFile(path.join(cwd, 'agent.pid'), 'utf8'))
    await until(() => !alive(pid))
  })

  it('reports an agent that dies, with its stderr', async () => {
    const script = await agentScript()
    const driver = createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: process.execPath, args: [script, 'crash'] }) })
    const rec = recorder()
    await driver.createTurn(request({ cwd: await tempDir(), env: process.env as Record<string, string> }), rec.cb).run()
    expect(rec.find('notice')).toMatchObject([{ level: 'error', text: expect.stringMatching(/exited unexpectedly[\s\S]*fake agent starting/) }])
    expect(rec.calls.finished).toBe(1)
    expect(rec.calls.results).toMatchObject([{ ok: false, error: expect.stringContaining('exited unexpectedly') }])
  })

  it('reports a missing binary as not installed', async () => {
    const rec = recorder()
    await opencodeDriver.createTurn(request({ executablePath: '/definitely/missing/opencode', env: process.env as Record<string, string> }), rec.cb).run()
    expect(rec.find('notice')).toMatchObject([{ level: 'error', action: 'open-settings', text: expect.stringContaining('OpenCode is not installed') }])
  })

  it('status runs --version', async () => {
    const env = process.env as Record<string, string>
    const node = createAcpDriver({ kind: 'opencode', label: 'OpenCode', command: () => ({ file: process.execPath, args: [] }) })
    expect(await node.status(env)).toEqual({ agent: 'opencode', installed: true, ready: true, version: process.versions.node })

    const missing = await opencodeDriver.status(env, '/definitely/missing/opencode')
    expect(missing).toMatchObject({ agent: 'opencode', installed: false, ready: false })
    expect(missing.detail).toContain('OpenCode is not installed')
    expect(missing.detail).toContain('npm i -g opencode-ai')
  })
})
