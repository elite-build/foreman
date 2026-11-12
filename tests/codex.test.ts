import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogAgent } from '../src/shared/agentCatalog'
import { modelInfo } from '../src/shared/agents'
import type { ChatItem } from '../src/shared/types'
import {
  CodexEventMapper,
  CodexTurn,
  codexDriver,
  codexSettings,
  expandCustomPrompt,
  threadCommand,
  listCodexModels,
  readCodexLimits,
  windowsSandboxFact
} from '../src/main/agents/codex'
import type { CodexAppServerLike } from '../src/main/agents/codex/appServer'
import type { TurnCallbacks, TurnRequest, TurnResult } from '../src/main/agents/types'
import { makeRepo, tempDir } from './helpers'

const CWD = path.resolve('/work/repo')
const THREAD = 'thread-1'

function request(patch: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: 't1',
    prompt: 'hello',
    cwd: CWD,
    env: { PATH: '/usr/bin' },
    model: 'gpt-6.1-sol',
    effort: 'high',
    fastMode: false,
    planMode: false,
    approvals: 'never-ask',
    systemPromptAppend: '',
    ...patch
  }
}

function recorder(overrides: Partial<TurnCallbacks> = {}) {
  const log: { item: ChatItem; transient: boolean }[] = []
  const calls: string[] = []
  const results: TurnResult[] = []
  const cb: TurnCallbacks = {
    item: (item, transient = false) => {
      log.push({ item: structuredClone(item), transient })
      calls.push(`item:${item.kind}`)
    },
    sessionStarted: (id) => calls.push(`session:${id}`),
    assistantMessage: () => undefined,
    approveTool: vi.fn(() => Promise.reject(new Error('unexpected approval'))),
    reviewPlan: vi.fn(() => Promise.reject(new Error('unexpected plan'))),
    ask: vi.fn(() => Promise.reject(new Error('unexpected question'))),
    planModeChanged: vi.fn(),
    autoAcceptEdits: vi.fn(),
    usage: (u) => calls.push(`usage:${u.used}/${u.limit}`),
    finished: (result) => {
      results.push(result)
      calls.push('finished')
    },
    ...overrides
  }
  // What the chat log would hold after replay: the last persisted version of each id.
  const persisted = () => {
    const byId = new Map<string, ChatItem>()
    for (const { item, transient } of log) if (!transient) byId.set(item.id, item)
    return [...byId.values()]
  }
  return { cb, log, calls, results, persisted }
}

type Params = Record<string, any>
type Call = { method: string; params: Params }
type TurnScript = (server: FakeServer, params: Params, turnId: string) => Promise<void> | void

/** `codex app-server` with no process: records what the driver sends and plays a script for each turn. */
class FakeServer implements CodexAppServerLike {
  exited = false
  closed = 0
  calls: Call[] = []
  private notifications: ((method: string, params: any) => void)[] = []
  private requestHandler?: (method: string, params: any, id: number | string) => Promise<unknown>
  private exits: ((code: number | null, tail: string) => void)[] = []
  private turns = 0
  private thread = THREAD
  // Answers by method, overriding the defaults.
  answers: Record<string, (params: Params) => unknown> = {}

  constructor(private scripts: TurnScript[] = []) {}

  // What a real server says about itself: its version is in `userAgent`.
  userAgent?: string
  // Which system it says it runs on ("windows": the sandbox's readiness is read).
  platformOs?: string

  async initialize(): Promise<{ userAgent?: string; platformOs?: string } | void> {
    this.calls.push({ method: 'initialize', params: {} })
    if (this.userAgent || this.platformOs) return { userAgent: this.userAgent, platformOs: this.platformOs }
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params: params as Params })
    if (this.exited) throw new Error('Codex app-server exited unexpectedly')
    if (method === 'thread/resume') this.thread = (params as Params).threadId
    const custom = this.answers[method]
    if (custom) {
      const answer = custom(params as Params) as { thread?: { id: string } }
      // A fork is the thread its notifications are about from then on.
      if (method === 'thread/fork' && answer.thread) this.thread = answer.thread.id
      return answer as T
    }
    switch (method) {
      case 'thread/start':
        this.thread = THREAD
        return { thread: { id: THREAD }, model: 'gpt-6.1-sol' } as T
      case 'thread/resume':
        this.thread = (params as Params).threadId
        return { thread: { id: this.thread }, model: 'gpt-6.1-sol' } as T
      case 'turn/start': {
        const n = this.turns++
        const id = `turn-${n + 1}`
        const script = this.scripts[n]
        // After the answer, like the real thing: notifications follow the response.
        setTimeout(async () => {
          if (script) await script(this, params as Params, id)
          else this.completed(id)
        }, 0)
        return { turn: { id } } as T
      }
      default:
        return {} as T
    }
  }

  notify(): void {}
  onNotification(handler: (method: string, params: any) => void): void {
    this.notifications.push(handler)
  }
  onRequest(handler: (method: string, params: any, id: number | string) => Promise<unknown>): void {
    this.requestHandler = handler
  }
  onExit(handler: (code: number | null, tail: string) => void): void {
    this.exits.push(handler)
  }
  close(): void {
    this.closed++
    this.exited = true
  }

  /** The process dies on its own. */
  die(code: number, tail: string): void {
    this.exited = true
    for (const handler of this.exits) handler(code, tail)
  }

  emit(method: string, params: Params): void {
    for (const handler of this.notifications) handler(method, { threadId: this.thread, ...params })
  }
  started(turnId: string, item: Params): void {
    this.emit('item/started', { turnId, item })
  }
  finished(turnId: string, item: Params): void {
    this.emit('item/completed', { turnId, item })
  }
  completed(turnId: string, status = 'completed', error: Params | null = null): void {
    this.emit('turn/completed', { turn: { id: turnId, status, error } })
  }
  /** A request from the server, answered the way the driver answers it. */
  ask(method: string, params: Params, id: number | string = 1): Promise<any> {
    if (!this.requestHandler) throw new Error('no request handler')
    return this.requestHandler(method, { threadId: this.thread, ...params }, id)
  }
  sent(method: string): Params[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params)
  }
}

async function runTurn(req: TurnRequest, cb: TurnCallbacks, server: FakeServer): Promise<CodexTurn> {
  const turn = new CodexTurn(req, cb, () => server)
  await turn.run()
  return turn
}

const agentMessage = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: null })
const command = (id: string, extra: Params = {}) => ({ type: 'commandExecution', id, command: 'ls', cwd: CWD, status: 'inProgress', aggregatedOutput: null, exitCode: null, ...extra })
const fileChange = (id: string, changes: Params[], status = 'inProgress') => ({ type: 'fileChange', id, changes, status })
const change = (p: string, kind: 'add' | 'delete' | 'update') => ({ path: p, kind: kind === 'update' ? { type: kind, move_path: null } : { type: kind }, diff: '' })

describe('codex event mapping', () => {
  it('maps a full turn to chat items', () => {
    const r = recorder()
    const mapper = new CodexEventMapper('t1', CWD, modelInfo('codex', 'gpt-6.1-sol').contextWindow, r.cb)
    const on = (method: string, params: Params) => mapper.handle(method, { threadId: THREAD, turnId: 'c1', ...params })
    on('item/completed', { item: { type: 'reasoning', id: 'item_0', summary: ['**Looking around**'], content: [] } })
    on('item/started', { item: command('item_1') })
    on('item/commandExecution/outputDelta', { itemId: 'item_1', delta: 'a.txt\n' })
    on('item/completed', { item: command('item_1', { aggregatedOutput: 'a.txt\nb.txt\n', exitCode: 0, status: 'completed' }) })
    on('item/completed', { item: command('item_2', { command: 'false', aggregatedOutput: '', exitCode: 1, status: 'completed' }) })
    on('item/completed', { item: command('item_2b', { command: 'rm -rf x', status: 'declined' }) })
    on('item/completed', {
      item: fileChange('item_3', [change('src/new.ts', 'add'), change(path.join(CWD, 'README.md'), 'update'), change('old.txt', 'delete')], 'completed')
    })
    on('item/completed', { item: fileChange('item_3b', [change('nope.ts', 'update')], 'declined') })
    on('item/started', { item: { type: 'mcpToolCall', id: 'item_4', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'inProgress', result: null, error: null } })
    on('item/completed', {
      item: {
        type: 'mcpToolCall',
        id: 'item_4',
        server: 'docs',
        tool: 'search',
        arguments: { q: 'x' },
        status: 'completed',
        result: { content: [{ type: 'text', text: 'found it' }], structuredContent: null, _meta: null },
        error: null
      }
    })
    on('item/completed', { item: { type: 'mcpToolCall', id: 'item_4b', server: 'docs', tool: 'broken', arguments: {}, status: 'failed', result: null, error: { message: 'tool exploded' } } })
    on('item/started', { item: { type: 'webSearch', id: 'item_5', query: 'codex app-server', action: null, results: null } })
    on('item/completed', { item: { type: 'webSearch', id: 'item_5', query: 'codex app-server', action: null, results: null } })
    on('turn/plan/updated', { explanation: null, plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'inProgress' }, { step: 'Test', status: 'pending' }] })
    on('turn/plan/updated', { explanation: null, plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'completed' }, { step: 'Test', status: 'inProgress' }] })
    on('error', { error: { message: 'Skill failed to load' }, willRetry: false })
    on('item/agentMessage/delta', { itemId: 'item_8', delta: 'Done' })
    on('item/completed', { item: agentMessage('item_8', 'Done.') })
    on('thread/tokenUsage/updated', { tokenUsage: { total: {}, last: { inputTokens: 12000, outputTokens: 345 }, modelContextWindow: null } })
    mapper.completeTurn({ status: 'completed' })
    mapper.finish(false)

    const items = r.persisted()
    const byId = (id: string) => items.find((i) => i.id === id)

    expect(byId('t1:item_0')).toEqual({ kind: 'thinking', id: 't1:item_0', turnId: 't1', text: '**Looking around**' })

    // Running command shown live, then finished in place.
    expect(r.log.find((l) => l.item.id === 't1:item_1' && l.transient)?.item).toMatchObject({ status: 'running', output: 'a.txt\n' })
    expect(byId('t1:item_1')).toMatchObject({ kind: 'tool', name: 'Bash', input: { command: 'ls' }, status: 'done', output: 'a.txt\nb.txt\n' })
    expect(byId('t1:item_2')).toMatchObject({ name: 'Bash', status: 'error', output: 'Exit code 1' })
    expect(byId('t1:item_2b')).toMatchObject({ name: 'Bash', status: 'error', output: 'Declined.' })

    expect(byId('t1:item_3:0')).toMatchObject({ name: 'Write', input: { file_path: path.join(CWD, 'src/new.ts') }, status: 'done' })
    expect(byId('t1:item_3:1')).toMatchObject({ name: 'Edit', input: { file_path: path.join(CWD, 'README.md') }, status: 'done' })
    expect(byId('t1:item_3:2')).toMatchObject({ name: 'Edit', input: { file_path: path.join(CWD, 'old.txt') }, output: 'Deleted.' })
    expect(byId('t1:item_3b:0')).toMatchObject({ name: 'Edit', status: 'error', output: 'Declined.' })

    expect(byId('t1:item_4')).toMatchObject({ name: 'mcp__docs__search', input: { q: 'x' }, status: 'done', output: 'found it' })
    expect(byId('t1:item_4b')).toMatchObject({ name: 'mcp__docs__broken', status: 'error', output: 'tool exploded' })
    expect(byId('t1:item_5')).toMatchObject({ name: 'WebSearch', input: { query: 'codex app-server' }, status: 'done' })

    // One TodoWrite per Codex turn, rewritten in place as the plan moves on.
    expect(byId('t1:plan:c1')).toMatchObject({
      name: 'TodoWrite',
      status: 'done',
      input: { todos: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'completed' }, { content: 'Test', status: 'in_progress' }] }
    })
    expect(r.log.filter((l) => l.item.id === 't1:plan:c1')).toHaveLength(2)
    expect(byId('t1:notice:0')).toMatchObject({ kind: 'notice', level: 'error', text: 'Skill failed to load' })

    // Streaming preview first, then the final text under the same id.
    expect(r.log.find((l) => l.item.id === 't1:item_8' && l.transient)?.item).toMatchObject({ kind: 'assistant', text: 'Done', streaming: true })
    expect(byId('t1:item_8')).toEqual({ kind: 'assistant', id: 't1:item_8', turnId: 't1', text: 'Done.' })

    const result = items.find((i) => i.kind === 'result')
    expect(result).toMatchObject({ ok: true, turnId: 't1' })
    expect(typeof (result as { durationMs?: number }).durationMs).toBe('number')
    // The context meter: the last request's input and output, against the model's window.
    expect(r.calls).toContain(`usage:12345/${modelInfo('codex', 'gpt-6.1-sol').contextWindow}`)
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
    expect(r.calls.at(-1)).toBe('finished')
    expect(r.results).toEqual([{ ok: true }])
    // Nothing was left running.
    expect(items.filter((i) => i.kind === 'tool' && i.status === 'running')).toEqual([])
  })

  it('uses the window Codex reports, capped at it', () => {
    const r = recorder()
    const mapper = new CodexEventMapper('t1', CWD, 400_000, r.cb)
    mapper.handle('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 900, outputTokens: 200 }, modelContextWindow: 1000 } })
    expect(r.calls).toEqual(['usage:1000/1000'])
  })

  it('shows reconnecting as information, not as a failure', () => {
    const r = recorder()
    const mapper = new CodexEventMapper('t1', CWD, 400_000, r.cb)
    mapper.handle('error', { error: { message: 'Reconnecting... 1/5' }, willRetry: true })
    mapper.handle('error', { error: { message: 'Reconnecting... 2/5' }, willRetry: false })
    expect(r.persisted().map((i) => (i.kind === 'notice' ? i.level : i.kind))).toEqual(['info', 'info'])
  })

  it('persists unfinished previews and closes running tools on finish', () => {
    const r = recorder()
    const mapper = new CodexEventMapper('t2', CWD, 400_000, r.cb)
    mapper.handle('item/agentMessage/delta', { itemId: 'item_0', delta: 'partial' })
    mapper.handle('item/started', { item: command('item_1', { command: 'sleep 9' }) })
    mapper.finish(true)
    const items = r.persisted()
    expect(items.find((i) => i.id === 't2:item_0')).toMatchObject({ kind: 'assistant', text: 'partial', streaming: false })
    expect(items.find((i) => i.id === 't2:item_1')).toMatchObject({ status: 'error', output: 'Interrupted.' })
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
  })

  it('puts a plan item in the transcript and hands the plan over once', () => {
    const r = recorder()
    const mapper = new CodexEventMapper('t1', CWD, 400_000, r.cb)
    mapper.handle('item/completed', { item: { type: 'plan', id: 'p1', text: '1. Do it' } })
    expect(r.persisted().find((i) => i.id === 't1:p1')).toMatchObject({ kind: 'assistant', text: '1. Do it' })
    expect(mapper.takePlan()).toBe('1. Do it')
    expect(mapper.takePlan()).toBe('')
  })
})

