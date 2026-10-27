// "Maximum agents running at once": turns over the limit queue (first come, first served) and start as running ones end.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import type { AgentTurn, TurnRequest, TurnResult } from '../src/main/agents/types'
import { useCloudSandboxes } from '../src/main/runtime'
import { SessionService, type HostedFacts, type TurnHost } from '../src/main/sessions'
import { Store } from '../src/main/store'
import type { Session, Workspace } from '../src/shared/types'
import { fakeDriver } from './sessionHarness'
import { makeRepo, tempDir } from './helpers'

afterEach(() => {
  registerDriver(claudeDriver)
  useCloudSandboxes(null)
})

interface Live {
  prompt: string
  env: Record<string, string>
  finish(result?: TurnResult): void
}

/** Turns that run until the test finishes them (or they are stopped, which ends them as cancelled). */
function liveTurns() {
  const live: Live[] = []
  const run = async (req: TurnRequest, finished: (r: TurnResult) => void, signal?: AbortSignal) => {
    const result = await new Promise<TurnResult>((resolve) => {
      live.push({ prompt: req.prompt, env: req.env, finish: (r = { ok: true }) => resolve(r) })
      signal?.addEventListener('abort', () => resolve({ ok: false, error: 'aborted' }))
    })
    finished(result)
  }
  const find = (text: string) => {
    const hit = live.find((l) => l.prompt.includes(text))
    if (!hit) throw new Error(`no turn for ${text}`)
    return hit
  }
  return { live, run, find, prompts: () => live.map((l) => l.prompt) }
}

async function setup(options: { max?: number; githubReady?: () => Promise<void>; forAgent?: () => Record<string, string> } = {}) {
  const store = new Store(await tempDir('foreman-slots-'))
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  store.state.settings.maxRunningAgents = options.max ?? 0
  const repo = await makeRepo()
  const ws: Workspace = { id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: repo, portBase: 50060, state: 'ready', createdAt: new Date().toISOString() }
  const cloudWs: Workspace = {
    id: 'cloud-ws', repoId: 'repo', name: 'cloud', branch: 'c', baseBranch: 'main', path: '/workspace', portBase: 50070, state: 'ready', createdAt: new Date().toISOString(),
    cloud: { provider: 'vercel', id: 'sbx', status: 'running', region: 'iad1', vcpus: 2, cwd: '/workspace' }
  } as Workspace
  store.state.workspaces.push(ws, cloudWs)
  const turns = liveTurns()
  registerDriver(fakeDriver((req, cb, signal) => turns.run(req, (r) => cb.finished(r), signal)))
  const workspaces = {
    workspace: (id: string) => (id === cloudWs.id ? cloudWs : ws),
    env: () => ({}),
    settingsFor: () => ({ prompts: { general: '' }, sensitivePaths: [] }),
    agentContext: () => '',
    template: () => undefined
  }
  const environment = { forAgent: options.forAgent ?? (() => ({})), githubReady: options.githubReady }
  const sessions = new SessionService(store, environment as never, workspaces as never, {
    changed() {}, item() {}, reset() {}, approval() {}, approvalResolved() {}, notify() {}, turnEnded() {}
  })
  const tab = (title: string, workspaceId = ws.id) => sessions.createSession(workspaceId, { agent: 'claude', title })
  return { store, ws, cloudWs, sessions, turns, tab }
}

/** A cloud host whose turns run like the local ones (in the sandbox, as far as the app knows). */
function cloudHost(turns: ReturnType<typeof liveTurns>): TurnHost {
  return {
    keeps: () => true,
    createTurn: (_session, _ws, request, callbacks): AgentTurn & HostedFacts => {
      const abort = new AbortController()
      return {
        hosted: true,
        endCheckpointSaved: true,
        run: () => turns.run(request, (r) => callbacks.finished(r), abort.signal),
        stop: async () => abort.abort(),
        steer: () => false,
        setPlanMode: async () => {},
        setModel: async () => {}
      }
    },
    ended: () => {}
  }
}

const waiting = (s: Session) => Boolean(s.waitingForSlot)
// A turn's start saves a git checkpoint first, which a loaded machine can make slow.
const until = (check: () => void) => vi.waitFor(check, { timeout: 20_000, interval: 20 })

