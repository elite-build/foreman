// @vitest-environment jsdom
// Projects in the window (docs/ai-employees.md §15): the sidebar's Channels row (the organization's channel and one per
// project, with its state); the organization's channel, where "@Priya …" starts a project and "@Ravi …" asks Ravi; a
// project's channel with its plan (drawn as a workflow, what the program manager understood and assumed, the parts, the
// employees it proposes, Approve plan only once each is approved, Send back only with a note), her questions answered
// on one card (or Plan with what you have), a part waiting at its gate, follow-ups and notes from the message box, and
// Stop only after you confirm; who is at work on a project right now (in its channel, beside its state, on its row) or
// that nothing runs; the person's row in the Team list; and Add Priya for an organization without her.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeSummary } from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import type { Project, ProjectPlan } from '../src/shared/projects'
import { EmployeesView } from '../src/renderer/src/components/employees/EmployeesView'
import { ChannelList } from '../src/renderer/src/components/employees/ProjectsSection'
import { OrgChannel } from '../src/renderer/src/components/employees/OrgChannel'
import { ProjectPage } from '../src/renderer/src/components/employees/ProjectPage'
import { TeamList } from '../src/renderer/src/components/employees/TeamSection'
import { AddProgramManager } from '../src/renderer/src/components/employees/TeamRoles'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const original = fakeState.snapshot
const NOW = '2026-11-15T10:00:00.000Z'
const org: Organization = { id: 'o1', name: 'FRLK', memoryRepoId: 'mem', programManagerId: 'e-pri1', leadEmployeeId: 'e-pri1', createdAt: NOW }
const member = (id: string, name: string, colour: string, role: string, state: EmployeeSummary['state'] = 'active'): EmployeeSummary => ({ id, path: `bots/${id}.toml`, name, role, colour, responsibilities: [], problems: [], state, changed: false })
const PRIYA = member('e-pri1', 'Priya', 'teal', 'Program manager')
const RAVI = member('e-rav1', 'Ravi', 'blue', 'Developer')
const QUINN = member('e-qui1', 'Quinn', 'green', 'QA engineer', 'draft')

const PLAN: ProjectPlan = {
  version: 1,
  summary: 'A Download CSV button on the reports page.',
  size: 'large',
  parts: [
    { id: 'build', title: 'Build the export', owner: 'e-rav1', brief: 'Build it.', reads: [], writes: 'build.md', dependsOn: [], gate: true },
    { id: 'qa', title: 'Test it', owner: 'new:qa', brief: 'Test it.', reads: [], writes: 'qa.md', dependsOn: ['build'], gate: false }
  ],
  proposed: [{ key: 'qa', name: 'Quinn', role: 'QA engineer', description: 'Tests what is built.', responsibilities: [], instructions: 'Test.', repos: { site: 'write' } }],
  proposedIds: { qa: 'e-qui1' },
  taskId: 't1',
  at: NOW,
  status: 'waiting'
}

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    orgId: 'o1',
    slug: 'csv-export',
    title: 'Export reports to CSV',
    requirement: 'Export reports to CSV',
    repoId: 'site',
    pmId: 'e-pri1',
    phase: 'plan-gate',
    plans: [PLAN],
    parts: {},
    replans: 0,
    rootTaskId: 't1',
    steps: [{ kind: 'plan', round: 1, taskId: 't1', employeeId: 'e-pri1', state: 'done', summary: 'Two parts; Quinn tests.', startedAt: NOW, endedAt: '2026-11-15T10:05:00.000Z' }],
    artifacts: { 'plan.md': { file: 'plan.md', path: 'memory/org/projects/csv-export/plan.md', employeeId: 'e-pri1', taskId: 't1', commit: 'abc123abc123abc', version: 1, at: NOW } },
    waits: [{ id: 'w1', kind: 'plan', since: NOW }],
    decisions: [],
    notes: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

function setSnapshot(projects: Project[] = [project()], members: EmployeeSummary[] = [PRIYA, RAVI, QUINN], organization: Organization = org) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'frlk-memory', rootPath: 'C:\\code\\frlk-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'site', rootPath: 'C:\\code\\site', defaultBranch: 'main', spaceId: 'o1' }
    ],
    organizations: [organization],
    workspaces: [],
    employees: { o1: { head: 'h1', employees: members } },
    employeeWork: { o1: { tasks: [], runs: [], last: {}, proposals: [], roots: {}, actions: [], decided: [], revision: 1 } },
    projects: { o1: projects }
  }
}

beforeEach(() => {
  resetFake()
  for (const name of ['openEmployees', 'openMemory', 'selectWorkspace', 'openNewWorkspace']) spy(name).mockReset()
  ;(storeModule.showToast as ReturnType<typeof vi.fn>).mockReset()
  fakeState.space = 'o1'
  fakeApi.memoryReadFile = vi.fn(async (_org: string, path: string) => ({ path, head: 'h1', blob: 'b', size: 10, binary: false, tooLarge: false, text: '## Build\n\nAdded toCsv().' }))
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
})