describe('codex turn', () => {
  it('runs a turn: thread, then turn, then result', async () => {
    const r = recorder()
    const server = new FakeServer([
      (s, _p, id) => {
        s.started(id, agentMessage('m', ''))
        s.emit('item/agentMessage/delta', { turnId: id, itemId: 'm', delta: 'Hi' })
        s.finished(id, agentMessage('m', 'Hi there'))
        s.completed(id)
      }
    ])
    await runTurn(request(), r.cb, server)
    expect(r.calls[0]).toBe(`session:${THREAD}`)
    expect(r.persisted().find((i) => i.kind === 'assistant')).toMatchObject({ text: 'Hi there' })
    expect(r.persisted().find((i) => i.kind === 'result')).toMatchObject({ ok: true })
    expect(r.results).toEqual([{ ok: true }])
    expect(server.calls.map((c) => c.method)).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(server.sent('turn/start')[0]).toMatchObject({ threadId: THREAD, input: [{ type: 'text', text: 'hello', text_elements: [] }], model: 'gpt-6.1-sol', effort: 'high' })
    // The process never outlives its turn.
    expect(server.closed).toBe(1)
  })

  it('reports a failed turn once, flags auth errors, and ignores the exit error', async () => {
    const r = recorder()
    const message = 'unexpected status 401 Unauthorized: Missing bearer authentication'
    const server = new FakeServer([
      (s, _p, id) => {
        s.emit('error', { turnId: id, error: { message }, willRetry: false })
        s.completed(id, 'failed', { message })
      }
    ])
    await runTurn(request(), r.cb, server)
    const items = r.persisted()
    const notices = items.filter((i) => i.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ level: 'error', text: 'Codex isn’t signed in, or its sign-in has expired.', action: 'open-settings' })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: false })
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
    expect(r.results).toEqual([{ ok: false, error: message }])
    expect(server.closed).toBe(1)
  })

  // Docs/agents.md 7.1: `account/rateLimits/updated` reports the account's windows during a turn, and a turn that fails at the
  // limit takes its reset time from the blocked window, so a paused chat can resume when it resets.
  it('reports rate-limit windows during the turn and reads the reset time of a limit failure from the blocked one', async () => {
    const windows: unknown[] = []
    const r = recorder({ limits: (w) => void windows.push(w) })
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600
    const message = "You've hit your usage limit. Try again later."
    const server = new FakeServer([
      (s, _p, id) => {
        s.emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 83, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: resetsAt + 86_400 } } })
        s.emit('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, rateLimitReachedType: 'rate_limit_reached' } })
        s.emit('error', { turnId: id, error: { message }, willRetry: false })
        s.completed(id, 'failed', { message })
      }
    ])
    await runTurn(request(), r.cb, server)
    expect(windows).toEqual([
      [{ kind: 'session', usedPercent: 83, resetsAt: new Date(resetsAt * 1000).toISOString(), state: 'warning' }, { kind: 'weekly', usedPercent: 20, resetsAt: new Date((resetsAt + 86_400) * 1000).toISOString(), state: 'ok' }],
      [{ kind: 'session', usedPercent: 100, resetsAt: new Date(resetsAt * 1000).toISOString(), state: 'blocked' }]
    ])
    expect(r.results).toEqual([{ ok: false, error: message, limit: { resetAt: new Date(resetsAt * 1000).toISOString(), source: 'five_hour', timeZone: 'UTC', from: 'event' } }])
  })

  it('a limit failure with no window reported is a limit with an unknown reset time, and any other failure none', async () => {
    const limited = recorder()
    const message = "You've hit your usage limit."
    await runTurn(request(), limited.cb, new FakeServer([(s, _p, id) => s.completed(id, 'failed', { message })]))
    expect(limited.results).toEqual([{ ok: false, error: message, limit: {} }])
    const other = recorder()
    await runTurn(request(), other.cb, new FakeServer([(s, _p, id) => s.completed(id, 'failed', { message: 'model not found' })]))
    expect(other.results).toEqual([{ ok: false, error: 'model not found' }])
  })

  it('shows the CLI error when the process dies without a turn result', async () => {
    const r = recorder()
    const server = new FakeServer([(s) => s.die(1, 'Error: model not found')])
    await runTurn(request(), r.cb, server)
    const items = r.persisted()
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({ level: 'error', text: 'Error: model not found' })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: false })
    expect(r.calls.at(-1)).toBe('finished')
    expect(r.results).toEqual([{ ok: false, error: 'Error: model not found' }])
    expect(server.closed).toBe(1)
  })

  it('strips the process wrapper from a failed request, and still closes', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/start'] = () => {
      throw new Error('Codex app-server exited with code 1: Error: bad config')
    }
    await runTurn(request(), r.cb, server)
    expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ level: 'error', text: 'Error: bad config' })
    expect(r.results).toEqual([{ ok: false, error: 'Error: bad config' }])
    expect(server.closed).toBe(1)
  })

  it('points at Settings when the CLI path is wrong', async () => {
    const r = recorder()
    await codexDriver.createTurn(request({ executablePath: path.join(os.tmpdir(), 'no-such-codex') }), r.cb).run()
    const items = r.persisted()
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({ level: 'error', text: expect.stringMatching(/^Codex is not installed or could not be found at /), action: 'open-settings' })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: false })
    expect(r.calls.at(-1)).toBe('finished')
  })

  it('expands custom prompts before sending', async () => {
    const home = await tempDir()
    await mkdir(path.join(home, 'prompts'))
    await writeFile(path.join(home, 'prompts', 'review.md'), '---\ndescription: Review a file\n---\nReview $1 for $FOCUS. All: $ARGUMENTS. Cost $$5.\n')
    const r = recorder()
    const server = new FakeServer()
    await runTurn(request({ prompt: '/prompts:review a.ts FOCUS=bugs\n\nAttached: x.png', env: { CODEX_HOME: home } }), r.cb, server)
    expect(server.sent('turn/start')[0].input[0].text).toBe('Review a.ts for bugs. All: a.ts FOCUS=bugs. Cost $5.\n\nAttached: x.png')
    expect(await expandCustomPrompt('/prompts:missing x', home)).toBe('/prompts:missing x')
    expect(await expandCustomPrompt('plain text', home)).toBe('plain text')
  })
})

