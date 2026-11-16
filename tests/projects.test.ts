// Projects (docs/ai-employees.md §15), the pure part: titles and slugs, @mentions, Foreman's checks on a plan (owners,
// files, dependencies, sizes, proposed employees, what a replan must keep), which replans go ahead on their own, the
// parts that may start, plan.md, the words a task carries, the program manager's and a proposed employee's definitions,
// and the memory file a task grants.
import { describe, expect, it } from 'vitest'
import { programManagerDefinition, proposedDefinition } from '../src/shared/employeeTeams'
import { memoryWriteDecision } from '../src/shared/employeeTools'
import { employeeFromObject, parseEmployee, serializeEmployee } from '../src/shared/employees'
import { createT } from '../src/shared/i18n'
import {
  allPartsDone,
  artifactPath,
  checkPlan,
  followUpBody,
  listedProjects,
  mentionOf,
  partBody,
  partsAfter,
  planDiff,
  planMarkdown,
  planningBody,
  projectSlug,
  projectTitle,
  readyParts,
  replanGoesAhead,
  type PlanContext,
  type PlanInput,
  type Project,
  type ProjectPlan
} from '../src/shared/projects'

const NOW = '2026-11-15T10:00:00.000Z'

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    orgId: 'o1',
    slug: 'csv-export',
    title: 'Export reports to CSV',
    requirement: 'Export reports to CSV',
    repoId: 'site',
    pmId: 'e-pri1',
    phase: 'planning',
    plans: [],
    parts: {},
    replans: 0,
    steps: [],
    artifacts: {},
    waits: [],
    decisions: [],
    notes: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

const CTX: PlanContext = {
  employees: [
    { id: 'e-pri1', name: 'Priya', state: 'active' },
    { id: 'e-rav1', name: 'Ravi', state: 'active' },
    { id: 'e-old1', name: 'Olga', state: 'retired' }
  ],
  pmId: 'e-pri1',
  repos: ['site']
}

const PLAN: PlanInput = {
  summary: 'A Download CSV button on the reports page.',
  size: 'large',
  parts: [
    { id: 'reqs', title: 'Requirements', owner: 'Priya', brief: 'Say what the file holds.', writes: 'requirements.md', gate_after: true },
    { id: 'build', title: 'Build', owner: 'e-rav1', brief: 'Build it.', writes: 'build.md', depends_on: ['reqs'] },
    { id: 'qa', title: 'QA', owner: 'new:qa', brief: 'Test it.', writes: 'qa.md', depends_on: ['build'], reads: ['reqs'] }
  ],
  new_employees: [{ key: 'qa', name: 'Quinn', role: 'QA engineer', description: 'Tests what is built.', instructions: 'Test it.', repos: { site: 'write' } }]
}

function checked(input: PlanInput = PLAN, ctx: PlanContext = CTX): ProjectPlan {
  const out = checkPlan(input, ctx)
  if (!out.ok) throw new Error(out.problems.join('\n'))
  return { version: 1, summary: out.summary, size: out.size, parts: out.parts, proposed: out.proposed, proposedIds: { qa: 'e-qui1' }, taskId: 't1', at: NOW, status: 'approved' }
}

