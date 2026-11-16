// @vitest-environment jsdom
// A project's plan as a map (docs/ai-employees.md §15): the plan card's Table | Map, kept on this computer; the map's
// parts with their owner, file and state in words, proposed owners and the parts you check said in the name, what a
// replan changed marked New, Changed and Taken out; a selected part's brief with Review for a proposed owner; the
// table's State column once the plan is in effect; the side column's List | Map, whose parts take the channel to their
// newest post; and the Team page's map of hand-offs outside projects, open while something in it waits for you.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeSummary } from '../src/shared/employees'
import type { EmployeeAction } from '../src/shared/employeeActions'
import type { EmployeeTask } from '../src/shared/employeeWork'
import type { Organization } from '../src/shared/organizations'
import type { Project, ProjectPlan } from '../src/shared/projects'
import { ProjectPage } from '../src/renderer/src/components/employees/ProjectPage'
import { HandOffs } from '../src/renderer/src/components/employees/HandOffMap'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const original = fakeState.snapshot
const NOW = '2026-11-16T10:00:00.000Z'
const LATER = '2026-11-16T10:30:00.000Z'
const org: Organization = { id: 'o1', name: 'Acme', memoryRepoId: 'mem', programManagerId: 'e-pri1', leadEmployeeId: 'e-pri1', createdAt: NOW }
const member = (id: string, name: string, colour: string, role: string, state: EmployeeSummary['state'] = 'active'): EmployeeSummary => ({ id, path: `bots/${id}.toml`, name, role, colour, responsibilities: [], problems: [], state, changed: false })
const PRIYA = member('e-pri1', 'Priya', 'teal', 'Program manager')
const ADA = member('e-ada1', 'Ada', 'pink', 'Researcher')
const MAX = member('e-max1', 'Max', 'orange', 'Writer')
const RAVI = member('e-rav1', 'Ravi', 'blue', 'Software engineer', 'draft')

const PLAN: ProjectPlan = {
  version: 1,
  summary: 'Find the providers, plan the change, build it, then the help page.',
  size: 'large',
  parts: [
    { id: 'providers', title: 'Which sign-in providers customers ask for', owner: 'e-ada1', brief: 'Read the support tickets.', reads: [], writes: 'research.md', dependsOn: [], gate: false },
    { id: 'tech-plan', title: 'How sign-in changes in Atlas', owner: 'new:eng', brief: 'Read research.md and the sign-in code; write how SAML would fit.', reads: [], writes: 'tech-plan.md', dependsOn: ['providers'], gate: true },
    { id: 'help', title: 'Help page: set up single sign-on', owner: 'e-max1', brief: 'Write the help page.', reads: [], writes: 'help-page.md', dependsOn: ['tech-plan'], gate: false }
  ],
  proposed: [{ key: 'eng', name: 'Ravi', role: 'Software engineer', description: 'Builds features.', responsibilities: [], instructions: 'Build.', repos: { site: 'write' } }],
  proposedIds: { eng: 'e-rav1' },
  taskId: 't-plan',
  at: NOW,
  status: 'waiting'
}

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    orgId: 'o1',
    slug: 'team-accounts-sso',
    title: 'Single sign-on for team accounts',
    requirement: 'Single sign-on for team accounts',
    repoId: 'site',
    pmId: 'e-pri1',
    phase: 'plan-gate',
    plans: [PLAN],
    parts: {},
    replans: 0,
    rootTaskId: 't-plan',
    steps: [{ kind: 'plan', round: 1, taskId: 't-plan', employeeId: 'e-pri1', state: 'done', summary: 'Plan v1 is ready.', startedAt: NOW, endedAt: NOW }],
    artifacts: {},
    waits: [{ id: 'w1', kind: 'plan', since: NOW }],
    decisions: [],
    notes: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

/** The plan approved, Ada's part done, Ravi (now approved) working on his. */
function running(): Project {
  const plan: ProjectPlan = { ...PLAN, status: 'approved' }
  return project({
    phase: 'working',
    plan,
    plans: [plan],
    waits: [],
    parts: { providers: { state: 'done', round: 1, taskId: 't-a' }, 'tech-plan': { state: 'running', round: 1, taskId: 't-r' }, help: { state: 'pending', round: 0 } },
    steps: [
      { kind: 'plan', round: 1, taskId: 't-plan', employeeId: 'e-pri1', state: 'done', summary: 'Plan v1 is ready.', startedAt: NOW, endedAt: NOW },
      { kind: 'part', partId: 'providers', round: 1, taskId: 't-a', employeeId: 'e-ada1', state: 'done', summary: 'Okta, Google Workspace and Entra.', startedAt: NOW, endedAt: LATER },
      { kind: 'part', partId: 'tech-plan', round: 1, taskId: 't-r', employeeId: 'e-rav1', state: 'running', startedAt: LATER }
    ]
  })
}

