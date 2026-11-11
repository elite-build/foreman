// docs/agent-access.md §4, "Down the tree": a capped turn's foreman-app grant and its `foreman` commands pass its cap on to
// whatever they start, and never start a flow.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ForemanActions } from '../src/main/foremanActions'
import { ForemanMcp } from '../src/main/foremanMcp'
import { handleRequest } from '../src/main/cli/server'
import { apiFor, callerCap } from '../src/main/cli/policy'
import type { CliHost } from '../src/main/cli/host'
import { defaultSettings } from '../src/main/store'
import type { TurnCap } from '../src/shared/agentAccess'
import type { Api, ChatItem, CreateWorkspaceOptions, Repo, SendOptions, Session, Workspace } from '../src/shared/types'
import type { CliReplyV2 } from '../src/cli/protocol'
import { fakeApi, stubHost } from './cliHost'
import { delegationRig } from './foremanDelegationHarness'

const cap = (ceiling: TurnCap['ceiling'], grantId = 'grant-1'): TurnCap => ({ ceiling, grantId, name: 'Claude Code' })
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

describe('the CLI from inside a capped turn', () => {
  const repo = { id: 'r', name: 'app', rootPath: '/app' } as Repo
  const caller = { token: 'tok', sessionId: 'caller', turnId: 'turn-c' }

  function rig(options: { turnCap?: TurnCap; live?: boolean; chat?: ChatItem[]; capped?: boolean } = {}) {
    const ws = { id: 'ws1', repoId: 'r', name: 'lisbon', branch: 'b', state: 'ready', path: '/x', note: { text: 'Mind the API', revision: 2, updatedAt: '' } } as Workspace
    const remote = { ...ws, id: 'ws2', name: 'porto', cloud: { provider: 'vercel', id: 'sb', status: 'capped', cwd: '/vercel/sandbox' } } as unknown as Workspace
    const callerSession = { id: 'caller', workspaceId: 'ws1', agent: 'claude', model: 'm', status: options.live === false ? 'idle' : 'running', queue: [], fastMode: false, planMode: false, turnCap: options.turnCap } as unknown as Session
    const target = { id: 't1', workspaceId: 'ws1', agent: 'claude', model: 'm', status: 'idle', queue: [{ id: 'q1', turnId: 'tq', text: 'queued', attachments: [] }], fastMode: false, planMode: false } as unknown as Session
    const cloudTab = { ...target, id: 'c1', workspaceId: 'ws2', queue: [] } as Session
    const state = { repos: [repo], workspaces: [ws, remote], sessions: [target, cloudTab], settings: { ...defaultSettings(), flows: true } }
    const plain: [string, ...unknown[]][] = []
    const capped: [string, TurnCap, ...unknown[]][] = []
    const receipt = { disposition: 'queued' as const, turnId: 'turn-x' }
    const calls = (log: (name: string, ...args: unknown[]) => void): Partial<Api> => ({
      fixCi: async (...args) => (log('fixCi', ...args), 't1'),
      resolveBaseMoved: async (...args) => (log('resolveBaseMoved', ...args), 't1'),
      gitAction: async (...args) => (log('gitAction', ...args), receipt),
      sendReviewThreads: async (...args) => (log('sendReviewThreads', ...args), 't1'),
      cloudContinue: async (...args) => (log('cloudContinue', ...args), receipt),
      sendNote: async (...args) => (log('sendNote', ...args), receipt),
      steerQueued: async (...args) => void log('steerQueued', ...args),
      resumeLimitNow: async (...args) => void log('resumeLimitNow', ...args),
      retryStopped: async (...args) => void log('retryStopped', ...args),
      adoptWorktree: async (...args) => (log('adoptWorktree', ...args), { ...ws, id: 'adopted' }),
      rerunSetup: async (...args) => void log('rerunSetup', ...args),
      retrySetup: async (...args) => void log('retrySetup', ...args),
      editQueued: async (...args) => (log('editQueued', ...args), { ok: true as const, revision: 1 }),
      addComment: async (...args) => void log('addComment', ...args),
      updateComment: async (...args) => void log('updateComment', ...args),
      getDiff: async () => ({ files: [{ path: 'a.ts' }], truncated: false }) as never
    })
    const reads: Partial<Api> = {
      getChat: async () => options.chat ?? [],
      reviewThreads: async () => [{ id: 'th1', path: 'a.ts', line: 1, isResolved: false, isOutdated: false, comments: [] } as never],
      stopReview: async () => [{ kind: 'turn', key: 'stopped-turn', workspace: 'lisbon', cause: 'quit', at: '', message: 'Do it' } as never]
    }
    const delivered: { sessionId: string; options: SendOptions }[] = []
    const created: { options: CreateWorkspaceOptions; extra: unknown }[] = []
    const armed: unknown[][] = []
    const held: unknown[][] = []
    const comments = [{ id: 'c1', workspaceId: 'ws1', file: 'a.ts', line: 1, body: 'Rename this', author: 'user', state: 'pending' }]
    const checksRun: string[] = []
    const host: CliHost = stubHost({
      state: () => state,
      snapshot: () => ({ comments }) as never,
      runChecks: async (id) => (checksRun.push(id), { workspace: { id, name: 'lisbon' }, outcome: 'passed', results: [] }) as never,
      api: fakeApi({ ...reads, ...calls((name, ...args) => void plain.push([name, ...args])) }),
      ...(options.capped === false ? {} : { capped: (c: TurnCap) => fakeApi({ ...reads, ...calls((name, ...args) => void capped.push([name, c, ...args])) }) }),
      identifyCaller: (given) => (given?.token === 'tok' ? { kind: 'turn', session: callerSession, ws, turnId: 'turn-c', live: options.live !== false } : given?.token ? { kind: 'bad-token' } : null),
      agentsMayStart: () => true,
      deliver: async (sessionId, _text, opts) => (delivered.push({ sessionId, options: opts }), receipt),
      createWorkspace: async (_repoId, opts, extra) => (created.push({ options: opts, extra }), { ...ws, id: 'new-ws', name: 'new' }),
      startHeldMessage: async (...args) => void held.push(args),
      setupOutcome: async () => ({ failed: true, held: true, logTail: '' }),
      turnStatus: async (turnId) => ({ workspaceId: 'ws1', sessionId: 't1', turnId, state: 'ended', outcome: 'error' }),
      cancelLimitResume: () => undefined,
      armLimitResume: async (...args) => (armed.push(args), { turnId: 'stopped', resetAt: '', at: new Date(Date.now() + 60_000).toISOString(), source: 'resets 5pm', text: 'Continue', armedAt: '' })
    })
    const call = async (method: string, params: unknown, from: typeof caller | null = caller) => {
      const reply = (await handleRequest(host, { v: 2, method, params, ...(from ? { caller: from } : {}) } as never)) as CliReplyV2<unknown>
      if (!reply.ok) throw new Error(`${method}: ${reply.error}`)
      return reply.result
    }
    return { host, call, plain, capped, delivered, created, armed, held, checksRun, target }
  }

  it('reads the cap of the running turn, or of an ended one from its message; none without a turn token', async () => {
    const live = rig({ turnCap: cap('auto') })
    expect(await callerCap(live.host, caller)).toEqual(cap('auto'))
    expect(await callerCap(live.host, undefined)).toBeUndefined()
    expect(await callerCap(live.host, { ...caller, token: 'forged' })).toBeUndefined()
    const ended = rig({ live: false, chat: [{ kind: 'user', id: 'user:turn-c', turnId: 'turn-c', text: 'go', at: '', cap: cap('ask') }, { kind: 'user', id: 'u2', turnId: 'turn-c', text: 'steer', at: '', steered: true }] })
    expect(await callerCap(ended.host, caller)).toEqual(cap('ask'))
    expect(await callerCap(rig({ live: false }).host, caller)).toBeUndefined()
    expect(await callerCap(rig().host, caller)).toBeUndefined()
  })

  it('send, new (and Start anyway) and resume-at carry it to what they start', async () => {
    const r = rig({ turnCap: cap('ask-except-edits') })
    await r.call('send', { workspace: 'lisbon', tab: 1, args: ['please', 'fix'], cwd: '/' })
    expect(r.delivered[0]).toMatchObject({ sessionId: 't1', options: { mode: 'queue', via: 'cli', cap: cap('ask-except-edits'), origin: { kind: 'delegation', sessionId: 'caller', turnId: 'turn-c' } } })
    await r.call('new', { prompt: 'Build it', cwd: '/', repo: 'app', startAnyway: true })
    expect(r.created[0].extra).toEqual({ startedBy: { sessionId: 'caller', turnId: 'turn-c', via: 'cli' }, cap: cap('ask-except-edits') })
    expect(r.held).toEqual([['new-ws', cap('ask-except-edits')]])
    await r.call('resume-at', { turn: 'stopped' })
    expect(r.armed).toEqual([['t1', 'stopped', cap('ask-except-edits')]])
  })

  it('every other act-tier call that starts or queues a turn goes through the capped Api', async () => {
    const r = rig({ turnCap: cap('ask') })
    await r.call('pr-fix-ci', { workspace: 'lisbon', cwd: '/', tab: 1 })
    await r.call('base-moved', { workspace: 'lisbon', cwd: '/', tab: 1 })
    await r.call('git-action', { workspace: 'lisbon', cwd: '/', action: 'commit-and-push', tab: 1 })
    await r.call('pr-threads', { workspace: 'lisbon', cwd: '/', verb: 'send', ids: ['th1'], tab: 1 })
    await r.call('cloud-continue', { workspace: 'porto', cwd: '/', tab: 1 })
    await r.call('ws-note', { workspace: 'lisbon', cwd: '/', verb: 'send', tab: 1 })
    await r.call('queue', { workspace: 'lisbon', cwd: '/', verb: 'steer', message: 'q1', tab: 1 })
    await r.call('resume-now', { workspace: 'lisbon', cwd: '/', tab: 1 })
    await r.call('stopped', { verb: 'retry', key: 'stopped-turn' })
    await r.call('ws-adopt', { cwd: '/app', path: 'wt', repo: 'app', prompt: 'Carry on' })
    expect(r.capped.map(([name, c]) => [name, c.ceiling])).toEqual(
      ['fixCi', 'resolveBaseMoved', 'gitAction', 'sendReviewThreads', 'cloudContinue', 'sendNote', 'steerQueued', 'resumeLimitNow', 'retryStopped', 'adoptWorktree'].map((n) => [n, 'ask'])
    )
    expect(r.plain).toEqual([])
  })

  it('an uncapped turn and a person at a terminal use the Api as it is', async () => {
    const turn = rig()
    await turn.call('pr-fix-ci', { workspace: 'lisbon', cwd: '/', tab: 1 })
    await turn.call('send', { workspace: 'lisbon', tab: 1, args: ['hi'], cwd: '/' })
    const person = rig({ turnCap: cap('ask') })
    await person.call('resume-now', { workspace: 'lisbon', cwd: '/', tab: 1 }, null)
    expect(turn.plain.map(([n]) => n)).toEqual(['fixCi'])
    expect(turn.delivered[0].options).not.toHaveProperty('cap')
    expect(person.plain.map(([n]) => n)).toEqual(['resumeLimitNow'])
    expect(turn.capped).toEqual([])
    expect(person.capped).toEqual([])
  })

  it('refuses rather than start uncapped when the host can’t hold a command to the cap', async () => {
    const r = rig({ turnCap: cap('ask'), capped: false })
    await expect(r.call('pr-fix-ci', { workspace: 'lisbon', cwd: '/', tab: 1 })).rejects.toThrow('access is limited')
    expect(r.plain).toEqual([])
    expect(() => apiFor(r.host, {})).not.toThrow()
  })

  it('refuses a flow run from a capped turn, preview and all', async () => {
    const r = rig({ turnCap: cap('never-ask') })
    await expect(r.call('flow-run', { flow: 'fix', cwd: '/' })).rejects.toThrow('A flow can’t be started from this turn')
  })

  it('refuses checks and running setup again below Never ask: they run the workspace’s code with the user’s full rights', async () => {
    for (const ceiling of ['ask', 'ask-except-edits', 'auto'] as const) {
      const r = rig({ turnCap: cap(ceiling) })
      await expect(r.call('checks', { cwd: '/x' })).rejects.toThrow('full rights')
      await expect(r.call('ws-setup', { workspace: 'lisbon', cwd: '/', verb: 'rerun' })).rejects.toThrow('full rights')
      await expect(r.call('ws-setup', { workspace: 'lisbon', cwd: '/', verb: 'retry' })).rejects.toThrow('full rights')
      await expect(r.call('ws-adopt', { cwd: '/app', path: 'wt', repo: 'app', setup: true })).rejects.toThrow('full rights')
      expect(r.checksRun).toEqual([])
      expect([...r.plain, ...r.capped]).toEqual([])
    }
    // At Never ask, from an uncapped turn, and from a terminal, they run as before.
    for (const r of [rig({ turnCap: cap('never-ask') }), rig()]) {
      await r.call('checks', { cwd: '/x' })
      await r.call('ws-setup', { workspace: 'lisbon', cwd: '/', verb: 'rerun' })
      expect(r.checksRun).toEqual(['ws1'])
      expect(r.plain.map(([n]) => n)).toEqual(['rerunSetup'])
    }
    const person = rig({ turnCap: cap('ask') })
    await person.call('ws-setup', { workspace: 'lisbon', cwd: '/', verb: 'retry' }, null)
    expect(person.plain.map(([n]) => n)).toEqual(['retrySetup'])
  })

  it('refuses editing a queued message that would run less held than the caller, and adding or editing comments below Never ask', async () => {
    const r = rig({ turnCap: cap('auto') })
    // The user's own message (no cap), and one held higher than the caller.
    await expect(r.call('queue', { workspace: 'lisbon', cwd: '/', tab: 1, verb: 'edit', message: 'q1', text: 'something else' })).rejects.toThrow('can’t be edited from this turn')
    r.target.queue[0].cap = cap('never-ask')
    await expect(r.call('queue', { workspace: 'lisbon', cwd: '/', tab: 1, verb: 'edit', message: 'q1', text: 'something else' })).rejects.toThrow('can’t be edited from this turn')
    // One held as low or lower may be edited.
    r.target.queue[0].cap = cap('ask')
    await r.call('queue', { workspace: 'lisbon', cwd: '/', tab: 1, verb: 'edit', message: 'q1', text: 'something else' })
    expect(r.plain.map(([n]) => n)).toEqual(['editQueued'])

    await expect(r.call('comments', { workspace: 'lisbon', cwd: '/', verb: 'add', file: 'a.ts', line: 1, body: 'Also delete the tests' })).rejects.toThrow('Comments can’t be added or edited')
    await expect(r.call('comments', { workspace: 'lisbon', cwd: '/', verb: 'edit', id: 'c1', body: 'Also delete the tests' })).rejects.toThrow('Comments can’t be added or edited')
    expect(r.plain.map(([n]) => n)).toEqual(['editQueued'])

    // An uncapped turn and the person at a terminal edit as before.
    for (const [who, from] of [[rig(), caller], [rig({ turnCap: cap('ask') }), null]] as const) {
      await who.call('queue', { workspace: 'lisbon', cwd: '/', tab: 1, verb: 'edit', message: 'q1', text: 'mine' }, from)
      await who.call('comments', { workspace: 'lisbon', cwd: '/', verb: 'add', file: 'a.ts', line: 1, body: 'Note' }, from)
      expect(who.plain.map(([n]) => n)).toEqual(['editQueued', 'addComment'])
    }
    // A Never ask turn may comment, but not rewrite the user's own (uncapped) message.
    const never = rig({ turnCap: cap('never-ask') })
    await never.call('comments', { workspace: 'lisbon', cwd: '/', verb: 'add', file: 'a.ts', line: 1, body: 'Note' })
    await expect(never.call('queue', { workspace: 'lisbon', cwd: '/', tab: 1, verb: 'edit', message: 'q1', text: 'mine' })).rejects.toThrow('not held at all')
    expect(never.plain.map(([n]) => n)).toEqual(['addComment'])
  })

  it('refuses a send to a chat whose agent can’t be held to the ceiling', async () => {
    const r = rig({ turnCap: cap('auto') })
    const chat = r.host.state().sessions[0]
    chat.agent = 'cursor'
    await expect(r.call('send', { workspace: 'lisbon', tab: 1, args: ['hi'], cwd: '/' })).rejects.toThrow(/Cursor/)
    expect(r.delivered).toEqual([])
  })
})

