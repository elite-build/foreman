// @vitest-environment jsdom
// Decisions that look and work the same everywhere, for AI employees: the Team page is a column per employee with its
// own waiting decisions as rows and the organization's in a strip above; an employee's page leads with where it is and
// its decisions as cards; its run's banner says "Needs you", never "Done", and carries the same card; a draft's page is
// its plan, true for its definition, with Approve <name> in the header; a changed one lists each difference first.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeAction } from '../src/shared/employeeActions'
import { defaultEmployee, serializeEmployee, type EmployeeDefinition, type EmployeeSummary, type EmployeeView } from '../src/shared/employees'
import type { EmployeeTask, EmployeeWorkView } from '../src/shared/employeeWork'
import type { Workspace } from '../src/shared/types'
import { EmployeePage } from '../src/renderer/src/components/employees/EmployeePage'
import { EmployeeRunBanner } from '../src/renderer/src/components/employees/EmployeeRunBanner'
import { TeamPage } from '../src/renderer/src/components/employees/TeamPage'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot
const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const definition = (id: string, name: string, colour: string, patch: (d: EmployeeDefinition) => EmployeeDefinition = (d) => d): EmployeeDefinition =>
  patch(defaultEmployee({ id, colour, repos: ['site'], loadouts: [{ agent: 'claude', model: 'claude-opus-5-5' }], text: { name, role: name === 'Lin' ? 'Triage' : 'Writer', responsibilities: ['Label new issues'] } }))

const ada = definition('e-ada', 'Ada', 'pink')
const max = definition('e-max', 'Max', 'orange', (d) => ({ ...d, access: { ...d.access, repos: { site: 'write' } } }))
const lin = definition('e-lin', 'Lin', 'teal')

const summary = (d: EmployeeDefinition, patch: Partial<EmployeeSummary> = {}): EmployeeSummary => ({
  id: d.id, path: `bots/${d.id}.toml`, name: d.name, role: d.role, colour: d.look.colour, agent: 'claude', model: 'claude-opus-5-5', responsibilities: d.responsibilities, problems: [], state: 'active', changed: false, ...patch
})
const view = (d: EmployeeDefinition, patch: Partial<EmployeeView> = {}): EmployeeView => ({ ...summary(d), blob: 'b', text: serializeEmployee(d), definition: d, fingerprint: 'f1', ...patch })

