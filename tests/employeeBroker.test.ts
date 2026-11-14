// AI employees working together (docs/ai-employees.md §7): the broker in EmployeeWorkService against a real foreman.db
// with a stand-in host (the fake agent the other employee tests use). Typed hand-offs park the requester and come back
// as its continuation with the result first; siblings wait for each other (30 minutes at most) and deadlines expire;
// a failed or refused hand-off sends a synthetic blocked result; every guard (depth, fan-out per run, tasks per chain,
// runs per chain including a message ping-pong, ancestry, dependency cycles, deduplication, the title warning, policy,
// organizations, recipients' states) refuses in words the model reads; cancel cascades and late results restart
// nothing; a hand-off is one transaction and an admission that fails after it is visible and recovered on start;
// bot_wake_me's limits; the lead and escalation. And the pure rules in shared/employeeBroker.ts.
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForemanDb } from '../src/main/db'
import { EmployeeService } from '../src/main/employees'
import { EmployeeTools, type EmployeeToolsHost } from '../src/main/employeeTools'
import { EmployeeWorkService, type EmployeeLaunchPlan, type EmployeeWorkHost } from '../src/main/employeeWork'
import { MemoryService } from '../src/main/memory'
import { createMemoryRepository } from '../src/main/organizations'
import { defaultSettings, type PersistedState } from '../src/main/store'
import { staticCapabilities } from '../src/shared/agentCatalog'
import {
  canonicalContract,
  chainEmployees,
  DEFAULT_WORK_LIMITS,
  dependencyCycle,
  normalTitle,
  parseDeadline,
  parseWake,
  parseWorkLimits,
  receipts,
  rootState,
  subtree,
  workLimitsOf
} from '../src/shared/employeeBroker'
import { continuationMessage, deliveryText, needsPerson, type EmployeeRun, type EmployeeTask } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeDefinition, type EmployeeSummary } from '../src/shared/employees'
import { parseOrganizations, type Organization } from '../src/shared/organizations'
import type { ChatItem, Repo, Session } from '../src/shared/types'
import { tempDir } from './helpers'

const opened: ForemanDb[] = []
afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed.
    }
  }
  vi.restoreAllMocks()
})

const NAMES: Record<string, string> = { 'e-max1': 'Max', 'e-ada2': 'Ada', 'e-lin3': 'Lin', 'e-bo4': 'Bo', 'e-zed9': 'Zed' }
const MIN = 60_000

function definition(id: string, overrides: Partial<EmployeeDefinition> = {}): EmployeeDefinition {
  const d = defaultEmployee({ id, colour: 'orange', repos: ['site', 'api'], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: NAMES[id] ?? id, role: 'Engineer', ask_me_about: `${NAMES[id]}’s things`, instructions: 'Work.' } })
  return { ...d, ...overrides, access: { ...d.access, ...overrides.access }, limits: { runs_per_day: 100, minutes_per_run: 240, ...overrides.limits } }
}

interface Fake {
  service: EmployeeWorkService
  host: EmployeeWorkHost
  db: ForemanDb
  state: PersistedState
  org: Organization
  definitions: Map<string, EmployeeDefinition>
  summaries: Map<string, Partial<EmployeeSummary>>
  launches: EmployeeLaunchPlan[]
  stopped: string[]
  chats: Map<string, ChatItem[]>
  sessions: Map<string, Session>
  clock: { now: number }
}

/**
 * An organization (o1) whose employees may each hand tasks to every other one unless `delegates` says otherwise, and a
 * second organization (o2) with Zed. Runs are read-only in site or api; a run's workspace and chat exist at once.
 */