describe('delegation from a capped turn', () => {
  it('start_task gives the new workspace’s first message the cap, and refuses an agent that can’t be held', async () => {
    const r = delegationRig()
    const scope = { ...r.scope, cap: cap('ask') }
    await r.service.call('start_task', { prompt: 'Research', loadout: 2 }, scope)
    expect(r.createWorkspace).toHaveBeenLastCalledWith('r', expect.objectContaining({ prompt: 'Research' }), { startedBy: { sessionId: 's', turnId: 'own', via: 'delegation' }, cap: cap('ask') })
    await expect(r.service.call('start_task', { prompt: 'Build', loadout: 4 }, scope)).rejects.toThrow(/Cursor/)
    await expect(r.service.call('start_task', { prompt: 'Build', loadout: 3 }, scope)).rejects.toThrow(/OpenCode/)
    expect(r.createWorkspace).toHaveBeenCalledTimes(1)
    // At Never ask every agent is held, and an uncapped caller passes nothing on.
    await r.service.call('start_task', { prompt: 'Build', loadout: 4 }, { ...r.scope, cap: cap('never-ask') })
    await r.service.call('start_task', { prompt: 'Build', loadout: 1 }, r.scope)
    expect(r.createWorkspace).toHaveBeenLastCalledWith('r', expect.anything(), { startedBy: { sessionId: 's', turnId: 'own', via: 'delegation' } })
  })

  it('send_task queues with the cap, and refuses a chat whose agent can’t be held', async () => {
    const r = delegationRig()
    const target = { ...r.session, id: 'target', status: 'idle' as const, turnId: undefined, queue: [] }
    r.state.sessions.push(target)
    await r.service.call('send_task', { workspaceId: 'w', sessionId: 'target', prompt: 'Review this' }, { ...r.scope, cap: cap('auto') })
    expect(r.deliver).toHaveBeenLastCalledWith('target', 'Review this', expect.objectContaining({ mode: 'queue', cap: cap('auto') }))
    target.agent = 'cursor'
    await expect(r.service.call('send_task', { workspaceId: 'w', sessionId: 'target', prompt: 'Again' }, { ...r.scope, cap: cap('auto') })).rejects.toThrow(/Cursor/)
    expect(r.deliver).toHaveBeenCalledTimes(1)
  })

  it('start_flow is refused', async () => {
    const r = delegationRig()
    r.state.settings.flows = true
    await expect(r.service.call('start_flow', { flowId: 'built-in:fix-until-green', inputs: { task: 'x' } }, { ...r.scope, cap: cap('never-ask') })).rejects.toThrow('A flow can’t be started from this turn')
  })
})

