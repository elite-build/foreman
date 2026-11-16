// @vitest-environment jsdom
// Projects in the window (docs/ai-employees.md §15): the sidebar's Channels row (the organization's channel and one per
// project, with its state); the organization's channel, where "@Priya …" starts a project and "@Ravi …" asks Ravi; a
// project's channel with its plan (the parts, the employees it proposes, Approve plan only once each is approved, Send
// back only with a note), a part waiting at its gate, follow-ups and notes from the message box, and Stop only after you
// confirm; the person's row in the Team list; and Add Priya for an organization without her.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeSummary } from '../src/shared/employees'
import type { Organization } from '../src/shared/organizations'
import type { Project, ProjectPlan } from '../src/shared/projects'
import { ProjectsSection } from '../src/renderer/src/components/employees/ProjectsSection'
import { OrgChannel } from '../src/renderer/src/components/employees/OrgChannel'
import { ProjectPage } from '../src/renderer/src/components/employees/ProjectPage'
import { TeamSection } from '../src/renderer/src/components/employees/TeamSection'
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
  for (const name of ['openEmployees', 'openMemory', 'selectWorkspace', 'toggleProjectsOpen', 'openNewWorkspace']) spy(name).mockReset()
  ;(storeModule.showToast as ReturnType<typeof vi.fn>).mockReset()
  fakeState.space = 'o1'
  fakeState.projectsOpen = true
  fakeApi.memoryReadFile = vi.fn(async (_org: string, path: string) => ({ path, head: 'h1', blob: 'b', size: 10, binary: false, tooLarge: false, text: '## Build\n\nAdded toCsv().' }))
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
  delete fakeState.projectsOpen
  delete fakeState.teamOpen
})

describe('the sidebar’s Channels row', () => {
  it('lists the organization’s channel, then each project with its state, and opens each', async () => {
    const user = userEvent.setup()
    setSnapshot()
    render(<ProjectsSection />)
    expect(screen.getByRole('button', { name: 'Channels · 1 needs you' })).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Channels in FRLK' })
    expect(within(list).getByText('#frlk')).toBeTruthy()
    expect(within(list).getByText('@Priya starts a project')).toBeTruthy()
    expect(within(list).getByText('#csv-export')).toBeTruthy()
    expect(within(list).getByText('Plan')).toBeTruthy()
    await user.click(within(list).getByText('#frlk'))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channel' })
    await user.click(within(list).getByText('#csv-export'))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'project', id: 'p1' })
  })

  it('says how to start one when there are none, and is absent in Personal', () => {
    setSnapshot([])
    const first = render(<ProjectsSection />)
    expect(screen.getByText('No projects yet. Tag @Priya in the organization’s channel to start one.')).toBeTruthy()
    first.unmount()
    fakeState.space = null
    render(<ProjectsSection />)
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
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenCalledWith('p1', 'w1', 'send-back', 'Add a docs part.'))
    // Quinn approved: the plan can be.
    view.unmount()
    setSnapshot(undefined, [PRIYA, RAVI, { ...QUINN, state: 'active' }])
    render(<ProjectPage orgId="o1" project={project()} />)
    await user.click(screen.getByRole('button', { name: /^Approve plan/ }))
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenLastCalledWith('p1', 'w1', 'approve', undefined))
  })

  it('shows a part waiting at its gate with what it wrote, and the parts beside the channel', async () => {
    const user = userEvent.setup()
    const atGate = project({
      phase: 'working',
      plan: { ...PLAN, status: 'approved' },
      plans: [{ ...PLAN, status: 'approved' }],
      parts: { build: { state: 'gate', round: 1, taskId: 't2' }, qa: { state: 'pending', round: 0 } },
      steps: [...project().steps, { kind: 'part', partId: 'build', round: 1, taskId: 't2', employeeId: 'e-rav1', state: 'done', summary: 'Built toCsv().', startedAt: '2026-11-15T10:06:00.000Z', endedAt: '2026-11-15T10:20:00.000Z' }],
      artifacts: { ...project().artifacts, 'build.md': { file: 'build.md', path: 'memory/org/projects/csv-export/build.md', employeeId: 'e-rav1', taskId: 't2', partId: 'build', commit: 'def456def456def', version: 1, at: NOW } },
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
    await user.click(screen.getByRole('button', { name: /^Approve/ }))
    await waitFor(() => expect(fakeApi.decideProject).toHaveBeenCalledWith('p1', 'w2', 'approve', undefined))
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

describe('the person on the team', () => {
  it('lists you first in the Team list, with what waits for you here', () => {
    setSnapshot()
    fakeState.teamOpen = true
    render(<TeamSection />)
    const list = screen.getByRole('list', { name: 'Employees of FRLK' })
    const rows = within(list).getAllByRole('listitem')
    expect(within(rows[0]).getByText('You')).toBeTruthy()
    expect(within(rows[0]).getByText('Needs you · 1')).toBeTruthy()
  })
})