describe('the sidebar’s Channels mode', () => {
  it('lists the organization’s channel, then each project with its state, and opens each', async () => {
    const user = userEvent.setup()
    setSnapshot()
    render(<ChannelList />)
    // The rows say what waits.
    const list = screen.getByRole('list', { name: 'Channels in FRLK' })
    expect(within(list).getByText('#frlk')).toBeTruthy()
    expect(within(list).getByText('@Priya starts a project')).toBeTruthy()
    expect(within(list).getByText('#csv-export')).toBeTruthy()
    // What waits on its line; its state by shape, with the word for screen readers.
    expect(within(list).getByText('Plan')).toBeTruthy()
    expect(within(list).getByText('Needs you').closest('.ui-status')).not.toBeNull()
    await user.click(within(list).getByText('#frlk'))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channel' })
    await user.click(within(list).getByText('#csv-export'))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'project', id: 'p1' })
    await user.click(screen.getByRole('button', { name: 'All channels' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channels' })
  })

  it('says how to start one when there are none, and is absent in Personal', () => {
    setSnapshot([])
    const first = render(<ChannelList />)
    expect(screen.getByText('No projects yet. Tag @Priya in the organization’s channel to start one.')).toBeTruthy()
    first.unmount()
    fakeState.space = null
    render(<ChannelList />)
    expect(screen.queryByRole('list', { name: 'Channels in FRLK' })).toBeNull()
  })
})

describe('the organization’s channel', () => {
  it('starts a project when you tag Priya, asks anyone else, and needs a name first', async () => {
    const user = userEvent.setup()
    setSnapshot([])
    fakeApi.startProject = vi.fn(async () => project({ id: 'p2', title: 'Dark mode' }))
    fakeApi.askEmployee = vi.fn(async () => ({ id: 't9' }))
    render(<OrgChannel orgId="o1" />)
    const box = screen.getByRole('textbox', { name: 'Message #frlk' })
    // A chip puts her name first.
    await user.click(screen.getByRole('button', { name: /@Priya/ }))
    expect((box as HTMLTextAreaElement).value).toBe('@Priya ')
    await user.type(box, 'Dark mode for reports{Enter}')
    await waitFor(() => expect(fakeApi.startProject).toHaveBeenCalledWith('o1', { requirement: 'Dark mode for reports', repoId: 'site' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'project', id: 'p2' })
    await user.type(box, '@ravi how big is the reports table?{Enter}')
    await waitFor(() => expect(fakeApi.askEmployee).toHaveBeenCalledWith('o1', 'e-rav1', { body: 'how big is the reports table?', repoId: 'site' }))
    await user.type(box, 'just thinking aloud{Enter}')
    expect(storeModule.showToast).toHaveBeenLastCalledWith('Start with a name: @Priya starts a project, or @someone asks them.')
    expect((box as HTMLTextAreaElement).value).toBe('just thinking aloud')
    // A small change is still a workspace.
    await user.click(screen.getByRole('button', { name: 'New workspace' }))
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('site')
  })

  it('offers to add Priya to an organization without her', async () => {
    const user = userEvent.setup()
    setSnapshot([], [RAVI], { ...org, programManagerId: undefined })
    fakeApi.addProgramManager = vi.fn(async () => org)
    render(<AddProgramManager orgId="o1" />)
    await user.click(screen.getByRole('button', { name: 'Add Priya' }))
    expect(fakeApi.addProgramManager).toHaveBeenCalledWith('o1')
  })
})

describe('a project’s channel', () => {
  it('shows the plan with its parts and proposed employees, and approves it only once each is approved', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeApi.decideProject = vi.fn(async () => project())
    const view = render(<ProjectPage orgId="o1" project={project()} />)
    const plan = screen.getByRole('region', { name: 'Plan v1' })
    expect(within(plan).getByText('A Download CSV button on the reports page.')).toBeTruthy()
    expect(within(plan).getAllByText('Build the export').length).toBeGreaterThan(0)
    expect(within(plan).getByText('Needs 1 new employee')).toBeTruthy()
    const approve = screen.getByRole('button', { name: /^Approve plan/ }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(screen.getAllByText('Approve Quinn first, on their page: every part needs an approved owner.').length).toBeGreaterThan(0)
    await user.click(within(plan).getByRole('button', { name: 'Review Quinn' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-qui1' })
    // Send back needs a note.
    const back = screen.getByRole('button', { name: /^Send back/ }) as HTMLButtonElement
    expect(back.disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'What should change (for Send back)' }), 'Add a docs part.')
    await user.click(back)
    // Bound to the plan on the card: one changed since is refused.
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenCalledWith('p1', 'w1', 'send-back', 'Add a docs part.', { seen: `1@${NOW}` }))
    // Quinn approved: the plan can be.
    view.unmount()
    setSnapshot(undefined, [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    render(<ProjectPage orgId="o1" project={project()} />)
    await user.click(screen.getByRole('button', { name: /^Approve plan/ }))
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenLastCalledWith('p1', 'w1', 'approve', undefined, { seen: `1@${NOW}` }))
  })

  it('draws the plan as a workflow, in order, with what she understood, done when, out of scope and her assumptions', () => {
    const plan = { ...PLAN, understood: ['Finance exports monthly reports.'], doneWhen: ['A report downloads as CSV.'], outOfScope: ['Excel'], assumptions: [] }
    setSnapshot([project({ plans: [plan] })])
    render(<ProjectPage orgId="o1" project={project({ plans: [plan] })} />)
    const card = screen.getByRole('region', { name: 'Plan v1' })
    const drawn = within(card).getByRole('img', { name: 'Plan v1 as a workflow' })
    for (const step of ['Your request', 'Build the export', 'You check', 'Test it', 'Acceptance', 'Your final check', 'Done']) expect(within(drawn).getAllByText(step).length).toBeGreaterThan(0)
    const order = within(card).getByRole('list', { name: 'In order' })
    expect(within(order).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Build the export (Ravi) then you check Build the export', 'Test it (Quinn)', 'Priya checks the result against your request, then your final check'])
    expect(within(card).getByText('Finance exports monthly reports.')).toBeTruthy()
    expect(within(card).getByText('A report downloads as CSV.')).toBeTruthy()
    expect(within(card).getByText('Excel')).toBeTruthy()
    expect(within(card).getByText('None: every open point was asked.')).toBeTruthy()
  })

  it('asks you her questions on one card: Send answers once each is answered, or let her plan with what is known', async () => {
    const user = userEvent.setup()
    const asks = [{ round: 1, taskId: 't1', understood: ['Enterprise customers log in with company accounts.'], questions: [{ question: 'Which identity providers?', why: 'So I don’t guess Okta only.', options: ['Okta only', 'Any SAML 2.0'] }, { question: 'Does password login stay?', options: [] }], at: NOW }]
    const asking = project({ phase: 'planning', plans: [], asks, steps: [{ kind: 'plan', round: 1, taskId: 't1', employeeId: 'e-pri1', state: 'done', summary: 'Two questions first.', startedAt: NOW, endedAt: NOW }], artifacts: {}, waits: [{ id: 'wq', kind: 'questions', since: NOW }] })
    setSnapshot([asking])
    fakeApi.answerProject = vi.fn(async () => asking)
    render(<ProjectPage orgId="o1" project={asking} />)
    // Her post lists them, with why she asks.
    const post = screen.getByRole('region', { name: 'Questions, round 1' })
    expect(within(post).getByText('So I don’t guess Okta only.')).toBeTruthy()
    expect(within(post).getByText('Enterprise customers log in with company accounts.')).toBeTruthy()
    const send = screen.getByRole('button', { name: /^Send answers/ }) as HTMLButtonElement
    expect(screen.getByText('0 of 2 answered')).toBeTruthy()
    // Every option chosen but the text-only question left empty: Send says which, and goes to it, instead of sitting greyed.
    await user.click(screen.getByRole('radio', { name: 'Any SAML 2.0' }))
    expect(send.disabled).toBe(false)
    await user.click(send)
    expect(fakeApi.answerProject).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Question 2 isn’t answered yet')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Your answer' }))
    await user.keyboard('Yes, for small teams')
    expect(screen.getByText('2 of 2 answered')).toBeTruthy()
    await user.click(send)
    await waitFor(() => expect(fakeApi.answerProject).toHaveBeenCalledWith('p1', 'wq', ['Any SAML 2.0', 'Yes, for small teams'], { seen: `1@${NOW}` }))
    // Plan with what you have sends what was answered too.
    await user.click(screen.getByRole('button', { name: /^Plan with what you have/ }))
    await waitFor(() => expect(fakeApi.answerProject).toHaveBeenLastCalledWith('p1', 'wq', ['Any SAML 2.0', 'Yes, for small teams'], { skip: true, seen: `1@${NOW}` }))
  })

  it('shows a part waiting at its gate with what it wrote, and the parts beside the channel', async () => {
    const user = userEvent.setup()
    const atGate = project({
      phase: 'working',
      plan: { ...PLAN, status: 'approved' },
      plans: [{ ...PLAN, status: 'approved' }],
      parts: { build: { state: 'gate', round: 1, taskId: 't2' }, qa: { state: 'pending', round: 0 } },
      steps: [...project().steps, { kind: 'part', partId: 'build', round: 1, taskId: 't2', employeeId: 'e-rav1', state: 'done', summary: 'Built toCsv().', startedAt: '2026-11-15T10:06:00.000Z', endedAt: '2026-11-15T10:20:00.000Z' }],
      artifacts: {
        ...project().artifacts,
        'build.md': {
          file: 'build.md',
          path: 'memory/org/projects/csv-export/build.md',
          employeeId: 'e-rav1',
          taskId: 't2',
          partId: 'build',
          commit: 'def456def456def',
          version: 1,
          at: NOW,
          mocks: ['memory/org/projects/csv-export/mocks/build/index.html', 'memory/org/projects/csv-export/mocks/build/1-export-a.html']
        }
      },
      waits: [{ id: 'w2', kind: 'gate', partId: 'build', since: NOW }],
      decisions: [{ waitKind: 'plan', decision: 'approve', at: '2026-11-15T10:05:30.000Z' }]
    })
    setSnapshot([atGate], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    fakeApi.decideProject = vi.fn(async () => atGate)
    render(<ProjectPage orgId="o1" project={atGate} />)
    expect(screen.getByText('Ravi started “Build the export”')).toBeTruthy()
    expect(screen.getByText('Approved the plan.')).toBeTruthy()
    expect(screen.getByText('“Build the export” is ready for you to check')).toBeTruthy()
    const side = screen.getByRole('complementary', { name: 'About #csv-export' })
    expect(within(side).getByText('Build the export')).toBeTruthy()
    expect(within(side).getAllByText('Needs you').length).toBe(1)
    expect(within(side).getByText('0 of 3 replans used')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: /build\.md/ })[0])
    await waitFor(() => expect(screen.getAllByText('Added toCsv().').length).toBeGreaterThan(0))
    expect(fakeApi.memoryReadFile).toHaveBeenCalledWith('o1', 'memory/org/projects/csv-export/build.md')
    // Its mocks, beside the file, each open in the browser from the memory repository's folder.
    expect(screen.getAllByText('2 mocks to open in your browser').length).toBeGreaterThan(0)
    await user.click(screen.getAllByRole('button', { name: /1-export-a\.html/ })[0])
    await waitFor(() => expect(fakeApi.openFile).toHaveBeenCalledWith('C:\\code\\frlk-memory\\memory\\org\\projects\\csv-export\\mocks\\build\\1-export-a.html', 'open'))
    await user.click(screen.getByRole('button', { name: /^Approve/ }))
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenCalledWith('p1', 'w2', 'approve', undefined))
  })

  it('gives each page a part made (a mock’s index.html) a button that opens it in the browser', async () => {
    const user = userEvent.setup()
    const mocks = 'memory/bots/e-rav1/mocks/csv-button'
    const made = project({
      phase: 'working',
      plan: { ...PLAN, status: 'approved' },
      plans: [{ ...PLAN, status: 'approved' }],
      parts: { build: { state: 'done', round: 1, taskId: 't2' }, qa: { state: 'pending', round: 0 } },
      steps: [
        ...project().steps,
        {
          kind: 'part',
          partId: 'build',
          round: 1,
          taskId: 't2',
          employeeId: 'e-rav1',
          state: 'done',
          summary: 'Drew two mocks.',
          files: ['memory/org/projects/csv-export/build.md', `${mocks}/index.html`, `${mocks}/1-button.html`, `${mocks}/2-menu.html`],
          startedAt: '2026-11-15T10:06:00.000Z',
          endedAt: '2026-11-15T10:20:00.000Z'
        }
      ],
      waits: []
    })
    setSnapshot([made], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    fakeApi.memoryOpenFile = vi.fn(async () => undefined)
    render(<ProjectPage orgId="o1" project={made} />)
    // The index stands for the pages it links; the Markdown file isn't a page.
    expect(screen.getAllByRole('button', { name: /in your browser$/ }).map((b) => b.textContent)).toEqual(['Open csv-button/index.html in your browser'])
    await user.click(screen.getByRole('button', { name: 'Open csv-button/index.html in your browser' }))
    await waitFor(() => expect(fakeApi.memoryOpenFile).toHaveBeenCalledWith('o1', `${mocks}/index.html`))
  })

  it('makes Send back the main act once a note is written at a gate, with Approve with note beside it, and holds Approve plan while one is written', async () => {
    const user = userEvent.setup()
    const atGate = project({
      phase: 'working',
      plan: { ...PLAN, status: 'approved' },
      plans: [{ ...PLAN, status: 'approved' }],
      parts: { build: { state: 'gate', round: 1, taskId: 't2' }, qa: { state: 'pending', round: 0 } },
      waits: [{ id: 'w2', kind: 'gate', partId: 'build', since: NOW }]
    })
    setSnapshot([atGate], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    fakeApi.decideProject = vi.fn(async () => atGate)
    const view = render(<ProjectPage orgId="o1" project={atGate} />)
    expect(screen.getByText('Approve lets what waits for it start.')).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: /^Your note/ }), 'Use option 2')
    expect(screen.getByText(/^Send back: the same person does this part again, with your note. To let what waits for it start instead, Approve with note/)).toBeTruthy()
    const sendBack = screen.getByRole('button', { name: /^Send back/ })
    expect(sendBack.className).toContain('ui-btn--primary')
    expect(screen.getByRole('button', { name: /^Approve with note/ }).className).not.toContain('ui-btn--primary')
    // Ctrl+Enter in the note sends it back; Enter there is a new line.
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenCalledWith('p1', 'w2', 'send-back', 'Use option 2'))
    await user.type(screen.getByRole('textbox', { name: /^Your note/ }), 'Use option 2')
    await user.click(screen.getByRole('button', { name: /^Approve with note/ }))
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenLastCalledWith('p1', 'w2', 'approve', 'Use option 2'))
    view.unmount()
    // At the plan a note goes only with Send back.
    setSnapshot(undefined, [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    render(<ProjectPage orgId="o1" project={project()} />)
    const approve = screen.getByRole('button', { name: /^Approve plan/ }) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    await user.type(screen.getByRole('textbox', { name: 'What should change (for Send back)' }), 'More mocks first.')
    expect(approve.disabled).toBe(true)
    expect(approve.title).toBe('Your note goes with Send back. Clear it to approve.')
  })

  it('asks a follow-up of a named employee, keeps anything else as a note, and stops only after you confirm', async () => {
    const user = userEvent.setup()
    setSnapshot()
    fakeApi.askProjectFollowUp = vi.fn(async () => ({ id: 't9' }))
    fakeApi.noteProject = vi.fn(async () => project())
    fakeApi.stopProject = vi.fn(async () => project({ phase: 'closed', outcome: 'stopped' }))
    render(<ProjectPage orgId="o1" project={project()} />)
    const box = screen.getByRole('textbox', { name: 'Message #csv-export' })
    await user.type(box, '@Priya why two parts?{Enter}')
    await waitFor(() => expect(fakeApi.askProjectFollowUp).toHaveBeenCalledWith('p1', 'e-pri1', 'why two parts?'))
    expect(storeModule.showToast).toHaveBeenCalledWith('Asked Priya a follow-up.')
    await user.type(box, 'Finance wants it by Friday{Enter}')
    await waitFor(() => expect(fakeApi.noteProject).toHaveBeenCalledWith('p1', 'Finance wants it by Friday'))
    await user.click(screen.getAllByRole('button', { name: 'Stop' })[0])
    expect(fakeApi.stopProject).not.toHaveBeenCalled()
    const confirm = screen.getByRole('alert')
    await user.click(within(confirm).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(fakeApi.stopProject).toHaveBeenCalledWith('p1'))
  })
})