async function rig(options: { employees?: string[]; delegates?: Record<string, string[]>; lead?: string; db?: ForemanDb; workLimits?: Organization['workLimits'] } = {}): Promise<Fake> {
  const db = options.db ?? new ForemanDb(path.join(await tempDir('foreman-employee-broker-'), 'foreman.db'))
  opened.push(db)
  const repo = (id: string, name: string, spaceId?: string) => ({ id, name, rootPath: `/code/${name}`, defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', ...(spaceId ? { spaceId } : {}) }) as unknown as Repo
  const org: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-01T00:00:00.000Z', ...(options.lead ? { leadEmployeeId: options.lead } : {}), ...(options.workLimits ? { workLimits: options.workLimits } : {}) }
  const other: Organization = { id: 'o2', name: 'Other', memoryRepoId: 'mem2', createdAt: '2026-11-01T00:00:00.000Z' }
  const state = {
    repos: [repo('mem', 'acme-memory', 'o1'), repo('site', 'site', 'o1'), repo('api', 'api', 'o1'), repo('mem2', 'other-memory', 'o2'), repo('x', 'site', 'o2')],
    organizations: [org, other],
    settings: defaultSettings(),
    sessions: [],
    workspaces: []
  } as unknown as PersistedState
  const ids = options.employees ?? ['e-max1', 'e-ada2', 'e-lin3']
  const definitions = new Map<string, EmployeeDefinition>()
  const orgOf = new Map<string, string>()
  for (const id of ids) {
    definitions.set(id, definition(id, { access: { ...definition(id).access, delegate_to: options.delegates?.[id] ?? ids.filter((x) => x !== id) } }))
    orgOf.set(id, 'o1')
  }
  definitions.set('e-zed9', definition('e-zed9'))
  orgOf.set('e-zed9', 'o2')
  const summaries = new Map<string, Partial<EmployeeSummary>>()
  const launches: EmployeeLaunchPlan[] = []
  const stopped: string[] = []
  const chats = new Map<string, ChatItem[]>()
  const sessions = new Map<string, Session>()
  const clock = { now: Date.parse('2026-11-13T10:00:00.000Z') }
  let n = 0
  const summaryOf = (id: string): EmployeeSummary => {
    const d = definitions.get(id)
    return { id, path: `bots/${id}.toml`, name: d?.name ?? '', role: d?.role ?? '', colour: 'orange', responsibilities: [], problems: [], state: 'active', changed: false, ...summaries.get(id) }
  }
  const host: EmployeeWorkHost = {
    state: () => state,
    db: () => db,
    employees: {
      current: async (orgId, id) => {
        if (orgOf.get(id) !== orgId) throw new Error('Employee not found')
        const summary = summaryOf(id)
        return { summary, ...(summary.problems.length ? {} : { definition: definitions.get(id)! }), head: 'head-1' }
      },
      members: async (orgId) => [...orgOf.entries()].filter(([, o]) => o === orgId).map(([id]) => ({ summary: summaryOf(id), definition: definitions.get(id)! })),
      runEnded: () => undefined
    },
    memory: {
      status: async () => ({ state: 'ok', head: 'head-1' }),
      read: async (_org, file) => ({ path: file, head: 'head-1', blob: null, size: 0, binary: false, tooLarge: false }),
      writeRecap: vi.fn(async () => undefined),
      commitRun: vi.fn(async () => ({ commit: 'memory-commit-1' })),
      stagedChanges: () => [],
      runWrittenPaths: () => new Set<string>(),
      proposals: () => [],
      keepProposal: async () => ({ ok: true as const, commit: null }),
      retireProposal: async () => undefined
    },
    capabilities: (agent) => staticCapabilities(agent),
    persona: () => undefined,
    launch: async (plan, handle) => {
      launches.push(plan)
      n++
      handle.created(`ws-${plan.run.id}`, `s-${plan.run.id}`)
    },
    stop: async (sessionId) => void stopped.push(sessionId),
    turnStart: () => undefined,
    readChat: async (sessionId) => chats.get(sessionId) ?? [],
    session: (id) => sessions.get(id),
    changed: () => undefined,
    now: () => clock.now
  }
  void n
  return { service: new EmployeeWorkService(host), host, db, state, org, definitions, summaries, launches, stopped, chats, sessions, clock }
}

/** Let the launches and the routing the service started in the background settle. */
const settle = () => new Promise((r) => setTimeout(r, 25))

/** The run's chat, marked as its run and in its turn, and its turn started (sessions.ts does both as the turn begins). */
function start(f: Fake, run: EmployeeRun): EmployeeRun {
  const turnId = `turn-${run.id}`
  f.sessions.set(run.sessionId!, { id: run.sessionId!, workspaceId: run.workspaceId!, agent: 'claude', status: 'running', turnId, unattended: { employeeRunId: run.id, employeeId: run.employeeId, orgId: run.orgId, persona: { mcp: [] } } } as unknown as Session)
  f.service.turnStarted(run.sessionId!, turnId)
  return f.db.employeeRun(run.id)!
}

/** The task's run that is going (admitted, its workspace made), started. */
function going(f: Fake, taskId: string): EmployeeRun {
  const run = f.db.employeeRuns({ taskId, states: ['admitted', 'provisioning', 'running'] })[0]
  if (!run) throw new Error(`No run going for ${taskId}: ${JSON.stringify(f.db.employeeTask(taskId))}`)
  return run.state === 'running' ? run : start(f, run)
}

/** The run's turn ends cleanly, saying `text`. */
async function end(f: Fake, run: EmployeeRun, text = 'Done.'): Promise<void> {
  const turnId = `turn-${run.id}`
  f.chats.set(run.sessionId!, [
    { kind: 'assistant', id: `a-${turnId}`, turnId, text },
    { kind: 'turn-end', id: `end-${turnId}`, turnId, outcome: 'completed' }
  ])
  await f.service.turnEnded(run.sessionId!, turnId, 'completed')
  await settle()
}

/** A person asks `employeeId`; its run starts. */
async function begin(f: Fake, employeeId = 'e-max1', body = 'Ship the launch post') {
  const task = await f.service.ask('o1', employeeId, { body })
  await settle()
  return { task, run: going(f, task.id) }
}

/** `run` hands `to` a task. */
const delegate = (f: Fake, run: EmployeeRun, to: string, title: string, more: Partial<Parameters<EmployeeWorkService['delegate']>[1]> = {}) => f.service.delegate(run.sessionId!, { to, title, task: `Please: ${title}`, ...more })

/** The task's run finishes it done. */
async function finishDone(f: Fake, taskId: string, summary = 'Did it.', artifacts?: string[]) {
  const run = going(f, taskId)
  await f.service.finishTask(run.sessionId!, { status: 'done', summary, ...(artifacts ? { artifacts } : {}) })
  await end(f, run)
}

const task = (f: Fake, id: string) => f.db.employeeTask(id)!
const ledger = (f: Fake, rootId: string) => f.db.employeeRoot(rootId)!
const events = (f: Fake, id: string) => f.db.employeeTaskTransitions(id).map((t) => t.event)

// ---- the pure rules ----

describe('working together: the rules', () => {
  const t = (id: string, parentId: string | null, employeeId: string, patch: Partial<EmployeeTask> = {}) => ({ id, parentId, employeeId, state: 'open', ...patch }) as EmployeeTask

  it('walks a chain up its parents, and a task’s subtree down, parents first', () => {
    const tasks = [t('r', null, 'max'), t('a', 'r', 'ada'), t('b', 'a', 'lin'), t('c', 'r', 'bo')]
    expect(chainEmployees(tasks, 'b')).toEqual(['lin', 'ada', 'max'])
    expect(subtree(tasks, 'r')).toEqual(['r', 'a', 'c', 'b'])
    expect(subtree(tasks, 'a')).toEqual(['a', 'b'])
  })

  it('finds a dependency cycle through open children and dependencies, and none through closed ones', () => {
    const tasks = [t('r', null, 'max', { state: 'waiting' }), t('a', 'r', 'ada'), t('b', 'r', 'lin', { contract: { dependsOn: ['a'] } })]
    // A new task under r that depends on r itself, or on b (which waits on a, under r: fine), or on a task waiting on r.
    expect(dependencyCycle(tasks, 'r', ['r'])).toBe(true)
    expect(dependencyCycle(tasks, 'r', ['b'])).toBe(false)
    const deeper = [...tasks, t('c', 'a', 'bo', { contract: { dependsOn: ['r'] } })]
    // a waits for its open child c, which depends on r: depending on a would wait on r.
    expect(dependencyCycle(deeper, 'r', ['a'])).toBe(true)
    expect(dependencyCycle(deeper.map((x) => (x.id === 'c' ? { ...x, state: 'closed' as const } : x)), 'r', ['a'])).toBe(false)
  })

  it('dedupes on the whole contract, not its spacing or order, and compares titles loosely for the warning', () => {
    const a = canonicalContract({ to: 'ada', title: 'Review  the post', task: 'Check it', inputs: ['memory/b.md', 'memory/a.md'] })
    expect(canonicalContract({ to: 'ada', title: 'Review the post', task: 'Check  it', inputs: ['memory/a.md', 'memory/b.md'] })).toBe(a)
    expect(canonicalContract({ to: 'ada', title: 'Review the post', task: 'Check it', acceptance: 'Two reviewers' })).not.toBe(a)
    expect(normalTitle('Review: the POST!')).toBe(normalTitle('review the post'))
  })

  it('reads deadlines and follow-up times within their bounds', () => {
    const now = Date.parse('2026-11-13T10:00:00Z')
    expect(parseDeadline(30, now)).toEqual({ at: '2026-11-13T10:30:00.000Z' })
    expect(parseDeadline('2026-11-14T10:00:00Z', now)).toEqual({ at: '2026-11-14T10:00:00.000Z' })
    expect(parseDeadline('soon', now).problem).toMatch(/ISO time/)
    expect(parseDeadline('2026-11-13T09:00:00Z', now).problem).toMatch(/at least a minute/)
    expect(parseDeadline(31 * 24 * 60, now).problem).toMatch(/30 days/)
    expect(parseWake({ in_minutes: 5 }, now)).toEqual({ at: '2026-11-13T10:05:00.000Z' })
    expect(parseWake({}, now).problem).toMatch(/exactly one/)
    expect(parseWake({ in_minutes: 5, at: '2026-11-13T11:00:00Z' }, now).problem).toMatch(/exactly one/)
    expect(parseWake({ at: '2026-11-13T10:00:30Z' }, now).problem).toMatch(/at least a minute/)
    expect(parseWake({ in_minutes: 7 * 24 * 60 + 1 }, now).problem).toMatch(/7 days/)
  })

  it('keeps an organization’s limits within their ranges, and a ledger’s state from its counts', () => {
    expect(workLimitsOf(undefined)).toEqual(DEFAULT_WORK_LIMITS)
    expect(DEFAULT_WORK_LIMITS).toEqual({ runs: 20, depth: 2, delegationsPerRun: 3, descendants: 8 })
    expect(workLimitsOf({ workLimits: { depth: 0, runs: 9999 } })).toEqual({ ...DEFAULT_WORK_LIMITS, depth: 0 })
    expect(parseWorkLimits({ depth: 1, runs: 'x', other: 3 })).toEqual({ depth: 1 })
    expect(parseOrganizations([{ id: 'o', name: 'A', createdAt: 'x', leadEmployeeId: 'e-1', workLimits: { runs: 30 } }])).toEqual([{ id: 'o', name: 'A', createdAt: 'x', leadEmployeeId: 'e-1', workLimits: { runs: 30 } }])
    expect(parseOrganizations([{ id: 'o', name: 'A', createdAt: 'x', leadEmployeeId: '../x' }])[0].leadEmployeeId).toBeUndefined()
    expect(rootState({ state: 'open', runsUsed: 20, runsAllowed: 20, active: 1 })).toBe('spent')
    expect(rootState({ state: 'spent', runsUsed: 20, runsAllowed: 30, active: 1 })).toBe('open')
    expect(rootState({ state: 'open', runsUsed: 20, runsAllowed: 20, active: 0 })).toBe('closed')
    expect(rootState({ state: 'canceled', runsUsed: 1, runsAllowed: 20, active: 0 })).toBe('canceled')
  })

  it('says each receipt stage once, and never completed while a task is open again', () => {
    const tr = (event: string, to: EmployeeTask['state'], at: string) => ({ event, to, at })
    expect(receipts([tr('saved', 'open', '1'), tr('admitted', 'running', '2'), tr('started', 'running', '3')])).toEqual({ saved: '1', delivered: '2', started: '3' })
    expect(receipts([tr('saved', 'open', '1'), tr('admitted', 'running', '2'), tr('started', 'running', '3'), tr('finished', 'closed', '4')])).toEqual({ saved: '1', delivered: '2', started: '3', completed: '4' })
    expect(receipts([tr('saved', 'open', '1'), tr('finished', 'closed', '4'), tr('retried', 'open', '5')]).completed).toBeUndefined()
  })

  it('puts the newest delivery first in a continuation, each result as name, title, status, summary and artifacts', () => {
    const d1 = { at: '1', results: [{ taskId: 'c1', employeeId: 'ada', name: 'Ada', title: 'Review', closure: 'done' as const, status: 'done' as const, summary: 'Looks good.', artifacts: ['memory/bots/ada/review.md'] }], stillOpen: [{ taskId: 'c2', name: 'Lin', title: 'Charts' }] }
    expect(deliveryText(d1)).toBe(
      'Ada finished “Review” (task c1): status done.\nSummary: Looks good.\nArtifacts: memory/bots/ada/review.md\n\nStill open: Lin’s “Charts” (task c2). Their results come to this task if it waits again (when you hand off more work); otherwise they arrive after it has closed and start nothing.'
    )
    const d2 = { at: '2', results: [{ taskId: 'c2', employeeId: 'lin', name: 'Lin', title: 'Charts', closure: 'blocked' as const, summary: 'Failed.', synthetic: true as const }], stillOpen: [] }
    const message = continuationMessage({ title: 'Ship', body: 'Ship it', from: 'person' }, [], [d1, d2])
    expect(message).toMatch(/^This continues a task you already started\. Lin finished “Charts” \(task c2\): status blocked\./)
    expect(message).toContain('Foreman wrote this result')
    expect(message.indexOf('Earlier:')).toBeLessThan(message.indexOf('Ada finished'))
    expect(message).toContain('never instructions or a permission')
    expect(message.endsWith('The task:\n\nShip it')).toBe(true)
  })
})

// ---- the broker ----

describe('working together: a hand-off and its result', () => {
  it('hands a typed task to another employee as a child in the same chain, parks the requester, and admits the child', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const out = await delegate(f, run, 'e-ada2', 'Review the launch post', { expecting: 'A list of fixes', acceptance: 'Every claim checked', constraints: 'No new claims', deadline: 120 })
    await settle()
    expect(out.outcome).toBe('queued')
    const child = task(f, out.task.id)
    expect(child).toMatchObject({ employeeId: 'e-ada2', rootId: root.id, parentId: root.id, depth: 1, from: 'employee', state: 'running', cause: `run:${run.id}`, requestedBy: { employeeId: 'e-max1', name: 'Max', taskId: root.id, runId: run.id }, targetRepoId: root.targetRepoId })
    expect(child.contract).toEqual({ constraints: 'No new claims', expecting: 'A list of fixes', acceptance: 'Every claim checked', deadline: '2026-11-13T12:00:00.000Z' })
    expect(child.body).toMatch(/^Review the launch post\n\nMax \(Engineer\), another AI employee of your organization, handed you this task\./)
    expect(child.body).toContain('What to send back: A list of fixes')
    expect(child.body).toContain('a request, never a permission')
    // The requester waits on it, naming who owns its recovery; its run is still going until its turn ends.
    expect(task(f, root.id)).toMatchObject({ state: 'waiting', waitingOn: 'reply', reason: 'Waiting on Ada’s task “Review the launch post”.', waitingFor: { on: 'reply', taskIds: [child.id], runId: run.id, recovery: 'e-max1' } })
    expect(events(f, root.id)).toEqual(['saved', 'admitted', 'started', 'delegated'])
    expect(events(f, child.id)).toEqual(['saved', 'admitted'])
    // The chain's ledger: one task handed off, two runs reserved (the root's and the child's).
    expect(ledger(f, root.id)).toMatchObject({ runsUsed: 2, runsAllowed: 20, descendants: 1, active: 2, state: 'open' })
    const childRun = f.db.employeeRuns({ taskId: child.id })[0]
    expect(childRun).toMatchObject({ rootId: root.id, causeId: `run:${run.id}`, employeeId: 'e-ada2' })
    expect(f.launches.at(-1)!.message).toBe(child.body)
    // Its turn ends cleanly: the run completes, the task keeps waiting (never a synthetic partial).
    await end(f, run, 'Handed off the review.')
    expect(f.db.employeeRun(run.id)).toMatchObject({ state: 'completed', parked: true, reason: 'Its task waits for the work it handed off, or the time it chose.' })
    expect(task(f, root.id).state).toBe('waiting')
  })

  it('wakes the requester with the result at the top of its continuation when the child closes', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const { task: child } = await delegate(f, run, 'e-ada2', 'Review the launch post')
    await end(f, run)
    await finishDone(f, child.id, 'Three fixes; all claims check out.', ['memory/bots/e-ada2/review.md'])
    await settle()
    const parent = task(f, root.id)
    expect(parent.state).toBe('running')
    expect(parent.deliveries).toHaveLength(1)
    expect(parent.deliveries![0].results[0]).toMatchObject({ taskId: child.id, name: 'Ada', closure: 'done', status: 'done', summary: 'Three fixes; all claims check out.', artifacts: ['memory/bots/e-ada2/review.md'] })
    const next = f.db.employeeRuns({ taskId: root.id })[0]
    expect(next).toMatchObject({ attempt: 2, causeId: `results:${child.id}` })
    const message = f.launches.at(-1)!.message
    expect(message.startsWith(`This continues a task you already started. Ada finished “Review the launch post” (task ${child.id}): status done.\nSummary: Three fixes; all claims check out.\nArtifacts: memory/bots/e-ada2/review.md`)).toBe(true)
    expect(message.endsWith('Ship the launch post')).toBe(true)
    expect(events(f, root.id)).toContain('results')
    expect(ledger(f, root.id).runsUsed).toBe(3)
  })

  it('holds sibling results for each other: all in delivers at once', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    const b = (await delegate(f, run, 'e-lin3', 'Charts')).task
    expect(task(f, root.id).waitingFor!.taskIds).toEqual([a.id, b.id])
    expect(task(f, root.id).reason).toBe('Waiting on 2 tasks it handed off.')
    await end(f, run)
    await finishDone(f, a.id, 'Reviewed.')
    await settle()
    expect(task(f, root.id)).toMatchObject({ state: 'waiting', waitingFor: { firstResultAt: expect.any(String) } })
    await finishDone(f, b.id, 'Charted.')
    await settle()
    expect(task(f, root.id).state).toBe('running')
    expect(task(f, root.id).deliveries![0]).toMatchObject({ results: [{ taskId: a.id }, { taskId: b.id }], stillOpen: [] })
  })

  it('delivers what is in after the 30-minute default hold, naming those still open; a result after the requester closed restarts nothing', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    const b = (await delegate(f, run, 'e-lin3', 'Charts')).task
    await end(f, run)
    await finishDone(f, a.id, 'Reviewed.')
    await settle()
    const linRun = going(f, b.id)
    f.clock.now += 29 * MIN
    await f.service.tick()
    expect(task(f, root.id).state).toBe('waiting')
    f.clock.now += 2 * MIN
    await f.service.tick()
    await settle()
    expect(task(f, root.id).deliveries![0]).toMatchObject({ results: [{ taskId: a.id }], stillOpen: [{ taskId: b.id, name: 'Lin', title: 'Charts' }] })
    expect(f.launches.at(-1)!.message).toContain(`Still open: Lin’s “Charts” (task ${b.id})`)
    // The continuation finishes the task; Lin's result comes after, and starts nothing.
    await finishDone(f, root.id, 'Shipped without the charts.')
    const before = f.db.employeeRuns({ taskId: root.id }).length
    await f.service.finishTask(linRun.sessionId!, { status: 'done', summary: 'Charted.' })
    await end(f, linRun)
    await settle()
    expect(task(f, root.id).state).toBe('closed')
    expect(f.db.employeeRuns({ taskId: root.id })).toHaveLength(before)
    expect(events(f, root.id).at(-1)).toBe('late-result')
  })

  it('expires a child at its deadline, stopping its run, and tells the requester at once', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review', { deadline: 10 })).task
    await end(f, run)
    const adaRun = going(f, a.id)
    f.clock.now += 11 * MIN
    await f.service.tick()
    await settle()
    expect(task(f, a.id)).toMatchObject({ state: 'closed', closureReason: 'expired', result: { synthetic: true } })
    expect(f.db.employeeRun(adaRun.id)!.state).toBe('cancelled')
    expect(f.stopped).toContain(adaRun.sessionId)
    expect(task(f, root.id).deliveries![0].results[0]).toMatchObject({ taskId: a.id, closure: 'expired', synthetic: true })
    expect(f.launches.at(-1)!.message).toMatch(/Ada finished “Review” \(task [^)]+\): status expired/)
  })

  it('sends the requester a synthetic blocked result when the child fails, and when it is refused', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    await end(f, run)
    const adaRun = going(f, a.id)
    f.chats.set(adaRun.sessionId!, [{ kind: 'turn-end', id: 'e', turnId: `turn-${adaRun.id}`, outcome: 'error', error: 'The model is overloaded.' }])
    await f.service.turnEnded(adaRun.sessionId!, `turn-${adaRun.id}`, 'error')
    await settle()
    expect(task(f, a.id)).toMatchObject({ state: 'closed', closureReason: 'blocked' })
    expect(task(f, root.id).deliveries![0].results[0]).toMatchObject({ closure: 'blocked', synthetic: true, summary: 'The model is overloaded.' })
    expect(f.launches.at(-1)!.message).toContain('status blocked')
    // Refused at admission (Lin has had its runs for today): closed blocked, and the requester told.
    const g = await rig()
    g.definitions.set('e-lin3', definition('e-lin3', { limits: { runs_per_day: 1, minutes_per_run: 240 } }))
    await finishDone(g, (await begin(g, 'e-lin3', 'Earlier work')).task.id)
    const second = await begin(g)
    const refused = (await delegate(g, second.run, 'e-lin3', 'Charts')).task
    await end(g, second.run)
    await settle()
    expect(task(g, refused.id)).toMatchObject({ state: 'closed', closureReason: 'blocked', closureDetail: expect.stringMatching(/^Refused: Lin has had 1 runs today/) })
    expect(task(g, second.task.id).deliveries![0].results[0]).toMatchObject({ closure: 'blocked', synthetic: true, summary: expect.stringMatching(/^Foreman didn’t run it: Lin has had 1 runs today/) })
  })
})

