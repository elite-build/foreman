// O10 Keep agents running: the background agent host, its protocol, and adopting kept turns after a relaunch.
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gapRange, hostView, keepRunningPlan, reconnectRecord, shortAge, stepsIn } from '../src/shared/agentHost'
import type { ApprovalResponse, ChatItem, TurnOutcome, Workspace } from '../src/shared/types'
import { claudeDriver } from '../src/main/agents/claude'
import type { TurnCallbacks } from '../src/main/agents/types'
import { HostClient } from '../src/main/agentHost/client'
import { readHostInfo, readLog } from '../src/main/agentHost/protocol'
import { HostServer, type HostUi } from '../src/main/agentHost/server'
import { AgentHostService } from '../src/main/agentHost/service'
import { SessionService } from '../src/main/sessions'
import { Store } from '../src/main/store'
import { fakeDriver, fakeRequest } from './agentHostFake'
import { makeRepo, tempDir } from './helpers'

// The Claude adapter test below drives the real ClaudeTurn with the SDK's `query` replaced.
const sdk = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn(() => ({})), createSdkMcpServer: vi.fn(() => ({})) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Callbacks that record what a turn reports, and answer approvals with `answer`. */
function recorder(answer?: (kind: string) => ApprovalResponse) {
  const items: ChatItem[] = []
  const finished: unknown[] = []
  const asked: string[] = []
  const cb: TurnCallbacks = {
    item: (item, transient) => {
      if (!transient) items.push(item)
    },
    sessionStarted: () => undefined,
    assistantMessage: () => undefined,
    approveTool: async (request) => {
      asked.push(`tool:${request.toolName}`)
      return (answer?.('tool') ?? { kind: 'tool', allow: true }) as never
    },
    reviewPlan: async () => ({ kind: 'plan', approve: true }),
    ask: async () => {
      asked.push('question')
      return (answer?.('question') ?? { kind: 'question', answers: { 'Which?': 'A' } }) as never
    },
    planModeChanged: () => undefined,
    autoAcceptEdits: () => undefined,
    usage: () => undefined,
    finished: (r) => void finished.push(r)
  }
  const said = () => items.flatMap((i) => (i.kind === 'assistant' ? [i.text] : i.kind === 'tool' ? [`${i.id}:${i.status}`] : []))
  return { cb, items, finished, asked, said }
}

const started: { server?: HostServer; clients: HostClient[]; children: ChildProcess[] } = { clients: [], children: [] }
afterEach(() => {
  for (const c of started.clients) c.close()
  started.server?.close()
  for (const child of started.children) child.kill()
  started.clients = []
  started.children = []
  started.server = undefined
})

async function inProcessHost(options: { ui?: HostUi; idleMs?: number; exit?: () => void; driver?: typeof fakeDriver } = {}) {
  const dir = await tempDir('foreman-host-')
  const server = new HostServer({ dir, driver: () => options.driver ?? fakeDriver, ui: options.ui, idleMs: options.idleMs ?? 60_000, exit: options.exit ?? (() => undefined) })
  expect(await server.listen()).toBe(true)
  started.server = server
  return { dir, server, client: () => track(new HostClient({ dir })) }
}

function track(client: HostClient): HostClient {
  started.clients.push(client)
  return client
}

const label = { workspace: 'nairobi', title: 'Linear import' }