const task = (id: string, employeeId: string, patch: Partial<EmployeeTask> = {}): EmployeeTask => ({
  id, orgId: 'o1', employeeId, requestId: id, rootId: id, parentId: null, title: `Task ${id}`, body: '', from: 'person', targetRepoId: 'site', state: 'closed', closureReason: 'done', createdAt: ago(60), updatedAt: ago(41), ...patch
})
const question = task('t-date', 'e-ada', { title: 'Which day does 2.4 launch?', state: 'waiting', waitingOn: 'person', closureReason: undefined, question: { id: 'q1', question: 'Which day does Atlas 2.4 launch?', options: ['Tuesday', 'Thursday'], runId: 'r-ada', askedAt: ago(23) } })
const launch = task('t-launch', 'e-max', { title: 'Write the Atlas 2.4 launch post' })
const push: EmployeeAction = {
  id: 'a-push', orgId: 'o1', employeeId: 'e-max', taskId: 't-launch', runId: 'r-max', repoId: 'site', kind: 'push', policy: 'held', state: 'held', key: 'k',
  payload: { kind: 'push', connection: 'gh’s active account (yatin)', workspaceId: 'ws-max', branch: 'max/launch-2.4', base: 'main', head: 'abc', ahead: 1, commits: [{ sha: '1f71733', subject: 'Write the post' }], repo: 'site', remote: 'origin', remoteUrl: 'github.com/acme/site', login: 'yatin', files: [{ path: 'blog/launch-2.4.md', insertions: 6, deletions: 0 }] },
  createdAt: ago(42), updatedAt: ago(42)
}
const work: EmployeeWorkView = {
  tasks: [question],
  runs: [],
  last: { 'e-max': launch },
  actions: [push],
  proposals: [{ id: 'p-org', orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append', text: '- 2.3 shipped on a Thursday.\n', employeeId: 'e-ada', runId: 'r-ada', taskId: 't-date', why: '2.3 shipped on a Thursday, though PROJECT.md says Tuesdays.', createdAt: ago(33) }],
  revision: 1
}
const maxWorkspace = { id: 'ws-max', name: 'kyoto', repoId: 'site', branch: 'max/launch-2.4', baseBranch: 'main', state: 'ready', createdAt: ago(60), startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e-max', taskId: 't-launch', runId: 'r-max', title: 'Write the Atlas 2.4 launch post' } } as unknown as Workspace

function setSnapshot(employees: EmployeeSummary[] = [summary(ada), summary(lin, { state: 'draft' }), summary(max)]) {
  fakeState.snapshot = {
    ...original,
    platform: 'win32',
    settings: { ...original.settings },
    organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: ago(9000) }],
    repos: [
      { id: 'mem', name: 'acme-memory', spaceId: 'o1' },
      { id: 'site', name: 'site', spaceId: 'o1' }
    ],
    employees: { o1: { head: 'h', employees } },
    employeeWork: { o1: work },
    employeeTriggers: [],
    workspaces: [maxWorkspace],
    sessions: []
  }
}

const data = (employees: EmployeeView[] = []) => ({ employees, error: '', reload: vi.fn() })

beforeEach(() => {
  resetFake()
  setSnapshot()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('the Team page', () => {
  it('is a column per employee, each with one state, its own decisions and its last task', () => {
    render(<TeamPage orgId="o1" data={data()} />)
    const columns = within(screen.getByRole('list', { name: 'Employees of Acme' })).getAllByRole('listitem', { name: undefined }).filter((li) => li.classList.contains('team-column'))
    expect(columns.map((c) => c.querySelector('.employee-card-name')?.textContent)).toEqual(['Ada', 'Lin', 'Max'])
    const [adaColumn, linColumn, maxColumn] = columns
    expect(adaColumn.querySelector('.employee-card-state .ui-status')?.textContent).toBe('Needs you · 1')
    expect(within(adaColumn).getByRole('button', { name: 'Answer…' })).toBeTruthy()
    expect(linColumn.querySelector('.employee-card-state .ui-status')?.textContent).toBe('Draft — review and approve')
    expect(within(linColumn).getByRole('button', { name: 'Review and approve' })).toBeTruthy()
    // The push leaves this computer: its row opens the card, it never pushes from the list.
    expect(within(maxColumn).getByRole('button', { name: 'Review…' })).toBeTruthy()
    expect(within(maxColumn).queryByRole('button', { name: 'Push branch' })).toBeNull()
    expect(maxColumn.textContent).toContain('Write the Atlas 2.4 launch post')
  })

  it('puts the organization’s own decisions in a strip above the columns, with the employee’s reason and an act that stays here', async () => {
    const user = userEvent.setup()
    fakeApi.keepMemoryProposal = vi.fn(async () => ({ ok: true }))
    render(<TeamPage orgId="o1" data={data()} />)
    const strip = screen.getByRole('list', { name: 'Waiting for you from all of Acme' })
    expect(strip.textContent).toMatch(/Memory change\s*Ada\s*Add to PROJECT.md/)
    await user.click(within(strip).getByRole('button', { name: 'Add to PROJECT.md' }))
    expect(fakeApi.keepMemoryProposal).toHaveBeenCalledWith('o1', 'p-org')
    // Ada's column holds her question only.
    expect(screen.getAllByRole('list', { name: 'What of Ada needs you' })[0].textContent).not.toContain('PROJECT.md')
  })

  it('opens a push in place, saying where it goes and as whom before the button', async () => {
    const user = userEvent.setup()
    render(<TeamPage orgId="o1" data={data()} />)
    await user.click(screen.getByRole('button', { name: 'Review…' }))
    const card = screen.getByRole('group', { name: 'Push max/launch-2.4 to site' })
    expect(card.textContent).toContain('Pushes 1 commit of max/launch-2.4 to origin (github.com/acme/site) as @yatin. It leaves this computer and can’t be undone.')
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['blog/launch-2.4.md', 'Open its workspace', 'Don’t push Esc', 'Push branch'])
  })

  it('makes New employee a secondary button: the decisions are the page’s main acts', () => {
    render(<TeamPage orgId="o1" data={data()} />)
    expect(screen.getByRole('button', { name: 'New employee' }).className).not.toContain('ui-btn--primary')
    expect(screen.getByRole('heading', { name: 'Employees · 3' })).toBeTruthy()
  })
})

describe('an employee’s page', () => {
  it('leads with where it is, then what of it waits for you as cards, decided right there', async () => {
    const user = userEvent.setup()
    fakeApi.sendEmployeeAction = vi.fn(async () => undefined)
    render(<EmployeePage orgId="o1" employee={view(max)} edit={false} data={data([view(max)])} />)
    expect(document.querySelector('.employee-page-status')?.textContent).toMatch(/^Needs you: Push of max\/launch-2.4Last run finished/)
    const card = screen.getByRole('group', { name: 'Push max/launch-2.4 to site' })
    expect(within(card).getByRole('button', { name: 'Push branch' }).querySelector('kbd')).toBeNull()
    await user.click(within(card).getByRole('button', { name: 'Push branch' }))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a-push', {})
    // The decisions come before Ask, which is one line.
    const ask = screen.getByRole('textbox', { name: 'Ask Max…' })
    expect(card.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Tasks/ }).textContent).toBe('Tasks1 needs you')
  })

  it('asks with Ctrl+Enter, and says what is missing instead of a button that does nothing', async () => {
    const user = userEvent.setup()
    fakeApi.askEmployee = vi.fn(async () => ({ ...launch, state: 'running' }))
    render(<EmployeePage orgId="o1" employee={view(ada)} edit={false} data={data([view(ada)])} />)
    await user.click(screen.getByRole('button', { name: /^Ask/ }))
    expect(screen.getByText('Say what Ada should do first.')).toBeTruthy()
    expect(fakeApi.askEmployee).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: 'Ask Ada…' }), 'List what changed{Control>}{Enter}{/Control}')
    expect(fakeApi.askEmployee).toHaveBeenCalledWith('o1', 'e-ada', { body: 'List what changed', repoId: 'site' })
  })

  it('says Remove from team, and names its notes rather than their path', () => {
    render(<EmployeePage orgId="o1" employee={view(ada)} edit={false} data={data([view(ada)])} />)
    expect(screen.getByRole('button', { name: 'Remove from team…' })).toBeTruthy()
    expect(screen.queryByText(/Retire/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Ada’s notes' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('memory/bots/e-ada/')
  })
})