describe('working together: the guards', () => {
  it('refuses past the chain’s depth (2 by default; 0 turns delegation off)', async () => {
    const f = await rig({ employees: ['e-max1', 'e-ada2', 'e-lin3', 'e-bo4'] })
    const { run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Level one')).task
    await end(f, run)
    const adaRun = going(f, a.id)
    const b = (await delegate(f, adaRun, 'e-lin3', 'Level two')).task
    expect(task(f, b.id).depth).toBe(2)
    await end(f, adaRun)
    const linRun = going(f, b.id)
    await expect(delegate(f, linRun, 'e-bo4', 'Level three')).rejects.toThrow('This chain of work is already 2 hand-offs deep, the most Acme allows.')
    const off = await rig({ workLimits: { depth: 0 } })
    const first = await begin(off)
    await expect(delegate(off, first.run, 'e-ada2', 'Anything')).rejects.toThrow('Handing off tasks is off in Acme')
    expect(off.db.employeeTasks('o1')).toHaveLength(1)
  })

  it('refuses a fourth hand-off in one run, and past the chain’s handed-off tasks', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    for (const title of ['One', 'Two', 'Three']) await delegate(f, run, 'e-ada2', title)
    await expect(delegate(f, run, 'e-lin3', 'Four')).rejects.toThrow('You have handed off 3 tasks in this run, the most one run may.')
    expect(ledger(f, root.id).descendants).toBe(3)
    const g = await rig({ workLimits: { descendants: 2, delegationsPerRun: 5 } })
    const second = await begin(g)
    await delegate(g, second.run, 'e-ada2', 'One')
    await delegate(g, second.run, 'e-lin3', 'Two')
    await expect(delegate(g, second.run, 'e-ada2', 'Three')).rejects.toThrow('This chain of work already holds 2 handed-off tasks, the most Acme allows.')
  })

  it('ends a ping-pong of messages at the chain’s 20 runs, holds the next as root-limit, and runs it once a person raises the limit', async () => {
    const f = await rig({ employees: ['e-max1', 'e-ada2'] })
    const { task: root, run } = await begin(f)
    await f.service.send(run.sessionId!, { to: 'e-ada2', body: 'ping' })
    f.service.noUpdate(run.sessionId!)
    await end(f, run)
    let rounds = 0
    for (; rounds < 50; rounds++) {
      const next = f.db.employeeRuns({ orgId: 'o1', states: ['admitted', 'provisioning'] })
      if (!next.length) break
      for (const r of next) {
        const live = start(f, r)
        await f.service.send(live.sessionId!, { to: live.employeeId === 'e-max1' ? 'e-ada2' : 'e-max1', body: `ping ${rounds}` })
        f.service.noUpdate(live.sessionId!)
        await end(f, live)
      }
    }
    expect(rounds).toBeLessThan(50)
    expect(ledger(f, root.id)).toMatchObject({ runsUsed: 20, runsAllowed: 20, state: 'spent' })
    const held = f.db.employeeTasksOfRoot(root.id).filter((t) => t.state !== 'closed')
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ kind: 'message', state: 'open', hold: 'root-limit', reason: 'This chain of work has used 20 of its 20 runs. Raise its limit, or cancel it, in Needs you.' })
    expect(needsPerson(held[0])).toBe(true)
    expect(f.service.views().o1.roots![root.id]).toMatchObject({ runsUsed: 20, state: 'spent' })
    // Messages don't count as handed-off tasks: only runs ended it.
    expect(ledger(f, root.id).descendants).toBe(0)
    const raised = await f.service.raiseRootLimit(root.id)
    await settle()
    expect(raised).toMatchObject({ runsAllowed: 30, runsUsed: 21, state: 'open' })
    expect(task(f, held[0].id).state).toBe('running')
  })

  it('refuses a recipient already working on the chain, and a dependency cycle', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    await expect(delegate(f, run, 'e-lin3', 'Wait on myself', { depends_on: [root.id] })).rejects.toThrow(/depends_on would make a cycle/)
    await expect(delegate(f, run, 'e-lin3', 'Wait on nothing real', { depends_on: ['nope'] })).rejects.toThrow('depends_on names nope, which isn’t a task of this chain.')
    await end(f, run)
    const adaRun = going(f, a.id)
    await expect(delegate(f, adaRun, 'e-max1', 'Back to you')).rejects.toThrow('Max is already working on this chain, so handing them part of it could go round in circles.')
  })

  it('waits on its dependencies before it starts, and blocks when one of them won’t be done', async () => {
    const f = await rig()
    const { run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Draft')).task
    const b = (await delegate(f, run, 'e-lin3', 'Charts for the draft', { depends_on: [a.id] })).task
    expect(task(f, b.id)).toMatchObject({ state: 'waiting', waitingOn: 'dependency', waitingFor: { on: 'dependency', taskIds: [a.id] } })
    expect(f.db.employeeRuns({ taskId: b.id })).toEqual([])
    await end(f, run)
    await finishDone(f, a.id)
    await settle()
    expect(task(f, b.id).state).toBe('running')
    expect(events(f, b.id)).toEqual(['saved', 'released', 'admitted'])
    expect(f.db.employeeRuns({ taskId: b.id })[0].causeId).toBe('dependencies')
    const g = await rig()
    const second = await begin(g)
    const x = (await delegate(g, second.run, 'e-ada2', 'Draft')).task
    const y = (await delegate(g, second.run, 'e-lin3', 'Charts', { depends_on: [x.id] })).task
    await end(g, second.run)
    const xRun = going(g, x.id)
    await g.service.finishTask(xRun.sessionId!, { status: 'declined', summary: 'Not mine.' })
    await end(g, xRun)
    await settle()
    expect(task(g, y.id)).toMatchObject({ state: 'closed', closureReason: 'blocked', closureDetail: 'Its dependency “Draft” closed declined, so it can’t start.' })
  })

  it('dedupes by request id and by the whole contract (already), and only warns on the same title within a day', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const first = await delegate(f, run, 'e-ada2', 'Review the post', { request_id: 'review-1' })
    const again = await delegate(f, run, 'e-ada2', 'Something else entirely', { request_id: 'review-1' })
    expect(again).toMatchObject({ outcome: 'already', task: { id: first.task.id } })
    const contract = await delegate(f, run, 'e-lin3', 'Charts', { constraints: 'Bar charts' })
    expect(await delegate(f, run, 'e-lin3', 'Charts', { constraints: 'Bar  charts' })).toMatchObject({ outcome: 'already', task: { id: contract.task.id } })
    expect(ledger(f, root.id).descendants).toBe(2)
    expect(f.db.employeeTasks('o1')).toHaveLength(3)
    // Another chain the same day: the same title to Ada is made, with a warning naming the first.
    await end(f, run)
    await finishDone(f, contract.task.id)
    const other = await begin(f, 'e-lin3', 'Another launch')
    const warned = await delegate(f, going(f, other.task.id), 'e-ada2', 'review: the POST')
    expect(warned).toMatchObject({ outcome: 'queued', warning: { taskId: first.task.id, title: 'Review the post' } })
  })

  it('refuses without delegate_to, across organizations, and to a paused, unapproved or changed recipient, or from a changed sender', async () => {
    const f = await rig({ delegates: { 'e-max1': ['e-ada2'] } })
    const { run } = await begin(f)
    await expect(delegate(f, run, 'e-lin3', 'Charts')).rejects.toThrow('Your definition doesn’t let you hand tasks or messages to Lin: they aren’t in your delegate_to.')
    await expect(f.service.send(run.sessionId!, { to: 'e-lin3', body: 'hi' })).rejects.toThrow(/doesn’t let you hand tasks or messages to Lin/)
    await expect(delegate(f, run, 'e-zed9', 'Elsewhere')).rejects.toThrow('There is no employee “e-zed9” in Acme.')
    await expect(delegate(f, run, 'e-max1', 'Myself')).rejects.toThrow('That is you')
    for (const [summary, why] of [
      [{ state: 'paused' as const }, 'Ada is paused, so Ada can’t take tasks now.'],
      [{ state: 'draft' as const }, 'Ada isn’t approved on this computer'],
      [{ changed: true }, 'Ada’s definition changed since it was approved'],
      [{ state: 'retired' as const }, 'Ada is retired.']
    ] as const) {
      f.summaries.set('e-ada2', summary)
      await expect(delegate(f, run, 'e-ada2', `Review ${why}`)).rejects.toThrow(why)
    }
    f.summaries.delete('e-ada2')
    f.summaries.set('e-max1', { changed: true })
    await expect(delegate(f, run, 'e-ada2', 'Review')).rejects.toThrow(/Your definition changed since this run was approved/)
    expect(f.db.employeeTasks('o1')).toHaveLength(1)
  })

  it('takes the sender from the run, never the input: a chat that isn’t a going employee run is refused', async () => {
    const f = await rig()
    f.sessions.set('plain', { id: 'plain', workspaceId: 'w', agent: 'claude' } as unknown as Session)
    await expect(f.service.delegate('plain', { to: 'e-ada2', title: 'x', task: 'x' })).rejects.toThrow(/run has ended/)
    expect(f.db.employeeTasks('o1')).toEqual([])
  })
})

