// Projects (docs/ai-employees.md §15), the pure part: titles and slugs, @mentions, Foreman's checks on a plan (owners,
// files, dependencies, sizes, proposed employees, what a replan must keep), which replans go ahead on their own, the
// parts that may start, asking before planning (questions, answers, what a plan may assume), the plan's workflow
// and order, plan.md, the words a task carries, the program manager's and a proposed employee's definitions, the
// memory file a task grants, and what a project's employees are doing right now.
import { describe, expect, it } from 'vitest'
import { programManagerDefinition, proposedDefinition } from '../src/shared/employeeTeams'
import { MAX_FINISH_SUMMARY, memoryWriteDecision } from '../src/shared/employeeTools'
import { MAX_TASK_BODY } from '../src/shared/employeeWork'
import { jobPrompt } from '../src/shared/employeePrompts'
import { employeeFromObject, parseEmployee, serializeEmployee } from '../src/shared/employees'
import { createT } from '../src/shared/i18n'
import {
  acceptanceBody,
  allPartsDone,
  answersProblem,
  approvalsFor,
  approvalUndo,
  cutText,
  decisionsText,
  endsWithFinalCheck,
  gateNoteTo,
  handoverTranscript,
  planStateText,
  proposedAccess,
  rosterCan,
  MAX_ANSWER,
  MAX_STEP_SUMMARY,
  publishedTasks,
  questionsText,
  artifactPath,
  checkPlan,
  checkQuestions,
  MAX_QUESTION_ROUNDS,
  followUpBody,
  listedProjects,
  mentionOf,
  MAX_MESSAGES,
  MAX_MOCKS,
  messageBody,
  messagesSince,
  messagesText,
  steerText,
  mocksFolder,
  partBody,
  partMocks,
  partsAfter,
  planDiff,
  planMarkdown,
  projectLive,
  planningBody,
  planStages,
  planWorkflow,
  projectSlug,
  projectPublications,
  projectTaskRetryable,
  projectTitle,
  publishedLines,
  publisherOf,
  publishRefusal,
  publishRule,
  questionState,
  readyParts,
  replanGoesAhead,
  waitingOnRepo,
  type PlanContext,
  type PlanInput,
  type Project,
  type ProjectPlan,
  type QuestionRound
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
  return { version: 1, summary: out.summary, size: out.size, understood: out.understood, doneWhen: out.doneWhen, outOfScope: out.outOfScope, assumptions: out.assumptions, parts: out.parts, proposed: out.proposed, proposedIds: { qa: 'e-qui1' }, taskId: 't1', at: NOW, status: 'approved' }
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
    expect(body).toContain('Before you plan it, understand it: ask the person')
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
    expect(part).not.toContain('The person approved')
    // What the person wrote approving the part it waits for goes with it, a blank note doesn't.
    const picked = partBody({ project: project(), organization: 'Acme', plan, part: plan.parts[1], round: 1, inputs: [], approvals: [{ part: 'Requirements', note: ' Take option 2 ' }, { part: 'Docs', note: ' ' }] })
    expect(picked).toContain('- On “Requirements”: “Take option 2”')
    expect(picked).not.toContain('On “Docs”')
    expect(picked).toContain('finish_task blocked and say in unblock what they asked for')
    expect(followUpBody({ project: project(), question: 'Why?', artifact: { path: 'memory/org/projects/csv-export/build.md' }, part: plan.parts[1] })).toContain('your part “Build”')
    // Its standard mocks folder, for a part that designs or changes screens.
    expect(part).toContain('draw them as HTML mocks in memory/org/projects/csv-export/mocks/build/')
    const follow = followUpBody({ project: project(), question: 'Why?', artifact: { path: 'memory/org/projects/csv-export/build.md' }, part: plan.parts[1], mocks: mocksFolder('csv-export', 'build') })
    expect(follow).toContain('your part “Build”')
    expect(follow).toContain('Your HTML mocks are in memory/org/projects/csv-export/mocks/build/')
    expect(followUpBody({ project: project(), question: 'Why?', mocks: mocksFolder('csv-export', 'build') })).not.toContain('HTML mocks')
  })

  it('tells the program manager to give screens to a designer, gated, with mocks', () => {
    const body = planningBody({ project: project(), organization: 'Acme', repos: [], roster: [], replan: { reason: 'r', current: '-', version: 2, left: 2 } })
    expect(body).toContain('A part that designs or changes screens also draws them as HTML mocks')
  })
})

describe('a part’s mocks', () => {
  const folder = mocksFolder('csv-export', 'design')

  it('is the part’s own folder in the project’s', () => {
    expect(folder).toBe('memory/org/projects/csv-export/mocks/design/')
  })

  it('keeps the HTML files its result names in its folder, each once, index.html first', () => {
    const named = [
      `${folder}2-export-b.html`,
      'memory/org/projects/csv-export/design.md',
      `${folder}index.html`,
      `${folder}1-export-a.html`,
      ` ${folder}1-export-a.html `,
      `${folder}notes.md`,
      `${folder}sub/1-a.html`,
      `${folder}Big.html`,
      'memory/org/projects/csv-export/mocks/build/1-a.html',
      'memory/org/projects/csv-export/mocks/design-2/1-a.html'
    ]
    expect(partMocks('csv-export', 'design', named)).toEqual([`${folder}index.html`, `${folder}1-export-a.html`, `${folder}2-export-b.html`])
    expect(partMocks('csv-export', 'design', [])).toEqual([])
    expect(partMocks('csv-export', 'design', Array.from({ length: MAX_MOCKS + 5 }, (_, i) => `${folder}${String(i).padStart(2, '0')}-a.html`))).toHaveLength(MAX_MOCKS)
  })

  it('tells an acceptance what a replan decision does: another replan, or the person’s final check once none are left', () => {
    const accept = (replansLeft: number) => acceptanceBody({ project: project(), organization: 'Acme', plan: { version: 2, summary: 's' }, inputs: [], replansLeft })
    expect(accept(1)).toContain('replan (something must change: Foreman starts another planning round)')
    expect(accept(0)).toContain('no replans are left, so the unresolved result goes to the person’s final gate')
  })
})