describe('codex thread settings', () => {
  const settings = (patch: Partial<TurnRequest>) => codexSettings(request(patch))

  it('never-ask: never asks, no sandbox', () => {
    const s = settings({ approvals: 'never-ask', effort: 'none', fastMode: true, systemPromptAppend: ' Workspace notes ' })
    expect(s.approvalPolicy).toBe('never')
    expect(s.sandbox).toBe('danger-full-access')
    expect(s.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
    expect(s.thread).toEqual({
      model: 'gpt-6.1-sol',
      cwd: CWD,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: 'Workspace notes',
      serviceTier: 'priority',
      config: undefined
    })
  })

  it('ask: sandboxed with the git folder and the network, and Codex asks when it must leave it', () => {
    const s = settings({ approvals: 'ask', extraWritableDirs: ['/repo/.git'] })
    expect(s.approvalPolicy).toBe('on-request')
    expect(s.sandbox).toBe('workspace-write')
    expect(s.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: ['/repo/.git'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
    expect(settings({ approvals: 'ask-except-edits' }).approvalPolicy).toBe('on-request')
  })

  it('auto (unattended): sandboxed, never asks', () => {
    const s = settings({ approvals: 'auto', extraWritableDirs: ['/repo/.git'] })
    expect(s.approvalPolicy).toBe('never')
    expect(s.sandbox).toBe('workspace-write')
    expect(s.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: ['/repo/.git'], networkAccess: true })
  })

  it('a turn capped below Never ask has no network in its sandbox, so reaching Foreman’s CLI asks or fails (docs/agent-access.md §3)', () => {
    for (const ceiling of ['ask', 'ask-except-edits', 'auto'] as const) {
      const s = settings({ approvals: ceiling, capped: { ceiling } })
      expect(s.sandbox).toBe('workspace-write')
      expect(s.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: false })
    }
    expect(settings({ approvals: 'auto' }).sandboxPolicy).toMatchObject({ networkAccess: true })
  })

  it('a capped turn’s MCP tools prompt (asked at Ask, refused at Auto), except Foreman’s own server, which holds the cap itself', () => {
    const servers = { echo: { command: 'node', args: ['x.mjs'], env: {} }, 'foreman-app': { command: 'foreman', args: ['mcp-bridge', 'app'], env: {} } }
    const capped = settings({ approvals: 'auto', capped: { ceiling: 'auto' }, mcpServers: servers }).config.mcp_servers as Record<string, { default_tools_approval_mode: string }>
    expect(capped.echo.default_tools_approval_mode).toBe('prompt')
    expect(capped['foreman-app'].default_tools_approval_mode).toBe('approve')
    const plain = settings({ approvals: 'auto', mcpServers: servers }).config.mcp_servers as Record<string, { default_tools_approval_mode: string }>
    expect(plain.echo.default_tools_approval_mode).toBe('approve')
  })

  it('read-only: never asks, whatever the policy, with nothing writable and no network', () => {
    for (const approvals of ['never-ask', 'ask', 'auto'] as const) {
      const s = settings({ approvals, readOnly: true, extraWritableDirs: ['/repo/.git'] })
      expect(s.approvalPolicy).toBe('never')
      expect(s.sandbox).toBe('read-only')
      expect(s.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
    }
  })

  it('omits empty settings, and the speed unless the model has it', () => {
    const s = settings({ model: '', effort: undefined, approvals: 'ask', fastMode: true })
    expect(s.thread.model).toBeUndefined()
    expect(s.thread.developerInstructions).toBeUndefined()
    expect(s.thread.serviceTier).toBeUndefined()
    expect(s.config).toEqual({})
    expect(s.env).toEqual({ PATH: '/usr/bin' })
  })

  it('puts the bundled helper tools on PATH', () => {
    const { env } = codexSettings(request(), { file: '/opt/codex', pathDirs: ['/opt/helpers'] })
    expect(env.PATH).toBe(['/opt/helpers', '/usr/bin'].join(path.delimiter))
  })

  it('starts or resumes the thread with the same settings and the repo servers', async () => {
    const servers = { echo: { command: 'node', args: ['x.mjs'], env: { T: 't' } } }
    const fresh = new FakeServer()
    await runTurn(request({ approvals: 'ask', mcpServers: servers, disabledMcp: ['linear'] }), recorder().cb, fresh)
    const start = fresh.sent('thread/start')[0]
    expect(start).toMatchObject({ cwd: CWD, approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(start.config.mcp_servers.linear).toEqual({ enabled: false })
    expect(start.config.mcp_servers.echo).toMatchObject({ command: 'node', enabled: true, default_tools_approval_mode: 'approve' })
    // Per-turn settings ride on turn/start, so the sandbox's writable folders and network are typed there.
    expect(fresh.sent('turn/start')[0]).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } })

    const resumed = new FakeServer()
    const r = recorder()
    await runTurn(request({ approvals: 'ask', resume: 'old-thread', mcpServers: servers }), r.cb, resumed)
    expect(resumed.calls.map((c) => c.method)).toEqual(['initialize', 'thread/resume', 'turn/start'])
    expect(resumed.sent('thread/resume')[0]).toMatchObject({ threadId: 'old-thread', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(resumed.sent('turn/start')[0].threadId).toBe('old-thread')
    expect(r.calls[0]).toBe('session:old-thread')
  })

  it('keeps a read-only chat in the read-only sandbox on every turn', async () => {
    const server = new FakeServer()
    await runTurn(request({ approvals: 'never-ask', readOnly: true }), recorder().cb, server)
    expect(server.sent('thread/start')[0]).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' })
    expect(server.sent('turn/start')[0]).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
  })
})

describe('codex approvals', () => {
  const approving = (answer: Awaited<ReturnType<TurnCallbacks['approveTool']>>) => vi.fn(async () => answer)
  const allow = { kind: 'tool', allow: true } as const

  /** One turn in which the server asks `method`; the driver's reply comes back. */
  async function asked(req: Partial<TurnRequest>, cb: Partial<TurnCallbacks>, method: string, params: Params, before?: (s: FakeServer) => void) {
    let reply: unknown
    const r = recorder(cb)
    const server = new FakeServer([
      async (s, _p, id) => {
        before?.(s)
        reply = await s.ask(method, { turnId: id, ...params }, 7).catch((e: Error) => ({ rejected: e.message }))
        s.completed(id)
      }
    ])
    await runTurn(request(req), r.cb, server)
    return { reply, r, server }
  }

  const bash = { itemId: 'c1', command: 'npm publish', cwd: CWD, reason: 'needs the network' }

  it('asks for a command with Bash, and maps allow, always allow, deny', async () => {
    const approveTool = approving(allow)
    const accepted = await asked({ approvals: 'ask' }, { approveTool }, 'item/commandExecution/requestApproval', bash)
    expect(accepted.reply).toEqual({ decision: 'accept' })
    expect(approveTool).toHaveBeenCalledWith({ kind: 'tool', toolName: 'Bash', input: { command: 'npm publish', cwd: CWD }, reason: 'needs the network', alternate: 'always-allow' }, expect.any(AbortSignal))

    const remembered = await asked({ approvals: 'ask' }, { approveTool: approving({ kind: 'tool', allow: true, alternate: true }) }, 'item/commandExecution/requestApproval', bash)
    expect(remembered.reply).toEqual({ decision: 'acceptForSession' })

    const declined = await asked({ approvals: 'ask' }, { approveTool: approving({ kind: 'tool', allow: false }) }, 'item/commandExecution/requestApproval', bash)
    expect(declined.reply).toEqual({ decision: 'decline' })
  })

  it('offers no always-allow when Codex does not offer a session grant', async () => {
    const approveTool = approving({ kind: 'tool', allow: true, alternate: true })
    const { reply } = await asked({ approvals: 'ask' }, { approveTool }, 'item/commandExecution/requestApproval', { ...bash, availableDecisions: ['accept', 'decline', 'cancel'] })
    expect(reply).toEqual({ decision: 'accept' })
    expect(approveTool).toHaveBeenCalledWith(expect.objectContaining({ alternate: undefined }), expect.any(AbortSignal))
  })

  it('cancels an approval that stop() withdraws', async () => {
    const approveTool = vi.fn((_req, signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))
    const r = recorder({ approveTool })
    let reply: unknown
    let asking!: () => void
    const reached = new Promise<void>((resolve) => (asking = resolve))
    const server = new FakeServer([
      async (s, _p, id) => {
        const pending = s.ask('item/commandExecution/requestApproval', { turnId: id, ...bash }, 7)
        asking()
        reply = await pending
      }
    ])
    // Interrupting answers the turn as interrupted, like Codex does.
    server.answers['turn/interrupt'] = () => {
      setTimeout(() => server.completed('turn-1', 'interrupted'), 0)
      return {}
    }
    const turn = new CodexTurn(request({ approvals: 'ask' }), r.cb, () => server)
    const done = turn.run()
    await reached
    await turn.stop()
    await done
    expect(reply).toEqual({ decision: 'cancel' })
  })

  it('cancels an approval the server says it no longer needs', async () => {
    const signals: AbortSignal[] = []
    const approveTool = vi.fn((_req, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    const { reply } = await asked({ approvals: 'ask' }, { approveTool }, 'item/commandExecution/requestApproval', bash, (s) =>
      setTimeout(() => s.emit('serverRequest/resolved', { requestId: 7 }), 5)
    )
    expect(reply).toEqual({ decision: 'cancel' })
    expect(signals[0].aborted).toBe(true)
  })

  it('declines everything in a read-only chat without asking', async () => {
    const approveTool = vi.fn()
    const ask = vi.fn()
    const cb = { approveTool, ask }
    const base = { approvals: 'never-ask', readOnly: true } as const
    expect((await asked(base, cb, 'item/commandExecution/requestApproval', bash)).reply).toEqual({ decision: 'decline' })
    expect((await asked(base, cb, 'item/fileChange/requestApproval', { itemId: 'f1' })).reply).toEqual({ decision: 'decline' })
    expect((await asked(base, cb, 'item/permissions/requestApproval', { itemId: 'p1', cwd: CWD, reason: null, permissions: { network: { enabled: true }, fileSystem: null } })).reply).toEqual({ permissions: {}, scope: 'turn' })
    const question = await asked(base, cb, 'item/tool/requestUserInput', { itemId: 'q1', questions: [{ id: 'a', header: 'H', question: 'Which?', isOther: false, isSecret: false, options: null }] })
    expect(question.reply).toEqual({ answers: { a: { answers: [] } } })
    expect(approveTool).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
  })

  it('accepts without asking when the chat never asks', async () => {
    const approveTool = vi.fn()
    const cb = { approveTool }
    expect((await asked({ approvals: 'never-ask' }, cb, 'item/commandExecution/requestApproval', bash)).reply).toEqual({ decision: 'accept' })
    expect((await asked({ approvals: 'never-ask' }, cb, 'item/fileChange/requestApproval', { itemId: 'f1' })).reply).toEqual({ decision: 'accept' })
    expect((await asked({ approvals: 'never-ask' }, cb, 'item/permissions/requestApproval', { itemId: 'p', cwd: CWD, reason: null, permissions: { network: { enabled: true }, fileSystem: null } })).reply).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn'
    })
    expect(approveTool).not.toHaveBeenCalled()
  })

  it('asks for a file change as Edit, or Write when it only adds files, naming the files', async () => {
    const approveTool = approving(allow)
    const edit = await asked({ approvals: 'ask' }, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f1', reason: 'extra write access' }, (s) =>
      s.started('turn-1', fileChange('f1', [change('src/a.ts', 'update'), change('src/b.ts', 'add')]))
    )
    expect(edit.reply).toEqual({ decision: 'accept' })
    expect(approveTool).toHaveBeenLastCalledWith(
      { kind: 'tool', toolName: 'Edit', input: { file_path: path.join(CWD, 'src/a.ts'), files: [path.join(CWD, 'src/a.ts'), path.join(CWD, 'src/b.ts')] }, reason: 'extra write access', alternate: 'edits-for-session' },
      expect.any(AbortSignal)
    )
    await asked({ approvals: 'ask' }, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f2' }, (s) => s.started('turn-1', fileChange('f2', [change('new.ts', 'add')])))
    expect(approveTool).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: 'Write', input: { file_path: path.join(CWD, 'new.ts'), files: [path.join(CWD, 'new.ts')] } }), expect.any(AbortSignal))
  })

  it('"allow edits for the session" accepts for the session and then stops asking about edits', async () => {
    const approveTool = approving({ kind: 'tool', allow: true, alternate: true })
    const autoAcceptEdits = vi.fn()
    const r = recorder({ approveTool, autoAcceptEdits })
    const replies: unknown[] = []
    const server = new FakeServer([
      async (s, _p, id) => {
        s.started(id, fileChange('f1', [change('a.ts', 'update')]))
        replies.push(await s.ask('item/fileChange/requestApproval', { turnId: id, itemId: 'f1' }, 1))
        s.started(id, fileChange('f2', [change('b.ts', 'update')]))
        replies.push(await s.ask('item/fileChange/requestApproval', { turnId: id, itemId: 'f2' }, 2))
        // Commands are still asked about.
        replies.push(await s.ask('item/commandExecution/requestApproval', { turnId: id, ...bash }, 3))
        s.completed(id)
      }
    ])
    await runTurn(request({ approvals: 'ask' }), r.cb, server)
    expect(replies).toEqual([{ decision: 'acceptForSession' }, { decision: 'accept' }, { decision: 'acceptForSession' }])
    expect(autoAcceptEdits).toHaveBeenCalledWith(true)
    expect(approveTool).toHaveBeenCalledTimes(2)
  })

  it('a turn capped below Never ask asks before writing agent or git configuration, even where edits go ahead (docs/agent-access.md §3)', async () => {
    const approveTool = approving(allow)
    const capped = { approvals: 'ask-except-edits' as const, capped: { ceiling: 'ask-except-edits' as const, gitDir: path.resolve('/repos/app/.git') } }
    const plain = await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f1' }, (s) => s.started('turn-1', fileChange('f1', [change('src/a.ts', 'update')])))
    expect(plain.reply).toEqual({ decision: 'accept' })
    expect(approveTool).not.toHaveBeenCalled()
    const config = await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f2' }, (s) => s.started('turn-1', fileChange('f2', [change('src/b.ts', 'update'), change('.codex/config.toml', 'update')])))
    expect(config.reply).toEqual({ decision: 'accept' })
    expect(approveTool).toHaveBeenCalledTimes(1)
    await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f3' }, (s) => s.started('turn-1', fileChange('f3', [change(path.resolve('/repos/app/.git/hooks/pre-commit'), 'add')])))
    expect(approveTool).toHaveBeenCalledTimes(2)
    // Uncapped, the same write goes ahead as before.
    await asked({ approvals: 'ask-except-edits' }, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f4' }, (s) => s.started('turn-1', fileChange('f4', [change('.codex/config.toml', 'update')])))
    expect(approveTool).toHaveBeenCalledTimes(2)
  })

  it('a capped turn goes ahead only with writes inside the workspace: anything outside it asks, even after edits for the session (docs/agent-access.md §3)', async () => {
    const approveTool = approving(allow)
    const capped = { approvals: 'ask-except-edits' as const, capped: { ceiling: 'ask-except-edits' as const } }
    const outside = await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f1' }, (s) => s.started('turn-1', fileChange('f1', [change(path.resolve(CWD, '../elsewhere/a.ts'), 'update')])))
    expect(outside.reply).toEqual({ decision: 'accept' })
    expect(approveTool).toHaveBeenCalledTimes(1)
    // A grant root outside the workspace, or none at all, asks too.
    await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f2', grantRoot: path.resolve('/home/me') })
    await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f3' })
    expect(approveTool).toHaveBeenCalledTimes(3)
    // Inside the workspace, the root included, it goes ahead.
    await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f4', grantRoot: CWD })
    await asked(capped, { approveTool }, 'item/fileChange/requestApproval', { itemId: 'f5' }, (s) => s.started('turn-1', fileChange('f5', [change('src/a.ts', 'update')])))
    expect(approveTool).toHaveBeenCalledTimes(3)

    // "Edits for this session" doesn't reach outside the workspace.
    const forSession = approving({ kind: 'tool', allow: true, alternate: true })
    const replies: unknown[] = []
    const server = new FakeServer([
      async (s, _p, id) => {
        s.started(id, fileChange('g1', [change('a.ts', 'update')]))
        replies.push(await s.ask('item/fileChange/requestApproval', { turnId: id, itemId: 'g1' }, 1))
        s.started(id, fileChange('g2', [change(path.resolve(CWD, '../other/b.ts'), 'update')]))
        replies.push(await s.ask('item/fileChange/requestApproval', { turnId: id, itemId: 'g2' }, 2))
        s.completed(id)
      }
    ])
    await runTurn(request({ approvals: 'ask', capped: { ceiling: 'ask' } }), recorder({ approveTool: forSession, autoAcceptEdits: vi.fn() }).cb, server)
    expect(forSession).toHaveBeenCalledTimes(2)
    expect(replies[0]).toEqual({ decision: 'acceptForSession' })
  })

  it('asks before an MCP tool as a tool approval, never as a question an outside agent could answer', async () => {
    const questions = [{ id: 'mcp_tool_call_approval_call-1', header: 'Approve app tool call?', question: 'Allow echo to run tool "say"?', isOther: false, isSecret: false, options: [{ label: 'Allow', description: '' }, { label: 'Allow for this session', description: '' }, { label: 'Cancel', description: '' }] }]
    const ask = vi.fn()
    const approveTool = approving(allow)
    const allowed = await asked({ approvals: 'ask', capped: { ceiling: 'ask' } }, { ask, approveTool }, 'item/tool/requestUserInput', { itemId: 'q1', questions })
    expect(allowed.reply).toEqual({ answers: { 'mcp_tool_call_approval_call-1': { answers: ['Allow'] } } })
    expect(approveTool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool', toolName: 'MCP', input: { question: 'Allow echo to run tool "say"?' } }), expect.any(AbortSignal))
    expect(ask).not.toHaveBeenCalled()
    const denied = await asked({ approvals: 'ask', capped: { ceiling: 'ask' } }, { ask, approveTool: approving({ kind: 'tool', allow: false }) }, 'item/tool/requestUserInput', { itemId: 'q1', questions })
    expect(denied.reply).toEqual({ answers: { 'mcp_tool_call_approval_call-1': { answers: [] } } })
  })

  it('asks for permissions: allow grants what was asked, minus what it left null; deny grants none', async () => {
    const params = { itemId: 'p1', cwd: CWD, reason: 'to fetch', permissions: { network: { enabled: true }, fileSystem: null } }
    const approveTool = approving(allow)
    const granted = await asked({ approvals: 'ask' }, { approveTool }, 'item/permissions/requestApproval', params)
    expect(granted.reply).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
    expect(approveTool).toHaveBeenCalledWith({ kind: 'tool', toolName: 'Permissions', input: { permissions: params.permissions, cwd: CWD }, reason: 'to fetch' }, expect.any(AbortSignal))
    const denied = await asked({ approvals: 'ask' }, { approveTool: approving({ kind: 'tool', allow: false }) }, 'item/permissions/requestApproval', params)
    expect(denied.reply).toEqual({ permissions: {}, scope: 'turn' })
  })

  it('puts a question to the user and answers by question id', async () => {
    const ask = vi.fn(async () => ({ kind: 'question' as const, answers: { 'Which database?': 'Postgres' } }))
    const questions = [
      { id: 'db', header: 'Database', question: 'Which database?', isOther: true, isSecret: false, options: [{ label: 'Postgres', description: 'The usual' }, { label: 'SQLite', description: '' }] },
      { id: 'why', header: 'Why', question: 'Why?', isOther: true, isSecret: false, options: null }
    ]
    const { reply } = await asked({ approvals: 'ask' }, { ask }, 'item/tool/requestUserInput', { itemId: 'q1', questions })
    expect(ask).toHaveBeenCalledWith(
      [
        { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres', description: 'The usual' }, { label: 'SQLite', description: undefined }] },
        { question: 'Why?', header: 'Why', options: [] }
      ],
      expect.any(AbortSignal)
    )
    expect(reply).toEqual({ answers: { db: { answers: ['Postgres'] }, why: { answers: [] } } })

    const skipped = await asked({ approvals: 'ask' }, { ask: vi.fn(async () => ({ kind: 'question' as const, skipped: true })) }, 'item/tool/requestUserInput', { itemId: 'q1', questions })
    expect(skipped.reply).toEqual({ answers: { db: { answers: [] }, why: { answers: [] } } })
  })

  it('declines an MCP form with a notice, and refuses what Foreman does not support', async () => {
    const elicitation = await asked({ approvals: 'ask' }, {}, 'mcpServer/elicitation/request', { serverName: 'docs' })
    expect(elicitation.reply).toEqual({ action: 'decline', content: null, _meta: null })
    expect(elicitation.r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ level: 'info', text: expect.stringContaining('form') })
    for (const method of ['item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'applyPatchApproval', 'execCommandApproval']) {
      expect((await asked({ approvals: 'ask' }, {}, method, {})).reply).toEqual({ rejected: `${method} is not supported by Foreman` })
    }
  })
})

describe('codex steering and stopping', () => {
  const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

  it('steers the turn in flight with its id, and says so when the message is not taken', async () => {
    const r = recorder()
    let steered: boolean[] = []
    let turn!: CodexTurn
    const server = new FakeServer([
      async (s, _p, id) => {
        s.emit('turn/started', { turn: { id } })
        steered = [turn.steer('and also this')]
        await sleep()
        // The turn ended just as the next message went out: Codex refuses it.
        s.answers['turn/steer'] = () => {
          throw new Error('no active turn to steer')
        }
        steered.push(turn.steer('too late'))
        await sleep()
        s.completed(id)
        steered.push(turn.steer('after the end'))
      }
    ])
    turn = new CodexTurn(request(), r.cb, () => server)
    expect(turn.steer('before it starts')).toBe(false)
    await turn.run()
    expect(steered).toEqual([true, true, false])
    expect(server.sent('turn/steer')[0]).toEqual({ threadId: THREAD, expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'and also this', text_elements: [] }] })
    const notice = r.persisted().find((i) => i.kind === 'notice')
    expect(notice).toMatchObject({ level: 'error', text: expect.stringContaining('too late') })
    expect(notice).toMatchObject({ text: expect.stringContaining('no active turn to steer') })
    expect(turn.steer('after the run')).toBe(false)
  })

  it('stops a running turn: interrupt, wait for Codex to confirm, then close', async () => {
    const r = recorder()
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const server = new FakeServer([
      (s, _p, id) => {
        s.started(id, command('item_0', { command: 'sleep 60' }))
        started()
      }
    ])
    server.answers['turn/interrupt'] = () => {
      setTimeout(() => server.completed('turn-1', 'interrupted'), 0)
      return {}
    }
    const turn = new CodexTurn(request(), r.cb, () => server)
    const done = turn.run()
    await running
    await turn.stop()
    await done
    expect(server.sent('turn/interrupt')).toEqual([{ threadId: THREAD, turnId: 'turn-1' }])
    const items = r.persisted()
    expect(items.find((i) => i.kind === 'notice')).toMatchObject({ level: 'info', text: 'Stopped.' })
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error', output: 'Interrupted.' })
    expect(items.some((i) => i.kind === 'result')).toBe(false)
    expect(r.calls.filter((c) => c === 'finished')).toHaveLength(1)
    expect(r.results).toEqual([{ ok: false, error: 'Stopped.' }])
    expect(server.closed).toBeGreaterThanOrEqual(1)
    expect(turn.steer('more')).toBe(false)
  })

  it('stops a turn that has not started yet', async () => {
    const r = recorder()
    const turn = new CodexTurn(request({ prompt: 'x' }), r.cb, () => new FakeServer())
    await turn.stop()
    await turn.run()
    expect(r.results).toEqual([{ ok: false, error: 'Stopped.' }])
  })

  it('treats an interrupt from outside as a stop', async () => {
    const r = recorder()
    const server = new FakeServer([(s, _p, id) => s.completed(id, 'interrupted')])
    await runTurn(request(), r.cb, server)
    expect(r.results).toEqual([{ ok: false, error: 'Stopped.' }])
    expect(r.persisted().some((i) => i.kind === 'result')).toBe(false)
    expect(server.closed).toBe(1)
  })
})

describe('codex plan mode', () => {
  const plan = (s: FakeServer, id: string, text = '1. Add the thing') => {
    s.started(id, { type: 'plan', id: 'plan-1', text: '' })
    s.finished(id, { type: 'plan', id: 'plan-1', text })
    s.completed(id)
  }
  const reviewing = (review: Awaited<ReturnType<TurnCallbacks['reviewPlan']>>) => vi.fn(async () => review)

  it('sends the plan collaboration mode only while plan mode is on', async () => {
    const on = new FakeServer()
    await runTurn(request({ planMode: true, effort: 'low' }), recorder().cb, on)
    expect(on.sent('turn/start')[0].collaborationMode).toEqual({ mode: 'plan', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'low', developer_instructions: null } })
    const off = new FakeServer()
    await runTurn(request(), recorder().cb, off)
    expect(off.sent('turn/start')[0]).not.toHaveProperty('collaborationMode')
  })

  it('approving the plan turns plan mode off and implements it on the same thread in one Foreman turn', async () => {
    const reviewPlan = reviewing({ kind: 'plan', approve: true })
    const planModeChanged = vi.fn()
    const r = recorder({ reviewPlan, planModeChanged })
    const server = new FakeServer([
      (s, _p, id) => plan(s, id),
      (s, _p, id) => {
        s.finished(id, agentMessage('m2', 'Implemented.'))
        s.completed(id)
      }
    ])
    await runTurn(request({ planMode: true, approvals: 'ask' }), r.cb, server)
    expect(reviewPlan).toHaveBeenCalledWith('1. Add the thing', expect.any(AbortSignal))
    expect(planModeChanged).toHaveBeenCalledWith(false)
    const [first, second] = server.sent('turn/start')
    expect(first.collaborationMode).toMatchObject({ mode: 'plan' })
    // Plan mode sticks to the thread, so the implementation turn leaves it explicitly.
    expect(second.collaborationMode).toMatchObject({ mode: 'default', settings: { model: 'gpt-6.1-sol', developer_instructions: null } })
    expect(second).toMatchObject({ threadId: THREAD, input: [{ type: 'text', text: 'Implement the plan.' }] })
    // One Foreman turn: the plan is in the transcript, one result and one finished come at the end.
    expect(r.persisted().find((i) => i.id === 't1:plan-1')).toMatchObject({ kind: 'assistant', text: '1. Add the thing' })
    expect(r.persisted().filter((i) => i.kind === 'result')).toHaveLength(1)
    expect(r.results).toEqual([{ ok: true }])
    expect(r.calls.indexOf('finished')).toBeGreaterThan(r.calls.indexOf('item:result'))
    expect(server.closed).toBe(1)
  })

  it('passes the user notes along when approving', async () => {
    const server = new FakeServer([(s, _p, id) => plan(s, id)])
    await runTurn(request({ planMode: true }), recorder({ reviewPlan: reviewing({ kind: 'plan', approve: true, feedback: 'use the helper' }) }).cb, server)
    expect(server.sent('turn/start')[1].input[0].text).toBe('Implement the plan.\n\nNotes from the user: use the helper')
  })

  it('feedback on the plan plans again, in plan mode', async () => {
    const reviewPlan = vi.fn().mockResolvedValueOnce({ kind: 'plan', approve: false, feedback: 'smaller steps' }).mockResolvedValueOnce({ kind: 'plan', approve: false })
    const planModeChanged = vi.fn()
    const r = recorder({ reviewPlan, planModeChanged })
    const server = new FakeServer([(s, _p, id) => plan(s, id), (s, _p, id) => plan(s, id, '1. Smaller')])
    await runTurn(request({ planMode: true }), r.cb, server)
    const turns = server.sent('turn/start')
    expect(turns).toHaveLength(2)
    expect(turns[1].input[0].text).toBe('Revise the plan. The user says: smaller steps')
    expect(turns[1].collaborationMode).toMatchObject({ mode: 'plan' })
    // Rejected again with nothing to say: the turn ends, still in plan mode.
    expect(reviewPlan).toHaveBeenCalledTimes(2)
    expect(planModeChanged).not.toHaveBeenCalled()
    expect(r.results).toEqual([{ ok: true }])
  })

  it('handing the plan off ends the turn after the plan', async () => {
    const server = new FakeServer([(s, _p, id) => plan(s, id)])
    const r = recorder({ reviewPlan: reviewing({ kind: 'plan', approve: false, handOff: true }) })
    await runTurn(request({ planMode: true }), r.cb, server)
    expect(server.sent('turn/start')).toHaveLength(1)
    expect(r.results).toEqual([{ ok: true }])
  })

  it('a read-only chat keeps the plan as text and never reviews it', async () => {
    const reviewPlan = vi.fn()
    const server = new FakeServer([(s, _p, id) => plan(s, id)])
    const r = recorder({ reviewPlan })
    await runTurn(request({ planMode: true, readOnly: true }), r.cb, server)
    expect(reviewPlan).not.toHaveBeenCalled()
    expect(server.sent('turn/start')).toHaveLength(1)
    expect(r.persisted().find((i) => i.id === 't1:plan-1')).toMatchObject({ text: '1. Add the thing' })
  })

  it('a plan-mode turn with no plan just ends', async () => {
    const reviewPlan = vi.fn()
    const server = new FakeServer([(s, _p, id) => (s.finished(id, agentMessage('m', 'A question first.')), s.completed(id))])
    await runTurn(request({ planMode: true }), recorder({ reviewPlan }).cb, server)
    expect(reviewPlan).not.toHaveBeenCalled()
    expect(server.sent('turn/start')).toHaveLength(1)
  })

  it('setPlanMode(false) during the plan turn makes the revise turn a normal one', async () => {
    let turn!: CodexTurn
    const server = new FakeServer([
      async (s, _p, id) => {
        await turn.setPlanMode(false)
        plan(s, id)
      },
      (s, _p, id) => s.completed(id)
    ])
    turn = new CodexTurn(request({ planMode: true }), recorder({ reviewPlan: reviewing({ kind: 'plan', approve: false, feedback: 'again' }) }).cb, () => server)
    await turn.run()
    const [first, second] = server.sent('turn/start')
    expect(first.collaborationMode).toMatchObject({ mode: 'plan' })
    expect(second.collaborationMode).toMatchObject({ mode: 'default' })
  })

  it('a resumed thread that is still in plan mode is taken out of it when plan mode is off', async () => {
    const server = new FakeServer()
    server.answers['thread/resume'] = (p) => ({ thread: { id: p.threadId }, model: 'gpt-6.1-sol', collaborationMode: { mode: 'plan', settings: { model: 'gpt-6.1-sol', reasoning_effort: null, developer_instructions: null } } })
    await runTurn(request({ resume: 'old-thread', effort: 'low' }), recorder().cb, server)
    expect(server.sent('turn/start')[0].collaborationMode).toEqual({ mode: 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: 'low', developer_instructions: null } })
  })

  it('a resumed thread that reports no mode, and a fresh thread, get no collaboration mode on an ordinary turn', async () => {
    const resumed = new FakeServer()
    await runTurn(request({ resume: 'old-thread' }), recorder().cb, resumed)
    expect(resumed.sent('turn/start')[0]).not.toHaveProperty('collaborationMode')
    const fresh = new FakeServer()
    await runTurn(request(), recorder().cb, fresh)
    expect(fresh.sent('turn/start')[0]).not.toHaveProperty('collaborationMode')
  })

  it('setModel applies from the next turn', async () => {
    let turn!: CodexTurn
    const server = new FakeServer([
      async (s, _p, id) => {
        await turn.setModel('gpt-5.5')
        plan(s, id)
      },
      (s, _p, id) => s.completed(id)
    ])
    turn = new CodexTurn(request({ planMode: true }), recorder({ reviewPlan: reviewing({ kind: 'plan', approve: true }) }).cb, () => server)
    await turn.run()
    expect(server.sent('turn/start').map((p) => p.model)).toEqual(['gpt-6.1-sol', 'gpt-5.5'])
  })
})