describe('background agent host: a separate process', () => {
  it('runs a turn, keeps it going while the app is away, and replays what was missed in order', async () => {
    const dir = await tempDir('foreman-host-proc-')
    const jiti = path.join(process.cwd(), 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs')
    const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'agentHostMain.ts')
    let child: ChildProcess | undefined
    const spawnHost = () => {
      child = spawn(process.execPath, [jiti, fixture, dir, '1500'], { stdio: 'ignore', windowsHide: true })
      started.children.push(child)
    }
    const a = track(new HostClient({ dir, spawn: spawnHost, connectTimeoutMs: 60_000 }))
    const gateA = path.join(dir, 'go-a')
    const gateB = path.join(dir, 'go-b')
    const first = recorder()
    const turn = a.start(
      { sessionId: 's1', agent: 'claude', request: fakeRequest('t1', ['say:one', `gate:${gateA}`, 'say:two', 'tool:t2', `gate:${gateB}`, 'say:three'].join('\n')), label },
      {},
      first.cb
    )
    const run = turn.run()
    await until(() => first.said().includes('one'), 60_000)
    expect(child).toBeDefined()

    // The app goes away; the turn goes on without it.
    const seenSeq = readLog(dir, 't1').at(-1)!.seq
    a.close()
    writeFileSync(gateA, '')
    await until(() => readLog(dir, 't1').some((e) => e.type === 'item' && e.item.kind === 'tool' && e.item.status === 'done'))

    // A relaunched app finds the same host, adopts the turn and gets the missed events in order.
    const b = track(new HostClient({ dir }))
    const turns = await b.connect({ spawn: false })
    expect(turns).toEqual([expect.objectContaining({ turnId: 't1', sessionId: 's1', ended: false })])
    const second = recorder()
    const { turn: adopted, missed } = await b.adopt('t1', seenSeq, {}, second.cb)
    expect(missed.map((e) => e.seq)).toEqual(missed.map((_, i) => seenSeq + 1 + i))
    const ending = adopted.run()
    await until(() => second.said().length === 3)
    expect(second.said()).toEqual(['two', 't2:running', 't2:done'])

    // The same turn streams on live, and ends.
    writeFileSync(gateB, '')
    await ending
    expect(second.said()).toEqual(['two', 't2:running', 't2:done', 'three'])
    expect(second.finished).toEqual([{ ok: true }])
    expect([...first.said(), ...second.said()]).toEqual(['one', 'two', 't2:running', 't2:done', 'three'])
    void run

    // With the end applied and no turn left, the host exits on its own.
    await b.ack('t1')
    expect(readLog(dir, 't1')).toEqual([])
    b.close()
    await until(() => !readHostInfo(dir) && child!.exitCode !== null, 20_000)
    expect(child!.exitCode).toBe(0)
  }, 120_000)
})

describe('background agent host: one owner', () => {
  it('lets only one app attach at a time', async () => {
    const host = await inProcessHost()
    await host.client().connect({ spawn: false })
    await expect(host.client().connect({ spawn: false })).rejects.toThrow(/already attached/)
  })

  it('refuses a second turn for a chat whose turn is still running', async () => {
    const host = await inProcessHost()
    const client = host.client()
    const gate = path.join(host.dir, 'never')
    const one = client.start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', `gate:${gate}`), label }, {}, recorder().cb)
    void one.run()
    await until(() => host.server.view().count === 1)
    const two = client.start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t2', 'say:hi'), label }, {}, recorder().cb)
    await expect(two.run()).rejects.toThrow(/already has a turn running/)
    // Another chat is fine.
    const other = recorder()
    await client.start({ sessionId: 's2', agent: 'claude', request: fakeRequest('t3', 'say:hi'), label }, {}, other.cb).run()
    expect(other.said()).toEqual(['hi'])
  })

  it('a client without the token is turned away', async () => {
    const host = await inProcessHost()
    writeFileSync(path.join(host.dir, 'host.json'), JSON.stringify({ token: 'wrong', version: 1 }))
    await expect(host.client().connect({ spawn: false })).rejects.toThrow()
  })
})

describe('background agent host: exits when idle', () => {
  it('exits with no app and no turn, but not while a turn runs', async () => {
    const exit = vi.fn()
    const host = await inProcessHost({ idleMs: 50, exit })
    const client = host.client()
    await client.connect({ spawn: false })
    const gate = path.join(host.dir, 'go')
    const turn = client.start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', `gate:${gate}`), label }, {}, recorder().cb)
    void turn.run()
    await until(() => host.server.view().count === 1)
    client.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(exit).not.toHaveBeenCalled()
    writeFileSync(gate, '')
    await until(() => exit.mock.calls.length > 0)
    // The ended turn's log stays on disk for the app to replay.
    expect(readLog(host.dir, 't1').at(-1)).toMatchObject({ type: 'ended' })
  })
})