describe('the program manager and proposed employees', () => {
  const loadouts = [{ agent: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const }]

  it('makes Priya a valid definition with a shell that writes every repository, pushes and opens pull requests, and has no limits', () => {
    const d = programManagerDefinition({ repos: ['site', 'api'], loadouts, taken: [] })
    expect(parseEmployee(serializeEmployee(d), createT('en')).problems).toEqual([])
    expect(employeeFromObject(JSON.parse(JSON.stringify(d))).definition).toBeDefined()
    expect(d).toMatchObject({ name: 'Priya', role: 'Program manager', look: { colour: 'teal' }, attendance: 'unattended' })
    expect(d.access.repos).toEqual({ site: 'write', api: 'write' })
    expect(d.access.profile).toBe('shell')
    expect(d.access.actions).toEqual({ 'slack-post': 'held', linear: 'held', push: 'allowed', 'pull-request': 'allowed' })
    // Her prompt is the program manager's own file, linked rather than copied.
    expect(d.template).toBe('program-manager')
    expect(jobPrompt('program-manager')).toContain('project_plan')
    // Another employee called Priya: she is told apart.
    expect(programManagerDefinition({ repos: [], loadouts, taken: [], takenNames: ['priya'] }).name).toBe('Priya (PM)')
  })

  it('makes a proposed employee a draft with Write on every repository the plan names, pushes and pull requests allowed, only unattended', () => {
    const base = { id: 'e-qui1', colour: 'pink', name: 'Quinn', role: 'QA engineer', description: 'Tests.', responsibilities: ['Test'], instructions: 'Test it.', repos: { site: 'write' as const, api: 'read' as const } }
    const d = proposedDefinition({ ...base, loadouts })
    expect(parseEmployee(serializeEmployee(d), createT('en')).problems).toEqual([])
    expect(d.access.repos).toEqual({ site: 'write', api: 'write' })
    expect(d.access.actions).toMatchObject({ push: 'allowed', 'pull-request': 'allowed' })
    expect(d.access.profile).toBe('shell')
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

  it('lets a part write in its mocks folder, not beside it or in another part’s, and makes it a proposal when read-only', () => {
    const grants = { scopes: [], readOnly: false, files: ['memory/org/projects/csv-export/design.md'], folders: [mocksFolder('csv-export', 'design')] }
    expect(memoryWriteDecision('e-max1', 'memory/org/projects/csv-export/mocks/design/1-export-a.html', grants)).toEqual({ kind: 'write' })
    expect(memoryWriteDecision('e-max1', 'memory/org/projects/csv-export/mocks/design/index.html', { ...grants, readOnly: true }).kind).toBe('propose')
    for (const file of ['memory/org/projects/csv-export/mocks/build/1-a.html', 'memory/org/projects/csv-export/mocks/design-2/1-a.html', 'memory/org/projects/csv-export/plan.md', 'memory/org/projects/csv-export/mocks/design/../../plan.md'])
      expect(memoryWriteDecision('e-max1', file, grants).kind).toBe('refuse')
    // A folder grant that doesn't end in / grants nothing beside it.
    expect(memoryWriteDecision('e-max1', 'memory/org/projects/csv-export/mocks/design-2/1-a.html', { scopes: [], readOnly: false, folders: ['memory/org/projects/csv-export/mocks/design'] }).kind).toBe('refuse')
  })
})

describe('what a project’s employees are doing now', () => {
  const at = (m: number) => `2026-11-15T10:${String(m).padStart(2, '0')}:00.000Z`
  const step = (taskId: string, kind: 'plan' | 'part' | 'accept' | 'follow-up', state: 'running' | 'done' | 'stuck' = 'running') => ({ kind, round: 1, taskId, employeeId: `e-${taskId}`, state, startedAt: at(0), ...(kind === 'part' ? { partId: taskId } : {}) })

  it('pairs each running step with its task’s run not ended: working first, then starting, then queued', () => {
    const steps = [step('t1', 'part'), step('t2', 'part'), step('t3', 'part'), step('t4', 'plan', 'done')]
    const runs = [
      { id: 'r1', taskId: 't1', state: 'queued' as const, createdAt: at(1), reason: 'Ravi is busy with another task' },
      { id: 'r2', taskId: 't2', state: 'provisioning' as const, createdAt: at(1), admittedAt: at(2) },
      { id: 'r3', taskId: 't3', state: 'running' as const, createdAt: at(1), admittedAt: at(2), startedAt: at(3), workspaceId: 'w3', sessionId: 's3' },
      // A finished step's task has no live run, and isn't listed even if a stray one is.
      { id: 'r4', taskId: 't4', state: 'running' as const, createdAt: at(1) }
    ]
    const live = projectLive({ phase: 'working', steps }, runs)
    expect(live.map((l) => [l.runId, l.state, l.since])).toEqual([
      ['r3', 'working', at(3)],
      ['r2', 'starting', at(2)],
      ['r1', 'queued', at(1)]
    ])
    expect(live[0]).toMatchObject({ workspaceId: 'w3', sessionId: 's3' })
    expect(live[2].reason).toBe('Ravi is busy with another task')
  })

  it('leaves out a running step whose task has no run going (it waits on an answer), and everything once closed', () => {
    const steps = [step('t1', 'follow-up')]
    expect(projectLive({ phase: 'working', steps }, [])).toEqual([])
    expect(projectLive({ phase: 'working', steps }, [{ id: 'r9', taskId: 'other', state: 'running', createdAt: at(1) }])).toEqual([])
    expect(projectLive({ phase: 'closed', steps }, [{ id: 'r1', taskId: 't1', state: 'running', createdAt: at(1) }])).toEqual([])
  })

  it('takes the newest run of a task that was tried again', () => {
    const runs = [
      { id: 'old', taskId: 't1', state: 'admitted' as const, createdAt: at(1) },
      { id: 'new', taskId: 't1', state: 'running' as const, createdAt: at(4), startedAt: at(5) }
    ]
    expect(projectLive({ phase: 'working', steps: [step('t1', 'part')] }, runs).map((l) => l.runId)).toEqual(['new'])
  })
})

describe('projects: asking before planning', () => {
  const round = (patch: Partial<QuestionRound> = {}): QuestionRound => ({ round: 1, taskId: 't1', understood: [], questions: [{ question: 'Which formats?', options: ['CSV', 'CSV and Excel'] }], at: NOW, ...patch })
  const answered = questionState([round({ answers: ['CSV only'], answeredAt: NOW })])
  const unasked = questionState([])

  it('checks a round of questions: some, not too many, each once, while rounds are left and none waits', () => {
    const ok = checkQuestions({ understood: ['Finance exports reports.'], questions: [{ question: 'Which formats?', why: 'So I don’t guess Excel.', options: ['CSV', 'Excel'] }] }, unasked)
    expect(ok).toEqual({ ok: true, understood: ['Finance exports reports.'], questions: [{ question: 'Which formats?', why: 'So I don’t guess Excel.', options: ['CSV', 'Excel'] }] })
    const problems = (input: Parameters<typeof checkQuestions>[0], state = unasked) => {
      const out = checkQuestions(input, state)
      return out.ok ? [] : out.problems
    }
    expect(problems({ questions: [] })).toContain('Ask at least one question.')
    expect(problems({ questions: Array.from({ length: 11 }, (_, i) => ({ question: `Q${i}?` })) })[0]).toContain('at most 10 questions')
    expect(problems({ questions: [{ question: 'Why?' }, { question: 'why?' }] })).toContain('Two questions are the same: ask each once.')
    expect(problems({ questions: [{ question: 'Which?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] })[0]).toContain('more than 6 options')
    expect(problems({ questions: [{ question: 'More?' }] }, questionState([round()]))[0]).toContain('still waiting for the person’s answers')
    const all = Array.from({ length: MAX_QUESTION_ROUNDS }, (_, i) => round({ round: i + 1, answers: ['x'] }))
    expect(problems({ questions: [{ question: 'More?' }] }, questionState(all))[0]).toContain('plan with what you know')
  })

  it('takes the person’s answers only when every question has one', () => {
    const r = round({ questions: [{ question: 'A?', options: [] }, { question: 'B?', options: [] }] })
    expect(answersProblem(r, ['yes', 'no'])).toBeNull()
    expect(answersProblem(r, ['yes'])).toBe('missing')
    expect(answersProblem(r, ['yes', '  '])).toBe('missing')
    expect(answersProblem(r, ['yes', 'x'.repeat(2_001)])).toBe('long')
  })

  it('refuses a first plan until the person has answered, and lets a replan through without asking', () => {
    const small: PlanInput = { summary: 's', size: 'small', parts: [{ id: 'build', title: 'Build', owner: 'Ravi', brief: 'b', writes: 'build.md' }] }
    const first = checkPlan(small, { ...CTX, asked: unasked })
    expect(first.ok ? '' : first.problems[0]).toContain('Ask before you plan: call project_questions')
    const waiting = checkPlan(small, { ...CTX, asked: questionState([round()]) })
    expect(waiting.ok ? '' : waiting.problems[0]).toContain('still waiting for the person’s answers')
    expect(checkPlan(small, { ...CTX, asked: answered }).ok).toBe(true)
    expect(checkPlan(small, { ...CTX, asked: questionState([round({ skipped: true })]) }).ok).toBe(true)
    // A replan: nothing to ask first, though a large one still says what was understood and when it is done.
    const current = checked()
    expect(checkPlan({ ...PLAN, understood: ['u'], done_when: ['d'] }, { ...CTX, asked: unasked, current, parts: {} }).ok).toBe(true)
    // It can't ask (project_questions is refused once a plan is in effect), so it may list what it assumed.
    expect(checkPlan({ ...PLAN, understood: ['u'], done_when: ['d'], assumptions: ['UTF-8 is fine'] }, { ...CTX, asked: answered, current, parts: {} }).ok).toBe(true)
  })

  it('makes a large plan say what was understood and when it is done, and assume nothing while she can still ask', () => {
    const problems = (input: PlanInput, asked = answered) => {
      const out = checkPlan(input, { ...CTX, asked })
      return out.ok ? [] : out.problems
    }
    expect(problems(PLAN)).toEqual([expect.stringContaining('(understood)'), expect.stringContaining('(done_when)')])
    const full = { ...PLAN, understood: ['Finance exports monthly reports.'], done_when: ['A report downloads as CSV.'], out_of_scope: ['Excel'] }
    expect(problems(full)).toEqual([])
    expect(problems({ ...full, assumptions: ['UTF-8 is fine'] })).toEqual([expect.stringContaining('ask about these with project_questions instead (2 rounds left): UTF-8 is fine')])
    // Told to plan with what she has, or out of rounds, she lists them for the person to check.
    expect(problems({ ...full, assumptions: ['UTF-8 is fine'] }, questionState([round({ skipped: true })]))).toEqual([])
    const spent = questionState(Array.from({ length: MAX_QUESTION_ROUNDS }, (_, i) => round({ round: i + 1, answers: ['x'] })))
    expect(problems({ ...full, assumptions: ['UTF-8 is fine'] }, spent)).toEqual([])
    // A small plan may assume.
    const out = checkPlan({ summary: 's', size: 'small', assumptions: ['UTF-8 is fine'], parts: [{ id: 'build', title: 'Build', owner: 'Ravi', brief: 'b', writes: 'build.md' }] }, { ...CTX, asked: answered })
    expect(out).toMatchObject({ ok: true, assumptions: ['UTF-8 is fine'] })
  })

  it('tells her to ask first, then gives her the answers, or says to plan with what she has', () => {
    const roster = [{ id: 'e-rav1', name: 'Ravi', role: 'Developer', askMeAbout: '', state: 'approved' }]
    const first = planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster, asks: [] })
    expect(first).toContain('Foreman refuses a first plan until they have answered')
    expect(first).toContain('How to ask:')
    expect(first).toContain('Call project_questions')
    const after = planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster, asks: [round({ answers: ['CSV only'], answeredAt: NOW })] })
    expect(after).toContain('Plan the project “Export reports to CSV” in Acme.')
    expect(after).toContain('1. Which formats?\n   Answer: CSV only')
    expect(after).toContain('2 rounds left')
    const skipped = planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster, asks: [round({ skipped: true, answeredAt: NOW })] })
    expect(skipped).toContain('plan with what you have: don’t ask again')
    expect(skipped).not.toContain('How to ask:')
  })
})

describe('projects: the plan as a workflow', () => {
  it('orders the parts in stages: what waits for nothing first, parts that wait for the same things together', () => {
    expect(planStages(checked().parts)).toEqual([['reqs'], ['build'], ['qa']])
    const parts = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] }
    ]
    expect(planStages(parts)).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('draws the request, the questions, each part, your checks, her acceptance and your final check, in order', () => {
    const flow = planWorkflow(checked(), { questions: true })
    expect(flow.steps.map((s) => [s.id, s.stage, s.lane])).toEqual([
      ['request', 0, 0],
      ['questions', 1, 0],
      ['part:reqs', 2, 0],
      ['check:reqs', 3, 0],
      ['part:build', 4, 0],
      ['part:qa', 5, 0],
      ['accept', 6, 0],
      ['final', 7, 0],
      ['end', 8, 0]
    ])
    expect(flow.steps.find((s) => s.id === 'check:reqs')).toMatchObject({ kind: 'check', partId: 'reqs' })
    expect(flow.links).toContainEqual({ from: 'check:reqs', to: 'part:build' })
    expect(flow.links).toContainEqual({ from: 'part:qa', to: 'accept' })
    expect(flow).toMatchObject({ stages: 9, lanes: 1 })
    // A small plan without questions ends at its last parts; parts side by side share a column.
    const [, build, qa] = checked().parts
    const small = planWorkflow({ size: 'small', parts: [{ ...build, dependsOn: [] }, { ...qa, dependsOn: [], reads: [] }] }, { questions: false })
    expect(small.steps.map((s) => [s.id, s.stage, s.lane])).toEqual([
      ['request', 0, 0],
      ['part:build', 1, 0],
      ['part:qa', 1, 1],
      ['end', 2, 0]
    ])
    expect(small.links).toEqual([
      { from: 'request', to: 'part:build' },
      { from: 'request', to: 'part:qa' },
      { from: 'part:build', to: 'end' },
      { from: 'part:qa', to: 'end' }
    ])
  })

  it('writes plan.md with what she understood, done when, out of scope, assumptions, the workflow, the order and the questions asked', () => {
    const plan = checked({ ...PLAN, understood: ['Finance exports monthly.'], done_when: ['It downloads.'], out_of_scope: ['Excel'] })
    const asks: QuestionRound[] = [{ round: 1, taskId: 't1', understood: [], questions: [{ question: 'Which formats?', options: [] }], at: NOW, answers: ['CSV only'], answeredAt: NOW }]
    const md = planMarkdown(project({ asks }), plan, { 'e-pri1': 'Priya', 'e-rav1': 'Ravi' })
    expect(md).toContain('## What I understood\n\n- Finance exports monthly.')
    expect(md).toContain('## Done when\n\n- It downloads.')
    expect(md).toContain('## Out of scope\n\n- Excel')
    expect(md).toContain('## Assumptions\n\nNone: every open point was asked.')
    expect(md).toContain('```mermaid\nflowchart TD')
    expect(md).toContain('  check_reqs{{"You check: Requirements"}}')
    expect(md).toContain('  questions --> part_reqs')
    expect(md).toContain('1. Requirements (Priya). Then the person checks Requirements.')
    expect(md).toContain('4. The program manager checks the result against the request')
    expect(md).toContain('## Questions asked\n\nRound 1:\n1. Which formats?\n   Answer: CSV only')
  })
})