describe('codex model list', () => {
  it('pages through model/list and reads context windows', async () => {
    const server = new FakeServer()
    const pages = [
      { data: [{ id: 'a', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true }], nextCursor: 'next' },
      { data: [{ id: 'b', model: 'other', displayName: 'Other', description: 'd', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'minimal', serviceTiers: [{ id: 'priority' }], isDefault: false }], nextCursor: null }
    ]
    const cursors: unknown[] = []
    server.answers['model/list'] = (p) => {
      cursors.push(p.cursor)
      return pages[cursors.length - 1]
    }
    const home = await tempDir()
    const list = await listCodexModels({ cwd: CWD, env: { CODEX_HOME: home }, executablePath: process.execPath }, () => server)
    expect(cursors).toEqual([null, 'next'])
    expect(list.models.map((m) => [m.id, m.label, m.supportsFast])).toEqual([['gpt-6.1-sol', 'GPT-6.1 Sol', false], ['other', 'Other', true]])
    expect(server.closed).toBeGreaterThanOrEqual(1)
  })

  // Docs/agents.md 7.1: the windows are read between turns with `account/rateLimits/read`, which starts no turn.
  it('reads the account’s windows with account/rateLimits/read, and closes the process', async () => {
    const server = new FakeServer()
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    server.answers['account/rateLimits/read'] = () => ({
      rateLimits: { limitId: 'codex', primary: { usedPercent: 54, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: resetsAt + 86_400 } },
      rateLimitsByLimitId: null
    })
    const windows = await readCodexLimits({ cwd: CWD, env: {}, executablePath: process.execPath }, () => server)
    expect(windows.map((w) => [w.kind, w.usedPercent, w.state])).toEqual([['session', 54, 'ok'], ['weekly', 18, 'ok']])
    expect(server.calls.map((c) => c.method)).toEqual(['initialize', 'account/rateLimits/read'])
    expect(server.closed).toBeGreaterThanOrEqual(1)
    // An account with no plan windows (an API key) answers with an error: nothing to report, never a throw.
    const keyed = new FakeServer()
    keyed.answers['account/rateLimits/read'] = () => {
      throw new Error('codex account authentication required to read rate limits')
    }
    await expect(readCodexLimits({ cwd: CWD, env: {}, executablePath: process.execPath }, () => keyed)).resolves.toEqual([])
    expect(keyed.closed).toBeGreaterThanOrEqual(1)
  })

  it('closes the process when the list fails', async () => {
    const server = new FakeServer()
    server.answers['model/list'] = () => {
      throw new Error('not signed in')
    }
    await expect(listCodexModels({ cwd: CWD, env: {}, executablePath: process.execPath }, () => server)).rejects.toThrow('not signed in')
    expect(server.closed).toBeGreaterThanOrEqual(1)
  })
})

