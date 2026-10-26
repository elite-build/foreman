// #16 Read-only Second opinion: enforced on Claude (plan mode it can't leave) and Codex (read-only sandbox),
// not offered for Cursor and OpenCode, and passed through O10's background host.
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { codexDriver, codexOptions } from '../src/main/agents/codex'
import { registerDriver } from '../src/main/agents/registry'
import type { TurnCallbacks, TurnRequest } from '../src/main/agents/types'
import { HostClient } from '../src/main/agentHost/client'
import { HostServer } from '../src/main/agentHost/server'
import { AgentHostService } from '../src/main/agentHost/service'
import { HandOffService } from '../src/main/handOffs'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import { AGENTS, AGENT_ORDER } from '../src/shared/agents'
import { readOnlyEnforcement } from '../src/shared/permissions'
import type { ChatItem, Session, Workspace } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'
import { fakeDriver, setupSessions } from './sessionHarness'

// No Claude Code here: `query` is replaced by a stub that records its options and asks about tools.
const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

type Options = {
  permissionMode: string
  disallowedTools: string[]
  canUseTool: (name: string, input: Record<string, unknown>, extra: { signal: AbortSignal; suggestions?: unknown[] }) => Promise<{ behavior: string; message?: string; updatedPermissions?: unknown[] }>
  abortController: AbortController
}

/** A Claude stand-in: records the options, lets the test ask about tools mid-turn, then ends ok. */
function stubClaude(probe: (options: Options, q: { setPermissionMode: ReturnType<typeof vi.fn> }) => Promise<void> = async () => {}) {
  const seen: Options[] = []
  sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    seen.push(options)
    const iterator = prompt[Symbol.asyncIterator]()
    const q = {
      async *[Symbol.asyncIterator]() {
        await iterator.next()
        yield { type: 'system', subtype: 'init', session_id: 'claude-1', uuid: 'u0' } as unknown as SDKMessage
        await probe(options, q)
        yield { type: 'assistant', parent_tool_use_id: null, uuid: 'u1', session_id: 'claude-1', message: { id: 'm1', content: [{ type: 'text', text: 'my opinion' }] } } as unknown as SDKMessage
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1, result: 'ok', uuid: 'u2', session_id: 'claude-1' } as unknown as SDKMessage
      },
      interrupt: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100 })),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined)
    }
    return q
  })
  return seen
}

function callbacks() {
  return {
    item: vi.fn(),
    sessionStarted: vi.fn(),
    assistantMessage: vi.fn(),
    approveTool: vi.fn(async () => ({ kind: 'tool' as const, allow: true, alternate: true })),
    reviewPlan: vi.fn(async () => ({ kind: 'plan' as const, approve: true })),
    ask: vi.fn(),
    planModeChanged: vi.fn(),
    autoAcceptEdits: vi.fn(),
    usage: vi.fn(),
    finished: vi.fn()
  } satisfies TurnCallbacks
}

const claudeRequest = (patch: Partial<TurnRequest> = {}): TurnRequest => ({
  turnId: 't1',
  prompt: 'give me a second opinion',
  cwd: process.cwd(),
  env: {},
  model: 'claude-opus-5-5',
  fastMode: false,
  planMode: false,
  // Even "tools run without approval" can't lift read-only.
  approvals: 'never-ask',
  systemPromptAppend: '',
  ...patch
})

const ask = (options: Options, name: string, input: Record<string, unknown> = {}, suggestions?: unknown[]) =>
  options.canUseTool(name, input, { signal: options.abortController.signal, suggestions })

afterEach(() => {
  sdk.query.mockReset()
  registerDriver(claudeDriver)
  registerDriver(codexDriver)
})

describe('which agents offer read-only', () => {
  it('Claude and Codex enforce it; Cursor and OpenCode can’t, so it is hidden for them', () => {
    expect(AGENT_ORDER.filter((a) => AGENTS[a].supportsReadOnly)).toEqual(['claude', 'codex'])
    expect(readOnlyEnforcement('claude')).toBe('plan')
    expect(readOnlyEnforcement('codex')).toBe('sandbox')
    expect(readOnlyEnforcement('cursor')).toBeNull()
    expect(readOnlyEnforcement('opencode')).toBeNull()
  })
})

