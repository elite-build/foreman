// The one list of what needs the person (src/shared/needsYou.ts): workspaces triage puts in Needs your attention plus
// each organization's employee questions, held actions, proposals and pauses; each thing once; counted by space,
// repository and employee, so every surface says the same number. The fixture is the screenshots': Personal 1, Acme 3.
import { describe, expect, it } from 'vitest'
import { employeeKey, inChannel, itemsInSpace, needsYouCounts, needsYouItems, projectAsks, projectNeeds, projectTaskIds } from '../src/shared/needsYou'
import { triageAll, type TriageInput } from '../src/shared/triage'
import type { EmployeeAction } from '../src/shared/employeeActions'
import type { EmployeeTask, EmployeeWorkView } from '../src/shared/employeeWork'
import type { EmployeeSummary } from '../src/shared/employees'
import type { AppSnapshot, Session, Workspace } from '../src/shared/types'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const repo = (id: string, spaceId?: string) => ({ id, name: id, rootPath: `/code/${id}`, defaultBranch: 'main', ...(spaceId ? { spaceId } : {}) })
const ws = (id: string, repoId: string, patch: Partial<Workspace> = {}): Workspace =>
  ({ id, repoId, name: id, branch: id, baseBranch: 'main', path: `/w/${id}`, portBase: 1, state: 'ready', createdAt: ago(200), ...patch }) as Workspace
const session = (id: string, workspaceId: string, patch: Partial<Session> = {}): Session =>
  ({ id, workspaceId, title: id, agent: 'claude', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: ago(190), ...patch }) as Session
const by = (employeeId: string, taskId: string, runId = `run-${taskId}`) => ({ via: 'employee' as const, orgId: 'acme', employeeId, runId, taskId, title: taskId })
const person = (id: string, name: string, patch: Partial<EmployeeSummary> = {}): EmployeeSummary => ({ id, path: `bots/${id}.toml`, name, role: '', colour: 'pink', responsibilities: [], problems: [], state: 'active', changed: false, ...patch })
const task = (patch: Partial<EmployeeTask> & Pick<EmployeeTask, 'id' | 'employeeId' | 'state'>): EmployeeTask =>
  ({ orgId: 'acme', requestId: `req-${patch.id}`, rootId: patch.id, parentId: null, title: patch.id, body: '', from: 'person', targetRepoId: 'site', createdAt: ago(40), updatedAt: ago(30), ...patch }) as EmployeeTask
const push = (patch: Partial<EmployeeAction> = {}): EmployeeAction =>
  ({
    id: 'act-push',
    orgId: 'acme',
    employeeId: 'max',
    taskId: 'launch',
    runId: 'run-launch',
    repoId: 'site',
    kind: 'push',
    payload: { kind: 'push', workspaceId: 'kyoto', branch: 'max/launch-2.4', base: 'main', head: 'abc', ahead: 1, commits: [], connection: 'gh' },
    policy: 'held',
    state: 'held',
    key: 'k',
    createdAt: ago(42),
    updatedAt: ago(42),
    ...patch
  }) as EmployeeAction
const question = task({ id: 'date', employeeId: 'ada', state: 'waiting', waitingOn: 'person', question: { id: 'q', question: 'Which day does Atlas 2.4 launch?', options: ['Tuesday', 'Thursday'], runId: 'run-date', askedAt: ago(32) } })
const proposal = { id: 'p1', orgId: 'acme', path: 'memory/org/PROJECT.md', kind: 'append' as const, text: '- 2.3 shipped on a Thursday.', employeeId: 'ada', runId: 'run-date', createdAt: ago(24) }

/** The screenshot fixture: osaka failed and lisbon idle in Personal; in Acme, lima holds Ada's question, kyoto Max's held push, and Ada proposed a fact. */
function fixture(work: Partial<EmployeeWorkView> = {}, extra: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    repos: [repo('atlas'), repo('beacon'), repo('acme-memory', 'acme'), repo('site', 'acme')],
    organizations: [{ id: 'acme', name: 'Acme', memoryRepoId: 'acme-memory', createdAt: ago(5000) }],
    workspaces: [ws('osaka', 'atlas'), ws('lisbon', 'atlas'), ws('lima', 'site', { createdAt: ago(30), startedBy: by('ada', 'date') }), ws('kyoto', 'site', { createdAt: ago(70), startedBy: by('max', 'launch') })],
    sessions: [session('s-osaka', 'osaka', { lastTurn: { outcome: 'error', endedAt: ago(180) }, lastActivityAt: ago(180) }), session('s-lisbon', 'lisbon', { lastActivityAt: ago(12) })],
    employees: { acme: { head: 'h', employees: [person('ada', 'Ada'), person('max', 'Max', { colour: 'orange' }), person('lin', 'Lin', { state: 'draft' })] } },
    employeeWork: { acme: { tasks: [question], runs: [], last: {}, proposals: [proposal], actions: [push()], revision: 1, ...work } },
    ...extra
  } as unknown as AppSnapshot
}

