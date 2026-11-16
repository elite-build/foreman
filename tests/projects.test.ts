// Projects (docs/ai-employees.md §15), the pure part: titles and slugs, @mentions, Foreman's checks on a plan (owners,
// files, dependencies, sizes, proposed employees, what a replan must keep), which replans go ahead on their own, the
// parts that may start, asking before planning (questions, answers, what a plan may assume), the plan's workflow
// and order, plan.md, the words a task carries, the program manager's and a proposed employee's definitions,
// and the memory file a task grants.
import { describe, expect, it } from 'vitest'
import { programManagerDefinition, proposedDefinition } from '../src/shared/employeeTeams'
import { memoryWriteDecision } from '../src/shared/employeeTools'
import { employeeFromObject, parseEmployee, serializeEmployee } from '../src/shared/employees'
import { createT } from '../src/shared/i18n'
import {
  allPartsDone,
  answersProblem,
  artifactPath,
  checkPlan,
  checkQuestions,
  MAX_QUESTION_ROUNDS,
  followUpBody,
  listedProjects,
  mentionOf,
  partBody,
  partsAfter,
  planDiff,
  planMarkdown,
  planningBody,
  planStages,
  planWorkflow,
  projectSlug,
  projectTitle,
  questionState,
  readyParts,
  replanGoesAhead,
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
    expect(followUpBody({ project: project(), question: 'Why?', artifact: { path: 'memory/org/projects/csv-export/build.md' }, part: plan.parts[1] })).toContain('your part “Build”')
  })
})

describe('the program manager and proposed employees', () => {
  const loadouts = [{ agent: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const }]

  it('makes Priya a valid definition that reads every repository, writes none, holds everything outward and runs often', () => {
    const d = programManagerDefinition({ repos: ['site', 'api'], loadouts, taken: [] })
    expect(parseEmployee(serializeEmployee(d), createT('en')).problems).toEqual([])
    expect(employeeFromObject(JSON.parse(JSON.stringify(d))).definition).toBeDefined()
    expect(d).toMatchObject({ name: 'Priya', role: 'Program manager', look: { colour: 'teal' }, attendance: 'unattended' })
    expect(d.access.repos).toEqual({ site: 'read', api: 'read' })
    expect(d.access.profile).toBe('no-shell')
    expect(Object.values(d.access.actions).every((a) => a === 'held')).toBe(true)
    expect(d.limits.runs_per_day).toBe(100)
    expect(d.instructions).toContain('project_plan')
    // Another employee called Priya: she is told apart.
    expect(programManagerDefinition({ repos: [], loadouts, taken: [], takenNames: ['priya'] }).name).toBe('Priya (PM)')
  })

  it('makes a proposed employee a draft at the safest settings, Write only where asked and only unattended', () => {
    const base = { id: 'e-qui1', colour: 'pink', name: 'Quinn', role: 'QA engineer', description: 'Tests.', responsibilities: ['Test'], instructions: 'Test it.', repos: { site: 'write' as const, api: 'read' as const } }
    const d = proposedDefinition({ ...base, loadouts })
    expect(parseEmployee(serializeEmployee(d), createT('en')).problems).toEqual([])
    expect(d.access.repos).toEqual({ site: 'write', api: 'read' })
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
