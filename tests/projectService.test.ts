// Projects (docs/ai-employees.md §15), the service: against a real foreman.db with a stand-in work service that records
// the tasks it is asked for. Starting with the program manager (refused without her or without words), her plan through
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
import { listedProjects, type PlanInput } from '../src/shared/projects'
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
  const close = async (id: string, how: { reason?: EmployeeTask['closureReason']; decision?: string; detail?: string } = {}) => {
    const task = db.employeeTask(id)!
    const reason = how.reason ?? 'done'
    clock.now += 1000
    const closed: EmployeeTask = {
      ...task,
      state: 'closed',
      closureReason: reason,
      ...(how.detail ? { closureDetail: how.detail } : {}),
      ...(reason === 'done' ? { result: { status: 'done', summary: `${task.title} finished.`, commit: `c-${id}`, ...(how.decision ? { decision: how.decision } : {}), runId: 'r', at: task.createdAt } } : {})
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
  return { db, state, org, team, service, asked, canceled, archived, staged, files, personCommits, alive, close, task, last, plan, get, clock }
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    expect(r.asked[1].contract).toEqual({ produces: 'memory/org/projects/export-reports-to-csv/build.md', writes: ['memory/org/projects/export-reports-to-csv/build.md'] })
    expect(going.decisions).toEqual([expect.objectContaining({ waitKind: 'plan', decision: 'approve' })])
  })

  it('sends a plan back with the person’s note: she plans again', async () => {
    const r = await rig()
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    // A small project ends with its last part: no acceptance, no final gate.
    await r.close(r.task(r.last()).id)
    p = r.get(r.id)
    expect(p).toMatchObject({ phase: 'closed', outcome: 'done', waits: [] })
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    const r = await approved({ ...TWO_PARTS, size: 'large' })
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
    await r.plan({ ...TWO_PARTS, parts: [TWO_PARTS.parts[0]] })
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    const build = r.task(r.last())
    await r.close(build.id)
    expect(r.get(project.id).phase).toBe('closed')
    const follow = await r.service.askFollowUp(project.id, 'e-rav1', 'Why semicolons?')
    expect(follow.employeeId).toBe('e-rav1')
    expect(r.last()).toMatchObject({ project: { kind: 'follow-up', partId: 'build' }, contract: { inputs: [{ path: 'memory/org/projects/export-reports-to-csv/build.md', commit: `c-${build.id}` }] }, runsAllowed: 80 })
    expect(r.last().body).toContain('“Why semicolons?”')
    expect(r.get(project.id).steps.at(-1)).toMatchObject({ kind: 'follow-up', question: 'Why semicolons?' })
  })
})

describe('projects: recovery', () => {
  it('goes on from a task that closed while Foreman wasn’t looking', async () => {
    const r = await rig()
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    const project = await r.service.start('o1', { requirement })
    await r.plan({ ...TWO_PARTS, parts: [TWO_PARTS.parts[0]] })
    await r.service.decide(project.id, r.get(project.id).waits[0].id, 'approve')
    await r.close(r.task(r.last()).id)
    expect(r.get(project.id).phase).toBe('closed')
    return project
  }

  it('renames only the name shown, refusing a bad or taken name', async () => {
    const r = await rig()
    const csv = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
    const project = await r.service.start('o1', { requirement: 'Export reports to CSV' })
    const planning = r.task(r.last())
    r.files.push({ path: 'memory/org/projects/export-reports-to-csv/plan.md', blob: 'b1' }, { path: 'memory/org/notes.md', blob: 'b2' })
    await r.service.remove(project.id)
    expect(r.canceled).toEqual([planning.id])
    expect(() => r.get(project.id)).toThrow()
    expect(r.personCommits).toHaveLength(0)
    // A new project doesn't take the folder the deleted one left.
    const again = await r.service.start('o1', { requirement: 'Export reports to CSV' })
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