describe('projects: names and mentions', () => {
  it('titles a project from its first line without the mention, and gives it a short slug, unique in its organization', () => {
    expect(projectTitle('@Priya   Export   reports to CSV\nmore')).toBe('Export reports to CSV')
    expect(projectTitle('x'.repeat(200))).toHaveLength(80)
    expect(projectSlug('Export reports to CSV', [])).toBe('export-reports-to-csv')
    expect(projectSlug('Export reports to CSV', ['export-reports-to-csv'])).toBe('export-reports-to-csv-2')
    expect(projectSlug('Café crème', [])).toBe('cafe-creme')
    expect(projectSlug('中文', [])).toBe('project')
    expect(projectSlug('Export reports to CSV so finance can open them in a spreadsheet', [])).toBe('export-reports-to-csv-so-finance')
    expect(projectSlug('a'.repeat(100), [])).toHaveLength(32)
    expect(artifactPath('csv-export', 'plan.md')).toBe('memory/org/projects/csv-export/plan.md')
  })

  it('reads who a message names first, whatever the case, and nothing when it names nobody on the team', () => {
    expect(mentionOf('@priya, build CSV export', ['Priya', 'Ravi'])).toEqual({ name: 'Priya', rest: 'build CSV export' })
    expect(mentionOf('  @Ravi: why quotes?', ['Priya', 'Ravi'])).toEqual({ name: 'Ravi', rest: 'why quotes?' })
    expect(mentionOf('build it @Priya', ['Priya'])).toBeNull()
    expect(mentionOf('@Nobody hi', ['Priya'])).toBeNull()
  })

  it('lists projects going and those closed lately, newest first', () => {
    const now = Date.parse(NOW)
    const old = project({ id: 'old', phase: 'closed', closedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' })
    const recent = project({ id: 'recent', phase: 'closed', closedAt: '2026-11-14T00:00:00.000Z', createdAt: '2026-11-10T00:00:00.000Z' })
    const going = project({ id: 'going', createdAt: '2026-11-12T00:00:00.000Z' })
    expect(listedProjects([old, recent, going], now).map((p) => p.id)).toEqual(['going', 'recent'])
  })
})

describe('projects: Foreman’s checks on a plan', () => {
  it('accepts a good plan, resolving owners by name or id and a proposed one as new:<key>', () => {
    const out = checkPlan(PLAN, CTX)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.parts.map((p) => p.owner)).toEqual(['e-pri1', 'e-rav1', 'new:qa'])
    expect(out.parts[0]).toMatchObject({ gate: true, dependsOn: [], reads: [] })
    expect(out.proposed[0]).toMatchObject({ key: 'qa', name: 'Quinn', repos: { site: 'write' } })
  })

  it('names every problem: owners off the team (or retired), bad or shared files, unknown parts, a circle and sizes', () => {
    const bad = checkPlan(
      {
        summary: '',
        size: 'small',
        parts: [
          { id: 'A b', title: 'x', owner: 'Olga', brief: 'x', writes: 'notes.txt' },
          { id: 'b', title: 'x', owner: 'Ravi', brief: 'x', writes: 'plan.md' },
          { id: 'c', title: 'x', owner: 'Ravi', brief: 'x', writes: 'c.md', depends_on: ['zz'] },
          { id: 'd', title: 'x', owner: 'Ravi', brief: 'x', writes: 'c.md' }
        ]
      },
      CTX
    )
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    const text = bad.problems.join('\n')
    expect(text).toContain('summary')
    expect(text).toContain('A small plan has at most 3 parts')
    expect(text).toContain('“Olga” isn’t on the team')
    expect(text).toContain('“A b” isn’t')
    expect(text).toContain('“notes.txt” isn’t')
    expect(text).toContain('can’t write plan.md')
    expect(text).toContain('Two parts write c.md')
    expect(text).toContain('“zz”, which isn’t a part')
    const circle = checkPlan(
      {
        summary: 's',
        size: 'large',
        parts: [
          { id: 'a', title: 'a', owner: 'Ravi', brief: 'a', writes: 'a.md', depends_on: ['b'] },
          { id: 'b', title: 'b', owner: 'Ravi', brief: 'b', writes: 'b.md', depends_on: ['a'] }
        ]
      },
      CTX
    )
    expect(circle.ok ? [] : circle.problems).toContain('The parts depend on each other in a circle, so none of them could start.')
  })

  it('checks proposed employees: a new name, a part to own, only the organization’s repositories', () => {
    const out = checkPlan(
      {
        ...PLAN,
        new_employees: [
          { key: 'qa', name: 'Quinn', role: 'QA', description: '', instructions: 'Test.', repos: { site: 'write', elsewhere: 'read' } },
          { key: 'ux', name: 'Ravi', role: 'UX', description: '', instructions: 'Design.', repos: {} }
        ]
      },
      CTX
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.problems.join('\n')).toContain('“elsewhere” isn’t one')
    expect(out.problems.join('\n')).toContain('Ravi is already on the team')
    expect(out.problems.join('\n')).toContain('owns no part')
  })

  it('makes a replan keep every part that started, with its owner', () => {
    const current = checked()
    const parts = { reqs: { state: 'done' as const, round: 1 }, build: { state: 'stuck' as const, round: 1 } }
    const dropped = checkPlan({ ...PLAN, parts: PLAN.parts.filter((p) => p.id !== 'build') }, { ...CTX, current, parts })
    expect(dropped.ok ? [] : dropped.problems.join('\n')).toContain('Part “build” has started (stuck)')
    const moved = checkPlan({ ...PLAN, parts: PLAN.parts.map((p) => (p.id === 'reqs' ? { ...p, owner: 'Ravi' } : p)) }, { ...CTX, current, parts })
    expect(moved.ok ? [] : moved.problems.join('\n')).toContain('stays with its owner')
    // A proposed owner is an employee by then: naming them by name or id keeps the part with them.
    const quinn = { ...CTX, employees: [...CTX.employees, { id: 'e-qui1', name: 'Quinn', state: 'active' }], current, parts: { ...parts, qa: { state: 'stuck' as const, round: 1 } } }
    const again = checkPlan({ ...PLAN, parts: PLAN.parts.map((p) => (p.id === 'qa' ? { ...p, owner: 'Quinn' } : p)), new_employees: [] }, quinn)
    expect(again.ok ? [] : again.problems).toEqual([])
    if (again.ok) expect(replanGoesAhead(current, { parts: [...again.parts, { ...again.parts[2], id: 'qa2', writes: 'qa2.md' }], proposed: [], size: 'large' })).toBe(true)
  })
})

describe('projects: replans, readiness and plan.md', () => {
  it('lets a replan go ahead when it only gives the plan’s owners more work, and holds one that adds a person or resizes', () => {
    const current = checked()
    const more = checked({ ...PLAN, parts: [...PLAN.parts, { id: 'fix', title: 'Fix', owner: 'Ravi', brief: 'Fix it.', writes: 'fix.md', depends_on: ['qa'] }] })
    expect(replanGoesAhead(current, { ...more, proposed: [] })).toBe(true)
    const withNewcomer = checkPlan({ ...PLAN, parts: [...PLAN.parts, { id: 'docs', title: 'Docs', owner: 'new:docs', brief: 'Write docs.', writes: 'docs.md' }], new_employees: [...PLAN.new_employees!, { key: 'docs', name: 'Dana', role: 'Writer', description: '', instructions: 'Write.', repos: {} }] }, CTX)
    expect(withNewcomer.ok).toBe(true)
    if (withNewcomer.ok) expect(replanGoesAhead(current, { parts: withNewcomer.parts, proposed: withNewcomer.proposed, size: 'large' })).toBe(false)
    expect(replanGoesAhead(current, { ...current, size: 'small', proposed: [] })).toBe(false)
    // Dropping the person's check on a part waits for them.
    expect(replanGoesAhead(current, { ...current, proposed: [], parts: current.parts.map((p) => ({ ...p, gate: false })) })).toBe(false)
    expect(planDiff(current, more)).toEqual({ added: ['fix'], removed: [], changed: [] })
  })

  it('starts parts whose dependencies are done, keeps the states of parts a new plan keeps, and knows when all are done', () => {
    const plan = checked()
    expect(readyParts(plan, {}).map((p) => p.id)).toEqual(['reqs'])
    expect(readyParts(plan, { reqs: { state: 'gate', round: 1 } }).map((p) => p.id)).toEqual([])
    expect(readyParts(plan, { reqs: { state: 'done', round: 1 } }).map((p) => p.id)).toEqual(['build'])
    expect(partsAfter(plan, { reqs: { state: 'done', round: 1 }, gone: { state: 'done', round: 1 } })).toEqual({ reqs: { state: 'done', round: 1 }, build: { state: 'pending', round: 0 }, qa: { state: 'pending', round: 0 } })
    expect(allPartsDone(plan, { reqs: { state: 'done', round: 1 }, build: { state: 'done', round: 1 }, qa: { state: 'done', round: 2 } })).toBe(true)
  })

  it('writes plan.md with the request, each part, who owns it and the employees proposed', () => {
    const md = planMarkdown(project(), checked(), { 'e-pri1': 'Priya', 'e-rav1': 'Ravi' })
    expect(md).toContain('# Plan v1: Export reports to CSV')
    expect(md).toContain('| 2 | Build (`build`) | Ravi | — | build.md | reqs | no |')
    expect(md).toContain('| 3 | QA (`qa`) | Quinn |')
    expect(md).toContain('- **Quinn**, QA engineer')
  })

  it('tells the program manager the roster and how to plan, a part its file and inputs, and a follow-up what to read', () => {
    const body = planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster: [{ id: 'e-rav1', name: 'Ravi', role: 'Developer', askMeAbout: 'code', state: 'approved' }], transcript: 'You: add a button' })
    expect(body).toContain('Plan a new project in Acme')
    expect(body).toContain('- Ravi (id e-rav1): Developer; ask about: code; approved')
    expect(body).toContain('<foreman-data kind="workspace-chat">')
    expect(body).toContain('call project_plan')
    const replan = planningBody({ project: project(), organization: 'Acme', repos: [], roster: [], replan: { reason: 'Ravi couldn’t finish', current: '- build · …', version: 2, left: 2 } })
    expect(replan).toContain('plan v2; 2 replans left')
    const plan = checked()
    const part = partBody({ project: project(), organization: 'Acme', plan, part: plan.parts[1], round: 2, inputs: [{ path: 'memory/org/projects/csv-export/requirements.md', commit: 'abcdef1234567890' }], note: 'Quote commas' })
    expect(part).toContain('round 2')
    expect(part).toContain('“Quote commas”')
    expect(part).toContain('requirements.md (at abcdef123456)')
    expect(part).toContain('memory/org/projects/csv-export/build.md')
    expect(followUpBody({ project: project(), question: 'Why?', artifact: { path: 'memory/org/projects/csv-export/build.md' }, part: plan.parts[1] })).toContain('your part “Build”')
  })
})