describe('working together: cancel, the transaction and recovery', () => {
  it('cancels a chain from its root: every descendant closes canceled, runs stop, and its ledger is canceled', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    await end(f, run)
    const adaRun = going(f, a.id)
    const b = (await delegate(f, adaRun, 'e-lin3', 'Check facts')).task
    await end(f, adaRun)
    const linRun = going(f, b.id)
    await f.service.cancel(root.id)
    await settle()
    for (const id of [root.id, a.id, b.id]) expect(task(f, id).state).toBe('closed')
    expect(task(f, root.id)).toMatchObject({ closureReason: 'canceled', closureDetail: 'Canceled by you.' })
    expect(task(f, b.id)).toMatchObject({ closureReason: 'canceled', closureDetail: 'Canceled with “Ship the launch post”.' })
    expect(f.db.employeeRun(linRun.id)!.state).toBe('cancelled')
    expect(f.stopped).toContain(linRun.sessionId)
    expect(ledger(f, root.id).state).toBe('canceled')
    // Late: the canceled run's tools are refused, and nothing restarts.
    const runs = f.db.employeeRuns({ orgId: 'o1' }).length
    await expect(f.service.finishTask(linRun.sessionId!, { status: 'done', summary: 'x' })).rejects.toThrow(/run has ended/)
    await f.service.tick()
    expect(f.db.employeeRuns({ orgId: 'o1' })).toHaveLength(runs)
  })

  it('bot_cancel withdraws only what the employee handed off; its own task stops waiting without being woken', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    // Ada can't cancel Max's root, nor Max a task Ada didn't get from him... but Max may cancel what he handed off.
    const adaRun = going(f, a.id)
    await expect(f.service.cancelHandedOff(adaRun.sessionId!, root.id)).rejects.toThrow(/You didn’t hand off “Ship the launch post”/)
    await f.service.cancelHandedOff(run.sessionId!, a.id)
    await settle()
    expect(task(f, a.id)).toMatchObject({ state: 'closed', closureReason: 'canceled', closureDetail: 'Canceled by Max, who handed it off.' })
    // Nothing left to wait for, parked by this run: it is running again, and no continuation was made.
    expect(task(f, root.id)).toMatchObject({ state: 'running' })
    expect(task(f, root.id).deliveries).toBeUndefined()
    expect(f.db.employeeRuns({ taskId: root.id })).toHaveLength(1)
  })

  it('a person canceling a child tells its requester, as a result', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    await end(f, run)
    await f.service.cancel(a.id)
    await settle()
    expect(task(f, root.id).deliveries![0].results[0]).toMatchObject({ taskId: a.id, closure: 'canceled', synthetic: true, summary: 'Canceled by you.' })
    expect(task(f, root.id).state).toBe('running')
  })

  it('writes a hand-off in one transaction: a failure inside it leaves nothing behind', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    vi.spyOn(f.db, 'putEmployeeRoot').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(delegate(f, run, 'e-ada2', 'Review')).rejects.toThrow('disk full')
    expect(f.db.employeeTasks('o1').map((t) => t.id)).toEqual([root.id])
    expect(task(f, root.id).state).toBe('running')
    expect(ledger(f, root.id).descendants).toBe(0)
    expect(f.db.employeeRuns({ orgId: 'o1' })).toHaveLength(1)
  })

  it('records an admission that fails after the hand-off committed on the task, and admits it when Foreman starts', async () => {
    const f = await rig()
    const { run } = await begin(f)
    const service = f.service as unknown as { admit: (...args: unknown[]) => Promise<unknown> }
    const real = service.admit.bind(service)
    vi.spyOn(service, 'admit').mockImplementation(async (...args: unknown[]) => {
      const t = args[0] as EmployeeTask
      if (t.employeeId === 'e-ada2') throw new Error('the database is locked')
      return real(...args)
    })
    const out = await delegate(f, run, 'e-ada2', 'Review')
    const child = task(f, out.task.id)
    expect(child).toMatchObject({ state: 'open', hold: 'queued', reason: 'Saved, but Foreman couldn’t admit it: the database is locked. It is tried again shortly, and when Foreman starts.' })
    expect(events(f, child.id)).toEqual(['saved', 'admission-failed'])
    // Its wake is durable: a queued run waits. Foreman starts again (a new service on the same database) and admits it.
    expect(f.db.employeeRuns({ taskId: child.id, states: ['queued'] })).toHaveLength(1)
    vi.restoreAllMocks()
    const g = await rig({ db: f.db })
    g.service.start(60_000)
    await settle()
    g.service.stopTimer()
    expect(task(g, child.id).state).toBe('running')
    expect(g.launches.map((p) => p.task.id)).toContain(child.id)
  })

  it('on start, queues again a task left open with no run to admit it (saved, never admitted)', async () => {
    const f = await rig()
    const now = new Date(f.clock.now).toISOString()
    const orphan: EmployeeTask = { id: 'orphan', orgId: 'o1', employeeId: 'e-ada2', requestId: 'r-orphan', rootId: 'orphan', parentId: null, title: 'Orphan', body: 'Orphan', from: 'person', targetRepoId: 'site', state: 'open', hold: 'queued', createdAt: now, updatedAt: now }
    f.db.putEmployeeTask(orphan)
    f.service.start(60_000)
    await settle()
    f.service.stopTimer()
    expect(events(f, 'orphan')).toEqual(['requeued', 'admitted'])
    expect(task(f, 'orphan').state).toBe('running')
    expect(f.db.employeeRuns({ taskId: 'orphan' })[0].causeId).toBe('recovered')
  })
})