describe('maximum agents running at once', () => {
  it('starts every turn at once with no limit (the default)', async () => {
    const { sessions, turns, tab, store } = await setup()
    expect(store.state.settings.maxRunningAgents).toBe(0)
    const tabs = [tab('a'), tab('b'), tab('c')]
    for (const [i, t] of tabs.entries()) expect(await sessions.send(t.id, `task ${i}`)).toBe('started')
    await until(() => expect(turns.live).toHaveLength(3))
    expect(tabs.some(waiting)).toBe(false)
  })

  it('queues turns over the limit and starts them oldest first as turns end, fail or are stopped', async () => {
    const { sessions, turns, tab } = await setup({ max: 2 })
    const [a, b, c, d, e] = [tab('a'), tab('b'), tab('c'), tab('d'), tab('e')]
    expect(await sessions.send(a.id, 'task a')).toBe('started')
    expect(await sessions.send(b.id, 'task b')).toBe('started')
    const receipt = await sessions.deliver(c.id, 'task c')
    expect(receipt.disposition).toBe('queued')
    expect(await sessions.send(d.id, 'task d')).toBe('queued')
    expect(await sessions.send(e.id, 'task e')).toBe('queued')
    // Queued: idle, its message first in the tab's queue, findable by its turn id.
    expect(c.status).toBe('idle')
    expect(waiting(c)).toBe(true)
    expect(c.queue.map((m) => m.text)).toEqual(['task c'])
    expect((await sessions.turnStatus(receipt.turnId!))?.state).toBe('queued')
    expect(sessions.waitingForSlot()).toEqual([c.id, d.id, e.id])
    await until(() => expect(turns.live).toHaveLength(2))

    // Completed: the oldest waiting tab starts.
    turns.find('task a').finish()
    await until(() => expect(turns.prompts()).toContain('task c'))
    expect(waiting(c)).toBe(false)
    expect(c.queue).toEqual([])
    expect(sessions.waitingForSlot()).toEqual([d.id, e.id])

    // Failed: the next one starts.
    turns.find('task b').finish({ ok: false, error: 'boom' })
    await until(() => expect(turns.prompts()).toContain('task d'))
    expect(sessions.waitingForSlot()).toEqual([e.id])

    // Stopped by the user: the slot is free too.
    await sessions.cancel(c.id)
    await until(() => expect(turns.prompts()).toContain('task e'))
    expect(sessions.waitingForSlot()).toEqual([])
    expect(turns.live).toHaveLength(5)
  })

  it('cancelling a queued turn takes it out of the queue, and it never starts', async () => {
    const { sessions, turns, tab } = await setup({ max: 1 })
    const [a, b, c] = [tab('a'), tab('b'), tab('c')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'task b')
    const queued = await sessions.deliver(c.id, 'task c')
    await sessions.cancel(b.id)
    expect(waiting(b)).toBe(false)
    expect(b.queue).toEqual([])
    // By turn id (the CLI, an auto-fix's cap): dropped the same way.
    expect((await sessions.cancelTurn(queued.turnId!))?.outcome).toBe('cancelled')
    expect(waiting(c)).toBe(false)
    expect(sessions.waitingForSlot()).toEqual([])
    turns.find('task a').finish()
    await new Promise((r) => setTimeout(r, 300))
    expect(turns.prompts()).toEqual(['task a'])
  })

  it('a message sent while a tab waits queues behind its waiting turn', async () => {
    const { sessions, turns, tab } = await setup({ max: 1 })
    const [a, b] = [tab('a'), tab('b')]
    await sessions.send(a.id, 'task a')
    expect(await sessions.send(b.id, 'first')).toBe('queued')
    expect(await sessions.send(b.id, 'second')).toBe('queued')
    expect(b.queue.map((m) => m.text)).toEqual(['first', 'second'])
    turns.find('task a').finish()
    await until(() => expect(turns.prompts()).toContain('first'))
    turns.find('first').finish()
    await until(() => expect(turns.prompts()).toContain('second'))
  })

  it('closing or archiving a queued tab leaves the queue', async () => {
    const { sessions, turns, tab, ws } = await setup({ max: 1 })
    const [a, b, c] = [tab('a'), tab('b'), tab('c')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'task b')
    await sessions.send(c.id, 'task c')
    await sessions.closeSession(b.id)
    expect(waiting(b)).toBe(false)
    expect(sessions.waitingForSlot()).toEqual([c.id])
    await sessions.disposeWorkspaceSessions(ws.id, ws.path!)
    expect(waiting(c)).toBe(false)
    expect(sessions.waitingForSlot()).toEqual([])
    expect(turns.prompts()).toEqual(['task a'])
  })

  it('a removed queued message leaves the queue with it', async () => {
    const { sessions, tab } = await setup({ max: 1 })
    const [a, b] = [tab('a'), tab('b')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'task b')
    sessions.removeQueued(b.id, b.queue[0].id)
    expect(waiting(b)).toBe(false)
    expect(sessions.waitingForSlot()).toEqual([])
  })

  it('raising the limit (or removing it) starts waiting turns', async () => {
    const { sessions, turns, tab, store } = await setup({ max: 1 })
    const [a, b, c] = [tab('a'), tab('b'), tab('c')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'task b')
    await sessions.send(c.id, 'task c')
    store.state.settings.maxRunningAgents = 0
    sessions.admitWaiting()
    await until(() => expect(turns.live).toHaveLength(3))
    expect([b, c].some(waiting)).toBe(false)
  })

  it('shutdown empties the queue; the messages stay held in their tabs', async () => {
    const { sessions, turns, tab } = await setup({ max: 1 })
    const [a, b] = [tab('a'), tab('b')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'task b')
    await sessions.shutdown()
    expect(waiting(b)).toBe(false)
    expect(b.queue.map((m) => m.text)).toEqual(['task b'])
    expect(turns.prompts()).toEqual(['task a'])
  })

  it('a turn whose end fails to be recorded still lets the next waiting tab start', async () => {
    const { sessions, turns, tab } = await setup({ max: 1 })
    const [a, b] = [tab('a'), tab('b')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'task b')
    await until(() => expect(turns.live).toHaveLength(1))
    const internals = sessions as unknown as { endTurn: () => Promise<void>; turns: Map<string, { done: Promise<void> }> }
    vi.spyOn(internals, 'endTurn').mockRejectedValueOnce(new Error('disk full'))
    const done = internals.turns.get(a.id)!.done
    turns.find('task a').finish()
    await expect(done).rejects.toThrow('disk full')
    await until(() => expect(turns.prompts()).toContain('task b'))
    expect(sessions.waitingForSlot()).toEqual([])
  })

  it('never leaves a slot idle behind a waiting tab: the waiting one starts first, then a new send if there is still room', async () => {
    const { sessions, turns, tab, store } = await setup({ max: 1 })
    const [a, b, c, d] = [tab('a'), tab('b'), tab('c'), tab('d')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'task b')
    // A slot frees without the queue hearing of it (here, the limit raised behind its back).
    store.state.settings.maxRunningAgents = 2
    expect(await sessions.send(c.id, 'task c')).toBe('queued')
    await until(() => expect(turns.prompts()).toContain('task b'))
    expect(sessions.waitingForSlot()).toEqual([c.id])
    store.state.settings.maxRunningAgents = 4
    expect(await sessions.send(d.id, 'task d')).toBe('started')
    await until(() => expect(turns.prompts()).toEqual(expect.arrayContaining(['task a', 'task b', 'task c', 'task d'])))
    expect(sessions.waitingForSlot()).toEqual([])
  })

  it('a running turn waiting on another lends its slot, so N coordinators each waiting on a delegate never deadlock', async () => {
    const { sessions, turns, tab } = await setup({ max: 2 })
    const [lead1, lead2, sub1, sub2, other] = [tab('lead 1'), tab('lead 2'), tab('sub 1'), tab('sub 2'), tab('other')]
    await sessions.send(lead1.id, 'coordinate 1')
    await sessions.send(lead2.id, 'coordinate 2')
    await until(() => expect(turns.live).toHaveLength(2))
    // Each coordinator delegates, then waits on its delegate (wait_for_turn, `foreman wait`).
    expect(await sessions.send(sub1.id, 'delegated 1')).toBe('queued')
    expect(await sessions.send(sub2.id, 'delegated 2')).toBe('queued')
    const release1 = sessions.lendSlot(lead1.id)
    await until(() => expect(turns.prompts()).toContain('delegated 1'))
    const release2 = sessions.lendSlot(lead2.id)
    await until(() => expect(turns.prompts()).toContain('delegated 2'))
    // Waits returning: the coordinators go on (over the limit for a while); new turns wait until it's back under.
    release1()
    release1()
    release2()
    expect(await sessions.send(other.id, 'other')).toBe('queued')
    turns.find('delegated 1').finish()
    turns.find('delegated 2').finish()
    await until(() => expect([sub1, sub2].map((t) => t.status)).toEqual(['idle', 'idle']))
    await new Promise((r) => setTimeout(r, 200))
    expect(turns.prompts()).not.toContain('other')
    turns.find('coordinate 1').finish()
    await until(() => expect(turns.prompts()).toContain('other'))
    // A tab with no turn running here has nothing to lend.
    const idle = tab('idle')
    sessions.lendSlot(idle.id)()
  })

  it('a loan ends with its turn: the tab’s next turn holds a slot again', async () => {
    const { sessions, turns, tab } = await setup({ max: 1 })
    const [a, b, c] = [tab('a'), tab('b'), tab('c')]
    await sessions.send(a.id, 'task a')
    await until(() => expect(turns.live).toHaveLength(1))
    sessions.lendSlot(a.id)
    turns.find('task a').finish()
    await until(() => expect(a.status).toBe('idle'))
    await new Promise((r) => setTimeout(r, 100))
    expect(await sessions.send(a.id, 'task a2')).toBe('started')
    expect(await sessions.send(b.id, 'task b')).toBe('queued')
    expect(await sessions.send(c.id, 'task c')).toBe('queued')
    expect(sessions.waitingForSlot()).toEqual([b.id, c.id])
  })

  it('Send now on a waiting tab puts that message first and keeps the tab’s place in the slot queue', async () => {
    const { sessions, turns, tab } = await setup({ max: 1 })
    const [a, b, c] = [tab('a'), tab('b'), tab('c')]
    await sessions.send(a.id, 'task a')
    await sessions.send(b.id, 'first')
    await sessions.send(c.id, 'task c')
    await sessions.send(b.id, 'second')
    await sessions.send(b.id, 'third')
    const third = b.queue[2]
    await sessions.steerQueued(b.id, third.id)
    expect(b.queue.map((m) => m.text)).toEqual(['third', 'first', 'second'])
    expect(b.queue[0].turnId).toBe(third.turnId)
    expect(sessions.waitingForSlot()).toEqual([b.id, c.id])
    // The head message too: it stays where it is.
    await sessions.steerQueued(b.id, b.queue[0].id)
    expect(b.queue.map((m) => m.text)).toEqual(['third', 'first', 'second'])
    turns.find('task a').finish()
    await until(() => expect(turns.prompts()).toContain('third'))
    expect(turns.prompts()).not.toContain('first')
  })

  it('cloud turns run in their sandboxes and neither count nor wait', async () => {
    useCloudSandboxes({ ready: async () => { throw new Error('not in tests') }, sandbox: async () => { throw new Error('not in tests') }, gh: async () => '', githubEnv: () => ({}) } as never)
    const { sessions, turns, tab, cloudWs } = await setup({ max: 1 })
    sessions.cloudHost = cloudHost(turns)
    const cloud = tab('remote', cloudWs.id)
    const local = tab('local')
    expect(await sessions.send(cloud.id, 'cloud task')).toBe('started')
    await until(() => expect(turns.prompts()).toContain('cloud task'))
    // The cloud turn holds no slot: a local one starts beside it.
    expect(await sessions.send(local.id, 'local task')).toBe('started')
    // And a full local slot doesn't hold back another cloud turn.
    const cloud2 = tab('remote 2', cloudWs.id)
    expect(await sessions.send(cloud2.id, 'cloud task 2')).toBe('started')
    await until(() => expect(turns.live).toHaveLength(3))
  })
})