describe('codex status', () => {
  let fakeCli = ''
  const env = (home: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', CODEX_HOME: home, ...extra })

  async function cli(): Promise<string> {
    if (fakeCli) return fakeCli
    const dir = await tempDir()
    fakeCli = path.join(dir, 'codex')
    await writeFile(fakeCli, '#!/bin/sh\necho "codex-cli 9.9.9"\n')
    await chmod(fakeCli, 0o755)
    return fakeCli
  }

  const jwt = (claims: object) =>
    ['{"alg":"none"}', JSON.stringify(claims), 'sig'].map((part) => Buffer.from(part).toString('base64url')).join('.')

  it.skipIf(process.platform === 'win32')('reports a ChatGPT login without exposing tokens', async () => {
    const home = await tempDir()
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt({ email: 'dev@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
          access_token: 'secret-access-token',
          refresh_token: 'secret-refresh-token'
        }
      })
    )
    const status = await codexDriver.status(env(home), await cli())
    expect(status).toEqual({
      agent: 'codex',
      installed: true,
      ready: true,
      version: '9.9.9',
      method: 'ChatGPT login',
      account: 'dev@example.com · ChatGPT Pro',
      detail: undefined
    })
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it.skipIf(process.platform === 'win32')('reports an API key from auth.json or the environment', async () => {
    const home = await tempDir()
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-secret' }))
    const fromFile = await codexDriver.status(env(home), await cli())
    expect(fromFile).toMatchObject({ ready: true, method: 'API key', account: undefined })
    expect(JSON.stringify(fromFile)).not.toContain('sk-secret')

    const empty = await tempDir()
    expect(await codexDriver.status(env(empty, { CODEX_API_KEY: 'sk-env' }), await cli())).toMatchObject({ ready: true, method: 'API key' })
    expect(await codexDriver.status(env(empty), await cli())).toMatchObject({ installed: true, ready: false, detail: 'Not signed in' })
  })

  it('finds the bundled CLI and reports a missing one', async () => {
    const home = await tempDir()
    const bundled = await codexDriver.status(env(home))
    expect(bundled.installed).toBe(true)
    expect(bundled.version).toMatch(/^\d+\.\d+\.\d+/)
    const missing = await codexDriver.status(env(home), path.join(home, 'no-such-codex'))
    expect(missing).toMatchObject({ installed: false, ready: false })
  })
})

describe('codex custom prompts', () => {
  const saved = process.env.CODEX_HOME
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  })

  it('lists prompts with their descriptions', async () => {
    const home = await tempDir()
    await mkdir(path.join(home, 'prompts'))
    await writeFile(path.join(home, 'prompts', 'review.md'), '---\ndescription: "Review a file"\n---\nReview $1\n')
    await writeFile(path.join(home, 'prompts', 'plan.md'), '\n# Make a plan\n\nThen do it.\n')
    await writeFile(path.join(home, 'prompts', 'notes.txt'), 'ignored')
    process.env.CODEX_HOME = home
    expect(await codexDriver.slashCommands!(home)).toEqual([
      { name: 'prompts:plan', description: 'Make a plan' },
      { name: 'prompts:review', description: 'Review a file' }
    ])
  })
})