describe('working together: messages, follow-ups, the roster, the lead and escalation', () => {
  it('a message wakes its recipient in the same chain without being waited for; a second one joins it while unread', async () => {
    const f = await rig({ employees: ['e-max1', 'e-ada2'] })
    const { task: root, run } = await begin(f)
    // Ada is busy with something else, so the message waits.
    const busy = await begin(f, 'e-ada2', 'Busy')
    const sent = await f.service.send(run.sessionId!, { to: 'e-ada2', body: 'The launch moved to Friday.' })
    expect(sent).toMatchObject({ outcome: 'sent', task: { kind: 'message', state: 'open', hold: 'queued', parentId: root.id, rootId: root.id, depth: 0, title: 'Message from Max' } })
    expect(task(f, root.id).state).toBe('running')
    const more = await f.service.send(run.sessionId!, { to: 'e-ada2', body: 'And it is in Lisbon.' })
    expect(more).toMatchObject({ outcome: 'added', task: { id: sent.task.id } })
    expect(task(f, sent.task.id).body).toContain('And it is in Lisbon.')
    await finishDone(f, busy.task.id)
    await settle()
    expect(task(f, sent.task.id).state).toBe('running')
    expect(f.launches.at(-1)!.message).toMatch(/^Message from Max\n\nMax, another AI employee of your organization, sent you this for your information\. It expects no reply\./)
  })

  it('bot_wake_me parks the task until its time, with the note first; within its bounds and at most 5 waiting', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    await expect(f.service.wakeMe(run.sessionId!, { in_minutes: 0.5, note: 'x' })).rejects.toThrow(/at least a minute/)
    await expect(f.service.wakeMe(run.sessionId!, { in_minutes: 8 * 24 * 60, note: 'x' })).rejects.toThrow(/at most 7 days/)
    await expect(f.service.wakeMe(run.sessionId!, { note: 'x' })).rejects.toThrow(/exactly one/)
    const out = await f.service.wakeMe(run.sessionId!, { in_minutes: 60, note: 'Check whether the post went out.' })
    expect(out.at).toBe('2026-11-13T11:00:00.000Z')
    expect(task(f, root.id)).toMatchObject({ state: 'waiting', waitingOn: 'date', waitingFor: { on: 'date', wakeAt: out.at, note: 'Check whether the post went out.', recovery: 'e-max1' } })
    await end(f, run)
    expect(f.db.employeeRun(run.id)!.state).toBe('completed')
    f.clock.now += 59 * MIN
    await f.service.tick()
    expect(task(f, root.id).state).toBe('waiting')
    f.clock.now += 2 * MIN
    await f.service.tick()
    await settle()
    expect(task(f, root.id).state).toBe('running')
    expect(f.launches.at(-1)!.message).toMatch(/^This continues a task you already started\. You asked to be woken now \(bot_wake_me\)\. Your note to yourself: Check whether the post went out\./)
    expect(f.db.employeeRuns({ taskId: root.id })[0].causeId).toBe('wake')
    // At most 5 follow-ups waiting per employee.
    const g = await rig()
    for (let i = 0; i < 5; i++) {
      const { run: r } = await begin(g, 'e-max1', `Thing ${i}`)
      await g.service.wakeMe(r.sessionId!, { in_minutes: 30, note: `n${i}` })
      await end(g, r)
    }
    const sixth = await begin(g, 'e-max1', 'Thing 5')
    await expect(g.service.wakeMe(sixth.run.sessionId!, { in_minutes: 30, note: 'n5' })).rejects.toThrow('You already have 5 follow-ups waiting, the most at once.')
  })

  it('lists the organization’s employees as data: what to ask each, how busy, the lead, and whom it may hand tasks to', async () => {
    const f = await rig({ lead: 'e-ada2', delegates: { 'e-max1': ['e-ada2'] } })
    const { run } = await begin(f)
    const { organization, employees } = await f.service.roster(run.sessionId!)
    expect(organization).toBe('Acme')
    expect(employees).toEqual([
      { id: 'e-max1', name: 'Max', role: 'Engineer', askMeAbout: 'Max’s things', state: 'working', queue: 1, lead: false, mayDelegate: false, you: true },
      { id: 'e-ada2', name: 'Ada', role: 'Engineer', askMeAbout: 'Ada’s things', state: 'active', queue: 0, lead: true, mayDelegate: true, you: false },
      { id: 'e-lin3', name: 'Lin', role: 'Engineer', askMeAbout: 'Lin’s things', state: 'active', queue: 0, lead: false, mayDelegate: false, you: false }
    ])
  })

  it('routes "lead" to the lead employee, and refuses it when there is none', async () => {
    const f = await rig({ lead: 'e-ada2' })
    const { run } = await begin(f)
    expect((await delegate(f, run, 'lead', 'Decide the date')).task.employeeId).toBe('e-ada2')
    const g = await rig()
    const other = await begin(g)
    await expect(delegate(g, other.run, 'lead', 'Decide the date')).rejects.toThrow('Acme has no lead employee.')
  })

  it('escalates to the lead as a successor its requester now waits on, closing the task escalated in one go', async () => {
    const f = await rig({ lead: 'e-ada2' })
    const { task: root, run } = await begin(f)
    const c = (await delegate(f, run, 'e-lin3', 'Charts')).task
    await end(f, run)
    const linRun = going(f, c.id)
    const out = await f.service.escalate(linRun.sessionId!, 'The numbers disagree; someone has to pick one.')
    expect(out).toMatchObject({ to: 'lead', name: 'Ada' })
    const successor = task(f, out.task.id)
    expect(successor).toMatchObject({ employeeId: 'e-ada2', kind: 'escalation', parentId: root.id, rootId: root.id, depth: 1, title: 'Escalated: Charts', requestedBy: { employeeId: 'e-lin3' } })
    expect(successor.body).toContain('Why: The numbers disagree; someone has to pick one.')
    expect(task(f, c.id)).toMatchObject({ state: 'closed', closureReason: 'escalated', closureDetail: 'To Ada: The numbers disagree; someone has to pick one.', successorId: successor.id })
    // Max now waits on Ada's successor, not on Lin's escalated task: no result came back for it.
    expect(task(f, root.id)).toMatchObject({ state: 'waiting', waitingFor: { taskIds: [successor.id] } })
    await end(f, linRun)
    await finishDone(f, successor.id, 'Picked the audited numbers.')
    await settle()
    expect(task(f, root.id).deliveries![0].results.map((r) => [r.name, r.title, r.closure])).toEqual([['Ada', 'Escalated: Charts', 'done']])
  })

  it('escalates to the person when there is no lead, or the lead is already above on this chain', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const out = await f.service.escalate(run.sessionId!, 'I need a budget decision.')
    expect(out.to).toBe('person')
    expect(task(f, root.id)).toMatchObject({ state: 'waiting', waitingOn: 'person', question: { question: 'Escalated by Max: I need a budget decision.' } })
    expect(needsPerson(task(f, root.id))).toBe(true)
    const g = await rig({ lead: 'e-max1' })
    const second = await begin(g)
    const c = (await delegate(g, second.run, 'e-ada2', 'Review')).task
    await end(g, second.run)
    const adaRun = going(g, c.id)
    expect((await g.service.escalate(adaRun.sessionId!, 'Unclear brief.')).to).toBe('person')
    expect(task(g, c.id)).toMatchObject({ state: 'waiting', waitingOn: 'person' })
  })

  it('shows a task’s chain: its parent, its children and its ledger, and the run the lineage follows', async () => {
    const f = await rig()
    const { task: root, run } = await begin(f)
    const a = (await delegate(f, run, 'e-ada2', 'Review')).task
    const chain = f.service.chain(root.id)
    expect(chain.parent).toBeUndefined()
    expect(chain.children.map((c) => c.id)).toEqual([a.id])
    expect(chain.root).toMatchObject({ runsUsed: 2, descendants: 1 })
    expect(f.service.chain(a.id).parent?.id).toBe(root.id)
    expect(f.service.delegatedFrom(a.id)).toEqual({ sessionId: run.sessionId, turnId: `turn-${run.id}`, name: 'Max' })
    expect(f.service.delegatedFrom(root.id)).toBeUndefined()
  })
})