describe('background agent host: approvals while Foreman is closed', () => {
  it('waits, notifies once that the turn is paused, and resumes when answered after reopening', async () => {
    const notes: { title: string; body: string }[] = []
    const views: number[] = []
    const ui: HostUi = { notify: (title, body) => void notes.push({ title, body }), update: (view) => void views.push(view.waiting.length) }
    const host = await inProcessHost({ ui })
    const a = host.client()
    const gate = path.join(host.dir, 'go')
    void a.start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', [`gate:${gate}`, 'approve:Bash', 'say:after'].join('\n')), label }, {}, recorder().cb).run()
    await until(() => host.server.view().count === 1)
    await a.detach({ locale: 'en', notify: true, labels: { t1: { workspace: 'quito', title: 'Annual billing toggle' } } })
    writeFileSync(gate, '')
    await until(() => notes.length > 0)
    expect(notes).toEqual([{ title: 'quito is waiting for you', body: 'Approve Bash: npm run build. The turn is paused until you answer in Foreman.' }])
    // The tray lists it under "Waiting for you"; nothing approved itself.
    expect(host.server.view()).toMatchObject({ visible: true, count: 1, waiting: [expect.objectContaining({ workspace: 'quito', waiting: { kind: 'tool', tool: 'Bash' } })] })
    await new Promise((r) => setTimeout(r, 100))
    expect(readLog(host.dir, 't1').some((e) => e.type === 'item' && e.item.kind === 'assistant' && e.item.text === 'after')).toBe(false)

    // Reopened: the approval comes back with the turn, and answering it resumes the same turn.
    const b = host.client()
    await b.connect({ spawn: false })
    const r = recorder(() => ({ kind: 'tool', allow: true }))
    const { turn } = await b.adopt('t1', 0, {}, r.cb)
    await turn.run()
    expect(r.asked).toEqual(['tool:Bash'])
    expect(r.said()).toEqual(['approved', 'after'])
    expect(notes).toHaveLength(1)
  })

  it('asks the attached app directly, and the app answers', async () => {
    const host = await inProcessHost()
    const r = recorder()
    await host.client().start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', 'ask'), label }, {}, r.cb).run()
    expect(r.asked).toEqual(['question'])
    expect(r.said()).toEqual(['answer: {"Which?":"A"}'])
  })
})

describe('background agent host: the real Claude adapter', () => {
  it('runs ClaudeTurn in the host with a stubbed SDK: streams, asks for approval through the app, and ends', async () => {
    sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: { canUseTool: Function; abortController: AbortController } }) => {
      const iterator = prompt[Symbol.asyncIterator]()
      return {
        async *[Symbol.asyncIterator]() {
          const first = await iterator.next()
          yield { type: 'system', subtype: 'init', session_id: 'claude-1', uuid: 'u0' } as unknown as SDKMessage
          const decision = await options.canUseTool('Bash', { command: 'npm test' }, { signal: options.abortController.signal, suggestions: [] })
          const text = `${(first.value as SDKUserMessage).message.content} → ${decision.behavior}`
          yield { type: 'assistant', parent_tool_use_id: null, uuid: 'u1', session_id: 'claude-1', message: { id: 'm1', content: [{ type: 'text', text }] } } as unknown as SDKMessage
          yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1, result: 'ok', uuid: 'u2', session_id: 'claude-1' } as unknown as SDKMessage
        },
        interrupt: vi.fn(async () => undefined),
        getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100 })),
        setPermissionMode: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined)
      }
    })
    const host = await inProcessHost({ driver: claudeDriver })
    const r = recorder()
    const started: string[] = []
    r.cb.sessionStarted = (id) => void started.push(id)
    await host.client().start({ sessionId: 's1', agent: 'claude', request: fakeRequest('t1', 'fix the test'), hostTools: { followups: true }, label }, {}, r.cb).run()
    expect(sdk.query).toHaveBeenCalledTimes(1)
    expect(started).toEqual(['claude-1'])
    expect(r.asked).toEqual(['tool:Bash'])
    expect(r.items.filter((i) => i.kind === 'assistant').map((i) => (i as { text: string }).text)).toEqual(['fix the test → allow'])
    expect(r.finished).toEqual([{ ok: true }])
    // Foreman's own MCP tools (questions, diff, follow-ups) are still given to Claude inside the host.
    expect(sdk.createSdkMcpServer).toHaveBeenCalled()
  })
})