describe('projects: what the person says reaches the right place, once', () => {
  const round = (patch: Partial<QuestionRound> = {}): QuestionRound => ({ round: 1, taskId: 't1', understood: [], questions: [{ question: 'Which formats?', options: [] }, { question: 'Who uses it?', options: [] }], at: NOW, ...patch })
  const roster = [{ id: 'e-rav1', name: 'Ravi', role: 'Developer', askMeAbout: '', state: 'approved' }]

  it('reads a name with spaces, the longest that fits, and keeps a step’s summary to an employee’s own limit', () => {
    expect(mentionOf('@Uma Rao make the rail narrower', ['Uma', 'Uma Rao', 'Ravi'])).toEqual({ name: 'Uma Rao', rest: 'make the rail narrower' })
    expect(mentionOf('@uma rao: why?', ['Uma Rao'])).toEqual({ name: 'Uma Rao', rest: 'why?' })
    expect(mentionOf('@Uma Raof hi', ['Uma Rao'])).toBeNull()
    expect(mentionOf('@Uma', ['Uma'])).toEqual({ name: 'Uma', rest: '' })
    expect(MAX_STEP_SUMMARY).toBe(MAX_FINISH_SUMMARY)
    expect(cutText('abcdef', 3)).toBe('abc … (cut: 3 characters)')
  })

  it('takes partly given answers when she is told to plan with what she has, and tells her which are hers to decide', () => {
    expect(answersProblem(round(), ['CSV only', ''], true)).toBeNull()
    expect(answersProblem(round(), ['CSV only', ''])).toBe('missing')
    const text = questionsText([round({ skipped: true, answers: ['CSV only', ''], answeredAt: NOW })])
    expect(text).toContain('Round 1 (the person asked you to plan with what you have, after answering 1 of 2):')
    expect(text).toContain('1. Which formats?\n   Answer: CSV only')
    expect(text).toContain('2. Who uses it?\n   Not answered (left to you).')
    const body = planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster, asks: [round({ skipped: true, answers: ['CSV only', ''], answeredAt: NOW })] })
    expect(body).toContain('Answer: CSV only')
    expect(body).toContain('The person asked you to plan with what you have: don’t ask again. Use the answers they gave')
  })

  it('cuts ten long answers fairly, so the roster and the planning rules always arrive', () => {
    const questions = Array.from({ length: 10 }, (_, i) => ({ question: `Question ${i + 1}?`, options: [] }))
    const answers = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(MAX_ANSWER))
    const body = planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster, asks: [round({ questions, answers, answeredAt: NOW })], max: MAX_TASK_BODY })
    expect(body.length).toBeLessThanOrEqual(MAX_TASK_BODY)
    expect(body).toContain('- Ravi (id e-rav1)')
    expect(body).toContain('How to plan:')
    expect(body).toContain('finish_task done. The person sees it drawn as a workflow')
    // Each answer keeps the same share and says what it lost; the last one isn't the one dropped.
    const cuts = [...body.matchAll(/\(cut: (\d+) characters\)/g)].map((m) => Number(m[1]))
    expect(cuts).toHaveLength(10)
    expect(new Set(cuts).size).toBe(1)
    expect(body).toContain('10. Question 10?\n   Answer: 999')
    // Short enough, nothing is cut.
    expect(planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster, asks: [round({ answers: ['a', 'b'], answeredAt: NOW })], max: MAX_TASK_BODY })).not.toContain('(cut:')
  })

  it('passes an approval’s note and pick once: to the first round after it, not to later rounds', () => {
    const plan = checked({
      summary: 's',
      size: 'small',
      parts: [
        { id: 'design', title: 'Mocks', owner: 'Priya', brief: 'Draw.', writes: 'design.md', gate_after: true },
        { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build.', writes: 'build.md', depends_on: ['design'] },
        { id: 'qa', title: 'QA', owner: 'Ravi', brief: 'Test.', writes: 'qa.md', reads: ['design'] }
      ]
    })
    const [, build, qa] = plan.parts
    const approved = { waitKind: 'gate' as const, partId: 'design', decision: 'approve' as const, note: 'More mocks first', pick: 'memory/org/projects/csv-export/mocks/design/1-a.html', at: '2026-11-15T10:10:00.000Z' }
    const step = (partId: string, startedAt: string) => ({ kind: 'part' as const, partId, round: 1, taskId: `t-${partId}-${startedAt}`, employeeId: 'e-rav1', state: 'stuck' as const, startedAt })
    expect(approvalsFor({ decisions: [approved], steps: [] }, plan, build)).toEqual([{ part: 'Mocks', note: 'More mocks first', pick: approved.pick }])
    // Its round 2 (after the replan the note caused) isn't told again.
    expect(approvalsFor({ decisions: [approved], steps: [step('build', '2026-11-15T10:11:00.000Z')] }, plan, build)).toEqual([])
    // QA, which reads the design and ran before the approval, gets it on its first round after, and only then.
    expect(approvalsFor({ decisions: [approved], steps: [step('qa', '2026-11-15T10:01:00.000Z')] }, plan, qa)).toHaveLength(1)
    expect(approvalsFor({ decisions: [approved], steps: [step('qa', '2026-11-15T10:12:00.000Z')] }, plan, qa)).toEqual([])
    // A newer approval goes once again; a taken-back one never.
    const again = { ...approved, note: 'Option 3b', pick: undefined, at: '2026-11-15T10:20:00.000Z' }
    expect(approvalsFor({ decisions: [approved, again], steps: [step('build', '2026-11-15T10:11:00.000Z')] }, plan, build)).toEqual([{ part: 'Mocks', note: 'Option 3b' }])
    expect(approvalsFor({ decisions: [{ ...approved, undoneAt: '2026-11-15T10:11:00.000Z' }], steps: [] }, plan, build)).toEqual([])
    // The pick alone tells the builder which option, without the instruction to block.
    const body = partBody({ project: project(), organization: 'Acme', plan, part: build, round: 1, inputs: [], approvals: [{ part: 'Mocks', pick: approved.pick }] })
    expect(body).toContain(`- On “Mocks”: picked ${approved.pick}`)
    expect(body).toContain('Their pick comes before the brief')
    expect(body).not.toContain('finish_task blocked and say in unblock')
  })

  it('knows where a gate’s note goes: what reads the part, else the acceptance of a large plan, else nowhere', () => {
    const parts = [
      { id: 'design', title: 'Mocks', owner: 'e-pri1', brief: 'b', reads: [], writes: 'design.md', dependsOn: [], gate: true },
      { id: 'build', title: 'Build', owner: 'e-rav1', brief: 'b', reads: [], writes: 'build.md', dependsOn: ['design'], gate: true }
    ]
    expect(gateNoteTo({ size: 'small', parts }, 'design')).toBe('parts')
    expect(gateNoteTo({ size: 'small', parts }, 'build')).toBe('nobody')
    expect(gateNoteTo({ size: 'large', parts }, 'build')).toBe('acceptance')
    expect(gateNoteTo({ size: 'small', parts: [parts[1], { ...parts[0], id: 'docs', dependsOn: [], reads: ['build'] }] }, 'build')).toBe('parts')
  })

  it('gives the replan and the acceptance the person’s decisions and notes, as data', () => {
    const decisions = [
      { waitKind: 'plan' as const, decision: 'approve' as const, at: '2026-11-15T10:01:00.000Z' },
      { waitKind: 'gate' as const, partId: 'reqs', decision: 'approve' as const, note: 'Keep it short', pick: 'memory/org/projects/csv-export/mocks/reqs/1-b.html', at: '2026-11-15T10:05:00.000Z' },
      { waitKind: 'gate' as const, partId: 'build', decision: 'send-back' as const, note: 'Quote commas', at: '2026-11-15T10:09:00.000Z' }
    ]
    const plan = checked()
    expect(decisionsText({ decisions }, plan)).toBe('- Approved “Requirements”: picked 1-b.html; “Keep it short”\n- Sent back “Build”: “Quote commas”')
    expect(decisionsText({ decisions }, plan, { since: '2026-11-15T10:06:00.000Z' })).toBe('- Sent back “Build”: “Quote commas”')
    const replan = planningBody({ project: project(), organization: 'Acme', repos: [], roster, replan: { reason: 'r', current: '-', version: 2, left: 2 }, decisions: { decisions, plan } })
    expect(replan).toContain('<foreman-data kind="decisions">\n- Approved “Requirements”: picked 1-b.html; “Keep it short”')
    const accept = acceptanceBody({ project: project({ decisions }), organization: 'Acme', plan, inputs: [] })
    expect(accept).toContain('- Sent back “Build”: “Quote commas”')
  })

  it('lets an approval be taken back only while what it started runs, unpublished, and nothing moved on', () => {
    const plan = checked({
      summary: 's',
      size: 'small',
      parts: [
        { id: 'design', title: 'Mocks', owner: 'Priya', brief: 'Draw.', writes: 'design.md', gate_after: true },
        { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build.', writes: 'build.md', depends_on: ['design'] },
        { id: 'docs', title: 'Docs', owner: 'Ravi', brief: 'Docs.', writes: 'docs.md', depends_on: ['design', 'build'] }
      ]
    })
    const at = '2026-11-15T10:10:00.000Z'
    const going = project({
      phase: 'working',
      plan,
      parts: { design: { state: 'done', round: 1, taskId: 't1' }, build: { state: 'running', round: 1, taskId: 't2' }, docs: { state: 'pending', round: 0 } },
      steps: [
        { kind: 'part', partId: 'design', round: 1, taskId: 't1', employeeId: 'e-pri1', state: 'done', startedAt: '2026-11-15T10:00:00.000Z', endedAt: '2026-11-15T10:05:00.000Z' },
        { kind: 'part', partId: 'build', round: 1, taskId: 't2', employeeId: 'e-rav1', state: 'running', startedAt: '2026-11-15T10:10:01.000Z' }
      ],
      decisions: [{ waitKind: 'gate', partId: 'design', decision: 'approve', at }]
    })
    // Docs waits for build too, so it hasn't started: nothing to undo there.
    expect(approvalUndo(going, at)).toEqual({ partId: 'design', parts: ['build'], tasks: ['t2'] })
    expect(approvalUndo(going, '2026-11-15T09:00:00.000Z')).toBeNull()
    // Published (or asked to: a held pull request), finished, replanning, closed, or taken back already: no.
    expect(approvalUndo(going, at, publishedTasks([{ kind: 'pull-request', state: 'held', taskId: 't2' }]))).toBeNull()
    expect(approvalUndo(going, at, publishedTasks([{ kind: 'push', state: 'refused', taskId: 't2' }]))).not.toBeNull()
    expect(approvalUndo({ ...going, parts: { ...going.parts, build: { state: 'gate', round: 1, taskId: 't2' } } }, at)).toBeNull()
    expect(approvalUndo({ ...going, replanning: true }, at)).toBeNull()
    expect(approvalUndo({ ...going, phase: 'closed' }, at)).toBeNull()
    expect(approvalUndo({ ...going, decisions: [{ ...going.decisions[0], undoneAt: '2026-11-15T10:11:00.000Z' }] }, at)).toBeNull()
    // A plan given since (a replan read from the channel) changed what it started.
    expect(approvalUndo({ ...going, plan: { ...going.plan!, at: '2026-11-15T10:12:00.000Z' } }, at)).toBeNull()
  })
})