describe('after a restart', () => {
  it('nothing waits for a slot; the message is still in its tab’s queue', async () => {
    const dir = await tempDir('foreman-slots-restart-')
    const first = new Store(dir)
    await first.load()
    first.state.sessions.push({
      id: 's1', workspaceId: 'ws', agent: 'claude', model: 'claude-opus-5-5', fastMode: false, planMode: false, status: 'idle',
      waitingForSlot: new Date().toISOString(), queue: [{ id: 'm1', turnId: 't1', text: 'task', attachments: [] }]
    } as unknown as Session)
    first.flush()
    first.close()
    const second = new Store(dir)
    await second.load()
    const session = second.state.sessions.find((s) => s.id === 's1')!
    expect(session.waitingForSlot).toBeUndefined()
    expect(session.queue.map((m) => m.text)).toEqual(['task'])
    second.close()
  })
})

describe('GitHub credentials for the first turn', () => {
  it('waits for gh’s first answers before building the turn’s environment', async () => {
    let ready = false
    const { sessions, turns, tab } = await setup({
      githubReady: () => new Promise<void>((resolve) => setTimeout(() => { ready = true; resolve() }, 50)),
      forAgent: (): Record<string, string> => (ready ? { GH_TOKEN: 'from-gh' } : {})
    })
    const a = tab('a')
    await sessions.send(a.id, 'task a')
    await until(() => expect(turns.live).toHaveLength(1))
    expect(turns.find('task a').env.GH_TOKEN).toBe('from-gh')
  })
})