describe('Claude read-only: plan mode it can’t leave', () => {
  it('starts in plan mode whatever the approval setting, and drops ExitPlanMode and the write tools', async () => {
    const seen = stubClaude()
    const cb = callbacks()
    await claudeDriver.createTurn(claudeRequest({ readOnly: true }), cb).run()
    expect(seen[0].permissionMode).toBe('plan')
    expect(seen[0].disallowedTools).toEqual(expect.arrayContaining(['AskUserQuestion', 'ExitPlanMode', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']))
    expect(cb.finished).toHaveBeenCalledWith({ ok: true })
  })

  it('refuses ExitPlanMode and every write or edit tool without asking; other tools still go through approvals', async () => {
    const decisions: Record<string, { behavior: string; message?: string; updatedPermissions?: unknown[] }> = {}
    const cb = callbacks()
    stubClaude(async (options) => {
      for (const name of ['ExitPlanMode', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']) decisions[name] = await ask(options, name, { plan: 'do it' })
      // "Always allow" on a read-only chat never carries a mode change.
      decisions.Bash = await ask(options, 'Bash', { command: 'git log' }, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }])
    })
    await claudeDriver.createTurn(claudeRequest({ readOnly: true }), cb).run()
    for (const name of ['ExitPlanMode', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
      expect(decisions[name]).toMatchObject({ behavior: 'deny', message: expect.stringContaining('read-only') })
    }
    // Denied outright: the plan was never offered for approval, and plan mode never turned off.
    expect(cb.reviewPlan).not.toHaveBeenCalled()
    expect(cb.planModeChanged).not.toHaveBeenCalled()
    expect(cb.approveTool).toHaveBeenCalledTimes(1)
    expect(decisions.Bash).toMatchObject({ behavior: 'allow' })
    expect(decisions.Bash.updatedPermissions).toEqual([{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }])
  })

  it('ignores a request to turn plan mode off mid-turn', async () => {
    let calls = -1
    const cb = callbacks()
    const turn = claudeDriver.createTurn(claudeRequest({ readOnly: true }), cb)
    stubClaude(async (_options, q) => {
      await turn.setPlanMode(false)
      calls = q.setPermissionMode.mock.calls.length
    })
    await turn.run()
    expect(calls).toBe(0)
  })

  it('without read-only, plain plan mode still exits into implementation after approval (the gap read-only closes)', async () => {
    let exit: { behavior: string } | undefined
    const cb = callbacks()
    stubClaude(async (options) => {
      exit = await ask(options, 'ExitPlanMode', { plan: 'do it' })
    })
    await claudeDriver.createTurn(claudeRequest({ planMode: true }), cb).run()
    expect(exit).toMatchObject({ behavior: 'allow' })
    expect(cb.reviewPlan).toHaveBeenCalledTimes(1)
    expect(cb.planModeChanged).toHaveBeenCalledWith(false)
  })
})

describe('Codex read-only: its read-only sandbox', () => {
  const request = (patch: Partial<TurnRequest>): TurnRequest => ({ ...claudeRequest(), model: 'gpt-6.1-sol', cwd: path.resolve('/work/repo'), ...patch })

  it('passes sandbox mode read-only, with nothing writable, whatever the approval setting', () => {
    for (const approvals of ['never-ask', 'ask'] as const) {
      const { thread } = codexOptions(request({ approvals, readOnly: true, extraWritableDirs: ['/repo/.git'] }))
      expect(thread.sandboxMode).toBe('read-only')
      expect(thread.additionalDirectories).toBeUndefined()
      expect(thread.networkAccessEnabled).toBeUndefined()
      expect(thread.approvalPolicy).toBe('never')
    }
    expect(codexOptions(request({ approvals: 'ask' })).thread.sandboxMode).toBe('workspace-write')
    expect(codexOptions(request({ approvals: 'never-ask' })).thread.sandboxMode).toBe('danger-full-access')
  })
})

type User = Extract<ChatItem, { kind: 'user' }>
const firstUser = async (h: { store: Store }, id: string) => (await h.store.readChat(id)).find((i): i is User => i.kind === 'user')!

describe('a read-only Second opinion chat', () => {
  async function opinion(agent: 'claude' | 'codex') {
    const seen: TurnRequest[] = []
    registerDriver({ ...fakeDriver(async (req, cb) => (seen.push(req), cb.finished({ ok: true }))), kind: agent })
    const h = await setupSessions()
    await h.store.appendChat(h.session.id, { kind: 'user', id: 'u1', turnId: 't1', text: 'Fix the flaky test', at: 'now' })
    await h.store.appendChat(h.session.id, { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Done.' })
    const handOffs = new HandOffService(h.store, h.sessions, { workspace: () => h.ws, settingsFor: () => ({ prompts: { codeReview: '' } }) } as never)
    const preview = await handOffs.prepare(h.session.id, 'second-opinion')
    const model = agent === 'claude' ? { agent, model: 'claude-opus-5-5[1m]', fast: false } : { agent, model: 'gpt-6.1-sol', fast: false }
    const result = await handOffs.start(h.session.id, { kind: 'second-opinion', model, message: preview.message, answer: false, diff: false, expect: {}, readOnly: true })
    if (!('session' in result)) throw new Error('stale')
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    return { h, seen, session: result.session }
  }

  it('Claude: the tab is read-only in plan mode, the turn asks for read-only, and the receipt says so', async () => {
    const { h, seen, session } = await opinion('claude')
    expect(session).toMatchObject({ readOnly: true, planMode: true, title: 'Second opinion' })
    expect(seen[0]).toMatchObject({ readOnly: true, planMode: true })
    expect(await firstUser(h, session.id)).toMatchObject({ readOnly: 'plan' })
    // Plan mode can't be turned off: not from the composer, not by /plan.
    await expect(h.sessions.updateSession(session.id, { planMode: false })).rejects.toThrow('read-only')
    await expect(h.sessions.send(session.id, '/plan')).rejects.toThrow('read-only')
    expect(h.store.state.sessions.find((s) => s.id === session.id)!.planMode).toBe(true)
  })

  it('Codex: the turn asks for read-only (the sandbox), and the receipt says so', async () => {
    const { h, seen, session } = await opinion('codex')
    expect(session).toMatchObject({ readOnly: true, planMode: false })
    expect(seen[0]).toMatchObject({ readOnly: true })
    expect(await firstUser(h, session.id)).toMatchObject({ readOnly: 'sandbox' })
  })

  it('an unticked opinion runs as before, with no read-only receipt', async () => {
    const seen: TurnRequest[] = []
    registerDriver({ ...fakeDriver(async (req, cb) => (seen.push(req), cb.finished({ ok: true }))), kind: 'codex' })
    const h = await setupSessions()
    const target = await h.sessions.handOff(h.session.id, { model: { agent: 'codex', model: 'gpt-6.1-sol', fast: false }, text: 'look', title: 'Second opinion' })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(target.readOnly).toBeUndefined()
    expect(seen[0].readOnly).toBeUndefined()
    expect((await firstUser(h, target.id)).readOnly).toBeUndefined()
  })

  it('Cursor and OpenCode: read-only is refused, and no tab is left behind', async () => {
    const h = await setupSessions()
    const open = () => h.store.state.sessions.filter((s) => !s.closedAt).length
    for (const agent of ['cursor', 'opencode'] as const) {
      await expect(h.sessions.handOff(h.session.id, { model: { agent, model: 'auto', fast: false }, text: 'look', readOnly: true })).rejects.toThrow('can’t enforce it')
    }
    expect(open()).toBe(1)
    // A read-only chat can't be switched to an agent that can't enforce it either.
    const fresh = h.sessions.createSession(h.ws.id, { agent: 'claude' })
    fresh.readOnly = true
    await expect(h.sessions.updateSession(fresh.id, { agent: 'cursor' })).rejects.toThrow('read-only')
  })
})

describe('read-only through O10’s background host', () => {
  const live: { server?: HostServer; clients: HostClient[] } = { clients: [] }
  afterEach(() => {
    for (const c of live.clients) c.close()
    live.server?.close()
    live.clients = []
    live.server = undefined
  })

  it('a kept Claude opinion reaches the host’s ClaudeTurn read-only: plan mode, ExitPlanMode and writes refused', async () => {
    const decisions: Record<string, { behavior: string }> = {}
    const seen = stubClaude(async (options) => {
      decisions.ExitPlanMode = await ask(options, 'ExitPlanMode', { plan: 'implement it' })
      decisions.Write = await ask(options, 'Write', { file_path: 'x', content: 'y' })
    })
    const dir = await tempDir('foreman-host-ro-')
    const server = new HostServer({ dir, driver: () => claudeDriver, idleMs: 60_000, exit: () => undefined })
    expect(await server.listen()).toBe(true)
    live.server = server

    const root = await tempDir('foreman-host-ro-store-')
    const store = new Store(root)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    store.state.settings.keepAgentsRunning = true
    const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'nairobi', branch: 'b', baseBranch: 'main', path: await makeRepo(), portBase: 50040, state: 'ready', createdAt: new Date().toISOString() }
    store.state.workspaces.push(ws)
    const host = new AgentHostService({ store, dir, spawn: () => undefined, changed: () => undefined })
    live.clients.push(host.client)
    const workspaces = { workspace: () => ws, env: () => ({}), settingsFor: () => ({ prompts: { general: '' }, sensitivePaths: [] }), agentContext: () => '' }
    const events = { changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {} }
    const sessions = new SessionService(store, { forAgent: () => ({}) } as never, workspaces as never, events, undefined, undefined, host)
    host.bind(sessions)
    const source = sessions.createSession(ws.id, { agent: 'claude', title: 'work' })

    const target = await sessions.handOff(source.id, { model: { agent: 'claude', model: 'claude-opus-5-5[1m]', fast: false }, text: 'second opinion please', title: 'Second opinion', readOnly: true })
    expect(sessions.isHosted(target.id)).toBe(true)
    await vi.waitFor(() => expect(store.state.sessions.find((s: Session) => s.id === target.id)!.status).toBe('idle'), { timeout: 15_000 })
    expect(seen).toHaveLength(1)
    expect(seen[0].permissionMode).toBe('plan')
    expect(seen[0].disallowedTools).toEqual(expect.arrayContaining(['ExitPlanMode', 'Write']))
    expect(decisions.ExitPlanMode).toMatchObject({ behavior: 'deny' })
    expect(decisions.Write).toMatchObject({ behavior: 'deny' })
    expect(await firstUser({ store }, target.id)).toMatchObject({ readOnly: 'plan' })
  })

  it('the app side keeps readOnly in the request it sends to the host', () => {
    const store = { state: { hostedTurns: [], settings: {} }, save: () => undefined } as unknown as Store
    const host = new AgentHostService({ store, dir: path.resolve('/nowhere'), changed: () => undefined })
    const start = vi.fn(() => ({}) as never)
    ;(host.client as unknown as { start: typeof start }).start = start
    const session = { id: 's1', agent: 'codex', title: 't' } as Session
    const ws = { name: 'w' } as Workspace
    host.createTurn(session, ws, { ...claudeRequest({ readOnly: true }), hostTools: undefined }, callbacks(), 'end')
    expect(start).toHaveBeenCalledTimes(1)
    expect((start.mock.calls[0] as unknown[])[0]).toMatchObject({ agent: 'codex', request: { readOnly: true, turnId: 't1' } })
  })
})