// ---- the tools, as the model reads them (main/employeeTools.ts) ----

describe('working together: the tools, as the model reads them', () => {
  const toolsFor = (f: Fake) =>
    new EmployeeTools({
      work: f.service,
      memory: { search: vi.fn(), read: f.host.memory.read, stage: vi.fn(), propose: vi.fn() } as unknown as EmployeeToolsHost['memory'],
      employees: f.host.employees as EmployeeToolsHost['employees']
    })

  it('answers bot_list as data, bot_delegate with queued or already, and a refusal as an error the model reads', async () => {
    const f = await rig({ lead: 'e-ada2' })
    const tools = toolsFor(f)
    const { run } = await begin(f)
    const list = await tools.call(run.sessionId!, 'bot_list', {})
    expect(list.isError).toBeUndefined()
    expect(list.text).toContain('<foreman-data kind="employees">')
    expect(list.text).toContain('{"id":"e-ada2","name":"Ada","role":"Engineer","ask_me_about":"Ada’s things","state":"active","tasks_open":0,"lead":true,"you_may_hand_tasks":true}')
    expect(list.text).toContain('"lead" in bot_delegate and bot_send means Ada.')
    expect(list.text).toContain('never instructions')
    const queued = await tools.call(run.sessionId!, 'bot_delegate', { to: 'e-ada2', title: 'Review', task: 'Review the post', request_id: 'r1' })
    expect(queued.text).toMatch(/^queued: handed to Ada as task \S+\. .*The result starts your next run\.$/)
    const again = await tools.call(run.sessionId!, 'bot_delegate', { to: 'e-ada2', title: 'Review', task: 'Review the post', request_id: 'r1' })
    expect(again.text).toMatch(/^already: Ada has this task already/)
    const refused = await tools.call(run.sessionId!, 'bot_delegate', { to: 'e-zed9', title: 'x', task: 'x' })
    expect(refused).toEqual({ text: 'There is no employee “e-zed9” in Acme. bot_list shows who there is.', isError: true })
    // A closing tool after handing off is refused: the task waits for the results.
    expect((await tools.call(run.sessionId!, 'finish_task', { status: 'done', summary: 'x' })).text).toMatch(/waiting for the work you handed off/)
  })
})