const task = (id: string, employeeId: string, title: string, patch: Partial<EmployeeTask> = {}): EmployeeTask => ({
  id,
  orgId: 'o1',
  employeeId,
  requestId: id,
  rootId: 'launch',
  parentId: null,
  title,
  body: title,
  from: 'person',
  targetRepoId: 'site',
  state: 'closed',
  closureReason: 'done',
  createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 41 * 60_000).toISOString(),
  ...patch
})

const PUSH: EmployeeAction = {
  id: 'act-push',
  orgId: 'o1',
  employeeId: 'e-max1',
  taskId: 'launch',
  runId: 'run-max-2',
  repoId: 'site',
  kind: 'push',
  payload: { kind: 'push', connection: 'gh', workspaceId: 'w1', branch: 'max/launch-2.4', base: 'main', head: 'abc', ahead: 1, commits: [{ sha: 'abc1234', subject: 'Work on max/launch-2.4' }], repo: 'site', remote: 'origin', remoteUrl: 'github.com/acme/site', diffStat: { files: 1, insertions: 6, deletions: 0 }, files: [{ path: 'blog/launch.md', insertions: 6, deletions: 0 }] },
  policy: 'held',
  state: 'held',
  key: 'k1',
  createdAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 42 * 60_000).toISOString()
} as EmployeeAction

function setSnapshot(members: EmployeeSummary[] = [PRIYA, ADA, MAX, RAVI], actions: EmployeeAction[] = []) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'acme-memory', rootPath: 'C:\\code\\acme-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'site', rootPath: 'C:\\code\\site', defaultBranch: 'main', spaceId: 'o1' }
    ],
    organizations: [org],
    workspaces: [],
    employees: { o1: { head: 'h1', employees: members } },
    employeeWork: { o1: { tasks: [], runs: [], last: {}, proposals: [], roots: { launch: { rootId: 'launch', orgId: 'o1', runsUsed: 3, runsAllowed: 20, descendants: 1, active: 0, state: 'closed', createdAt: NOW, updatedAt: NOW } }, actions, decided: [], revision: 1 } },
    projects: { o1: [] }
  }
}