describe('opening a channel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens the organization’s channel and a project’s channel at their newest post and the message box, not the top', () => {
    // The page shows 600px; the messages column ends 1500px down, and the side panel folds under it (as when narrow), so
    // the page's very end is further still.
    const tops = new Map<Element, number>()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const scrolled = tops.get(this.closest('.employees-body')!) ?? 0
      const bottom = this.classList.contains('employees-body') ? 600 : this.classList.contains('channel-main') ? 1500 - scrolled : 0
      return { top: 0, left: 0, right: 0, width: 0, height: bottom, bottom, x: 0, y: 0, toJSON: () => ({}) }
    })
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) {
      tops.set(this, v)
    })
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) {
      return tops.get(this) ?? 0
    })
    fakeApi.listEmployees = vi.fn(async () => ({ employees: [] }))
    setSnapshot()
    const view = render(<EmployeesView route={{ orgId: 'o1', page: 'channel' }} />)
    const body = document.querySelector('.employees-body')!
    expect(tops.get(body)).toBe(900)
    // Back at the top, then to a project's channel: it opens at its end too.
    tops.set(body, 0)
    view.rerender(<EmployeesView route={{ orgId: 'o1', page: 'project', id: 'p1' }} />)
    expect(tops.get(body)).toBe(900)
    // The Team page stays where it is.
    tops.set(body, 0)
    view.rerender(<EmployeesView route={{ orgId: 'o1', page: 'team' }} />)
    expect(tops.get(body)).toBe(0)
  })
})