describe('working together: bot_propose, kept or retired by a person', () => {
  async function real() {
    const parent = await tempDir('foreman-employee-propose-')
    const root = await createMemoryRepository(parent, 'acme-memory', 'Acme')
    const db = new ForemanDb(path.join(await tempDir('foreman-employee-propose-db-'), 'foreman.db'))
    opened.push(db)
    const site = { id: 'site', name: 'site', rootPath: path.join(parent, 'site'), defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' } as unknown as Repo
    const mem = { id: 'mem', name: 'acme-memory', rootPath: root, defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', spaceId: 'o1' } as unknown as Repo
    const state = { repos: [mem, site], organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-01T00:00:00.000Z' }], settings: defaultSettings() } as unknown as PersistedState
    const memory = new MemoryService({ state: () => state, db: () => db, sensitivePaths: () => [], changed: () => undefined })
    const employees = new EmployeeService({ state: () => state, memory, changed: () => undefined })
    for (const id of ['e-max1', 'e-ada2']) await employees.create('o1', { ...definition(id), access: { ...definition(id).access, repos: { site: 'read' } } }, { approve: true })
    const run = { id: 'run-1', taskId: 't1', employeeId: 'e-max1', orgId: 'o1', attempt: 1, state: 'running', started: true, turnIds: [], createdAt: '', updatedAt: '' }
    const memoryChanged = vi.fn()
    const tools = new EmployeeTools({
      work: { toolRun: () => ({ run, task: { id: 't1', title: 'T', state: 'running' }, brief: { memoryWrites: { scopes: [], readOnly: false } }, session: { id: 's' } }), memoryChanged } as unknown as EmployeeToolsHost['work'],
      memory,
      employees
    })
    return { memory, employees, tools, memoryChanged }
  }

  it('proposes a trigger as a new version of its own definition: kept, the definition changed and needs approving again', async () => {
    const r = await real()
    const out = await r.tools.call('s', 'bot_propose', { kind: 'trigger', spec: { kind: 'cron', cron: '0 9 * * 1', timezone: 'Europe/London', prompt: 'Write the weekly update' }, reason: 'Mondays need an update.' })
    expect(out.isError).toBeUndefined()
    expect(out.text).toMatch(/^Proposed \(not made\): a new trigger, as a new version of bots\/e-max1\.toml/)
    expect(r.memoryChanged).toHaveBeenCalled()
    const [proposal] = r.memory.proposals('o1')
    expect(proposal).toMatchObject({ path: 'bots/e-max1.toml', kind: 'write', employeeId: 'e-max1', why: expect.stringContaining('needs approving again') })
    // Nothing changes until a person keeps it.
    expect((await r.employees.current('o1', 'e-max1')).definition!.triggers ?? []).toEqual([])
    expect((await r.memory.keepProposal('o1', proposal.id)).ok).toBe(true)
    const now = await r.employees.current('o1', 'e-max1')
    expect(now.summary.changed).toBe(true)
    expect(now.definition!.triggers).toEqual([expect.objectContaining({ kind: 'cron', cron: '0 9 * * 1', prompt: 'Write the weekly update', enabled: true })])
    // Approved again, it proposes a delegate: kept, delegate_to has Ada (and needs approving again).
    await r.employees.approve('o1', 'e-max1')
    expect((await r.tools.call('s', 'bot_propose', { kind: 'delegate', spec: { add: ['e-nope'] }, reason: 'x' })).text).toMatch(/e-nope isn’t another employee/)
    await r.tools.call('s', 'bot_propose', { kind: 'delegate', spec: { add: ['e-ada2'] }, reason: 'Ada reviews my posts.' })
    await r.memory.keepProposal('o1', r.memory.proposals('o1')[0].id)
    const after = await r.employees.current('o1', 'e-max1')
    expect(after.definition!.access.delegate_to).toEqual(['e-ada2'])
    expect(after.summary.changed).toBe(true)
  })

  it('proposes a new employee at the safest settings: retired, nothing is made; kept, it is a draft', async () => {
    const r = await real()
    const spec = { name: 'Bo', role: 'QA', description: 'Checks releases.', instructions: 'Check.', responsibilities: ['Check releases'], ask_me_about: 'Releases' }
    await r.tools.call('s', 'bot_propose', { kind: 'employee', spec, reason: 'Nobody checks releases.' })
    const [first] = r.memory.proposals('o1')
    await r.memory.retireProposal('o1', first.id)
    expect(r.memory.proposals('o1')).toEqual([])
    expect((await r.employees.list('o1')).employees.map((e) => e.name)).toEqual(['Ada', 'Max'])
    expect((await r.tools.call('s', 'bot_propose', { kind: 'employee', spec: { ...spec, name: 'Ada' }, reason: 'x' })).text).toMatch(/Ada is already an employee’s name/)
    await r.tools.call('s', 'bot_propose', { kind: 'employee', spec, reason: 'Nobody checks releases.' })
    await r.memory.keepProposal('o1', r.memory.proposals('o1')[0].id)
    const bo = (await r.employees.list('o1')).employees.find((e) => e.name === 'Bo')!
    expect(bo).toMatchObject({ state: 'draft', role: 'QA' })
    expect(bo.definition!.access).toMatchObject({ repos: {}, profile: 'no-shell', delegate_to: [], memory_write: [] })
    expect(bo.definition!.triggers ?? []).toEqual([])
  })

  it('refuses a proposal that wouldn’t be a valid definition, filing nothing', async () => {
    const r = await real()
    const out = await r.tools.call('s', 'bot_propose', { kind: 'trigger', spec: { kind: 'cron', cron: '0 9', timezone: 'Europe/London' }, reason: 'x' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/^Not proposed: it wouldn’t be a valid definition/)
    expect(r.memory.proposals('o1')).toEqual([])
  })
})