// Costs real tokens, so it only runs on request:
// FOREMAN_CODEX_SMOKE=1 npx vitest run tests/codex.test.ts
const smoke = process.env.FOREMAN_CODEX_SMOKE === '1' && existsSync(path.join(os.homedir(), '.codex', 'auth.json'))

describe.runIf(smoke)('codex smoke test', () => {
  it('runs one real turn', async () => {
    const repo = await makeRepo()
    const r = recorder()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    const turn = codexDriver.createTurn(
      request({
        turnId: 'smoke',
        prompt: 'Reply with just the word OK. Do not run any commands.',
        cwd: repo,
        env,
        effort: 'low',
        approvals: 'ask',
        systemPromptAppend: 'You are running inside Foreman (smoke test).'
      }),
      r.cb
    )
    await turn.run()
    const items = r.persisted()
    expect(r.calls.some((c) => c.startsWith('session:'))).toBe(true)
    expect(items.find((i) => i.kind === 'assistant')).toMatchObject({ text: expect.stringMatching(/OK/) })
    expect(items.find((i) => i.kind === 'result')).toMatchObject({ ok: true })
  }, 180_000)
})

describe('codex launch problems (docs/agents.md, 4.1)', () => {
  const UNKNOWN = 'Invalid request: unknown variant `thread/start`, expected one of `initialize`, `thread/resume`'

  /** A server that says what version it is, as the real one does in its initialize answer. */
  const versioned = (): FakeServer => {
    const server = new FakeServer()
    server.userAgent = 'foreman/0.140.0 (Windows 10.0.26200; x86_64) unknown (foreman; 1.0.0)'
    return server
  }

  it('says a request the CLI does not know is older than Foreman expects, offers Update, and keeps its own words in the result', async () => {
    const r = recorder()
    const server = versioned()
    server.answers['thread/start'] = () => {
      throw new Error(UNKNOWN)
    }
    await runTurn(request(), r.cb, server)
    expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({
      level: 'error',
      text: 'Codex 0.140.0 doesn’t know the request “thread/start”, so it is older than Foreman expects.',
      action: 'update'
    })
    expect(r.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('unknown variant') })
  })

  it('refuses a version the table lists as broken before it opens a thread', async () => {
    const table = catalogAgent('codex')!.versions!
    catalogAgent('codex')!.versions = { ...table, broken: [{ range: '<0.150.0', why: 'agentCaps.why.cost' }] }
    try {
      const r = recorder()
      const server = versioned()
      await runTurn(request(), r.cb, server)
      expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ level: 'error', text: expect.stringContaining('Codex 0.140.0 doesn’t work with Foreman'), action: 'update' })
      expect(server.sent('thread/start')).toEqual([])
      expect(r.results).toEqual([{ ok: false, error: expect.stringContaining('Codex 0.140.0') }])
      expect(server.closed).toBe(1)
    } finally {
      catalogAgent('codex')!.versions = table
    }
  })

  it('refuses a model the table says needs a newer CLI, naming the model and the installed version', async () => {
    const table = catalogAgent('codex')!.versions!
    catalogAgent('codex')!.versions = { ...table, models: { 'gpt-6.1-sol': '0.170.0' } }
    try {
      const r = recorder()
      const server = versioned()
      await runTurn(request(), r.cb, server)
      expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ level: 'error', text: 'GPT-6.1 Sol needs a newer Codex than 0.140.0.', action: 'update' })
      expect(server.sent('thread/start')).toEqual([])
    } finally {
      catalogAgent('codex')!.versions = table
    }
  })

  it('goes on with a version the table has no complaint about', async () => {
    const r = recorder()
    await runTurn(request(), r.cb, versioned())
    expect(r.persisted().find((i) => i.kind === 'result')).toMatchObject({ ok: true })
  })
})

describe('codex scoped writes (docs/agents.md 8)', () => {
  const scoped = { writeScope: ['docs/**', 'notes/*.md'], approvals: 'ask' as const }

  /** One turn held to the globs in which the server asks `method`: the driver's reply, and what it said into the turn about it. */
  async function askedScoped(req: Partial<TurnRequest>, method: string, params: Params, before?: (s: FakeServer) => void, cb: Partial<TurnCallbacks> = {}) {
    let reply: unknown
    const r = recorder(cb)
    const server = new FakeServer([
      async (s, _p, id) => {
        before?.(s)
        reply = await s.ask(method, { turnId: id, ...params }, 7).catch((e: Error) => ({ rejected: e.message }))
        // The message goes in just after the answer, while the turn is still going.
        await new Promise((resolve) => setTimeout(resolve, 20))
        s.completed(id)
      }
    ])
    await runTurn(request({ ...scoped, ...req }), r.cb, server)
    const said = server.sent('turn/steer').map((p) => (p.input[0] as { text: string }).text)
    return { reply, r, server, said }
  }

  it('runs in the read-only sandbox with on-request approvals, whatever the chat’s approval setting', () => {
    for (const approvals of ['ask', 'ask-except-edits', 'never-ask', 'auto'] as const) {
      const { sandbox, sandboxPolicy, approvalPolicy, thread } = codexSettings(request({ ...scoped, approvals }))
      expect({ sandbox, approvalPolicy }).toEqual({ sandbox: 'read-only', approvalPolicy: 'on-request' })
      expect(sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: true })
      expect(thread).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' })
    }
    // No network under a ceiling, as in the workspace sandbox.
    expect(codexSettings(request({ ...scoped, capped: { gitDir: '/repo/.git' } as never })).sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
    // No globs, nothing changes; read-only wins and stays offline and never asks.
    expect(codexSettings(request({ approvals: 'ask' })).sandbox).toBe('workspace-write')
    expect(codexSettings(request({ ...scoped, readOnly: true }))).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    expect(codexSettings(request({ writeScope: [], approvals: 'never-ask' })).sandbox).toBe('danger-full-access')
  })

  it('sets repo MCP servers to prompt, Foreman’s own excepted, and declines the prompt', async () => {
    const servers = { sentry: { command: 'node', args: [], env: {} }, 'foreman-app': { command: 'node', args: [], env: {} } }
    const config = codexSettings(request({ ...scoped, mcpServers: servers })).config.mcp_servers as Record<string, { default_tools_approval_mode: string }>
    expect(config.sentry.default_tools_approval_mode).toBe('prompt')
    expect(config['foreman-app'].default_tools_approval_mode).toBe('approve')
    expect((codexSettings(request({ mcpServers: servers })).config.mcp_servers as typeof config).sentry.default_tools_approval_mode).toBe('approve')

    const approveTool = vi.fn()
    const { reply, said } = await askedScoped(
      {},
      'item/tool/requestUserInput',
      {
        itemId: 'q1',
        questions: [{ id: 'mcp_tool_call_approval_1', header: 'Approve app tool call?', question: 'Allow the sentry MCP server to run tool "search"?', isOther: false, isSecret: false, options: [{ label: 'Allow', description: '' }, { label: 'Cancel', description: '' }] }]
      },
      undefined,
      { approveTool }
    )
    expect(reply).toEqual({ answers: { mcp_tool_call_approval_1: { answers: [] } } })
    expect(approveTool).not.toHaveBeenCalled()
    expect(said[0]).toContain('MCP server’s tools run outside the sandbox')
  })

  it('accepts a file change whose every file is inside the globs, without asking the person', async () => {
    const approveTool = vi.fn()
    const { reply, said } = await askedScoped(
      {},
      'item/fileChange/requestApproval',
      { itemId: 'f1' },
      (s) => s.started('turn-1', fileChange('f1', [change('docs/a.md', 'add'), change(path.join(CWD, 'docs/deep/b.md'), 'update'), change('notes/x.md', 'add')])),
      { approveTool }
    )
    expect(reply).toEqual({ decision: 'accept' })
    expect(said).toEqual([])
    expect(approveTool).not.toHaveBeenCalled()
  })

  it('declines a change with any file outside them, naming it and the area in a message to the agent, and never asks the person', async () => {
    for (const [file, named] of [['src/main.ts', 'src/main.ts'], ['../other/docs/a.md', path.resolve(CWD, '../other/docs/a.md')], ['notes/deep/x.md', 'notes/deep/x.md'], ['docs/../src/x.ts', 'src/x.ts']] as const) {
      const approveTool = vi.fn()
      const { reply, said } = await askedScoped(
        {},
        'item/fileChange/requestApproval',
        { itemId: 'f1' },
        (s) => s.started('turn-1', fileChange('f1', [change('docs/ok.md', 'add'), change(file, 'add')])),
        { approveTool }
      )
      expect(reply, file).toEqual({ decision: 'decline' })
      expect(approveTool).not.toHaveBeenCalled()
      expect(said, file).toHaveLength(1)
      expect(said[0]).toContain(`writing “${named}” is outside the folders this step may write in`)
      expect(said[0]).toContain('allowed only inside docs/**, notes/*.md')
      expect(said[0]).toContain('Carry on.')
    }
  })

  it('declines a change that names no file, or asks for a whole folder', async () => {
    const none = await askedScoped({}, 'item/fileChange/requestApproval', { itemId: 'f1' })
    expect(none.reply).toEqual({ decision: 'decline' })
    expect(none.said[0]).toContain('it names no file to write')
    const root = await askedScoped({}, 'item/fileChange/requestApproval', { itemId: 'f2', grantRoot: 'docs' })
    expect(root.reply).toEqual({ decision: 'decline' })
    expect(root.said[0]).toContain('whole folder')
  })

  it('declines a write inside the globs that a ceiling protects (agent or git configuration)', async () => {
    const capped = { gitDir: path.resolve('/repos/app/.git') } as never
    const { reply, said } = await askedScoped({ capped, writeScope: ['**'] }, 'item/fileChange/requestApproval', { itemId: 'f1' }, (s) => s.started('turn-1', fileChange('f1', [change('.codex/config.toml', 'update')])))
    expect(reply).toEqual({ decision: 'decline' })
    expect(said[0]).toContain('agent or git configuration')
    const fine = await askedScoped({ capped, writeScope: ['**'] }, 'item/fileChange/requestApproval', { itemId: 'f2' }, (s) => s.started('turn-1', fileChange('f2', [change('src/a.ts', 'update')])))
    expect(fine.reply).toEqual({ decision: 'accept' })
  })

  it('declines every command that asks, and every request for more access, with the reason', async () => {
    const approveTool = vi.fn()
    const command = await askedScoped({}, 'item/commandExecution/requestApproval', { itemId: 'c1', command: 'npm run build', cwd: CWD, reason: 'needs to write dist' }, undefined, { approveTool })
    expect(command.reply).toEqual({ decision: 'decline' })
    expect(command.said[0]).toContain('the command “npm run build” needs to write or to leave the sandbox')
    const more = await askedScoped({}, 'item/permissions/requestApproval', { itemId: 'p1', cwd: CWD, reason: null, permissions: { network: { enabled: true }, fileSystem: null } }, undefined, { approveTool })
    expect(more.reply).toEqual({ permissions: {}, scope: 'turn' })
    expect(more.said[0]).toContain('more access than the sandbox gives')
    expect(approveTool).not.toHaveBeenCalled()
  })

  it('leaves a turn with no scope, and a read-only turn, as they were', async () => {
    const approveTool = vi.fn(async () => ({ kind: 'tool', allow: true }) as const)
    const plain = await askedScoped({ writeScope: undefined }, 'item/commandExecution/requestApproval', { itemId: 'c1', command: 'ls', cwd: CWD }, undefined, { approveTool })
    expect(plain.reply).toEqual({ decision: 'accept' })
    expect(plain.said).toEqual([])
    const readOnly = await askedScoped({ readOnly: true }, 'item/fileChange/requestApproval', { itemId: 'f1' }, (s) => s.started('turn-1', fileChange('f1', [change('docs/a.md', 'add')])))
    expect(readOnly.reply).toEqual({ decision: 'decline' })
    expect(readOnly.said).toEqual([])
  })
})

