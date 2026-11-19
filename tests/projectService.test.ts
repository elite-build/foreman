// Projects (docs/ai-employees.md §15), the service: against a real foreman.db with a stand-in work service that records
// the tasks it is asked for. Starting with the program manager (refused without her or without words), her questions
// before her first plan (asked, waited for, answered or skipped, a plan refused until then), her plan through
// project_plan (checked, proposed employees made as drafts, plan.md staged, a planning task can't finish without one),
// the plan gate (refused until every owner is approved), parts in parallel with their contracts, a part's gate, a part
// that can't finish waking a replan (one that goes ahead, one that waits), the end of a small project and a large one's
// acceptance and final gate, pause, stop, notes, follow-ups, the shared workspace and its release, recovery, and the
// channel's name, archive and delete.
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ForemanDb } from '../src/main/db'
import { ProjectService, type ProjectHost } from '../src/main/projects'
import { defaultSettings, type PersistedState } from '../src/main/store'
import type { EmployeeProjectTaskInput } from '../src/main/employeeWork'
import type { EmployeeTask } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeDefinition, type EmployeeSummary } from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import type { MemoryChange } from '../src/shared/memory'
import { listedProjects, planSeen, roundSeen, type PlanInput } from '../src/shared/projects'
import type { Repo } from '../src/shared/types'
import { tempDir } from './helpers'

const opened: ForemanDb[] = []
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

const PM = 'e-pri1'

async function rig(options: { pm?: boolean } = {}) {
  const db = new ForemanDb(path.join(await tempDir('foreman-projects-'), 'foreman.db'))
  opened.push(db)
  const repo = (id: string, name: string, spaceId?: string) => ({ id, name, rootPath: `/code/${name}`, defaultBranch: 'main', local: {}, createdAt: '2026-11-01T00:00:00.000Z', ...(spaceId ? { spaceId } : {}) }) as unknown as Repo
  const org: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', ...(options.pm === false ? {} : { programManagerId: PM }), createdAt: '2026-11-01T00:00:00.000Z' }
  const state = { repos: [repo('mem', 'acme-memory', 'o1'), repo('site', 'site', 'o1')], organizations: [org], settings: defaultSettings(), employees: [] } as unknown as PersistedState
  // The team: Priya and Ravi, approved; drafts the plan proposes join it.
  const team = new Map<string, { name: string; state: EmployeeSummary['state']; definition?: EmployeeDefinition }>([
    [PM, { name: 'Priya', state: 'active' }],
    ['e-rav1', { name: 'Ravi', state: 'active' }]
  ])
  const summary = (id: string): EmployeeSummary => ({ id, path: `bots/${id}.toml`, name: team.get(id)!.name, role: '', colour: 'orange', responsibilities: [], problems: [], state: team.get(id)!.state, changed: false })
  const asked: EmployeeProjectTaskInput[] = []
  const canceled: string[] = []
  const archived: [string, string][] = []
  const staged: { runId: string; path: string; text: string }[] = []
  // The memory repository's files at its head, and the commits the person made (deleting a channel's files).
  const files: { path: string; blob: string }[] = []
  const personCommits: { changes: MemoryChange[]; subject: string }[] = []
  const alive = new Set<string>()
  let n = 0
  const clock = { now: Date.parse('2026-11-15T10:00:00.000Z') }
  const work: ProjectHost['work'] = {
    projectTask: async (input) => {
      const found = db.employeeTaskByRequest('o1', input.requestId)
      if (found) return found
      asked.push(input)
      clock.now += 1000
      const at = new Date(clock.now).toISOString()
      const id = `t${++n}`
      const task: EmployeeTask = { id, orgId: 'o1', employeeId: input.employeeId, requestId: input.requestId, rootId: input.rootId ?? id, parentId: null, title: input.title, body: input.body, from: 'person', targetRepoId: input.repoId, state: 'running', contract: input.contract, project: input.project, createdAt: at, updatedAt: at }
      db.putEmployeeTask(task)
      return task
    },
    cancel: async (id) => {
      canceled.push(id)
      const task = db.employeeTask(id)!
      db.putEmployeeTask({ ...task, state: 'closed', closureReason: 'canceled' })
      return task
    }
  }
  const host: ProjectHost = {
    state: () => state,
    db: () => db,
    work,
    employees: {
      current: async (_org, id) => {
        if (!team.has(id)) throw new Error('Employee not found')
        const d = defaultEmployee({ id, colour: 'orange', repos: ['site'], loadouts: [{ agent: 'claude', model: 'm' }], text: { name: team.get(id)!.name } })
        return { summary: summary(id), definition: d, head: 'h' }
      },
      members: async () => [...team.keys()].map((id) => ({ summary: summary(id), definition: defaultEmployee({ id, colour: 'orange', repos: ['site'], loadouts: [{ agent: 'claude', model: 'm' }], text: { name: team.get(id)!.name } }) })) as never,
      createTeam: async (_org, definitions) => {
        for (const d of definitions) team.set(d.id, { name: d.name, state: 'draft', definition: d })
        return [] as never
      }
    },
    memory: {
      read: async () => ({ path: '', head: 'h', blob: null, size: 0, binary: false, tooLarge: false }),
      stage: async (_org, runId, change) => {
        staged.push({ runId, path: change.path, text: 'text' in change ? change.text : '' })
        return {} as never
      },
      tree: async () => ({ head: 'h', entries: files.map((f) => ({ ...f, size: 1 })) }),
      commitAsPerson: async (_org, changes, { subject }) => {
        personCommits.push({ changes, subject })
        for (const c of changes) files.splice(files.findIndex((f) => f.path === c.path), 1)
        return { ok: true, commit: 'c-person', blobs: {} }
      }
    },
    workspaceAlive: (id) => alive.has(id),
    workspaceRepo: (id) => (id === 'ws-own' ? 'site' : undefined),
    transcript: async () => 'You: add a Download CSV button',
    archive: (ws, runId) => void archived.push([ws, runId]),
    loadouts: () => [{ agent: 'claude', model: 'm' }],
    changed: () => undefined,
    now: () => clock.now
  }
  const service = new ProjectService(host)
  /** Close a task as its run would, and let the project go on. */
  const close = async (id: string, how: { reason?: EmployeeTask['closureReason']; decision?: string; detail?: string; artifacts?: string[]; summary?: string } = {}) => {
    const task = db.employeeTask(id)!
    const reason = how.reason ?? 'done'
    clock.now += 1000
    const closed: EmployeeTask = {
      ...task,
      state: 'closed',
      closureReason: reason,
      ...(how.detail ? { closureDetail: how.detail } : {}),
      ...(reason === 'done' ? { result: { status: 'done', summary: how.summary ?? `${task.title} finished.`, commit: `c-${id}`, ...(how.decision ? { decision: how.decision } : {}), ...(how.artifacts ? { artifacts: how.artifacts } : {}), runId: 'r', at: task.createdAt } } : {})
    }
    db.putEmployeeTask(closed)
    service.taskClosed(closed)
    await settle()
  }
  const task = (input: EmployeeProjectTaskInput) => db.employeeTaskByRequest('o1', input.requestId)!
  const last = () => asked.at(-1)!
  /** The planning task gives `plan` (as the project_plan tool would) and finishes done. */
  const plan = async (input: PlanInput) => {
    const t = task(last())
    const said = await service.submitPlan(t, 'run-1', input)
    await close(t.id)
    return said
  }
  const get = (id: string) => service.get(id)
  /** Start a project whose questions the person has already answered, so her planning task may plan. */
  const start = async (input: { requirement: string }) => {
    const project = await service.start('o1', input)
    const fresh = db.project(project.id)!
    const at = new Date(clock.now).toISOString()
    fresh.asks = [{ round: 1, taskId: 'earlier', understood: [], questions: [{ question: 'Which formats?', options: [] }], at, answers: ['CSV only'], answeredAt: at }]
    db.putProject(fresh)
    return service.get(project.id)
  }
  return { db, state, org, team, service, asked, canceled, archived, staged, files, personCommits, alive, close, task, last, plan, get, start, clock }
}