describe('projects: what the person writes in the channel', () => {
  const note = (text: string, at: string, patch = {}) => ({ text, at, ...patch })

  it('takes the messages since a time, the newest ten, quoted with whom each was to', () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`m${i}`, `2026-11-15T10:${String(i).padStart(2, '0')}:00.000Z`))
    expect(messagesSince(notes).map((n) => n.text)).toEqual(notes.slice(-MAX_MESSAGES).map((n) => n.text))
    expect(messagesSince(notes, '2026-11-15T10:10:00.000Z').map((n) => n.text)).toEqual(['m10', 'm11'])
    expect(messagesSince(undefined)).toEqual([])
    const text = messagesText({ notes: [note('Stop, I never approved this', NOW), note('use b', NOW, { to: 'e-rav1' })], names: { 'e-rav1': 'Ravi' } }, 10)
    expect(text).toBe('- 2026-11-15 10:00 UTC: “Stop, I ne … (cut: 17 characters)”\n- 2026-11-15 10:00 UTC, to Ravi: “use b”')
  })

  it('briefs her message task with the words, the plan, who works and what she may do; and a running turn with the words first', () => {
    const body = messageBody({
      project: { title: 'CSV', requirement: 'Export to CSV', phase: 'working', paused: true },
      organization: 'Acme',
      messages: { notes: [note('Stop, I never approved this layout', NOW)], names: {} },
      plan: { version: 2, summary: 'A button.', state: '- build · Build · Ravi' },
      running: ['Ravi: part “Build”'],
      replan: { can: false, left: 0, why: 'you have replanned 3 times' },
      max: MAX_TASK_BODY
    })
    expect(body).toContain('“Stop, I never approved this layout”')
    expect(body).toContain('(paused: what runs finishes, nothing new starts)')
    expect(body).toContain('The plan in effect (v2): A button.')
    expect(body).toContain('- Ravi: part “Build”')
    expect(body).toContain('The plan can’t be changed from here now (you have replanned 3 times)')
    expect(body).not.toContain('How to plan:')
    expect(messageBody({ project: { title: 'CSV', requirement: 'r', phase: 'working' }, organization: 'Acme', messages: { notes: [note('x'.repeat(30_000), NOW)], names: {} }, running: [], replan: { can: true, left: 2 }, max: MAX_TASK_BODY }).length).toBeLessThanOrEqual(MAX_TASK_BODY)
    const steer = steerText({ project: { title: 'CSV' }, text: 'use option b', part: 'Build' })
    expect(steer.startsWith('The person wrote to you in the channel of the project “CSV” while you work on “Build”, in their words: “use option b”')).toBe(true)
    expect(steer).toContain('finish_task blocked')
    // The program manager isn't told to block for herself: what she is doing takes it in.
    expect(steerText({ project: { title: 'CSV' }, text: 'x', kind: 'plan' })).toContain('Take it into the plan you are making')
    expect(steerText({ project: { title: 'CSV' }, text: 'x', kind: 'accept' })).toContain('decide replan')
    expect(steerText({ project: { title: 'CSV' }, text: 'x', kind: 'message' })).toContain('change it with project_plan')
    for (const kind of ['plan', 'accept', 'message'] as const) expect(steerText({ project: { title: 'CSV' }, text: 'x', kind })).not.toContain('so the program manager replans')
  })
})