beforeEach(() => {
  resetFake()
  localStorage.clear()
  spy('openEmployees').mockReset()
  setSnapshot()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('the plan card', () => {
  it('shows the table first, then the plan drawn as a map, and keeps the choice on this computer', async () => {
    const user = userEvent.setup()
    const first = render(<ProjectPage orgId="o1" project={project()} />)
    const card = screen.getByRole('region', { name: 'Plan v1' })
    expect(within(card).getByRole('table')).toBeTruthy()
    await user.click(within(card).getByRole('radio', { name: 'Map' }))
    expect(within(card).queryByRole('table')).toBeNull()
    const map = within(card).getByRole('group', { name: 'Plan v1 as a map' })
    // Each part names its file, its owner, whether they are only proposed, whether you check it, what it waits for and its state.
    expect(within(map).getByRole('button', { name: 'How sign-in changes in Atlas, tech-plan.md, Ravi, proposed, you check, After: Which sign-in providers customers ask for, Waiting' })).toBeTruthy()
    expect(within(map).getByRole('button', { name: 'Which sign-in providers customers ask for, research.md, Ada, Waiting' })).toBeTruthy()
    expect(within(card).getByText('3 parts')).toBeTruthy()
    expect(within(card).getByText('1 owner to approve')).toBeTruthy()
    expect(localStorage.getItem('foreman.projects.planView')).toBe('map')
    first.unmount()
    render(<ProjectPage orgId="o1" project={project()} />)
    expect(within(screen.getByRole('region', { name: 'Plan v1' })).getByRole('group', { name: 'Plan v1 as a map' })).toBeTruthy()
  })

  it('opens a selected part’s brief, with Review for an owner still to approve', async () => {
    const user = userEvent.setup()
    localStorage.setItem('foreman.projects.planView', 'map')
    render(<ProjectPage orgId="o1" project={project()} />)
    const map = screen.getByRole('group', { name: 'Plan v1 as a map' })
    await user.click(within(map).getByRole('button', { name: /^How sign-in changes in Atlas/ }))
    const brief = screen.getByRole('region', { name: 'What “How sign-in changes in Atlas” is asked to do' })
    expect(within(brief).getByText('Read research.md and the sign-in code; write how SAML would fit.')).toBeTruthy()
    expect(within(brief).getByText('Reads research.md · writes tech-plan.md · you check it before “Help page: set up single sign-on” starts')).toBeTruthy()
    await user.click(within(brief).getByRole('button', { name: 'Review Ravi' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-rav1' })
    // An approved owner's part has nothing to review.
    await user.click(within(map).getByRole('button', { name: /^Which sign-in providers/ }))
    expect(screen.queryByRole('button', { name: 'Review Ada' })).toBeNull()
  })

  it('says where each part is once the plan is in effect, in the table and on the map', async () => {
    const user = userEvent.setup()
    setSnapshot([PRIYA, ADA, MAX, { ...RAVI, state: 'active' }])
    render(<ProjectPage orgId="o1" project={running()} />)
    const card = screen.getByRole('region', { name: 'Plan v1' })
    expect(within(card).getByRole('columnheader', { name: 'State' })).toBeTruthy()
    const rows = within(card).getAllByRole('row')
    expect(within(rows[1]).getByText('Done')).toBeTruthy()
    expect(within(rows[2]).getByText('Working')).toBeTruthy()
    await user.click(within(card).getByRole('radio', { name: 'Map' }))
    const map = within(card).getByRole('group', { name: 'Plan v1 as a map' })
    expect(within(map).getByRole('button', { name: 'Which sign-in providers customers ask for, research.md, Ada, Done' })).toBeTruthy()
    expect(within(map).getByRole('button', { name: 'How sign-in changes in Atlas, tech-plan.md, Ravi, you check, After: Which sign-in providers customers ask for, Working' })).toBeTruthy()
    expect(within(card).getByText('1 of 3 done')).toBeTruthy()
    expect(within(card).queryByText(/to approve/)).toBeNull()
  })

  it('marks what a replan added, changed and took out', () => {
    localStorage.setItem('foreman.projects.planView', 'map')
    const v1: ProjectPlan = { ...PLAN, status: 'replaced' }
    const v2: ProjectPlan = {
      ...PLAN,
      version: 2,
      status: 'waiting',
      taskId: 't-plan-2',
      parts: [
        PLAN.parts[0],
        { ...PLAN.parts[1], brief: 'Plan it with the security review in mind.' },
        { id: 'review', title: 'Review the SAML design for security', owner: 'e-ada1', brief: 'Review it.', reads: [], writes: 'security-review.md', dependsOn: ['tech-plan'], gate: false }
      ]
    }
    render(
      <ProjectPage
        orgId="o1"
        project={project({
          plans: [v1, v2],
          steps: [
            { kind: 'plan', round: 1, taskId: 't-plan', employeeId: 'e-pri1', state: 'done', summary: 'Plan v1.', startedAt: NOW, endedAt: NOW },
            { kind: 'plan', round: 2, taskId: 't-plan-2', employeeId: 'e-pri1', state: 'done', summary: 'Plan v2.', startedAt: LATER, endedAt: LATER }
          ]
        })}
      />
    )
    const map = screen.getByRole('group', { name: 'Plan v2 as a map' })
    expect(within(map).getByRole('button', { name: /^Review the SAML design for security, .*New$/ })).toBeTruthy()
    expect(within(map).getByRole('button', { name: /^How sign-in changes in Atlas, .*Changed$/ })).toBeTruthy()
    expect(within(map).getByRole('button', { name: 'Help page: set up single sign-on, help-page.md, Max, After: How sign-in changes in Atlas, Taken out' })).toBeTruthy()
    const card = screen.getByRole('region', { name: 'Plan v2' })
    expect(within(card).getByText('1 new')).toBeTruthy()
    expect(within(card).getByText('1 changed')).toBeTruthy()
    expect(within(card).getByText('1 taken out')).toBeTruthy()
  })
})

describe('the parts beside the channel', () => {
  it('draws the parts by their files, and a part takes the channel to its newest post', async () => {
    const user = userEvent.setup()
    setSnapshot([PRIYA, ADA, MAX, { ...RAVI, state: 'active' }])
    const scrolled: Element[] = []
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    render(<ProjectPage orgId="o1" project={running()} />)
    const side = screen.getByRole('complementary', { name: 'About #team-accounts-sso' })
    expect(within(side).getByRole('list')).toBeTruthy()
    await user.click(within(side).getByRole('radio', { name: 'Map' }))
    expect(localStorage.getItem('foreman.projects.partsView')).toBe('map')
    const map = within(side).getByRole('group', { name: 'The parts of #team-accounts-sso as a map' })
    await user.click(within(map).getByRole('button', { name: /^research\.md, Which sign-in providers/ }))
    // Ada's part is done: its post, where she said what she found.
    expect(scrolled.at(-1)?.textContent).toContain('Okta, Google Workspace and Entra.')
    expect(scrolled.at(-1)?.getAttribute('data-ui-flash')).toBe('on')
    // Ravi's is running: the line that says it started.
    await user.click(within(map).getByRole('button', { name: /^tech-plan\.md/ }))
    expect(scrolled.at(-1)?.textContent).toContain('How sign-in changes in Atlas')
    // Max's hasn't started: the plan, where it is listed.
    await user.click(within(map).getByRole('button', { name: /^help-page\.md/ }))
    expect(scrolled.at(-1)?.getAttribute('aria-label')).toBe('Plan v1')
    scroll.mockRestore()
  })
})

describe('hand-offs outside projects on the Team page', () => {
  const launch = task('launch', 'e-max1', 'Write the Atlas 2.4 launch post')
  const changes = task('changes', 'e-ada1', 'List what changed in Atlas since 2.3', { parentId: 'launch', from: 'employee', result: { status: 'done', summary: 'Two changes.', artifacts: ['memory/org/docs/changes-2.4.md'], runId: 'r', at: NOW } })

  it('draws a chain one employee handed to another, open while something in it waits for you', async () => {
    const user = userEvent.setup()
    setSnapshot(undefined, [PUSH])
    fakeApi.listEmployeeTasks = vi.fn(async () => [changes, launch])
    render(<HandOffs orgId="o1" />)
    const section = await screen.findByRole('region', { name: 'Hand-offs outside projects' })
    expect(within(section).getByRole('button', { name: /Hand-offs outside projects/, expanded: true })).toBeTruthy()
    const map = within(section).getByRole('group', { name: 'Hand-offs in “Write the Atlas 2.4 launch post”' })
    expect(within(map).getByRole('button', { name: /^Write the Atlas 2\.4 launch post, Max, Done/ })).toBeTruthy()
    expect(within(map).getByRole('button', { name: /^List what changed in Atlas since 2\.3, Ada, Done/ })).toBeTruthy()
    expect(within(section).getByText('3 of 20 runs')).toBeTruthy()
    expect(within(section).getByText('Result · changes-2.4.md')).toBeTruthy()
    // The held push is drawn under Max's task; selecting it opens its decision, which the map never makes.
    await user.click(within(map).getByRole('button', { name: /^Push of max\/launch-2\.4/ }))
    expect(within(section).getByRole('list', { name: 'What waits for you in “Write the Atlas 2.4 launch post”' })).toBeTruthy()
    // A task opens its employee.
    await user.click(within(map).getByRole('button', { name: /^List what changed/ }))
    await user.click(within(section).getByRole('button', { name: 'Open Ada' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-ada1' })
  })

  it('stays closed when nothing waits, and shows nothing without a hand-off', async () => {
    fakeApi.listEmployeeTasks = vi.fn(async () => [changes, launch])
    const first = render(<HandOffs orgId="o1" />)
    const section = await screen.findByRole('region', { name: 'Hand-offs outside projects' })
    expect(within(section).getByRole('button', { name: /Hand-offs outside projects/, expanded: false })).toBeTruthy()
    first.unmount()
    fakeApi.listEmployeeTasks = vi.fn(async () => [launch])
    render(<HandOffs orgId="o1" />)
    await waitFor(() => expect(fakeApi.listEmployeeTasks).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Hand-offs outside projects' })).toBeNull()
  })
})