describe('codex on Windows: the sandbox’s readiness (docs/agents.md 8)', () => {
  const windows = (status: string | Error): FakeServer => {
    const server = new FakeServer()
    server.platformOs = 'windows'
    server.answers['windowsSandbox/readiness'] = () => {
      if (status instanceof Error) throw status
      return { status }
    }
    return server
  }

  it('reads it at start on Windows, with no params, and declares it for the account', async () => {
    const declared: unknown[] = []
    const r = recorder({ declared: (facts) => void declared.push(facts) })
    const server = windows('ready')
    await runTurn(request(), r.cb, server)
    expect(server.calls.map((c) => c.method).slice(0, 3)).toEqual(['initialize', 'windowsSandbox/readiness', 'thread/start'])
    expect(server.sent('windowsSandbox/readiness')).toEqual([undefined])
    expect(declared).toEqual([{ windowsSandbox: 'ready' }])
    expect(r.persisted().find((i) => i.kind === 'result')).toMatchObject({ ok: true })
  })

  it('declares "not-ready" for a sandbox that was never set up or needs an update, and a turn that promises nothing still runs', async () => {
    for (const status of ['notConfigured', 'updateRequired']) {
      const declared: unknown[] = []
      const r = recorder({ declared: (facts) => void declared.push(facts) })
      const server = windows(status)
      await runTurn(request(), r.cb, server)
      expect(declared, status).toEqual([{ windowsSandbox: 'not-ready' }])
      expect(server.sent('thread/start'), status).toHaveLength(1)
    }
  })

  it('does not start a read-only or scoped-writes turn on a sandbox that is not ready, and says why', async () => {
    for (const [patch, what] of [[{ readOnly: true }, 'hold this chat to read-only'], [{ writeScope: ['docs/**'] }, 'hold this step to the folders it may write in']] as [Partial<TurnRequest>, string][]) {
      const r = recorder()
      const server = windows('notConfigured')
      await runTurn(request(patch), r.cb, server)
      expect(server.sent('thread/start')).toEqual([])
      expect(r.results).toEqual([{ ok: false, error: expect.stringContaining(what) }])
      expect(r.results[0]).toMatchObject({ error: expect.stringContaining('isn’t set up') })
      expect(server.closed).toBe(1)
    }
    const r = recorder()
    await runTurn(request({ readOnly: true }), r.cb, windows('updateRequired'))
    expect(r.results[0]).toMatchObject({ error: expect.stringContaining('needs an update') })
  })

  it('lets a read-only turn go on where the sandbox is ready', async () => {
    const r = recorder()
    const server = windows('ready')
    await runTurn(request({ readOnly: true }), r.cb, server)
    expect(server.sent('thread/start')).toHaveLength(1)
    expect(r.results).toEqual([{ ok: true }])
  })

  it('reads nothing off Windows, and declares nothing when the answer cannot be read', async () => {
    const declared: unknown[] = []
    const r = recorder({ declared: (facts) => void declared.push(facts) })
    const mac = windows('notConfigured')
    mac.platformOs = 'macos'
    await runTurn(request({ readOnly: true }), r.cb, mac)
    expect(mac.sent('windowsSandbox/readiness')).toEqual([])
    const quiet = windows(new Error('Method not found'))
    await runTurn(request({ readOnly: true }), r.cb, quiet)
    expect(declared).toEqual([])
    expect(quiet.sent('thread/start')).toHaveLength(1)
  })

  it('names the states by what the protocol says: only "ready" holds', () => {
    expect(windowsSandboxFact('ready')).toEqual({ windowsSandbox: 'ready' })
    expect(windowsSandboxFact('notConfigured')).toEqual({ windowsSandbox: 'not-ready' })
    expect(windowsSandboxFact('updateRequired')).toEqual({ windowsSandbox: 'not-ready' })
  })
})

describe('codex update command', () => {
  it('runs Codex’s own `update` on the program the user set, else on the one on PATH, quoted for the shell', () => {
    expect(codexDriver.updateCommand?.('/opt/my codex/codex')).toMatch(/^['"]?\/opt\/my codex\/codex['"]? update$/)
    expect(codexDriver.updateCommand?.()).toMatch(/^['"]codex['"] update$/)
  })
})

// ---- docs/agents.md 3 (slice 4a): fork, rollback, compaction and goals ----

describe('codex slash commands that go to the protocol', () => {
  it('reads /compact, /goal <text>, /goal pause|resume|clear and a bare /goal, and nothing else', () => {
    expect(threadCommand('/compact')).toEqual({ name: 'compact' })
    expect(threadCommand('  /compact keep the API notes')).toEqual({ name: 'compact' })
    expect(threadCommand('/goal get the tests passing')).toEqual({ name: 'goal', objective: 'get the tests passing' })
    expect(threadCommand('/GOAL Clear')).toEqual({ name: 'goal-clear' })
    expect(threadCommand('/goal pause')).toEqual({ name: 'goal-pause' })
    expect(threadCommand('/goal resume')).toEqual({ name: 'goal-resume' })
    expect(threadCommand('/goal')).toEqual({ name: 'goal-usage' })
    // Only the first line is the objective: what Foreman appends after it (notes, attachments) is not.
    expect(threadCommand('/goal ship it\n\n[attached: a.png]')).toEqual({ name: 'goal', objective: 'ship it' })
    for (const text of ['hello', 'please /compact', '/compacted', '/goals', '/plan']) expect(threadCommand(text), text).toBeUndefined()
  })
})

describe('codex fork and rollback', () => {
  it('forks through the turn the conversation stood at, with the thread settings, and carries on in the fork', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/fork'] = () => ({ thread: { id: 'forked' }, model: 'gpt-6.1-sol' })
    await runTurn(request({ resume: 'parent', resumeAt: 'turn-9' }), r.cb, server)
    expect(server.sent('thread/resume')).toEqual([])
    expect(server.sent('thread/start')).toEqual([])
    expect(server.sent('thread/fork')).toEqual([expect.objectContaining({ threadId: 'parent', lastTurnId: 'turn-9', excludeTurns: true, cwd: CWD, model: 'gpt-6.1-sol' })])
    expect(r.calls).toContain('session:forked')
    expect(server.sent('turn/start')[0]).toMatchObject({ threadId: 'forked' })
  })

  it('reports the turn each Codex turn ended at, for Restore and forks to cut at', async () => {
    const points: string[] = []
    const r = recorder({ assistantMessage: (id) => void points.push(id) })
    await runTurn(request(), r.cb, new FakeServer())
    expect(points).toEqual(['turn-1'])
  })

  it('Restore: resumes, lists the turns, and reverts before the one after the turn it keeps', async () => {
    const r = recorder()
    const server = new FakeServer()
    // Newest first, as thread/turns/list answers; two pages.
    server.answers['thread/turns/list'] = (p) => (p.cursor ? { data: [{ id: 'turn-3' }, { id: 'turn-2' }], nextCursor: null } : { data: [{ id: 'turn-5' }, { id: 'turn-4' }], nextCursor: 'more' })
    await runTurn(request({ resume: 'mine', resumeAt: 'turn-3', rewind: true }), r.cb, server)
    expect(server.sent('thread/resume')).toHaveLength(1)
    expect(server.sent('thread/fork')).toEqual([])
    expect(server.sent('thread/turns/list')).toHaveLength(2)
    expect(server.sent('thread/revert')).toEqual([{ threadId: 'mine', beforeTurnId: 'turn-4' }])
    expect(r.calls).toContain('session:mine')
  })

  it('Restore to the newest turn has nothing to cut', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/turns/list'] = () => ({ data: [{ id: 'turn-3' }, { id: 'turn-2' }], nextCursor: null })
    await runTurn(request({ resume: 'mine', resumeAt: 'turn-3', rewind: true }), r.cb, server)
    expect(server.sent('thread/revert')).toEqual([])
    expect(r.calls).toContain('session:mine')
  })

  it('Restore to a turn the thread no longer has starts a new conversation, and says so', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/turns/list'] = () => ({ data: [{ id: 'turn-3' }], nextCursor: null })
    await runTurn(request({ resume: 'mine', resumeAt: 'gone', rewind: true }), r.cb, server)
    expect(server.sent('thread/revert')).toEqual([])
    expect(server.sent('thread/start')).toHaveLength(1)
    expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ level: 'info', text: expect.stringContaining('starts a new one') })
    expect(r.calls).toContain(`session:${THREAD}`)
  })
})