describe('a run’s banner', () => {
  it('says Needs you while its push waits, never Done, and opens the same card under it', async () => {
    const user = userEvent.setup()
    render(<EmployeeRunBanner ws={maxWorkspace} />)
    const banner = document.querySelector('.employee-run-banner')!
    expect(banner.textContent).toContain('Needs you · Push')
    expect(banner.textContent).not.toContain('Done')
    const review = screen.getByRole('button', { name: 'Review…' })
    expect(review.getAttribute('aria-expanded')).toBe('false')
    await user.click(review)
    expect(screen.getByRole('group', { name: 'Push max/launch-2.4 to site' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('answers the employee’s question there, and keeps Cancel task under More', async () => {
    const user = userEvent.setup()
    fakeApi.answerEmployeeQuestion = vi.fn(async () => undefined)
    const adaWorkspace = { ...maxWorkspace, id: 'ws-ada', startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e-ada', taskId: 't-date', runId: 'r-ada', title: 'Which day does 2.4 launch?' } } as unknown as Workspace
    render(<EmployeeRunBanner ws={adaWorkspace} />)
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Answer…' }))
    await user.click(screen.getByRole('radio', { name: 'Thursday' }))
    await user.click(screen.getByRole('button', { name: /^Send answer/ }))
    expect(fakeApi.answerEmployeeQuestion).toHaveBeenCalledWith('t-date', 'q1', 'Thursday')
  })
})

describe('a draft’s page is its plan', () => {
  it('says what it may do once approved, only what is true for it, and approves from the header', async () => {
    const user = userEvent.setup()
    fakeApi.approveEmployee = vi.fn(async () => undefined)
    const reload = vi.fn()
    render(<EmployeePage orgId="o1" employee={view(lin, { state: 'draft' })} edit={false} data={{ employees: [], error: '', reload }} />)
    setSnapshot()
    const plan = screen.getByRole('region', { name: 'What Lin may do once you approve it' })
    const group = (name: string) => within(within(plan).getByRole('region', { name })).getAllByRole('listitem').map((li) => li.textContent)
    expect(group('Can')).toEqual(['Read site', 'Keep its own notes in acme-memory'])
    expect(group('Can’t')).toEqual([
      'Change any repository It has Read access to site only.',
      'Push or open pull requests',
      'Post to Slack or change Linear It keeps no Slack or Linear tools.',
      'Use a shell',
      'Hand work to other employees'
    ])
    expect(group('Asks you first')).toEqual(['Before changing Acme’s shared memory You add or discard each change.'])
    expect(plan.textContent).toContain('Only when you ask · at most 6 runs a day, 30 minutes a run')
    // No Ask while it can't run, and no separate plan dialog: Approve <name> applies at once.
    expect(screen.queryByRole('textbox', { name: 'Ask Lin…' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Approve Lin' }))
    expect(fakeApi.approveEmployee).toHaveBeenCalledWith('o1', 'e-lin', 'f1')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(reload).toHaveBeenCalled()
    expect(storeModule.showToast).toHaveBeenCalledWith('Lin is approved on this computer.')
  })

  it('lists each difference since approval first, old → new, the wider ones tagged in words', () => {
    const before = lin
    const after: EmployeeDefinition = { ...lin, access: { ...lin.access, mcp: ['foreman-linear'] }, limits: { ...lin.limits, runs_per_day: 10 } }
    const approvedAt = '2026-11-12T09:00:00.000Z'
    setSnapshot([summary(ada), summary(lin, { changed: true, approvedAt }), summary(max)])
    render(<EmployeePage orgId="o1" employee={view(after, { changed: true, approvedAt, approvedText: serializeEmployee(before) })} edit={false} data={data()} />)
    const changed = screen.getByRole('region', { name: /^Changed since you approved it on (12 Nov|Nov 12)$/ })
    // Each part its own piece: the field, the old value, the arrow (read as "becomes"), the new value, then "Wider" in words.
    const rows = [...changed.querySelectorAll('.employee-change')].map((r) => [r.querySelector('dt')?.textContent, ...[...r.querySelector('dd')!.children].map((c) => c.textContent)])
    expect(rows).toEqual([
      ['MCP servers', 'None', '→', 'becomes', 'foreman-linear', 'Wider'],
      ['Runs a day', 'At most 6 runs a day', '→', 'becomes', 'At most 10 runs a day', 'Wider']
    ])
    expect(screen.getByRole('button', { name: 'Approve Lin' })).toBeTruthy()
    // The plan below says what it may do now: Linear asks first.
    expect(screen.getByRole('region', { name: 'Asks you first' }).textContent).toContain('Before each Linear change')
  })
})