describe('a capped turn’s foreman-app grant', () => {
  async function client(server: McpServer) {
    const [mine, theirs] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'test', version: '1' })
    await server.connect(theirs)
    await c.connect(mine)
    cleanup.push(() => c.close())
    return c
  }

  it('holds the turn’s cap and hands it to start_task and send_task; start_flow refuses', async () => {
    const d = delegationRig()
    d.state.settings.flows = true
    d.session.turnCap = cap('ask-except-edits')
    const actions = new ForemanActions({ state: () => d.state, api: {} as never })
    const mcp = new ForemanMcp({ actions, session: (id) => d.state.sessions.find((s) => s.id === id), launch: () => null, socket: () => null, flowsOn: () => true })
    mcp.delegation = d.service
    cleanup.push(() => mcp.close())
    const c = await client(mcp.inProcessForTurn(d.session)['foreman-app'])
    expect((await c.callTool({ name: 'start_task', arguments: { prompt: 'Research', loadout: 1 } })).isError).not.toBe(true)
    expect(d.createWorkspace).toHaveBeenLastCalledWith('r', expect.anything(), expect.objectContaining({ cap: cap('ask-except-edits') }))
    const flow = await c.callTool({ name: 'start_flow', arguments: { flowId: 'built-in:fix-until-green', inputs: { task: 'x' } } })
    expect(flow.isError).toBe(true)
    expect(JSON.stringify(flow.content)).toContain('A flow can’t be started from this turn')
    // A turn without a cap passes none on.
    delete d.session.turnCap
    const plain = await client(mcp.inProcessForTurn(d.session)['foreman-app'])
    await plain.callTool({ name: 'start_task', arguments: { prompt: 'Research', loadout: 1 } })
    expect(d.createWorkspace).toHaveBeenLastCalledWith('r', expect.anything(), { startedBy: { sessionId: 's', turnId: 'own', via: 'delegation' } })
  })
})