describe('adopting kept turns after a relaunch', () => {
  async function app(dir: string, store: Store, ws: Workspace, notify: string[] = []) {
    const ended: TurnOutcome[] = []
    const workspaces = {
      workspace: () => ws,
      env: () => ({}),
      settingsFor: () => ({ prompts: { general: '' }, sensitivePaths: [] }),
      agentContext: () => ''
    }
    const host = new AgentHostService({ store, dir, spawn: () => undefined, changed: () => undefined })
    track(host.client)
    const sessions = new SessionService(
      store,
      { forAgent: () => ({}) } as never,
      workspaces as never,
      {
        changed() {},
        item() {},
        reset() {},
        approval() {},
        approvalResolved() {},
        notify: (_w, _s, _t, body) => void notify.push(body),
        turnEnded: (_id, outcome) => void ended.push(outcome)
      },
      undefined,
      undefined,
      host
    )
    host.bind(sessions)
    return { host, sessions, ended }
  }

  it('reattaches, marks the gap in the chat, applies what happened meanwhile and ends the turn', async () => {
    const host = await inProcessHost()
    const root = await tempDir('foreman-adopt-')
    const store = new Store(root)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    store.state.settings.keepAgentsRunning = true
    const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'nairobi', branch: 'b', baseBranch: 'main', path: await makeRepo(), portBase: 50040, state: 'ready', createdAt: new Date().toISOString() }
    store.state.workspaces.push(ws)

    const before = await app(host.dir, store, ws)
    const session = before.sessions.createSession(ws.id, { agent: 'claude', title: 'Linear import' })
    session.title = 'Linear import'
    const gate = path.join(host.dir, 'go')
    await before.sessions.send(session.id, ['say:one', `gate:${gate}`, 'say:two', 'tool:t2', 'say:done'].join('\n'))
    await until(async () => (await store.readChat(session.id)).some((i) => i.kind === 'assistant' && i.text === 'one'))
    expect(before.sessions.isHosted(session.id)).toBe(true)
    expect(store.state.hostedTurns).toHaveLength(1)
    // The Quit sheet offers to keep it.
    expect(keepRunningPlan([{ sessionId: session.id, workspace: 'nairobi', agent: 'claude', waiting: false }], (id) => before.sessions.isHosted(id), true)).toMatchObject({ turns: 1, notKept: [] })

    // Keep-running quit: Foreman lets go; the turn finishes while it's closed.
    await before.host.detach('en', true)
    writeFileSync(gate, '')
    await until(() => readLog(host.dir, session.turnId!).some((e) => e.type === 'ended'))

    // Relaunch: a new app over the same data adopts it.
    const notify: string[] = []
    const after = await app(host.dir, store, ws, notify)
    await after.host.recover()
    await until(() => after.ended.length > 0)
    expect(after.ended).toEqual(['completed'])
    const chat = await store.readChat(session.id)
    const kinds = chat.map((i) => (i.kind === 'assistant' ? i.text : i.kind === 'notice' && i.gap ? 'gap' : i.kind === 'tool' ? 'tool' : i.kind))
    expect(kinds).toEqual(['user', 'one', 'gap', 'two', 'tool', 'done', 'turn-end'])
    const gapItem = chat.find((i) => i.kind === 'notice' && i.gap) as Extract<ChatItem, { kind: 'notice' }>
    expect(gapItem.gap).toMatchObject({ steps: 1, ended: true })
    expect(gapItem.gap!.from).toBeDefined()
    expect(store.state.reconnected).toMatchObject({ running: 0, finished: 1 })
    expect(store.state.hostedTurns).toEqual([])
    expect(session.status).toBe('idle')
    // The host already notified while Foreman was closed; the app doesn't repeat it.
    expect(notify).toEqual([])
    await until(() => readLog(host.dir, gapItem.turnId!).length === 0)
  })

  it('a kept turn whose host was stopped (a computer restart) ends as interrupted and is listed as stopped', async () => {
    const dir = await tempDir('foreman-lost-')
    const root = await tempDir('foreman-lost-store-')
    const store = new Store(root)
    await store.load()
    vi.spyOn(store, 'save').mockImplementation(() => {})
    const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'lisbon', branch: 'b', baseBranch: 'main', path: await makeRepo(), portBase: 50040, state: 'ready', createdAt: new Date().toISOString() }
    store.state.workspaces.push(ws)
    const { host, sessions } = await app(dir, store, ws)
    const session = sessions.createSession(ws.id, { agent: 'claude' })
    Object.assign(session, { status: 'running', turnId: 'lost-1', turnStartedAt: new Date().toISOString() })
    store.state.hostedTurns = [{ sessionId: session.id, turnId: 'lost-1', agent: 'claude', startedAt: session.turnStartedAt!, seq: 3 }]
    store.state.keepRunning = { closedAt: '2026-10-22T12:10:00.000Z' }
    await host.recover()
    expect(session).toMatchObject({ status: 'idle', turnId: undefined, lastTurn: { outcome: 'interrupted', turnId: 'lost-1' } })
    expect(store.state.stopRecord?.turns).toEqual([expect.objectContaining({ turnId: 'lost-1', cause: 'quit' })])
    expect((await store.readChat(session.id)).at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'interrupted' })
    expect(store.state.hostedTurns).toEqual([])
    expect(store.state.reconnected).toBeUndefined()
  })

  it('a restart keeps a hosted turn running in the saved state instead of marking it interrupted', async () => {
    const root = await tempDir('foreman-keep-store-')
    const store = new Store(root)
    await store.load()
    store.state.sessions.push(
      { id: 's1', workspaceId: 'ws', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'running', turnId: 'kept', queue: [], createdAt: '' },
      { id: 's2', workspaceId: 'ws', agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'running', turnId: 'crashed', queue: [], createdAt: '' }
    )
    store.state.hostedTurns = [{ sessionId: 's1', turnId: 'kept', agent: 'claude', startedAt: '', seq: 0 }]
    store.close()
    const again = new Store(root)
    await again.load()
    expect(again.state.sessions.find((s) => s.id === 's1')).toMatchObject({ status: 'running', turnId: 'kept' })
    expect(again.state.sessions.find((s) => s.id === 's2')).toMatchObject({ status: 'idle', turnId: undefined })
    again.close()
  })
})