describe('projects: who changes the repository, one at a time, and who publishes', () => {
  // Ravi has Write on site; the QA engineer proposed with Write too.
  const W: PlanContext = { ...CTX, writers: ['e-rav1'], repo: 'site' }
  const parts = (out: ReturnType<typeof checkPlan>) => (out.ok ? out.parts.map((p) => [p.id, p.changesRepo, Boolean(p.publishes)]) : out.problems)

  it('takes a Write owner’s part as changing the repository unless it says not, and anyone else’s as only reading it', () => {
    const out = checkPlan({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], publishes: true }, { ...PLAN.parts[2], changes_repo: false }] }, W)
    expect(parts(out)).toEqual([
      ['reqs', false, false],
      ['build', true, true],
      ['qa', false, false]
    ])
    // Without a word on who can write, a part changes the repository only when it says so (or publishes).
    expect(parts(checkPlan({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], publishes: true }, PLAN.parts[2]] }, CTX))).toEqual([
      ['reqs', false, false],
      ['build', true, true],
      ['qa', false, false]
    ])
  })

  it('asks for exactly one publisher when a part changes the repository, after every other part that does', () => {
    const none = checkPlan(PLAN, W)
    expect(none.ok ? [] : none.problems).toContainEqual(expect.stringContaining('“build”, “qa” change the repository, so one part publishes the branch'))
    const two = checkPlan({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], publishes: true }, { ...PLAN.parts[2], publishes: true }] }, W)
    expect(two.ok ? [] : two.problems).toContainEqual(expect.stringContaining('Only one part publishes, and “build”, “qa” all say publishes'))
    // QA changes it too, and doesn't finish before the build publishes.
    const early = checkPlan({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], publishes: true }, PLAN.parts[2]] }, W)
    expect(early.ok ? [] : early.problems).toContainEqual(expect.stringContaining('“build” publishes, so every other part that changes the repository finishes before it: add “qa” to its depends_on'))
    const read = checkPlan({ ...PLAN, parts: [PLAN.parts[0], PLAN.parts[1], { ...PLAN.parts[2], changes_repo: false, publishes: true }] }, W)
    expect(read.ok ? [] : read.problems).toContainEqual(expect.stringContaining('Part “qa” publishes, so it changes the repository'))
    // Her own parts only read it; one with no Write can't change it.
    const mine = checkPlan({ ...PLAN, parts: [{ ...PLAN.parts[0], changes_repo: true }, { ...PLAN.parts[1], publishes: true }, { ...PLAN.parts[2], changes_repo: false }] }, W)
    expect(mine.ok ? [] : mine.problems).toContainEqual('Part “reqs” changes the repository: give it to someone else (your own parts only read it).')
    const reader = checkPlan({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], publishes: true }, PLAN.parts[2]] }, { ...W, writers: [] })
    expect(reader.ok ? [] : reader.problems).toContainEqual(expect.stringContaining('Part “build” changes the repository, but its owner has no Write access to it'))
    // A plan that only reads the repository needs no publisher.
    expect(checkPlan({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], changes_repo: false }, { ...PLAN.parts[2], changes_repo: false }] }, W).ok).toBe(true)
  })

  it('starts one part that changes the repository at a time, the rest beside it, and says what a held one waits for', () => {
    const plan = checked(
      {
        summary: 's',
        size: 'small',
        parts: [
          { id: 'build', title: 'Build', owner: 'e-rav1', brief: 'b', writes: 'build.md' },
          { id: 'i18n', title: 'Translations', owner: 'e-rav1', brief: 't', writes: 'i18n.md', publishes: true, depends_on: ['build'] },
          { id: 'docs', title: 'Docs', owner: 'Priya', brief: 'd', writes: 'docs.md' }
        ]
      },
      W
    )
    expect(readyParts(plan, {}).map((p) => p.id)).toEqual(['build', 'docs'])
    // Two that change it, ready together: the first goes, the second waits for it.
    const loose = { ...plan, parts: plan.parts.map((p) => ({ ...p, dependsOn: [] })) }
    expect(readyParts(loose, {}).map((p) => p.id)).toEqual(['build', 'docs'])
    expect(readyParts(loose, { build: { state: 'running', round: 1 } }).map((p) => p.id)).toEqual(['docs'])
    expect(waitingOnRepo(loose, { build: { state: 'running', round: 1 } }, 'i18n')?.id).toBe('build')
    expect(waitingOnRepo(loose, { build: { state: 'running', round: 1 } }, 'docs')).toBeUndefined()
    expect(readyParts(loose, { build: { state: 'gate', round: 1 }, docs: { state: 'running', round: 1 } }).map((p) => p.id)).toEqual(['i18n'])
    // A plan made before parts said so: each is taken as changing it.
    const old = { parts: plan.parts.map(({ changesRepo: _c, publishes: _p, ...p }) => ({ ...p, dependsOn: [] })) }
    expect(readyParts(old, {}).map((p) => p.id)).toEqual(['build'])
    expect(publisherOf(old)).toBeUndefined()
  })

  it('lets only the publishing part publish, while the project is open, and says who does to the rest', () => {
    const plan = checked({ ...PLAN, parts: [PLAN.parts[0], PLAN.parts[1], { ...PLAN.parts[2], publishes: true }] }, W)
    const open = { phase: 'working' as const, plan }
    expect(publishRule(open, { kind: 'part', partId: 'qa' })).toMatchObject({ may: true })
    expect(publishRule(open, { kind: 'part', partId: 'build' })).toMatchObject({ may: false, publisher: { id: 'qa' } })
    for (const kind of ['follow-up', 'message', 'accept', 'plan'] as const) expect(publishRule(open, { kind, partId: 'qa' })?.may).toBe(false)
    expect(publishRule({ ...open, phase: 'closed' }, { kind: 'part', partId: 'qa' })?.may).toBe(false)
    expect(publishRule({ phase: 'planning' }, { kind: 'plan' })).toEqual({ may: false })
    expect(publishRefusal({ title: 'CSV' }, plan.parts[2])).toContain('only the part “QA” (qa) pushes the branch or opens its pull request')
    expect(publishRefusal({ title: 'CSV' }, undefined)).toContain('has no part that publishes')
  })

  it('tells a part that only reads the repository to leave it alone, and the publisher how to publish', () => {
    const plan = checked({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], depends_on: ['reqs'] }, { ...PLAN.parts[2], changes_repo: false }].map((p) => (p.id === 'build' ? { ...p, publishes: true } : p)) }, W)
    const base = { project: project(), organization: 'Acme', plan, round: 1, inputs: [] }
    expect(partBody({ ...base, part: plan.parts[2], publisher: plan.parts[1] })).toContain('Your part doesn’t change the repository')
    expect(partBody({ ...base, part: plan.parts[2], publisher: plan.parts[1] })).toContain('Don’t push the branch or open a pull request: “Build” (build) publishes the project')
    expect(partBody({ ...base, part: plan.parts[1] })).toContain('You publish the project')
    expect(planMarkdown(project(), plan, {})).toContain('| 2 | Build (`build`) | e-rav1 | — | build.md | reqs | no | changes, publishes |')
  })

  it('lists what was published for the briefs, and refuses the generic Retry once the project went on from a task', () => {
    const at = '2026-11-15T11:00:00.000Z'
    const steps = [{ kind: 'part' as const, partId: 'build', round: 1, taskId: 't-build', employeeId: 'e-rav1', state: 'done' as const, startedAt: NOW }]
    const list = projectPublications(
      [
        { id: 'a', orgId: 'o1', employeeId: 'e-rav1', taskId: 't-build', runId: 'r', repoId: 'site', kind: 'push', payload: { kind: 'push', connection: '', workspaceId: 'w', branch: 'csv', base: 'main', head: 'h', ahead: 1, commits: [] }, policy: 'held', state: 'held', key: 'k1', createdAt: at, updatedAt: at },
        { id: 'b', orgId: 'o1', employeeId: 'e-rav1', taskId: 't-build', runId: 'r', repoId: 'site', kind: 'push', payload: { kind: 'push', connection: '', workspaceId: 'w', branch: 'csv', base: 'main', head: 'h', ahead: 1, commits: [] }, policy: 'held', state: 'skipped', key: 'k2', createdAt: at, updatedAt: at },
        { id: 'c', orgId: 'o1', employeeId: 'e-rav1', taskId: 't-other', runId: 'r', repoId: 'site', kind: 'push', payload: { kind: 'push', connection: '', workspaceId: 'w', branch: 'x', base: 'main', head: 'h', ahead: 1, commits: [] }, policy: 'held', state: 'sent', key: 'k3', createdAt: at, updatedAt: at }
      ],
      { steps }
    )
    expect(list).toEqual([{ kind: 'push', employeeId: 'e-rav1', taskId: 't-build', state: 'held', branch: 'csv', at }])
    expect(publishedLines({ list, names: { 'e-rav1': 'Ravi' } }).join('\n')).toContain('- 2026-11-15 11:00 UTC: Ravi pushed csv: held for the person’s approval (not sent)')
    expect(publishedLines(undefined)).toEqual([])
    const running = { phase: 'working' as const, steps: [{ ...steps[0], state: 'running' as const }] }
    expect(projectTaskRetryable({ id: 't-build', project: { kind: 'part' } }, running)).toBe(true)
    expect(projectTaskRetryable({ id: 't-build', project: { kind: 'part' } }, { phase: 'working', steps })).toBe(false)
    expect(projectTaskRetryable({ id: 't-build', project: { kind: 'part' } }, { ...running, phase: 'closed' })).toBe(false)
    expect(projectTaskRetryable({ id: 't-build', project: { kind: 'part' } }, undefined)).toBe(false)
    expect(projectTaskRetryable({ id: 't-f', project: { kind: 'follow-up' } }, undefined)).toBe(true)
    expect(projectTaskRetryable({ id: 't-plain' }, undefined)).toBe(true)
  })
})
describe('projects: plans, replans and what they keep (slice 4)', () => {
  const W: PlanContext = { ...CTX, employees: [...CTX.employees, { id: 'e-nia1', name: 'Nia', state: 'active' }, { id: 'e-qui1', name: 'Quinn', state: 'active' }], writers: ['e-rav1'], repo: 'site' }
  // Design (gated), Build after it (publishes), QA reading the build (a check).
  const DESIGNED: PlanInput = {
    summary: 'A sidebar, designed and built.',
    size: 'small',
    parts: [
      { id: 'design', title: 'Design', owner: 'Ravi', brief: 'Draw it.', writes: 'design.md', gate_after: true, changes_repo: false },
      { id: 'build', title: 'Build', owner: 'Ravi', brief: 'Build it.', writes: 'build.md', depends_on: ['design'], publishes: true },
      { id: 'qa', title: 'QA', owner: 'Quinn', brief: 'Test it.', writes: 'qa.md', reads: ['build'], changes_repo: false, checks: true }
    ]
  }
  const plan = (input: PlanInput, ctx: PlanContext = W): ProjectPlan => {
    const out = checkPlan(input, ctx)
    if (!out.ok) throw new Error(out.problems.join('\n'))
    return { version: 1, summary: out.summary, size: out.size, parts: out.parts, proposed: out.proposed, proposedIds: {}, taskId: 't', at: NOW, status: 'approved' }
  }

  it('makes a part wait for every part it reads, so a builder that only reads the design starts after its gate (#27)', () => {
    const p = plan({ ...DESIGNED, parts: [DESIGNED.parts[0], { ...DESIGNED.parts[1], depends_on: undefined, reads: ['design'] }, DESIGNED.parts[2]] })
    expect(p.parts.find((x) => x.id === 'build')?.dependsOn).toEqual(['design'])
    expect(readyParts(p, {}).map((x) => x.id)).toEqual(['design'])
    expect(readyParts(p, { design: { state: 'gate', round: 1 } }).map((x) => x.id)).toEqual([])
    // A plan kept from before reads meant waiting: reads hold the part too.
    const old = { parts: p.parts.map((x) => (x.id === 'build' ? { ...x, dependsOn: [] } : x)) }
    expect(readyParts(old, {}).map((x) => x.id)).toEqual(['design'])
  })

  it('holds a replan that hands a part to someone new, stops waiting for a gate, or changes what started (#15)', () => {
    const current = plan(DESIGNED)
    const states = { design: { state: 'running' as const, round: 1 }, build: { state: 'stuck' as const, round: 1 }, qa: { state: 'pending' as const, round: 0 } }
    const next = (parts: PlanInput['parts']) => plan({ ...DESIGNED, parts }, { ...W, current, parts: states })
    // A19: pending QA to Nia, never an owner here: waits. To Ravi, already one: goes ahead.
    expect(replanGoesAhead(current, next(DESIGNED.parts.map((x) => (x.id === 'qa' ? { ...x, owner: 'Nia' } : x))), states)).toBe(false)
    expect(replanGoesAhead(current, next(DESIGNED.parts.map((x) => (x.id === 'qa' ? { ...x, owner: 'Ravi' } : x))), states)).toBe(true)
    // A20: Build no longer waits for the gated design: waits.
    expect(replanGoesAhead(current, next(DESIGNED.parts.map((x) => (x.id === 'build' ? { ...x, depends_on: [] } : x))), states)).toBe(false)
    // A21: a started part's brief changed waits; its file changed is refused.
    expect(replanGoesAhead(current, next(DESIGNED.parts.map((x) => (x.id === 'design' ? { ...x, brief: 'Draw something else.' } : x))), states)).toBe(false)
    const moved = checkPlan({ ...DESIGNED, parts: DESIGNED.parts.map((x) => (x.id === 'design' ? { ...x, writes: 'design-2.md' } : x)) }, { ...W, current, parts: states })
    expect(moved.ok ? [] : moved.problems).toContainEqual(expect.stringContaining('Part “design” has started: it keeps writing design.md'))
    // A pending part's brief may change, every check kept: goes ahead.
    expect(replanGoesAhead(current, next(DESIGNED.parts.map((x) => (x.id === 'qa' ? { ...x, brief: 'Test it on a narrow window too.' } : x))), states)).toBe(true)
  })

  it('lets a part that won’t run again keep a retired owner, and one that must run again change hands (#20)', () => {
    const current = plan(DESIGNED)
    const retired: PlanContext = { ...W, employees: W.employees.map((x) => (x.id === 'e-rav1' ? { ...x, state: 'retired' } : x)), writers: ['e-rav1', 'e-nia1'] }
    const done = { design: { state: 'done' as const, round: 1 }, build: { state: 'done' as const, round: 1 }, qa: { state: 'stuck' as const, round: 1 } }
    // a: the done parts keep Ravi.
    const keep = checkPlan(DESIGNED, { ...retired, current, parts: done })
    expect(keep.ok ? [] : keep.problems).toEqual([])
    // b: a stuck build with a retired owner must change hands, and may.
    const stuck = { ...done, build: { state: 'stuck' as const, round: 1 } }
    const kept = checkPlan(DESIGNED, { ...retired, current, parts: stuck })
    expect(kept.ok ? [] : kept.problems).toContainEqual(expect.stringContaining('Part “build”: Ravi has retired, so the part can’t run again with them'))
    const handed = checkPlan({ ...DESIGNED, parts: DESIGNED.parts.map((x) => (x.id === 'build' ? { ...x, owner: 'Nia' } : x)) }, { ...retired, current, parts: stuck })
    expect(handed.ok ? [] : handed.problems).toEqual([])
    // c: or be taken as it is, with him.
    const asIs = checkPlan({ ...DESIGNED, parts: DESIGNED.parts.map((x) => (x.id === 'build' ? { ...x, accept_as_is: true } : x)) }, { ...retired, current, parts: stuck })
    expect(asIs.ok ? [] : asIs.problems).toEqual([])
    // d: a pending part of his handed to Nia, the done design kept with him.
    const pending = { design: { state: 'done' as const, round: 1 }, build: { state: 'pending' as const, round: 0 }, qa: { state: 'pending' as const, round: 0 } }
    const dropped = checkPlan({ ...DESIGNED, parts: [DESIGNED.parts[0], { ...DESIGNED.parts[1], owner: 'Nia' }, DESIGNED.parts[2]] }, { ...retired, current, parts: pending })
    expect(dropped.ok ? [] : dropped.problems).toEqual([])
    // The replan's brief says who has retired.
    expect(planStateText(current, stuck, { 'e-rav1': 'Ravi' }, new Set(['e-rav1']))).toContain('(owner e-rav1, retired: give the part to someone on the roster if it must run again)')
  })

  it('ends a plan that changes code with the person’s final check, even small, and marks a check pass or fail (#26)', () => {
    const p = plan(DESIGNED)
    expect(p.parts.find((x) => x.id === 'qa')?.checks).toBe(true)
    expect(endsWithFinalCheck(p)).toBe(true)
    const research = plan({ summary: 's', size: 'small', parts: [{ id: 'notes', title: 'Notes', owner: 'Priya', brief: 'Read up.', writes: 'notes.md' }] })
    expect(endsWithFinalCheck(research)).toBe(false)
    const flow = planWorkflow(p, { questions: false })
    expect(flow.steps.map((s) => s.kind)).toContain('final')
    expect(flow.links).toContainEqual({ from: 'final', to: 'end' })
    expect(planWorkflow(research, { questions: false }).steps.map((s) => s.kind)).not.toContain('final')
    const md = planMarkdown(project(), p, { 'e-rav1': 'Ravi', 'e-qui1': 'Quinn' })
    expect(md).toContain('It changes the code, so it ends with the person’s final check once its last part is done.')
    expect(md).toContain('The person’s final check of the result')
    expect(md).toContain('QA (`qa`), passes or fails')
    const body = partBody({ project: project(), organization: 'Acme', plan: p, part: p.parts[2], round: 1, inputs: [] })
    expect(body).toContain('finish_task done with decision pass')
    expect(planningBody({ project: project(), organization: 'Acme', repos: [], roster: [], replan: { reason: 'r', current: '-', version: 2, left: 2 } })).toContain('Mark a part that checks the work (QA, a review) with checks')
  })

  it('tells Priya who can run commands, and says a proposed employee gets Write, a shell and publishing (#25, #30)', () => {
    const can = rosterCan({ repos: { site: 'read', docs: 'none' }, shell: false, attended: true })
    expect(can).toBe('reads site, no access to docs, no shell (runs no commands: no tests, builds or servers), attended (a person answers its approvals)')
    const body = planningBody({ project: project(), organization: 'Acme', repos: ['site'], roster: [{ id: 'e-qui1', name: 'Quinn', role: 'QA', askMeAbout: '', state: 'approved', can }] })
    expect(body).toContain(`- Quinn (id e-qui1): QA; approved; ${can}`)
    expect(body).toContain('Give work that runs commands (tests, builds, a dev server, a check that runs anything) only to an owner the roster says has a shell.')
    // Read asked for is Write given (every new employee writes where it works), unless no agent here runs unattended.
    const out = checkPlan({ ...PLAN, new_employees: [{ ...PLAN.new_employees![0], repos: { site: 'read' } }] }, CTX)
    expect(out.ok && out.proposed[0].repos).toEqual({ site: 'write' })
    const attended = checkPlan({ ...PLAN, new_employees: [{ ...PLAN.new_employees![0], repos: { site: 'write' } }] }, { ...CTX, proposedWrite: false })
    expect(attended.ok && attended.proposed[0].repos).toEqual({ site: 'read' })
    expect(proposedAccess({ repos: { site: 'write' } })).toBe('Write on site, a shell, pushes and opens pull requests without asking')
    expect(planMarkdown(project(), checked(), {})).toContain('- **Quinn**, QA engineer: Tests what is built. (Write on site, a shell, pushes and opens pull requests without asking)')
  })

  it('keeps the chat handed over: each older chat’s first message and the newest whole, or its start and end (#17)', () => {
    expect(handoverTranscript([{ title: 'A', text: 'You: first idea' }, { title: 'B', text: 'You: the plan\nClaude: ok' }])).toBe('Chat “A” (its first message):\nYou: first idea\n\nChat “B” (the newest, whole):\nYou: the plan\nClaude: ok')
    const long = `START ${'x'.repeat(20_000)} END`
    const kept = handoverTranscript([{ title: 'A', text: 'You: first idea' }, { title: 'B', text: long }], 5_000)
    expect(kept.length).toBeLessThanOrEqual(5_000)
    expect(kept).toContain('You: first idea')
    expect(kept).toContain('START')
    expect(kept.endsWith('END')).toBe(true)
    expect(kept).toContain('characters) …')
    // Every planning round reads it: a replan as what was discussed before the hand-over.
    const replan = planningBody({ project: project(), organization: 'Acme', repos: [], roster: [], transcript: 'You: keep the rail', replan: { reason: 'r', current: '-', version: 2, left: 2 } })
    expect(replan).toContain('What the person discussed in the workspace they handed the project from, before handing it over')
    expect(replan).toContain('You: keep the rail')
  })

  it('tells a part how many replans are left, and a rework round to change its own file (#29, #31)', () => {
    const p = plan(DESIGNED)
    const first = partBody({ project: project(), organization: 'Acme', plan: p, part: p.parts[0], round: 1, inputs: [], replansLeft: 2 })
    expect(first).toContain('the program manager replans (2 replans left for the project)')
    expect(partBody({ project: project(), organization: 'Acme', plan: p, part: p.parts[0], round: 1, inputs: [], replansLeft: 0 })).toContain('(none are left, so the project waits for the person)')
    const again = partBody({ project: project(), organization: 'Acme', plan: p, part: p.parts[0], round: 2, inputs: [{ path: 'memory/org/projects/csv-export/design.md' }], rework: true })
    expect(again).toContain('Your own file and mocks, as your last round left them, are among these')
    expect(again).toContain('pass that commit to memory_read')
  })
})