describe('the sidebar’s Team mode', () => {
  // What waits for the person here (the plan) is in the sidebar's Inbox and its channel, not a "You" row.
  it('lists the employees alone, one row each', () => {
    setSnapshot()
    render(<TeamList />)
    const list = screen.getByRole('list', { name: 'Employees of FRLK' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).queryByText('You')).toBeNull()
  })
})

describe('who is at work on a project now', () => {
  const working = (steps: Project['steps'] = [{ kind: 'part', partId: 'build', round: 1, taskId: 't2', employeeId: 'e-rav1', state: 'running', startedAt: '2026-11-15T10:06:00.000Z' }]) =>
    project({ phase: 'working', plan: { ...PLAN, status: 'approved' }, plans: [{ ...PLAN, status: 'approved' }], parts: { build: { state: 'running', round: 1, taskId: 't2' }, qa: { state: 'pending', round: 0 } }, steps: [...project().steps, ...steps], waits: [] })
  const run = (patch: Record<string, unknown>) => ({ id: 'r2', taskId: 't2', employeeId: 'e-rav1', orgId: 'o1', attempt: 1, started: true, turnIds: [], createdAt: NOW, updatedAt: NOW, ...patch })
  const withRuns = (runs: Record<string, unknown>[], workspaces: { id: string }[] = []) => {
    const snapshot = fakeState.snapshot!
    fakeState.snapshot = { ...snapshot, workspaces: workspaces as never, employeeWork: { o1: { ...snapshot.employeeWork!.o1, runs: runs as never } } }
  }

  it('shows who works on what, for how long, with a link to their chat, in the channel, beside its state and on the part', async () => {
    const user = userEvent.setup()
    spy('selectSession').mockReset()
    const p = working()
    setSnapshot([p], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    withRuns([run({ state: 'running', startedAt: '2026-11-15T10:06:00.000Z', workspaceId: 'w1', sessionId: 's1' })], [{ id: 'w1' }])
    render(<ProjectPage orgId="o1" project={p} />)
    const timeline = screen.getByRole('list', { name: /csv-export/ })
    expect(within(timeline).getByText('Ravi is working on “Build the export”')).toBeTruthy()
    expect(screen.getByText('Ravi working').closest('.ui-status')!.className).toContain('ui-status--busy')
    const side = screen.getByRole('complementary', { name: 'About #csv-export' })
    expect(within(side).getByText('Working').closest('.ui-status')!.className).toContain('ui-status--busy')
    await user.click(screen.getByRole('button', { name: 'Watch Ravi' }))
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('w1')
    expect(spy('selectSession')).toHaveBeenCalledWith('w1', 's1')
  })

  it('says a run is queued and why, and says Nothing running when the stage is working but no run is', () => {
    const p = working()
    setSnapshot([p], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    withRuns([run({ state: 'queued', started: false, reason: 'Waits for Ravi’s other task' })])
    const { unmount } = render(<ProjectPage orgId="o1" project={p} />)
    expect(screen.getByText('Waits for Ravi’s other task')).toBeTruthy()
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0)
    // No chat yet, so nothing to watch.
    expect(screen.queryByRole('button', { name: 'Watch Ravi' })).toBeNull()
    unmount()
    withRuns([])
    render(<ProjectPage orgId="o1" project={p} />)
    expect(screen.getByText('Nothing running')).toBeTruthy()
    expect(screen.queryByText(/is working on/)).toBeNull()
  })

  it('says nothing about running while the project waits for you', () => {
    setSnapshot()
    render(<ProjectPage orgId="o1" project={project()} />)
    expect(screen.queryByText('Nothing running')).toBeNull()
  })

  it('marks the channel’s row in the sidebar with who is at it', () => {
    const p = working()
    setSnapshot([p], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    withRuns([run({ state: 'running', startedAt: NOW })])
    render(<ChannelList />)
    const list = screen.getByRole('list', { name: 'Channels in FRLK' })
    expect(within(list).getByText('Ravi is working on “Build the export”')).toBeTruthy()
    expect(within(list).getByText('Working').closest('.ui-status')!.className).toContain('ui-status--busy')
  })
})

describe('a project’s channel: what you type and decide is kept, bound and undoable', () => {
  const asks = [{ round: 1, taskId: 't1', understood: [], questions: [{ question: 'Which identity providers?', options: ['Okta only', 'Any SAML 2.0'] }, { question: 'Does password login stay?', options: [] }], at: NOW }]
  const asking = () => project({ phase: 'planning', plans: [], asks, steps: [{ kind: 'plan', round: 1, taskId: 't1', employeeId: 'e-pri1', state: 'done', startedAt: NOW, endedAt: NOW }], artifacts: {}, waits: [{ id: 'wq', kind: 'questions', since: NOW }] })
  const mocks = ['index.html', '1-export-a.html', '1-export-b.html'].map((f) => `memory/org/projects/csv-export/mocks/build/${f}`)
  const atGate = (patch: Partial<Project> = {}) =>
    project({
      phase: 'working',
      plan: { ...PLAN, status: 'approved' },
      plans: [{ ...PLAN, status: 'approved' }],
      parts: { build: { state: 'gate', round: 1, taskId: 't2' }, qa: { state: 'pending', round: 0 } },
      artifacts: { 'build.md': { file: 'build.md', path: 'memory/org/projects/csv-export/build.md', employeeId: 'e-rav1', taskId: 't2', partId: 'build', version: 1, at: NOW, mocks } },
      waits: [{ id: 'w2', kind: 'gate', partId: 'build', since: NOW }],
      ...patch
    })

  it('sends on Ctrl+Enter in an answer box, never skips with it, and never stops on Esc: Stop on a card asks first', async () => {
    const user = userEvent.setup()
    setSnapshot([asking()])
    fakeApi.answerProject = vi.fn(async () => asking())
    fakeApi.stopProject = vi.fn(async () => asking())
    render(<ProjectPage orgId="o1" project={asking()} />)
    await user.click(screen.getByRole('radio', { name: 'Any SAML 2.0' }))
    // One unanswered: Ctrl+Enter goes to it and says so, instead of planning without it.
    await user.click(screen.getByRole('textbox', { name: 'Your answer' }))
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(fakeApi.answerProject).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Question 2 isn’t answered yet')
    await user.keyboard('Yes{Control>}{Enter}{/Control}')
    await waitFor(() => expect(fakeApi.answerProject).toHaveBeenCalledWith('p1', 'wq', ['Any SAML 2.0', 'Yes'], { seen: `1@${NOW}` }))
    expect(screen.getByRole('button', { name: /^Plan with what you have/ }).querySelector('kbd')).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alert')).toBeNull()
    const card = screen.getByRole('group', { name: 'Priya asks 2 questions before planning' })
    expect(within(card).getByRole('button', { name: 'Stop' }).querySelector('kbd')).toBeNull()
    await user.click(within(card).getByRole('button', { name: 'Stop' }))
    expect(fakeApi.stopProject).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(fakeApi.stopProject).toHaveBeenCalledWith('p1'))
  })

  it('keeps typed answers and a gate’s note when you leave the channel and come back, until the wait is gone', async () => {
    const user = userEvent.setup()
    setSnapshot([asking()])
    let view = render(<ProjectPage orgId="o1" project={asking()} />)
    await user.click(screen.getByRole('radio', { name: 'Okta only' }))
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'For small teams')
    view.unmount()
    view = render(<ProjectPage orgId="o1" project={asking()} />)
    expect((screen.getByRole('radio', { name: 'Okta only' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).value).toBe('For small teams')
    expect(screen.getByText('2 of 2 answered')).toBeTruthy()
    view.unmount()
    setSnapshot([atGate()], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    view = render(<ProjectPage orgId="o1" project={atGate()} />)
    await user.type(screen.getByRole('textbox', { name: /^Your note/ }), 'Tighter spacing')
    view.unmount()
    view = render(<ProjectPage orgId="o1" project={atGate()} />)
    expect((screen.getByRole('textbox', { name: /^Your note/ }) as HTMLTextAreaElement).value).toBe('Tighter spacing')
    // Decided elsewhere: the wait is gone, and its note with it.
    view.rerender(<ProjectPage orgId="o1" project={atGate({ waits: [] })} />)
    view.unmount()
    render(<ProjectPage orgId="o1" project={atGate()} />)
    expect((screen.getByRole('textbox', { name: /^Your note/ }) as HTMLTextAreaElement).value).toBe('')
  })

  it('offers a pick among a gate’s mocks, sent with Approve, and holds Approve with note where nothing would read it', async () => {
    const user = userEvent.setup()
    setSnapshot([atGate()], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    fakeApi.decideProject = vi.fn(async () => atGate())
    const view = render(<ProjectPage orgId="o1" project={atGate()} />)
    const picks = screen.getByRole('group', { name: /^The mock to build on/ })
    expect(within(picks).getAllByRole('radio')).toHaveLength(3)
    await user.click(within(picks).getByRole('radio', { name: '1-export-b.html' }))
    await user.click(screen.getByRole('button', { name: /^Approve/ }))
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenCalledWith('p1', 'w2', 'approve', undefined, { pick: mocks[2] }))
    view.unmount()
    // A small plan whose gated part nothing reads: a note goes only with Send back.
    const last = atGate({ plan: { ...PLAN, size: 'small', status: 'approved', parts: [PLAN.parts[0]] }, plans: [{ ...PLAN, size: 'small', status: 'approved', parts: [PLAN.parts[0]] }], waits: [{ id: 'w3', kind: 'gate', partId: 'build', since: NOW }] })
    setSnapshot([last], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    render(<ProjectPage orgId="o1" project={last} />)
    expect(screen.queryByRole('group', { name: /^The mock to build on/ })).toBeNull()
    await user.type(screen.getByRole('textbox', { name: /^Your note/ }), 'Fix the 2px gap')
    expect(screen.getByText(/Nothing starts after this part, so a note can’t go with Approve/)).toBeTruthy()
    expect((screen.getByRole('button', { name: /^Approve with note/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers Undo approval under a gate’s approval only while main says it can be taken back', async () => {
    const user = userEvent.setup()
    const at = '2026-11-15T10:21:00.000Z'
    const going = (qa: Project['parts'][string], state: 'running' | 'done' = 'running') =>
      project({
        phase: 'working',
        plan: { ...PLAN, status: 'approved' },
        plans: [{ ...PLAN, status: 'approved' }],
        parts: { build: { state: 'done', round: 1, taskId: 't2' }, qa },
        steps: [...project().steps, { kind: 'part', partId: 'qa', round: 1, taskId: 't3', employeeId: 'e-qui1', state, startedAt: '2026-11-15T10:22:00.000Z', ...(state === 'done' ? { endedAt: '2026-11-15T10:30:00.000Z' } : {}) }],
        waits: [],
        decisions: [{ waitKind: 'gate', partId: 'build', decision: 'approve', at }],
        ...(state === 'running' ? { undoable: [at] } : {})
      })
    const p = going({ state: 'running', round: 1, taskId: 't3' })
    setSnapshot([p], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    fakeApi.undoProjectDecision = vi.fn(async () => p)
    const view = render(<ProjectPage orgId="o1" project={p} />)
    await user.click(screen.getByRole('button', { name: 'Undo approval' }))
    await waitFor(() => expect(fakeApi.undoProjectDecision).toHaveBeenCalledWith('p1', at))
    expect(storeModule.showToast).toHaveBeenCalledWith('Took back the approval of “Build the export”: it waits for you again.')
    view.unmount()
    render(<ProjectPage orgId="o1" project={going({ state: 'done', round: 1, taskId: 't3' }, 'done')} />)
    expect(screen.queryByRole('button', { name: 'Undo approval' })).toBeNull()
    cleanup()
    // Still running, but main found a push of it (one the window's lists don't carry): no button either.
    render(<ProjectPage orgId="o1" project={{ ...p, undoable: undefined }} />)
    expect(screen.queryByRole('button', { name: 'Undo approval' })).toBeNull()
  })

  it('shows a part that asked for a replan as that, not Stuck, in the parts beside the channel', () => {
    const asked = project({
      phase: 'working',
      replanning: true,
      plan: { ...PLAN, status: 'approved' },
      plans: [{ ...PLAN, status: 'approved' }],
      parts: { build: { state: 'stuck', round: 1, taskId: 't2', askedReplan: true }, qa: { state: 'pending', round: 0 } },
      waits: []
    })
    setSnapshot([asked], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    render(<ProjectPage orgId="o1" project={asked} />)
    const side = screen.getByRole('complementary', { name: 'About #csv-export' })
    expect(within(side).getByText('Asked for a replan').closest('.ui-status')!.className).toContain('ui-status--warn')
    expect(within(side).queryByText('Stuck')).toBeNull()
  })

  it('says in Foreman’s words that you let her plan with what she has, and tells a stop, a replan and a cut result apart', async () => {
    const user = userEvent.setup()
    const told = project({
      phase: 'closed',
      outcome: 'stopped',
      closedAt: '2026-11-15T11:00:00.000Z',
      asks: [{ ...asks[0], skipped: true, answers: ['Okta only', ''], answeredAt: '2026-11-15T10:01:00.000Z' }],
      steps: [
        ...project().steps,
        { kind: 'part', partId: 'build', round: 1, taskId: 't2', employeeId: 'e-rav1', state: 'stuck', end: 'replan', reason: 'The person asked for more mocks', startedAt: '2026-11-15T10:06:00.000Z', endedAt: '2026-11-15T10:08:00.000Z' },
        { kind: 'part', partId: 'build', round: 2, taskId: 't3', employeeId: 'e-rav1', state: 'stuck', end: 'stopped', reason: 'Stopped by the person.', startedAt: '2026-11-15T10:09:00.000Z', endedAt: '2026-11-15T11:00:00.000Z' },
        { kind: 'part', partId: 'qa', round: 1, taskId: 't4', employeeId: 'e-qui1', state: 'done', summary: 'Start of a long result', summaryCut: 1234, startedAt: '2026-11-15T10:09:00.000Z', endedAt: '2026-11-15T10:50:00.000Z' }
      ],
      waits: []
    })
    setSnapshot([told], [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    fakeApi.employeeTaskChain = vi.fn(async () => ({ task: { id: 't4', result: { summary: 'Start of a long result, and its whole end.' } }, children: [], transitions: [] }))
    render(<ProjectPage orgId="o1" project={told} />)
    expect(screen.getByText('You asked Priya to plan with what is known (1 of 2 answered).')).toBeTruthy()
    expect(screen.queryByText(/Plan with what you have, Priya/)).toBeNull()
    expect(screen.getByText('Okta only')).toBeTruthy()
    expect(screen.getByText('Asked for a replan').closest('.ui-status')!.className).toContain('ui-status--warn')
    expect(screen.getAllByText('Stopped').some((el) => el.closest('.ui-status--off'))).toBe(true)
    expect(screen.queryByText('Stuck')).toBeNull()
    expect(screen.getByText('Cut here: the full result has 1,234 more characters.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show full result' }))
    await waitFor(() => expect(screen.getByText('Start of a long result, and its whole end.')).toBeTruthy())
    expect(fakeApi.employeeTaskChain).toHaveBeenCalledWith('t4')
  })

  it('says where a stopped project’s work is: its archived workspace, what it keeps, and Restore', async () => {
    const user = userEvent.setup()
    const stopped = project({ phase: 'closed', outcome: 'stopped', closedAt: '2026-11-15T11:00:00.000Z', workspaceId: 'ws-1', waits: [] })
    setSnapshot([stopped])
    fakeState.snapshot = { ...fakeState.snapshot, workspaces: [{ id: 'ws-1', name: 'edmund-berkeley', state: 'archived', archivedAt: NOW, archiveDiff: { at: NOW, files: 15, additions: 300, deletions: 20 } }] }
    fakeApi.archivedWork = vi.fn(async () => [{ id: 'ws-1', branch: 'priya/sidebar', deletesBranch: true, unpushed: 0, uncommitted: true }])
    render(<ProjectPage orgId="o1" project={stopped} />)
    expect(screen.getAllByText('Archived as “edmund-berkeley”.')).toHaveLength(2)
    await waitFor(() => expect(screen.getAllByText('Every commit on its branch priya/sidebar is pushed or on its base.')).toHaveLength(2))
    expect(screen.getAllByText('Its changed files are kept with the archive: Restore puts them back.').length).toBeGreaterThan(0)
    expect(screen.queryByText('Archived; its branch stays.')).toBeNull()
    await user.click(screen.getAllByRole('button', { name: 'Restore workspace' })[0])
    expect(spy('restoreArchived')).toHaveBeenCalledWith('ws-1')
    // The branch's words follow what git says: commits only here, a branch archiving keeps, or nothing known.
    for (const [work, words] of [
      [{ deletesBranch: true, unpushed: 3 }, 'Its branch priya/sidebar has 3 commits that aren’t pushed.'],
      [{ deletesBranch: false, unpushed: 0 }, 'Its branch priya/sidebar stays as it is.'],
      [{ deletesBranch: true, unpushed: null }, 'Foreman can’t tell which commits on its branch priya/sidebar are only here.']
    ] as const) {
      cleanup()
      fakeApi.archivedWork = vi.fn(async () => [{ id: 'ws-1', branch: 'priya/sidebar', uncommitted: false, ...work }])
      render(<ProjectPage orgId="o1" project={stopped} />)
      await waitFor(() => expect(screen.getAllByText(words)).toHaveLength(2))
    }
  })

  it('asks a name with spaces, asks a planned owner before their part, and asks what to ask for a bare name', async () => {
    const user = userEvent.setup()
    const uma = member('e-uma1', 'Uma Rao', 'pink', 'Designer')
    const planned = { ...PLAN, parts: [...PLAN.parts, { id: 'design', title: 'Design', owner: 'e-uma1', brief: 'Draw.', reads: [], writes: 'design.md', dependsOn: [], gate: true }] }
    const p = project({ plans: [planned] })
    setSnapshot([p], [PRIYA, RAVI, { ...QUINN, state: 'active' }, uma])
    fakeApi.askProjectFollowUp = vi.fn(async () => ({ id: 't9' }))
    fakeApi.noteProject = vi.fn(async () => p)
    render(<ProjectPage orgId="o1" project={p} />)
    const chips = screen.getByRole('group', { name: 'Put a name first' })
    expect(within(chips).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['@Priya', '@Ravi', '@Quinn', '@Uma Rao'])
    const box = screen.getByRole('textbox', { name: 'Message #csv-export' })
    await user.type(box, '@Uma Rao make the rail narrower{Enter}')
    await waitFor(() => expect(fakeApi.askProjectFollowUp).toHaveBeenCalledWith('p1', 'e-uma1', 'make the rail narrower'))
    await user.type(box, '@Quinn will you test keyboard nav?{Enter}')
    await waitFor(() => expect(fakeApi.askProjectFollowUp).toHaveBeenLastCalledWith('p1', 'e-qui1', 'will you test keyboard nav?'))
    await user.type(box, '@Ravi{Enter}')
    expect(storeModule.showToast).toHaveBeenLastCalledWith('Say what to ask Ravi, after their name.')
    expect(fakeApi.noteProject).not.toHaveBeenCalled()
    expect((box as HTMLTextAreaElement).value).toBe('@Ravi')
    // A chip replaces the whole name before it, spaces and all.
    await user.clear(box)
    await user.type(box, '@Uma Rao tidy it')
    await user.click(within(chips).getByRole('button', { name: /@Ravi/ }))
    expect((box as HTMLTextAreaElement).value).toBe('@Ravi tidy it')
  })
})