describe('keep running: pure parts', () => {
  it('shows the tray only while Foreman is closed and a turn is still going', () => {
    const turn = { turnId: 't', workspace: 'nairobi', startedAt: '2026-10-22T12:00:00Z', ended: false }
    expect(hostView(true, [turn]).visible).toBe(false)
    expect(hostView(false, [{ ...turn, ended: true }]).visible).toBe(false)
    const view = hostView(false, [turn, { ...turn, turnId: 'w', workspace: 'lisbon', waiting: { kind: 'tool', tool: 'Bash' } }])
    expect(view).toMatchObject({ visible: true, count: 2, running: [{ workspace: 'nairobi' }], waiting: [{ workspace: 'lisbon' }] })
  })

  it('counts what was reconnected and what finished meanwhile', () => {
    expect(reconnectRecord('now', 'then', [])).toBeUndefined()
    expect(reconnectRecord('now', 'then', [{ ended: false }, { ended: false }, { ended: true }])).toEqual({ at: 'now', closedAt: 'then', running: 2, finished: 1 })
  })

  it('counts new steps only, and formats the gap', () => {
    const tool = (id: string) => ({ kind: 'tool', id, turnId: 't', name: 'Bash', input: {}, status: 'done' }) as ChatItem
    expect(stepsIn([tool('a'), tool('a'), tool('b'), tool('old')], new Set(['old']))).toBe(2)
    expect(gapRange({ to: '2026-10-22T12:52:00Z' }, 'en-GB')).not.toContain('–')
    expect(gapRange({ from: '2026-10-22T12:10:00Z', to: '2026-10-22T12:52:00Z' }, 'en-GB')).toContain('–')
    expect(shortAge('2026-10-22T12:00:00Z', Date.parse('2026-10-22T12:03:10Z'))).toBe('3m')
  })

  it('names the turns that stop anyway, and why', () => {
    const plan = keepRunningPlan(
      [
        { sessionId: 'a', workspace: 'nairobi', agent: 'claude', waiting: false },
        { sessionId: 'b', workspace: 'quito', agent: 'codex', waiting: true },
        // G1: Cursor and OpenCode can be kept now; a Chat agent still can't.
        { sessionId: 'c', workspace: 'lisbon', agent: 'gemini', waiting: false },
        { sessionId: 'd', workspace: 'oslo', agent: 'claude', waiting: false }
      ],
      (id) => id === 'a' || id === 'b',
      true
    )
    expect(plan).toEqual({
      enabled: true,
      turns: 2,
      waiting: ['quito'],
      notKept: [
        { workspace: 'lisbon', agent: 'Gemini CLI', reason: 'agent' },
        { workspace: 'oslo', agent: 'Claude Code', reason: 'started-before' }
      ]
    })
    expect(keepRunningPlan([], () => true, true)).toBeUndefined()
  })
})