describe('codex /compact', () => {
  it('compacts the thread through thread/compact/start and shows the divider, without sending the text to the model', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/compact/start'] = () => {
      setTimeout(() => {
        server.emit('turn/started', { turn: { id: 'c1' } })
        server.finished('c1', { type: 'contextCompaction', id: 'cc' })
        server.completed('c1')
      }, 0)
      return {}
    }
    await runTurn(request({ prompt: '/compact', resume: 'mine' }), r.cb, server)
    expect(server.sent('thread/compact/start')).toEqual([{ threadId: 'mine' }])
    expect(server.sent('turn/start')).toEqual([])
    expect(r.persisted().flatMap((i) => (i.kind === 'notice' && i.divider ? [i.divider] : []))).toEqual([{ kind: 'compact' }])
    expect(r.results).toEqual([{ ok: true }])
  })

  it('says there is nothing to compact in a conversation that has not started', async () => {
    const r = recorder()
    const server = new FakeServer()
    await runTurn(request({ prompt: '/compact' }), r.cb, server)
    expect(server.sent('thread/compact/start')).toEqual([])
    expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ text: 'There is nothing to compact yet.' })
    expect(r.results).toEqual([{ ok: true }])
  })
})

describe('codex goals', () => {
  const goal = (status: string, extra: Params = {}) => ({ threadId: THREAD, objective: 'ship it', status, tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2, ...extra })
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

  /** What Codex does after thread/goal/set: the goal is active, and it takes turns of its own until it marks it complete. */
  function working(server: FakeServer, turns: number) {
    server.answers['thread/goal/set'] = (p) => {
      if (p.status === 'paused') {
        setTimeout(() => server.emit('thread/goal/updated', { turnId: null, goal: goal('paused') }), 0)
        return { goal: goal('paused') }
      }
      setTimeout(async () => {
        server.emit('thread/goal/updated', { turnId: null, goal: goal('active') })
        for (let n = 1; n <= turns; n++) {
          server.emit('turn/started', { turn: { id: `g${n}` } })
          server.finished(`g${n}`, agentMessage(`m${n}`, `step ${n}`))
          if (n === turns) server.emit('thread/goal/updated', { turnId: `g${n}`, goal: goal('complete', { tokensUsed: 99 }) })
          server.completed(`g${n}`)
          await tick(0)
        }
      }, 0)
      return { goal: goal('active') }
    }
  }

  /** A goal that starts one turn and then waits to be stopped or cleared. */
  function started(server: FakeServer) {
    server.answers['thread/goal/set'] = (p) => {
      if (p.status !== 'paused') {
        setTimeout(() => {
          server.emit('thread/goal/updated', { turnId: null, goal: goal('active') })
          server.emit('turn/started', { turn: { id: 'g1' } })
        }, 0)
      }
      return { goal: goal(p.status ?? 'active') }
    }
    server.answers['turn/interrupt'] = () => {
      setTimeout(() => server.completed('g1', 'interrupted'), 0)
      return {}
    }
  }

  it('sets the goal, stays open for the turns Codex takes by itself, and ends when the goal is complete', async () => {
    const goals: unknown[] = []
    const points: string[] = []
    const r = recorder({ goal: (g) => void goals.push(g), assistantMessage: (id) => void points.push(id) })
    const server = new FakeServer()
    working(server, 3)
    await runTurn(request({ prompt: '/goal ship it' }), r.cb, server)
    expect(server.sent('thread/goal/set')).toEqual([{ threadId: THREAD, objective: 'ship it', origin: 'user' }])
    // Foreman asked for no turn of its own: Codex's goal started all three.
    expect(server.sent('turn/start')).toEqual([])
    expect(r.persisted().filter((i) => i.kind === 'assistant').map((i) => (i as { text: string }).text)).toEqual(['step 1', 'step 2', 'step 3'])
    expect(points).toEqual(['g1', 'g2', 'g3'])
    expect(goals.map((g) => (g as { status: string }).status)).toEqual(['active', 'complete'])
    expect(goals.at(-1)).toEqual({ objective: 'ship it', status: 'complete', tokensUsed: 99, timeUsedSeconds: 2 })
    // The result is the one turn's, once; and a goal that finished has nothing to pause.
    expect(r.results).toEqual([{ ok: true }])
    expect(server.sent('thread/goal/set')).toHaveLength(1)
  })

  it('Stop pauses a goal that is still active, so the thread does not start it again on its own when it is resumed', async () => {
    const r = recorder()
    const server = new FakeServer()
    started(server)
    const turn = new CodexTurn(request({ prompt: '/goal ship it' }), r.cb, () => server)
    const done = turn.run()
    await vi.waitFor(() => expect(server.sent('thread/goal/set')).toHaveLength(1))
    await tick()
    await turn.stop()
    await done
    expect(server.sent('turn/interrupt')).toEqual([{ threadId: THREAD, turnId: 'g1' }])
    expect(server.sent('thread/goal/set').at(-1)).toEqual({ threadId: THREAD, status: 'paused', origin: 'user' })
  })

  it('/goal clear sent into the running goal clears it at once, and says nothing to the model', async () => {
    const goals: unknown[] = []
    const r = recorder({ goal: (g) => void goals.push(g) })
    const server = new FakeServer()
    started(server)
    server.answers['thread/goal/clear'] = () => ({ cleared: true })
    const turn = new CodexTurn(request({ prompt: '/goal ship it' }), r.cb, () => server)
    const done = turn.run()
    await vi.waitFor(() => expect(goals).toHaveLength(1))
    await tick()
    expect(turn.steer('/goal clear')).toBe(true)
    await vi.waitFor(() => expect(goals.at(-1)).toBeNull())
    expect(server.sent('turn/steer')).toEqual([])
    expect(server.sent('thread/goal/clear')).toEqual([{ threadId: THREAD, origin: 'user' }])
    await turn.stop()
    await done
  })

  it('/goal clear as a message of its own clears the goal and ends the turn', async () => {
    const goals: unknown[] = []
    const r = recorder({ goal: (g) => void goals.push(g) })
    const server = new FakeServer()
    server.answers['thread/goal/clear'] = () => ({ cleared: true })
    await runTurn(request({ prompt: '/goal clear', resume: 'mine' }), r.cb, server)
    expect(server.sent('thread/goal/clear')).toHaveLength(1)
    expect(goals).toEqual([null])
    expect(r.results).toEqual([{ ok: true }])
  })

  it('/goal pause and /goal resume set the status, and resume goes on to follow what Codex does next', async () => {
    const r = recorder()
    const server = new FakeServer()
    working(server, 1)
    await runTurn(request({ prompt: '/goal resume', resume: 'mine' }), r.cb, server)
    expect(server.sent('thread/goal/set')[0]).toEqual({ threadId: 'mine', status: 'active', origin: 'user' })
    expect(r.persisted().filter((i) => i.kind === 'assistant')).toHaveLength(1)

    const p = recorder()
    const paused = new FakeServer()
    working(paused, 1)
    await runTurn(request({ prompt: '/goal pause', resume: 'mine' }), p.cb, paused)
    expect(paused.sent('thread/goal/set')).toEqual([{ threadId: 'mine', status: 'paused', origin: 'user' }])
    expect(p.results).toEqual([{ ok: true }])
  })
})

describe('codex fork and rollback: when Codex cannot', () => {
  it('a fork Codex cannot make starts a new conversation and says so, rather than failing every message after it', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/fork'] = () => {
      throw new Error('thread not found: parent')
    }
    await runTurn(request({ resume: 'parent', resumeAt: 'turn-9' }), r.cb, server)
    expect(server.sent('thread/resume')).toEqual([])
    expect(server.sent('thread/start')).toHaveLength(1)
    expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ level: 'info', text: expect.stringContaining('could not fork') })
    expect(r.calls).toContain(`session:${THREAD}`)
    expect(r.results).toEqual([{ ok: true }])
  })

  it('a CLI that does not know thread/fork is a launch problem of the turn, not a fork to fall back from', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/fork'] = () => {
      throw new Error('Invalid request: unknown variant `thread/fork`, expected one of `initialize`, `thread/start`')
    }
    await runTurn(request({ resume: 'parent', resumeAt: 'turn-9' }), r.cb, server)
    expect(server.sent('thread/start')).toEqual([])
    expect(r.results[0]).toMatchObject({ ok: false })
  })

  it('a thread whose turns cannot be listed starts a new conversation on Restore, and says so', async () => {
    const r = recorder()
    const server = new FakeServer()
    server.answers['thread/turns/list'] = () => {
      throw new Error('thread not found')
    }
    await runTurn(request({ resume: 'mine', resumeAt: 'turn-3', rewind: true }), r.cb, server)
    expect(server.sent('thread/revert')).toEqual([])
    expect(server.sent('thread/start')).toHaveLength(1)
    expect(r.persisted().find((i) => i.kind === 'notice')).toMatchObject({ text: expect.stringContaining('starts a new one') })
  })
})

describe('codex goals: commands sent while it works, and a pause the card sees', () => {
  const goal = (status: string) => ({ threadId: THREAD, objective: 'ship it', status, tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 })

  it('/goal <text> sent into a running turn sets the goal and is not said to the model', async () => {
    const r = recorder()
    const server = new FakeServer([async (s, _p, id) => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      s.completed(id)
    }])
    server.answers['thread/goal/set'] = () => ({ goal: goal('active') })
    const turn = new CodexTurn(request({ prompt: 'work on it' }), r.cb, () => server)
    const done = turn.run()
    await vi.waitFor(() => expect(server.sent('turn/start')).toHaveLength(1))
    expect(turn.steer('/goal ship it')).toBe(true)
    await vi.waitFor(() => expect(server.sent('thread/goal/set')).toHaveLength(1))
    expect(server.sent('thread/goal/set')[0]).toEqual({ threadId: THREAD, objective: 'ship it', origin: 'user' })
    expect(server.sent('turn/steer')).toEqual([])
    await done
  })

  it('a goal left active when the turn ends is paused, and the card shows it paused without waiting for the notification', async () => {
    const goals: unknown[] = []
    const r = recorder({ goal: (g) => void goals.push(g) })
    const server = new FakeServer([async (s, _p, id) => {
      s.emit('thread/goal/updated', { turnId: id, goal: goal('active') })
      s.completed(id, 'interrupted')
    }])
    server.answers['thread/goal/set'] = (p) => ({ goal: goal(p.status ?? 'active') })
    await runTurn(request({ prompt: 'work on it' }), r.cb, server)
    expect(server.sent('thread/goal/set').at(-1)).toEqual({ threadId: THREAD, status: 'paused', origin: 'user' })
    expect(goals.map((g) => (g as { status: string }).status)).toEqual(['active', 'paused'])
  })
})