describe('the program manager and proposed employees', () => {
  const loadouts = [{ agent: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const }]

  it('makes Priya a valid definition that writes every repository, pushes and opens pull requests, and has no limits', () => {
    const d = programManagerDefinition({ repos: ['site', 'api'], loadouts, taken: [] })
    expect(parseEmployee(serializeEmployee(d), createT('en')).problems).toEqual([])
    expect(employeeFromObject(JSON.parse(JSON.stringify(d))).definition).toBeDefined()
    expect(d).toMatchObject({ name: 'Priya', role: 'Program manager', look: { colour: 'teal' }, attendance: 'unattended' })
    expect(d.access.repos).toEqual({ site: 'write', api: 'write' })
    expect(d.access.profile).toBe('no-shell')
    expect(d.access.actions).toEqual({ 'slack-post': 'held', linear: 'held', push: 'allowed', 'pull-request': 'allowed' })
    expect(d.limits).toEqual({})
    expect(d.instructions).toContain('project_plan')
    // Another employee called Priya: she is told apart.
    expect(programManagerDefinition({ repos: [], loadouts, taken: [], takenNames: ['priya'] }).name).toBe('Priya (PM)')
  })

  it('makes a proposed employee a draft with Write on every repository the plan names, pushes and pull requests allowed, only unattended', () => {
    const base = { id: 'e-qui1', colour: 'pink', name: 'Quinn', role: 'QA engineer', description: 'Tests.', responsibilities: ['Test'], instructions: 'Test it.', repos: { site: 'write' as const, api: 'read' as const } }
    const d = proposedDefinition({ ...base, loadouts })
    expect(parseEmployee(serializeEmployee(d), createT('en')).problems).toEqual([])
    expect(d.access.repos).toEqual({ site: 'write', api: 'write' })
    expect(d.access.actions).toMatchObject({ push: 'allowed', 'pull-request': 'allowed' })
    expect(d.limits).toEqual({})
    const codex = proposedDefinition({ ...base, loadouts: [{ agent: 'codex', model: 'gpt-6', effort: 'medium' }] })
    expect(codex).toMatchObject({ attendance: 'attended', access: { repos: { site: 'read', api: 'read' } } })
  })
})

describe('the memory file a task grants', () => {
  it('lets a part write its file and nothing else of the organization’s, and makes it a proposal when read-only', () => {
    const file = 'memory/org/projects/csv-export/requirements.md'
    expect(memoryWriteDecision('e-max1', file, { scopes: [], readOnly: false, files: [file] })).toEqual({ kind: 'write' })
    expect(memoryWriteDecision('e-max1', file, { scopes: [], readOnly: true, files: [file] }).kind).toBe('propose')
    expect(memoryWriteDecision('e-max1', 'memory/org/projects/csv-export/design.md', { scopes: [], readOnly: false, files: [file] }).kind).toBe('refuse')
    expect(memoryWriteDecision('e-max1', file, { scopes: [], readOnly: false }).kind).toBe('refuse')
  })
})