const settle = () => new Promise((r) => setTimeout(r, 15))

const TWO_PARTS: PlanInput = {
  summary: 'A CSV button and its docs.',
  size: 'small',
  parts: [
    { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build the button.', writes: 'build.md' },
    { id: 'docs', title: 'Docs', owner: 'Priya', brief: 'Write the note for finance.', writes: 'docs.md' }
  ]
}

describe('projects: starting with the program manager', () => {
  it('refuses without her, without words, or outside the organization’s repositories', async () => {
    const none = await rig({ pm: false })
    await expect(none.service.start('o1', { requirement: 'Export to CSV' })).rejects.toThrow('has no program manager')
    const r = await rig()
    await expect(r.service.start('o1', { requirement: '@Priya   ' })).rejects.toThrow('Say what should exist')
    await expect(r.service.start('o1', { requirement: 'x', repoId: 'mem' })).rejects.toThrow('isn’t one of Acme’s')
  })

  it('makes a planning task for her, with the request, the roster and plan.md to write', async () => {
    const r = await rig()
    const project = await r.service.start('o1', { requirement: '@Priya Export reports to CSV' })
    expect(project).toMatchObject({ title: 'Export reports to CSV', requirement: 'Export reports to CSV', slug: 'export-reports-to-csv', phase: 'planning', pmId: PM, repoId: 'site' })
    expect(r.asked).toHaveLength(1)
    expect(r.last()).toMatchObject({ employeeId: PM, project: { id: project.id, kind: 'plan', round: 1 }, contract: { writes: ['memory/org/projects/export-reports-to-csv/plan.md'] }, runsAllowed: 80 })
    expect(r.last().body).toContain('- Ravi (id e-rav1)')
    expect(r.get(project.id).steps[0]).toMatchObject({ kind: 'plan', employeeId: PM, state: 'running' })
  })

  it('takes a workspace handed to her as the project’s, with its chat as her first input', async () => {
    const r = await rig()
    r.alive.add('ws-own')
    const project = await r.service.start('o1', { requirement: 'Finish it for finance', fromWorkspaceId: 'ws-own' })
    expect(project).toMatchObject({ workspaceId: 'ws-own', fromWorkspaceId: 'ws-own', repoId: 'site' })
    expect(r.last().body).toContain('You: add a Download CSV button')
    expect(r.service.workspaceFor(r.task(r.last()))).toBe('ws-own')
  })
})

describe('projects: the plan', () => {
  it('answers the problems of a bad plan, records a good one with plan.md, and won’t let her finish without one', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    const planning = r.task(r.last())
    expect(r.service.finishCheck(planning, { status: 'done' })).toContain('project_plan first')
    expect(r.service.finishCheck(planning, { status: 'blocked' })).toBeUndefined()
    await expect(r.service.submitPlan(planning, 'run-1', { ...TWO_PARTS, parts: [{ ...TWO_PARTS.parts[0], owner: 'Nobody' }] })).rejects.toThrow('“Nobody” isn’t on the team')
    const said = await r.service.submitPlan(planning, 'run-1', TWO_PARTS)
    expect(said).toContain('Plan v1 recorded: 2 parts, small')
    expect(r.service.finishCheck(planning, { status: 'done' })).toBeUndefined()
    expect(r.staged).toEqual([expect.objectContaining({ runId: 'run-1', path: 'memory/org/projects/export-reports-to-csv/plan.md' })])
    expect(r.staged[0].text).toContain('| 1 | Build (`build`) | Ravi |')
    // Not a planning task: refused.
    await r.close(planning.id)
    const p = r.get(project.id)
    expect(p.phase).toBe('plan-gate')
    expect(p.waits).toEqual([expect.objectContaining({ kind: 'plan' })])
    expect(p.artifacts['plan.md']).toMatchObject({ commit: `c-${planning.id}`, version: 1 })
  })

  it('makes the employees a plan proposes as drafts, and approves the plan only once each is approved', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan({ ...TWO_PARTS, parts: [...TWO_PARTS.parts, { id: 'qa', title: 'QA', owner: 'new:qa', brief: 'Test it.', writes: 'qa.md', depends_on: ['build'] }], new_employees: [{ key: 'qa', name: 'Quinn', role: 'QA engineer', description: 'Tests.', instructions: 'Test.', repos: { site: 'write' } }] })
    const p = r.get(project.id)
    const quinn = p.plans[0].proposedIds.qa
    expect(r.team.get(quinn)).toMatchObject({ name: 'Quinn', state: 'draft' })
    const wait = p.waits[0]
    await expect(r.service.decide(project.id, wait.id, 'approve')).rejects.toThrow('Approve Quinn first')
    await expect(r.service.decide(project.id, wait.id, 'retry')).rejects.toThrow('isn’t one of this decision’s choices')
    await expect(r.service.decide(project.id, wait.id, 'send-back')).rejects.toThrow('Say what to change')
    r.team.get(quinn)!.state = 'active'
    await r.service.decide(project.id, wait.id, 'approve')
    const going = r.get(project.id)
    expect(going).toMatchObject({ phase: 'working', plan: { status: 'approved' } })
    // The two parts that wait for nothing start at once, each with its file to write.
    expect(r.asked.slice(1).map((a) => [a.employeeId, a.project.partId])).toEqual([
      ['e-rav1', 'build'],
      [PM, 'docs']
    ])
    expect(r.asked[1].contract).toEqual({
      produces: 'memory/org/projects/export-reports-to-csv/build.md',
      writes: ['memory/org/projects/export-reports-to-csv/build.md'],
      writesUnder: ['memory/org/projects/export-reports-to-csv/mocks/build/']
    })
    expect(going.decisions).toEqual([expect.objectContaining({ waitKind: 'plan', decision: 'approve' })])
  })

  it('sends a plan back with the person’s note: she plans again', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan(TWO_PARTS)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'send-back', 'Excel needs a BOM')
    const p = r.get(project.id)
    expect(p).toMatchObject({ phase: 'planning', plans: [expect.objectContaining({ status: 'sent-back' })] })
    expect(r.last()).toMatchObject({ employeeId: PM, project: { kind: 'plan', round: 2 } })
    expect(r.last().body).toContain('“Excel needs a BOM”')
  })
})