const input = (snapshot: AppSnapshot): TriageInput => ({ snapshot, approvals: [], unread: {}, unreadSessions: {}, now: NOW })

describe('one list of what needs you', () => {
  it('reads Personal 1, Acme 3, all spaces 4, oldest first, each item once', () => {
    const items = needsYouItems(input(fixture()))
    expect(items.map((i) => i.id)).toEqual(['ws:osaka', 'action:act-push', 'ws:lima', 'proposal:p1'])
    const counts = needsYouCounts(items)
    expect(counts.total).toBe(4)
    expect(counts.bySpace.get(null)).toBe(1)
    expect(counts.bySpace.get('acme')).toBe(3)
    expect(itemsInSpace(items, 'acme').map((i) => i.kind)).toEqual(['action', 'workspace', 'proposal'])
    expect(itemsInSpace(items, undefined)).toHaveLength(4)
  })

  it('counts an employee’s question and its run’s workspace once, as the workspace that says “Ada asks”', () => {
    const items = needsYouItems(input(fixture()))
    const lima = items.find((i) => i.id === 'ws:lima')!
    expect(lima).toMatchObject({ kind: 'workspace', space: 'acme', orgId: 'acme', employeeId: 'ada', task: { id: 'date' } })
    expect(lima.triage).toMatchObject({ label: 'Ada asks', detail: 'Which day does Atlas 2.4 launch?', namesEmployee: true })
    expect(items.some((i) => i.id === 'task:date')).toBe(false)
  })

  it('makes a question its own item once its run’s workspace is gone', () => {
    const snapshot = fixture()
    snapshot.workspaces = snapshot.workspaces.map((w) => (w.id === 'lima' ? { ...w, state: 'archived' } : w))
    const items = needsYouItems(input(snapshot))
    expect(items.find((i) => i.id === 'task:date')).toMatchObject({ kind: 'question', space: 'acme', employeeId: 'ada', repoId: 'site', since: ago(32) })
    expect(needsYouCounts(items).bySpace.get('acme')).toBe(3)
  })

  it('lists held, uncertain and failed outward actions, never sent or skipped ones, each apart from its run’s workspace', () => {
    const states = (state: EmployeeAction['state']) => needsYouItems(input(fixture({ actions: [push({ state })] }))).filter((i) => i.kind === 'action').length
    expect([states('held'), states('uncertain'), states('failed')]).toEqual([1, 1, 1])
    expect([states('sent'), states('skipped'), states('approved')]).toEqual([0, 0, 0])
    // kyoto itself needs nothing: the push is the one item.
    expect(needsYouItems(input(fixture())).some((i) => i.id === 'ws:kyoto')).toBe(false)
  })

  it('lists a stuck task, and an employee paused after two failing runs; not a usage-limit hold, which clears itself', () => {
    const stuck = task({ id: 'stuck', employeeId: 'max', state: 'open', hold: 'root-limit', reason: 'Its chain used its 20 runs.' })
    const held = task({ id: 'held', employeeId: 'max', state: 'open', hold: 'usage-limit' })
    const snapshot = fixture({ tasks: [question, stuck, held] })
    snapshot.employees!.acme.employees[1] = person('max', 'Max', { state: 'paused', pausedKind: 'failures', pausedDetail: 'Stopped after 30 minutes.' })
    const items = needsYouItems(input(snapshot))
    expect(items.find((i) => i.id === 'task:stuck')).toMatchObject({ kind: 'task', employeeId: 'max' })
    expect(items.find((i) => i.id === 'paused:acme:max')).toMatchObject({ kind: 'paused', detail: 'Stopped after 30 minutes.' })
    expect(items.some((i) => i.id === 'task:held')).toBe(false)
  })

  it('counts by repository for the rail (a proposal on the memory repository) and by employee for the Team rows', () => {
    const counts = needsYouCounts(needsYouItems(input(fixture())))
    expect(counts.byRepo.get('atlas')).toBe(1)
    expect(counts.byRepo.get('site')).toBe(2)
    expect(counts.byRepo.get('acme-memory')).toBe(1)
    expect(counts.byEmployee.get(employeeKey('acme', 'ada'))).toBe(2)
    expect(counts.byEmployee.get(employeeKey('acme', 'max'))).toBe(1)
    expect(counts.byEmployee.has(employeeKey('acme', 'lin'))).toBe(false)
  })

  it('takes the workspaces already triaged, and with no organization has only workspaces, all in Personal', () => {
    const snapshot = fixture({}, { organizations: [], employeeWork: undefined })
    const triaged = triageAll(input(snapshot), null)
    const items = needsYouItems(input(snapshot), triaged)
    expect(items.every((i) => i.kind === 'workspace' && i.space === null)).toBe(true)
    expect(needsYouCounts(items).bySpace.get(null)).toBe(items.length)
  })

  it('lists each thing a project waits on as the person’s own item in its organization, never one going or closed', () => {
    const project = (id: string, patch: Record<string, unknown>) => ({ id, orgId: 'acme', slug: id, title: id, requirement: id, repoId: 'site', pmId: 'pri', phase: 'working', plans: [], parts: {}, replans: 0, steps: [], artifacts: {}, waits: [], decisions: [], notes: [], createdAt: ago(100), updatedAt: ago(10), ...patch })
    const snapshot = fixture({}, {
      projects: {
        acme: [
          project('two', { waits: [{ id: 'w1', kind: 'gate', partId: 'reqs', since: ago(5) }, { id: 'w2', kind: 'stuck', partId: 'build', since: ago(2), reason: 'No access' }] }),
          project('going', {}),
          project('closed', { phase: 'closed', waits: [{ id: 'w3', kind: 'final', since: ago(1) }] })
        ]
      }
    } as unknown as Partial<AppSnapshot>)
    const items = needsYouItems(input(snapshot))
    const projects = items.filter((i) => i.kind === 'project')
    expect(projects.map((i) => [i.id, i.space, i.repoId, i.employeeId, i.wait?.kind])).toEqual([
      ['project:two:w1', 'acme', 'site', undefined, 'gate'],
      ['project:two:w2', 'acme', 'site', undefined, 'stuck']
    ])
    const counts = needsYouCounts(items)
    expect(counts.bySpace.get('acme')).toBe(5)
    // Nobody's employee count moves: it is the person's own.
    expect(counts.byEmployee.get(employeeKey('acme', 'ada'))).toBe(2)
  })

  it('leaves a project’s workspace to its channel unless it waits on an approval, and says which items its channel shows', () => {
    // Lima is the project's shared workspace: its run just finished (Ready for review) and Ada's question is a project task's.
    const project = { id: 'pr', orgId: 'acme', slug: 'pr', title: 'pr', requirement: 'pr', repoId: 'site', pmId: 'pri', phase: 'working', plans: [], parts: {}, replans: 0, steps: [{ kind: 'part', round: 1, taskId: 'date', employeeId: 'ada', state: 'running' }], artifacts: {}, waits: [{ id: 'w1', kind: 'questions', since: ago(5) }], decisions: [], notes: [], createdAt: ago(100), updatedAt: ago(10), workspaceId: 'lima' }
    const snapshot = fixture({}, { projects: { acme: [project] }, sessions: [...fixture().sessions, session('s-lima', 'lima', { employeeRun: { orgId: 'acme', employeeId: 'ada', runId: 'run-date', taskId: 'date', projectId: 'pr', endedAt: ago(10) } })] } as unknown as Partial<AppSnapshot>)
    const read = { ...input(snapshot), unread: { lima: true as const }, unreadSessions: { 's-lima': true as const } }
    const items = needsYouItems(read)
    expect(items.some((i) => i.id === 'ws:lima')).toBe(false)
    const tasks = projectTaskIds(snapshot)
    // Ada's question, with its workspace the channel's, is its own item; it and the project's wait are the channel's.
    expect(items.filter((i) => inChannel(i, tasks)).map((i) => i.id).sort()).toEqual(['project:pr:w1', 'task:date'])
    expect(items.filter((i) => !inChannel(i, tasks)).map((i) => i.id)).toEqual(['ws:osaka', 'action:act-push', 'proposal:p1'])
    // They still count for the space and for Ada's Team row.
    expect(needsYouCounts(items).byEmployee.get(employeeKey('acme', 'ada'))).toBe(2)
    // A chat there waiting on an approval only it can give: a workspace row again.
    expect(needsYouItems({ ...read, approvals: [{ id: 'a', sessionId: 's-lima', kind: 'tool', toolName: 'Bash' } as never] }).some((i) => i.id === 'ws:lima')).toBe(true)
  })

  it('counts what a project’s tasks ask with what it waits on, so its channel never says Working while someone waits', () => {
    const steps = [{ kind: 'part', round: 1, taskId: 'date', employeeId: 'ada', state: 'running' }, { kind: 'part', round: 1, taskId: 'launch', employeeId: 'max', state: 'running' }]
    const project = { steps, waits: [{ id: 'w1', kind: 'gate', since: ago(5) }], phase: 'working' } as never
    const work = fixture().employeeWork!.acme
    // Ada's question and Max's held push are the project's tasks'; the proposal is nobody's task.
    expect(projectAsks(project, work)).toEqual({ tasks: [question], actions: [push()] })
    expect(projectNeeds(project, work)).toEqual({ waits: 1, asks: 2, total: 3 })
    // Closed, its waits are gone, but a held push still waits; a task that runs asks nothing.
    expect(projectNeeds({ ...(project as object), phase: 'closed' } as never, work)).toEqual({ waits: 0, asks: 2, total: 2 })
    expect(projectNeeds(project, { tasks: [{ ...question, state: 'running', question: undefined, waitingOn: undefined }], actions: [] })).toEqual({ waits: 1, asks: 0, total: 1 })
    expect(projectNeeds(project, undefined).asks).toBe(0)
  })
})