describe('projects: parts, gates and the end', () => {
  async function approved(input: PlanInput) {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan(input)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    return { ...r, id: project.id }
  }

  it('waits at a gate after a gated part, then starts what depended on it with its file at its commit', async () => {
    const r = await approved({
      summary: 's',
      size: 'small',
      parts: [
        { id: 'reqs', title: 'Requirements', owner: 'Priya', brief: 'Say what.', writes: 'requirements.md', gate_after: true },
        { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build it.', writes: 'build.md', depends_on: ['reqs'] }
      ]
    })
    const reqs = r.task(r.last())
    await r.close(reqs.id)
    let p = r.get(r.id)
    expect(p.parts.reqs.state).toBe('gate')
    expect(p.waits).toEqual([expect.objectContaining({ kind: 'gate', partId: 'reqs' })])
    expect(r.asked).toHaveLength(2)
    await r.service.decide(r.id, p.waits[0].id, 'send-back', 'Name the columns')
    expect(r.last()).toMatchObject({ project: { kind: 'part', partId: 'reqs', round: 2 } })
    expect(r.last().body).toContain('“Name the columns”')
    await r.close(r.task(r.last()).id)
    p = r.get(r.id)
    await r.service.decide(r.id, p.waits[0].id, 'approve')
    expect(r.last()).toMatchObject({ employeeId: 'e-rav1', project: { partId: 'build', round: 1 } })
    expect(r.last().contract.inputs).toEqual([{ path: 'memory/org/projects/export-reports-to-csv/requirements.md', commit: `c-${r.task(r.asked[2]).id}` }])
    // An approval without a note passes nothing on (the note sent back with round 1 isn't the approval's).
    expect(r.last().body).not.toContain('The person approved what your part waits for')
    // A small project ends with its last part: no acceptance, no final gate.
    await r.close(r.task(r.last()).id)
    p = r.get(r.id)
    expect(p).toMatchObject({ phase: 'closed', outcome: 'done', waits: [] })
  })

  it('keeps the memory files a part’s task named, for the channel to link its pages, and finds them for a step closed before', async () => {
    const r = await approved(TWO_PARTS)
    const build = r.task(r.last())
    const pages = ['memory/bots/e-rav1/mocks/csv/index.html', 'memory/bots/e-rav1/mocks/csv/1-button.html']
    await r.close(build.id, { artifacts: ['memory/org/projects/export-reports-to-csv/build.md', ...pages, pages[0], 'src/export.ts', 'C:/elsewhere/mock.html'] })
    const step = () => r.service.all('o1')[0].steps.find((s) => s.taskId === build.id)!
    // Workspace and absolute paths go with their workspace or aren't memory: only memory files, each once.
    expect(step().files).toEqual(['memory/org/projects/export-reports-to-csv/build.md', ...pages])
    expect(r.service.views().o1[0].steps.find((s) => s.taskId === build.id)!.files).toEqual(step().files)
    // A step closed before steps kept their files reads them from its task's result.
    const stored = r.db.project(r.id)!
    for (const s of stored.steps) delete s.files
    r.db.putProject(stored)
    expect(step().files).toEqual(['memory/org/projects/export-reports-to-csv/build.md', ...pages])
    expect(r.db.project(r.id)!.steps.find((s) => s.taskId === build.id)!.files).toBeUndefined()
  })

  it('records the mocks a part drew in its folder, and hands them with its file to the part that reads it', async () => {
    const r = await approved({
      summary: 's',
      size: 'small',
      parts: [
        { id: 'design', title: 'Design', owner: 'Priya', brief: 'Draw it.', writes: 'design.md', gate_after: true },
        { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build it.', writes: 'build.md', depends_on: ['design'] }
      ]
    })
    const folder = 'memory/org/projects/export-reports-to-csv/mocks/design/'
    const design = r.task(r.last())
    expect(design.contract?.writesUnder).toEqual([folder])
    // What isn't an HTML file in its own folder isn't a mock.
    await r.close(design.id, { artifacts: ['memory/org/projects/export-reports-to-csv/design.md', `${folder}1-export-b.html`, `${folder}index.html`, `${folder}1-export-a.html`, `${folder}notes.md`, 'memory/bots/e-pri1/x.html'] })
    let p = r.get(r.id)
    expect(p.artifacts['design.md'].mocks).toEqual([`${folder}index.html`, `${folder}1-export-a.html`, `${folder}1-export-b.html`])
    await r.service.decide(r.id, p.waits[0].id, 'approve')
    const commit = `c-${design.id}`
    expect(r.last().contract.inputs).toEqual(['design.md', 'mocks/design/index.html', 'mocks/design/1-export-a.html', 'mocks/design/1-export-b.html'].map((f) => ({ path: `memory/org/projects/export-reports-to-csv/${f}`, commit })))
    // A part that drew none records none.
    await r.close(r.task(r.last()).id)
    p = r.get(r.id)
    expect(p.artifacts['build.md'].mocks).toBeUndefined()
  })

  it('gives what an approval at a gate said to the parts that wait for it, and holds an approval’s note at the plan', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Simplify the sidebar' })
    await r.plan({
      summary: 's',
      size: 'small',
      parts: [
        { id: 'design', title: 'Mocks', owner: 'Priya', brief: 'Draw mocks.', writes: 'design.md', gate_after: true },
        { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build the picked one.', writes: 'build.md', depends_on: ['design'] }
      ]
    })
    // A note on the plan would reach nobody: it goes with Send back.
    await expect(r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve', 'Use mock 2')).rejects.toThrow('A note goes with Send back')
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    await r.close(r.task(r.last()).id)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve', 'Suggest more mocks: five or six of them')
    expect(r.get(project.id).decisions.at(-1)).toMatchObject({ waitKind: 'gate', partId: 'design', decision: 'approve', note: 'Suggest more mocks: five or six of them' })
    expect(r.last()).toMatchObject({ employeeId: 'e-rav1', project: { partId: 'build', round: 1 } })
    expect(r.last().body).toContain('On “Mocks”: “Suggest more mocks: five or six of them”')
    expect(r.last().body).toContain('don’t start yours: finish_task blocked')
  })

  it('wakes a replan when a part can’t finish; one that only gives the owners more work goes ahead', async () => {
    const r = await approved(TWO_PARTS)
    const build = r.task(r.asked[1])
    const docs = r.task(r.asked[2])
    await r.close(build.id, { reason: 'blocked', detail: 'Excel mangles accents' })
    let p = r.get(r.id)
    expect(p).toMatchObject({ replans: 1, replanning: true, parts: { build: { state: 'stuck' } } })
    expect(r.last()).toMatchObject({ employeeId: PM, project: { kind: 'plan', round: 2 } })
    expect(r.last().body).toContain('Excel mangles accents')
    // Docs finishing while she replans starts nothing new.
    await r.close(docs.id)
    expect(r.asked).toHaveLength(4)
    await r.plan({ ...TWO_PARTS, parts: [...TWO_PARTS.parts, { id: 'bom', title: 'Add a BOM', owner: 'Ravi', brief: 'Write a BOM first.', writes: 'bom.md' }] })
    p = r.get(r.id)
    expect(p).toMatchObject({ replanning: false, plan: { version: 2, status: 'went-ahead' }, waits: [] })
    expect(p.plans[0].status).toBe('replaced')
    // The stuck part runs again (round 2) beside the new one.
    expect(r.asked.slice(4).map((a) => [a.project.partId, a.project.round])).toEqual([
      ['build', 2],
      ['bom', 1]
    ])
  })

  it('keeps a proposed owner’s part with them in a replan that names them as an employee', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan({ summary: 's', size: 'small', parts: [{ id: 'build', title: 'Build', owner: 'new:dev', brief: 'Build it.', writes: 'build.md' }], new_employees: [{ key: 'dev', name: 'Dev', role: 'Developer', description: '', instructions: 'Build.', repos: { site: 'write' } }] })
    const dev = r.get(project.id).plans[0].proposedIds.dev
    r.team.get(dev)!.state = 'active'
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    expect(r.get(project.id).plan?.parts[0].owner).toBe(dev)
    await r.close(r.task(r.last()).id, { reason: 'blocked', detail: 'No shell to run the tests' })
    await r.plan({ summary: 's', size: 'small', parts: [{ id: 'build', title: 'Build', owner: 'Dev', brief: 'Build it.', writes: 'build.md' }, { id: 'tests', title: 'Tests', owner: dev, brief: 'Say what to run.', writes: 'tests.md' }] })
    const p = r.get(project.id)
    expect(p).toMatchObject({ plan: { version: 2, status: 'went-ahead' }, waits: [] })
    // Build ran again (round 2): it wasn't taken as it is.
    expect(p.parts.build).toMatchObject({ state: 'running', round: 2 })
  })

  it('counts a part that couldn’t finish as done when the replan takes it as it is, and runs only what it adds', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan({ summary: 's', size: 'small', parts: [{ id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build it.', writes: 'build.md' }] })
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    await r.close(r.task(r.last()).id, { reason: 'blocked', detail: 'Code written; tests not run' })
    const planning = r.task(r.last())
    // Not allowed on a part that hasn't stopped short.
    await expect(r.service.submitPlan(planning, 'run-2', { summary: 's', size: 'small', parts: [{ id: 'build', title: 'Build', owner: 'Ravi', brief: 'b', writes: 'build.md', accept_as_is: true }, { id: 'run', title: 'Run', owner: 'Ravi', brief: 'r', writes: 'run.md', depends_on: ['build'], accept_as_is: true }] })).rejects.toThrow('“run” can’t be accept_as_is')
    await r.plan({ summary: 's', size: 'small', parts: [{ id: 'build', title: 'Build', owner: 'Ravi', brief: 'b', writes: 'build.md', accept_as_is: true }, { id: 'run', title: 'Run the tests', owner: 'Ravi', brief: 'r', writes: 'run.md', depends_on: ['build'] }] })
    const p = r.get(project.id)
    expect(p.parts.build).toMatchObject({ state: 'done', round: 1 })
    expect(r.last()).toMatchObject({ project: { kind: 'part', partId: 'run', round: 1 } })
  })

  it('holds a replan that adds a person at the plan gate, and asks the person once replans run out', async () => {
    const r = await approved(TWO_PARTS)
    await r.close(r.task(r.asked[1]).id, { reason: 'blocked', detail: 'Needs a designer' })
    await r.plan({
      ...TWO_PARTS,
      parts: [...TWO_PARTS.parts, { id: 'ux', title: 'Design', owner: 'new:ux', brief: 'Design it.', writes: 'design.md' }],
      new_employees: [{ key: 'ux', name: 'Uma', role: 'Designer', description: '', instructions: 'Design.', repos: { site: 'read' } }]
    })
    const p = r.get(r.id)
    expect(p.waits).toEqual([expect.objectContaining({ kind: 'plan' })])
    expect(p.plan?.version).toBe(1)
    expect(p.phase).toBe('working')
    // Out of replans: a part that can't finish waits for the person instead.
    const fresh = await approved(TWO_PARTS)
    const f = fresh.db.project(fresh.id)!
    fresh.db.putProject({ ...f, replans: 3 })
    await fresh.close(fresh.task(fresh.asked[1]).id, { reason: 'blocked', detail: 'Still broken' })
    const stuck = fresh.get(fresh.id)
    expect(stuck.waits).toEqual([expect.objectContaining({ kind: 'stuck', partId: 'build', reason: 'Still broken' })])
    await fresh.service.decide(fresh.id, stuck.waits[0].id, 'retry', 'Try UTF-16')
    expect(fresh.last()).toMatchObject({ project: { partId: 'build', round: 2 } })
    expect(fresh.last().body).toContain('“Try UTF-16”')
  })

  it('ends a large project with her acceptance and the person’s final gate, then archives its workspace', async () => {
    const r = await approved({ ...TWO_PARTS, size: 'large', understood: ['Finance wants reports as CSV.'], done_when: ['Reports download as CSV.'] })
    r.service.runCreated(r.task(r.asked[1]), 'ws-1')
    r.alive.add('ws-1')
    expect(r.service.workspaceFor(r.task(r.asked[2]))).toBe('ws-1')
    expect(r.service.keeps(r.task(r.asked[1]))).toBe(true)
    await r.close(r.task(r.asked[1]).id)
    await r.close(r.task(r.asked[2]).id)
    let p = r.get(r.id)
    expect(p.phase).toBe('accepting')
    expect(r.last()).toMatchObject({ employeeId: PM, project: { kind: 'accept' }, contract: { options: ['accept', 'replan'], produces: 'memory/org/projects/export-reports-to-csv/acceptance.md' } })
    expect(r.last().contract.inputs?.map((i) => i.path.split('/').at(-1))).toEqual(['plan.md', 'build.md', 'docs.md'])
    await r.close(r.task(r.last()).id, { decision: 'accept' })
    p = r.get(r.id)
    expect(p).toMatchObject({ phase: 'final-gate', waits: [expect.objectContaining({ kind: 'final' })] })
    await expect(r.service.decide(r.id, p.waits[0].id, 'approve', 'Looks good')).rejects.toThrow('A note goes with Send back')
    await r.service.decide(r.id, p.waits[0].id, 'approve')
    p = r.get(r.id)
    expect(p).toMatchObject({ phase: 'closed', outcome: 'done' })
    expect(r.archived).toEqual([['ws-1', expect.any(String)]])
    expect(r.service.keeps(r.task(r.asked[1]))).toBe(false)
  })
})

describe('projects: the person in the channel', () => {
  it('pauses (nothing new starts), resumes, takes notes, and stops what is going', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan({ ...TWO_PARTS, parts: [TWO_PARTS.parts[0], { ...TWO_PARTS.parts[1], depends_on: ['build'] }] })
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    await r.service.setPaused(project.id, true)
    await r.close(r.task(r.last()).id)
    expect(r.asked).toHaveLength(2)
    await r.service.setPaused(project.id, false)
    expect(r.last().project.partId).toBe('docs')
    await r.service.addNote(project.id, 'Finance wants it by Friday')
    await expect(r.service.addNote(project.id, '  ')).rejects.toThrow('Write something')
    await r.service.stop(project.id)
    const p = r.get(project.id)
    expect(p).toMatchObject({ phase: 'closed', outcome: 'stopped', notes: [expect.objectContaining({ text: 'Finance wants it by Friday' })] })
    expect(r.canceled).toEqual([r.task(r.last()).id])
  })

  it('asks a follow-up of whoever worked on it, reading what they wrote, even after it closed', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan({ ...TWO_PARTS, parts: [TWO_PARTS.parts[0]] })
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    const build = r.task(r.last())
    await r.close(build.id)
    expect(r.get(project.id).phase).toBe('closed')
    const follow = await r.service.askFollowUp(project.id, 'e-rav1', 'Why semicolons?')
    expect(follow.employeeId).toBe('e-rav1')
    expect(r.last()).toMatchObject({
      project: { kind: 'follow-up', partId: 'build' },
      contract: { inputs: [{ path: 'memory/org/projects/export-reports-to-csv/build.md', commit: `c-${build.id}` }], writesUnder: ['memory/org/projects/export-reports-to-csv/mocks/build/'] },
      runsAllowed: 80
    })
    expect(r.last().body).toContain('Your HTML mocks are in memory/org/projects/export-reports-to-csv/mocks/build/')
    expect(r.last().body).toContain('“Why semicolons?”')
    expect(r.get(project.id).steps.at(-1)).toMatchObject({ kind: 'follow-up', question: 'Why semicolons?' })
  })
})

describe('projects: recovery', () => {
  it('goes on from a task that closed while Foreman wasn’t looking', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    const planning = r.task(r.last())
    await r.service.submitPlan(planning, 'run-1', TWO_PARTS)
    // Closed in the database, but the project never heard.
    r.db.putEmployeeTask({ ...planning, state: 'closed', closureReason: 'done', result: { status: 'done', summary: 'Planned.', runId: 'r', at: planning.createdAt } })
    await r.service.recover()
    expect(r.get(project.id).waits).toEqual([expect.objectContaining({ kind: 'plan' })])
    // Again: nothing twice.
    await r.service.recover()
    expect(r.get(project.id).waits).toHaveLength(1)
  })
})

describe('projects: the channel’s name, archive and delete', () => {
  const DAY = 24 * 60 * 60_000
  /** A project that ran its one part and closed done. */
  const closedProject = async (r: Awaited<ReturnType<typeof rig>>, requirement = 'Export reports to CSV') => {
    const project = await r.start({ requirement })
    await r.plan({ ...TWO_PARTS, parts: [TWO_PARTS.parts[0]] })
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    await r.close(r.task(r.last()).id)
    expect(r.get(project.id).phase).toBe('closed')
    return project
  }

  it('renames only the name shown, refusing a bad or taken name', async () => {
    const r = await rig()
    const csv = await r.start({ requirement: 'Export reports to CSV' })
    await r.service.start('o1', { requirement: 'Team accounts SSO' })
    expect((await r.service.rename(csv.id, '#csv-export')).name).toBe('csv-export')
    expect(r.get(csv.id).slug).toBe('export-reports-to-csv')
    await expect(r.service.rename(csv.id, 'CSV Export')).rejects.toThrow('lowercase letters')
    await expect(r.service.rename(csv.id, 'team-accounts-sso')).rejects.toThrow('already called #team-accounts-sso')
    await expect(r.service.rename(csv.id, 'acme')).rejects.toThrow('already called #acme')
    await expect(r.service.rename(csv.id, 'a'.repeat(33))).rejects.toThrow('32 characters')
    // Back to its slug: no name of its own.
    expect((await r.service.rename(csv.id, 'export-reports-to-csv')).name).toBeUndefined()
  })

  it('archives a closed channel off the list, restores it, and archives one closed two weeks ago on its own', async () => {
    const r = await rig()
    const going = await r.service.start('o1', { requirement: 'Team accounts SSO' })
    await expect(r.service.setArchived(going.id, true)).rejects.toThrow('Only a closed project')
    const done = await closedProject(r)
    await r.service.setArchived(done.id, true)
    expect(r.service.views().o1.map((p) => p.id)).toEqual([going.id])
    expect(r.service.all('o1').map((p) => p.id).sort()).toEqual([going.id, done.id].sort())
    await r.service.setArchived(done.id, false)
    expect(r.service.views().o1.map((p) => p.id)).toContain(done.id)
    // Restored stays listed past two weeks; one never touched leaves after them.
    const now = Date.parse(r.get(done.id).closedAt!) + 15 * DAY
    expect(listedProjects([r.get(done.id)], now)).toHaveLength(1)
    expect(listedProjects([{ ...r.get(done.id), keptAt: undefined }], now)).toHaveLength(0)
  })

  it('deletes a going channel by stopping it first, keeping its files unless asked', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    const planning = r.task(r.last())
    r.files.push({ path: 'memory/org/projects/export-reports-to-csv/plan.md', blob: 'b1' }, { path: 'memory/org/notes.md', blob: 'b2' })
    await r.service.remove(project.id)
    expect(r.canceled).toEqual([planning.id])
    expect(() => r.get(project.id)).toThrow()
    expect(r.personCommits).toHaveLength(0)
    // A new project doesn't take the folder the deleted one left.
    const again = await r.start({ requirement: 'Export reports to CSV' })
    expect(again.slug).toBe('export-reports-to-csv-2')
  })

  it('deletes a channel’s files from the memory repository, as the person, when asked', async () => {
    const r = await rig()
    const project = await closedProject(r)
    r.files.push({ path: 'memory/org/projects/export-reports-to-csv/plan.md', blob: 'b1' }, { path: 'memory/org/projects/export-reports-to-csv/build.md', blob: 'b2' }, { path: 'memory/org/projects/other/plan.md', blob: 'b3' })
    await r.service.remove(project.id, { removeFiles: true })
    expect(r.personCommits).toEqual([
      {
        subject: "Delete #export-reports-to-csv's files",
        changes: [
          { kind: 'delete', path: 'memory/org/projects/export-reports-to-csv/plan.md', expectedBlob: 'b1' },
          { kind: 'delete', path: 'memory/org/projects/export-reports-to-csv/build.md', expectedBlob: 'b2' }
        ]
      }
    ])
    expect(r.files.map((f) => f.path)).toEqual(['memory/org/projects/other/plan.md'])
    expect(r.service.all('o1')).toHaveLength(0)
  })
})

describe('projects: asking before planning', () => {
  it('makes her ask first, waits for your answers, and plans again with them', async () => {
    const r = await rig()
    const project = await r.service.start('o1', { requirement: 'Add single sign-on with Okta' })
    const planning = r.task(r.last())
    expect(r.last().body).toContain('How to ask:')
    // Neither finishing nor a plan before she has asked.
    expect(r.service.finishCheck(planning, { status: 'done' })).toContain('Ask the person first with project_questions')
    await expect(r.service.submitPlan(planning, 'run-1', TWO_PARTS)).rejects.toThrow('Ask before you plan')
    await expect(r.service.submitQuestions(planning, { questions: [] })).rejects.toThrow('Ask at least one question')
    const said = await r.service.submitQuestions(planning, {
      understood: ['Enterprise customers want to log in with their company accounts.'],
      questions: [
        { question: 'Which identity providers?', why: 'So I don’t guess Okta only.', options: ['Okta only', 'Any SAML 2.0'] },
        { question: 'Does password login stay?' }
      ]
    })
    expect(said).toContain('2 questions recorded (round 1)')
    expect(r.service.finishCheck(planning, { status: 'done' })).toBeUndefined()
    // Asked in this task: no plan in it too.
    await expect(r.service.submitPlan(planning, 'run-1', TWO_PARTS)).rejects.toThrow('You asked questions in this task')
    await r.close(planning.id)
    let p = r.get(project.id)
    expect(p.phase).toBe('planning')
    expect(p.waits).toEqual([expect.objectContaining({ kind: 'questions' })])
    expect(p.asks).toEqual([expect.objectContaining({ round: 1, taskId: planning.id, questions: [expect.objectContaining({ question: 'Which identity providers?', options: ['Okta only', 'Any SAML 2.0'] }), expect.objectContaining({ options: [] })] })])
    const wait = p.waits[0]
    // Only answers (or Stop) answer it.
    await expect(r.service.decide(project.id, wait.id, 'approve')).rejects.toThrow('isn’t one of this decision’s choices')
    await expect(r.service.answer(project.id, wait.id, ['Any SAML 2.0'])).rejects.toThrow('Answer every question')
    await expect(r.service.answer(project.id, wait.id, ['Any SAML 2.0', ' '])).rejects.toThrow('Answer every question')
    await r.service.answer(project.id, wait.id, ['Any SAML 2.0', 'Yes, for small teams'])
    p = r.get(project.id)
    expect(p.waits).toEqual([])
    expect(p.asks?.[0]).toMatchObject({ answers: ['Any SAML 2.0', 'Yes, for small teams'] })
    expect(r.last()).toMatchObject({ employeeId: PM, project: { kind: 'plan', round: 2 } })
    expect(r.last().body).toContain('1. Which identity providers?\n   Answer: Any SAML 2.0')
    await expect(r.service.answer(project.id, wait.id, ['x', 'y'])).rejects.toThrow('isn’t waiting for answers')
    // Now she may plan; a large plan says what she understood and assumes nothing while she can still ask.
    const second = r.task(r.last())
    const large = { ...TWO_PARTS, size: 'large' as const, understood: ['Any SAML 2.0 provider; passwords stay.'], done_when: ['A test Okta tenant can log in.'] }
    await expect(r.service.submitPlan(second, 'run-2', { ...large, assumptions: ['JIT accounts'] })).rejects.toThrow('A large plan assumes nothing while you can still ask')
    await r.service.submitPlan(second, 'run-2', large)
    expect(r.staged.at(-1)?.text).toContain('## Questions asked')
    await r.close(second.id)
    expect(r.get(project.id).plans[0]).toMatchObject({ understood: ['Any SAML 2.0 provider; passwords stay.'], doneWhen: ['A test Okta tenant can log in.'], assumptions: [] })
  })

  it('plans with what she has when you say so, listing what she assumed, and asks no more', async () => {
    const r = await rig()
    const project = await r.service.start('o1', { requirement: 'Add single sign-on with Okta' })
    const planning = r.task(r.last())
    await r.service.submitQuestions(planning, { questions: [{ question: 'Which identity providers?' }] })
    await r.close(planning.id)
    await r.service.answer(project.id, r.get(project.id).waits[0].id, null)
    expect(r.get(project.id).asks?.[0]).toMatchObject({ skipped: true })
    expect(r.last().body).toContain('plan with what you have: don’t ask again')
    const second = r.task(r.last())
    await r.service.submitPlan(second, 'run-2', { ...TWO_PARTS, size: 'large', understood: ['SSO for enterprise customers.'], done_when: ['Okta works.'], assumptions: ['Okta only'] })
    await r.close(second.id)
    expect(r.get(project.id).plans[0]).toMatchObject({ assumptions: ['Okta only'] })
    expect(r.get(project.id).waits).toEqual([expect.objectContaining({ kind: 'plan' })])
  })

  it('stops a project waiting on its questions, and keeps project_questions out of a replan', async () => {
    const r = await rig()
    const asking = await r.service.start('o1', { requirement: 'Add single sign-on with Okta' })
    const planning = r.task(r.last())
    await r.service.submitQuestions(planning, { questions: [{ question: 'Which identity providers?' }] })
    await r.close(planning.id)
    await r.service.decide(asking.id, r.get(asking.id).waits[0].id, 'stop')
    expect(r.get(asking.id)).toMatchObject({ phase: 'closed', outcome: 'stopped' })
    // A plan in effect: a replan asks with ask_person instead.
    const going = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan(TWO_PARTS)
    await r.service.decide(going.id, r.get(going.id).waits[0].id, 'approve')
    await r.close(r.task(r.asked.find((a) => a.project.partId === 'build')!).id, { reason: 'blocked', detail: 'No test data' })
    const replanning = r.task(r.last())
    expect(replanning.project?.kind).toBe('plan')
    await expect(r.service.submitQuestions(replanning, { questions: [{ question: 'Where is the test data?' }] })).rejects.toThrow('A plan is in effect')
  })
})

describe('projects: decisions bound to what the person saw, and taken back', () => {
  const MOCKS: PlanInput = {
    summary: 's',
    size: 'small',
    parts: [
      { id: 'design', title: 'Mocks', owner: 'Priya', brief: 'Draw mocks.', writes: 'design.md', gate_after: true },
      { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build the picked one.', writes: 'build.md', depends_on: ['design'] }
    ]
  }
  const folder = 'memory/org/projects/simplify-the-sidebar/mocks/design/'
  /** A project whose design part waits at its gate, with two mocks drawn. */
  async function atDesignGate(input: PlanInput = MOCKS) {
    const r = await rig()
    const project = await r.start({ requirement: 'Simplify the sidebar' })
    await r.plan(input)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    const design = r.task(r.last())
    await r.close(design.id, { artifacts: ['memory/org/projects/simplify-the-sidebar/design.md', `${folder}index.html`, `${folder}1-sidebar-a.html`, `${folder}1-sidebar-b.html`] })
    return { ...r, id: project.id, design }
  }

  it('sends the answers given with Plan with what you have, and refuses questions changed under the card', async () => {
    const r = await rig()
    const project = await r.service.start('o1', { requirement: 'Add single sign-on with Okta' })
    const planning = r.task(r.last())
    await r.service.submitQuestions(planning, { questions: [{ question: 'Which identity providers?' }, { question: 'Does password login stay?' }] })
    await r.close(planning.id)
    const wait = r.get(project.id).waits[0]
    const round = r.get(project.id).asks![0]
    await expect(r.service.answer(project.id, wait.id, ['Okta only', 'Yes'], { seen: '1@2026-01-01T00:00:00.000Z' })).rejects.toThrow('Priya changed the questions: look again.')
    await expect(r.service.answer(project.id, wait.id, ['Okta only'], { skip: true })).rejects.toThrow('one answer per question')
    await r.service.answer(project.id, wait.id, ['Okta only', ' '], { skip: true, seen: roundSeen(round) })
    expect(r.get(project.id).asks?.[0]).toMatchObject({ skipped: true, answers: ['Okta only', ''] })
    expect(r.last().body).toContain('1. Which identity providers?\n   Answer: Okta only')
    expect(r.last().body).toContain('2. Does password login stay?\n   Not answered (left to you).')
    expect(r.last().body).toContain('The person asked you to plan with what you have')
  })

  it('takes no questions or plan from a planning task once it finished, and refuses a plan changed under the card', async () => {
    const r = await rig()
    const asking = await r.service.start('o1', { requirement: 'Add single sign-on with Okta' })
    const planning = r.task(r.last())
    await r.service.submitQuestions(planning, { questions: [{ question: 'Which identity providers?' }] })
    await r.close(planning.id)
    // Its turn runs on after finish_task: what it gave stands.
    await expect(r.service.submitQuestions(planning, { questions: [{ question: 'Something else?' }] })).rejects.toThrow('This task has finished')
    expect(r.get(asking.id).asks?.[0].questions[0].question).toBe('Which identity providers?')
    const project = await r.start({ requirement: 'Export reports to CSV' })
    const second = r.task(r.last())
    await r.plan(TWO_PARTS)
    await expect(r.service.submitPlan(second, 'run-1', { ...TWO_PARTS, parts: [TWO_PARTS.parts[0]] })).rejects.toThrow('This task has finished')
    const p = r.get(project.id)
    await expect(r.service.decide(project.id, p.waits[0].id, 'approve', undefined, { seen: '1@2026-01-01T00:00:00.000Z' })).rejects.toThrow('Priya changed the plan: look again.')
    await r.service.decide(project.id, p.waits[0].id, 'approve', undefined, { seen: planSeen(p.plans[0]) })
    expect(r.get(project.id).phase).toBe('working')
  })

  it('passes a pick and a note to the first round after the approval only, and calls a block for a replan what it is', async () => {
    const r = await atDesignGate()
    const wait = r.get(r.id).waits[0]
    await expect(r.service.decide(r.id, wait.id, 'approve', undefined, { pick: `${folder}9-other.html` })).rejects.toThrow('That mock isn’t one this part drew.')
    await r.service.decide(r.id, wait.id, 'approve', 'More mocks first', { pick: `${folder}1-sidebar-b.html` })
    expect(r.get(r.id).decisions.at(-1)).toMatchObject({ partId: 'design', decision: 'approve', note: 'More mocks first', pick: `${folder}1-sidebar-b.html` })
    const build = r.task(r.last())
    expect(build.body).toContain(`- On “Mocks”: picked ${folder}1-sidebar-b.html; “More mocks first”`)
    // He blocks as told; it is a replan he asked for, not a failure.
    await r.close(build.id, { reason: 'blocked', detail: 'The person asked for more mocks first' })
    expect(r.get(r.id).steps.find((s) => s.taskId === build.id)).toMatchObject({ state: 'stuck', end: 'replan' })
    await r.plan(MOCKS)
    // Round 2 isn't told the old note again.
    expect(r.last()).toMatchObject({ project: { partId: 'build', round: 2 } })
    expect(r.last().body).not.toContain('More mocks first')
    expect(r.last().body).not.toContain('The person approved what your part waits for')
  })

  it('refuses a note with Approve where nothing would read it, and gives a large plan’s to the acceptance', async () => {
    const small = await atDesignGate({ ...MOCKS, parts: [MOCKS.parts[0]] })
    await expect(small.service.decide(small.id, small.get(small.id).waits[0].id, 'approve', 'Fix the 2px gap')).rejects.toThrow('Nothing starts after this part')
    const r = await atDesignGate({ ...MOCKS, size: 'large', understood: ['u'], done_when: ['d'], parts: [MOCKS.parts[0]] })
    await r.service.decide(r.id, r.get(r.id).waits[0].id, 'approve', 'Fix the 2px gap before release')
    expect(r.last()).toMatchObject({ project: { kind: 'accept' } })
    expect(r.last().body).toContain('- Approved “Mocks”: “Fix the 2px gap before release”')
  })

  it('takes an approval back while what it started runs: canceled, the gate waits again, and approving again starts it afresh', async () => {
    const r = await atDesignGate()
    await r.service.decide(r.id, r.get(r.id).waits[0].id, 'approve')
    const build = r.task(r.last())
    const at = r.get(r.id).decisions.at(-1)!.at
    await r.service.undoDecision(r.id, at)
    let p = r.get(r.id)
    expect(r.canceled).toEqual([build.id])
    expect(p.parts).toMatchObject({ design: { state: 'gate' }, build: { state: 'pending', round: 0 } })
    expect(p.waits).toEqual([expect.objectContaining({ kind: 'gate', partId: 'design' })])
    expect(p.steps.find((s) => s.taskId === build.id)).toMatchObject({ state: 'stuck', end: 'undone' })
    expect(p.decisions.at(-2)).toMatchObject({ decision: 'approve', undoneAt: expect.any(String) })
    expect(p.decisions.at(-1)).toMatchObject({ partId: 'design', decision: 'undo' })
    // Its cancel closing later changes nothing.
    r.service.taskClosed(r.db.employeeTask(build.id)!)
    await settle()
    expect(r.get(r.id).parts.build).toMatchObject({ state: 'pending', round: 0 })
    await expect(r.service.undoDecision(r.id, at)).rejects.toThrow('can’t be taken back now')
    // Approved again: round 1 again, as a new task.
    await r.service.decide(r.id, r.get(r.id).waits[0].id, 'approve')
    expect(r.last()).toMatchObject({ requestId: expect.stringMatching(/:part:build:1:again-1$/), project: { partId: 'build', round: 1 } })
    p = r.get(r.id)
    expect(p.parts.build).toMatchObject({ state: 'running', round: 1, taskId: r.task(r.last()).id })
    // Once what it started finished, it can't be.
    const again = p.decisions.at(-1)!.at
    await r.close(r.task(r.last()).id)
    await expect(r.service.undoDecision(r.id, again)).rejects.toThrow('can’t be taken back now')
  })

  it('stops with every running part and its post saying stopped, and keeps a long result whole with a mark', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan(TWO_PARTS)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    const [build, docs] = [r.task(r.asked[1]), r.task(r.asked[2])]
    // Docs closed done just before Stop, but the project hadn't heard yet.
    r.db.putEmployeeTask({ ...docs, state: 'closed', closureReason: 'done', result: { status: 'done', summary: 'x'.repeat(4_500), runId: 'r', at: docs.createdAt } })
    await r.service.stop(project.id)
    let p = r.get(project.id)
    expect(p.parts.build).toMatchObject({ state: 'stopped' })
    expect(p.steps.find((s) => s.taskId === build.id)).toMatchObject({ state: 'stuck', end: 'stopped' })
    expect(r.canceled).toEqual([build.id])
    r.service.taskClosed(r.db.employeeTask(docs.id)!)
    await settle()
    p = r.get(project.id)
    expect(p.parts.docs).toMatchObject({ state: 'done' })
    expect(p.steps.find((s) => s.taskId === docs.id)).toMatchObject({ state: 'done', summaryCut: 500 })
    expect(p.steps.find((s) => s.taskId === docs.id)!.summary).toHaveLength(4_000)
  })
})

describe('projects: what main tells the window, and what closing touches', () => {
  const MOCKS: PlanInput = {
    summary: 's',
    size: 'small',
    parts: [
      { id: 'design', title: 'Mocks', owner: 'Priya', brief: 'Draw mocks.', writes: 'design.md', gate_after: true },
      { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build it.', writes: 'build.md', depends_on: ['design'] },
      { id: 'docs', title: 'Docs', owner: 'Priya', brief: 'Write it up.', writes: 'docs.md' }
    ]
  }

  it('lists the approvals that can be taken back on the view, and none once main sees a pull request any way it was sent', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Simplify the sidebar' })
    await r.plan(MOCKS)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    await r.close(r.task(r.asked.find((a) => a.project.partId === 'design')!).id)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    const at = r.get(project.id).decisions.at(-1)!.at
    const build = r.task(r.last())
    expect(r.service.views().o1[0].undoable).toEqual([at])
    // Sent by a person a while ago: not in the window's lists, but main sees it.
    r.db.addEmployeeAction({ id: 'a1', orgId: 'o1', employeeId: 'e-rav1', taskId: build.id, runId: 'r', repoId: 'site', kind: 'pull-request', payload: {} as never, policy: 'ask' as never, state: 'sent', key: 'k1', decidedBy: 'person', createdAt: '2026-11-15T10:00:00.000Z', updatedAt: '2026-11-15T10:00:00.000Z' })
    expect(r.service.views().o1[0].undoable).toBeUndefined()
    await expect(r.service.undoDecision(project.id, at)).rejects.toThrow('can’t be taken back now')
    // The view is read, not stored.
    expect(r.db.project(project.id)!.undoable).toBeUndefined()
  })

  it('marks a part that asked for a replan until the replan runs it again, and leaves a part at its gate as it is on Stop', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Simplify the sidebar' })
    await r.plan(MOCKS)
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    const docs = r.task(r.asked.find((a) => a.project.partId === 'docs')!)
    await r.close(docs.id, { reason: 'blocked', detail: 'Which audience?' })
    expect(r.get(project.id).parts.docs).toMatchObject({ state: 'stuck', askedReplan: true })
    await r.plan(MOCKS)
    expect(r.get(project.id).parts.docs).toMatchObject({ state: 'running', round: 2 })
    expect(r.get(project.id).parts.docs.askedReplan).toBeUndefined()
    // Design waits at its gate when the project stops: it finished its work, and says so still.
    await r.close(r.task(r.asked.find((a) => a.project.partId === 'design')!).id)
    expect(r.get(project.id).parts.design.state).toBe('gate')
    await r.service.stop(project.id)
    expect(r.get(project.id).parts).toMatchObject({ design: { state: 'gate' }, docs: { state: 'stopped' } })
  })

  it('says a follow-up left running when a project closes done was canceled, not stopped by the person', async () => {
    const r = await rig()
    const project = await r.start({ requirement: 'Export reports to CSV' })
    await r.plan({ ...TWO_PARTS, parts: [TWO_PARTS.parts[0]] })
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    const build = r.task(r.last())
    const follow = await r.service.askFollowUp(project.id, 'e-rav1', 'Why semicolons?')
    await r.close(build.id)
    const p = r.get(project.id)
    expect(p).toMatchObject({ phase: 'closed', outcome: 'done' })
    expect(r.canceled).toEqual([follow.id])
    expect(p.steps.find((s) => s.taskId === follow.id)).toMatchObject({ end: 'stopped', reason: 'Canceled when the project closed.' })
  })
})
