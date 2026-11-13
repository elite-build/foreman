// @vitest-environment jsdom
// Employees working together in the window (docs/ai-employees.md §7, §6.5, §10): a task row says who handed it over and
// how much of its chain's runs are used, and opens its chain (the task it came from, those handed off from it with their
// states) and its receipts (saved → delivered → started → completed) as a stepper; Needs you lists a chain out of runs
// with Raise limit and Cancel chain, and not work waiting on other employees; the Edit view's delegation checklist; the
// Team page's lead tag and its Make lead / Remove as lead.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeRootLedger, EmployeeTask, EmployeeTaskChain, EmployeeWorkView } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeDefinition, type EmployeeSummary } from '../src/shared/employees'
import { EmployeesNeedYou, TaskRow } from '../src/renderer/src/components/employees/EmployeeWork'
import { AccessFields, CanDo } from '../src/renderer/src/components/employees/EmployeeFields'
import { TeamPage } from '../src/renderer/src/components/employees/TeamPage'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot
const NOW = '2026-11-13T10:00:00.000Z'

const summary = (id: string, name: string, patch: Partial<EmployeeSummary> = {}): EmployeeSummary => ({
  id,
  path: `bots/${id}.toml`,
  name,
  role: 'Engineer',
  colour: 'teal',
  agent: 'claude',
  model: 'claude-sonnet-5-5',
  responsibilities: [],
  problems: [],
  state: 'active',
  changed: false,
  ...patch
})

const task = (patch: Partial<EmployeeTask> = {}): EmployeeTask => ({
  id: 't1',
  orgId: 'o1',
  employeeId: 'e-ada2',
  requestId: 'r1',
  rootId: 'root',
  parentId: 'root',
  title: 'Review the launch post',
  body: 'Review it',
  from: 'employee',
  targetRepoId: 'site',
  state: 'running',
  depth: 1,
  requestedBy: { employeeId: 'e-max1', name: 'Max', taskId: 'root', runId: 'run-0' },
  createdAt: NOW,
  updatedAt: NOW,
  ...patch
})

const ledger = (patch: Partial<EmployeeRootLedger> = {}): EmployeeRootLedger => ({ rootId: 'root', orgId: 'o1', runsUsed: 7, runsAllowed: 20, descendants: 2, active: 3, state: 'open', createdAt: NOW, updatedAt: NOW, ...patch })

function setSnapshot({ work, lead }: { work?: Partial<EmployeeWorkView>; lead?: string } = {}) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'acme-memory', rootPath: 'C:\\code\\acme-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'site', rootPath: 'C:\\code\\site', defaultBranch: 'main', spaceId: 'o1' }
    ],
    organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: NOW, ...(lead ? { leadEmployeeId: lead } : {}) }],
    workspaces: [],
    employees: { o1: { head: 'h1', employees: [summary('e-max1', 'Max'), summary('e-ada2', 'Ada'), summary('e-lin3', 'Lin')] } },
    employeeWork: { o1: { tasks: [], runs: [], last: {}, proposals: [], revision: 1, ...work } },
    settings: { ...original.settings, aiEmployees: true }
  }
}

beforeEach(() => {
  resetFake()
  ;(storeModule.showToast as ReturnType<typeof vi.fn>).mockReset()
  fakeState.space = 'o1'
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
})

describe('a task’s chain and receipts', () => {
  it('says who handed it over and its chain’s runs, and opens the chain and its receipts', async () => {
    const user = userEvent.setup()
    setSnapshot({ work: { roots: { root: ledger() } } })
    const chain: EmployeeTaskChain = {
      task: task(),
      parent: task({ id: 'root', employeeId: 'e-max1', parentId: null, title: 'Ship the launch post', from: 'person', state: 'waiting', waitingOn: 'reply', depth: 0 }),
      children: [task({ id: 'c1', employeeId: 'e-lin3', parentId: 't1', title: 'Check the numbers', state: 'closed', closureReason: 'expired' }), task({ id: 'c2', employeeId: 'e-max1', parentId: 't1', title: 'Pick a date', state: 'open', hold: 'root-limit' })],
      root: ledger(),
      transitions: [
        { seq: 1, taskId: 't1', runId: null, at: '2026-11-13T10:00:00.000Z', from: null, to: 'open', event: 'saved' },
        { seq: 2, taskId: 't1', runId: 'r', at: '2026-11-13T10:01:00.000Z', from: 'open', to: 'running', event: 'admitted' },
        { seq: 3, taskId: 't1', runId: 'r', at: '2026-11-13T10:02:00.000Z', from: 'running', to: 'running', event: 'started' }
      ]
    }
    fakeApi.employeeTaskChain = vi.fn(async () => chain)
    render(
      <ul>
        <TaskRow task={task()} runs={[]} />
      </ul>
    )
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Asked by Max')
    expect(row.textContent).toContain('7 of 20 runs in this chain')
    // Read only when opened.
    expect(fakeApi.employeeTaskChain).not.toHaveBeenCalled()
    await user.click(within(row).getByRole('button', { name: 'Chain and receipts' }))
    expect(fakeApi.employeeTaskChain).toHaveBeenCalledWith('t1')
    await screen.findByText('Handed off from Max’s “Ship the launch post”')
    expect(within(row).getByText('Handed off from Max’s “Ship the launch post”').parentElement!.textContent).toContain('Waiting on a hand-off')
    const children = within(row).getByRole('list', { name: 'Tasks handed off from this one' })
    expect(within(children).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ExpiredLin: Check the numbers', 'Held: chain out of runsMax: Pick a date'])
    // Receipts: saved, delivered and started done; completed is where it is now (a started task never reads as done).
    const receipts = within(row).getByRole('list', { name: 'Receipts' })
    const steps = within(receipts).getAllByRole('listitem')
    // Each reached stage says when (in the person's locale), then that it is done.
    expect(steps.map((s) => s.textContent?.replace(/ [^,]*\d[^,]*/, ''))).toEqual(['Saved, done', 'Delivered, done', 'Started, done', 'Completed'])
    expect(steps[0].textContent).toMatch(/^Saved .*\d.*, done$/)
    expect(steps[3].getAttribute('aria-current')).toBe('step')
  })
})

describe('Needs you: a chain out of runs', () => {
  it('lists a root-limit hold with Raise limit and Cancel chain, and not tasks waiting on other employees', async () => {
    const user = userEvent.setup()
    const held = task({ id: 'm1', employeeId: 'e-max1', title: 'Message from Ada', kind: 'message', state: 'open', hold: 'root-limit', reason: 'This chain of work has used 20 of its 20 runs. Raise its limit, or cancel it, in Needs you.' })
    const parked = task({ id: 'p1', employeeId: 'e-max1', parentId: null, rootId: 'p1', title: 'Ship', state: 'waiting', waitingOn: 'reply', reason: 'Waiting on Ada’s task “Review”.' })
    setSnapshot({ work: { tasks: [held, parked], roots: { root: ledger({ runsUsed: 20, state: 'spent' }) } } })
    fakeApi.raiseEmployeeRootLimit = vi.fn(async () => ledger({ runsUsed: 20, runsAllowed: 30 }))
    fakeApi.cancelEmployeeTask = vi.fn(async () => held)
    render(<EmployeesNeedYou orgId="o1" />)
    const list = screen.getByRole('list', { name: /Acme/ })
    const rows = within(list).getAllByRole('listitem').filter((li) => li.classList.contains('employee-task'))
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Held: chain out of runs')
    expect(rows[0].textContent).toContain('20 of 20 runs in this chain')
    expect(within(rows[0]).queryByRole('button', { name: 'Retry' })).toBeNull()
    await user.click(within(rows[0]).getByRole('button', { name: 'Raise limit' }))
    expect(fakeApi.raiseEmployeeRootLimit).toHaveBeenCalledWith('root')
    await waitFor(() => expect(storeModule.showToast).toHaveBeenCalledWith('This chain may now have 30 runs.'))
    await user.click(within(rows[0]).getByRole('button', { name: 'Cancel chain' }))
    expect(fakeApi.cancelEmployeeTask).toHaveBeenCalledWith('root')
  })
})

describe('delegation in the Edit view and the plan', () => {
  it('edits delegate_to as a checklist of the organization’s other employees, and says it in words', async () => {
    const user = userEvent.setup()
    const start = defaultEmployee({ id: 'e-max1', colour: 'teal', repos: ['site'], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max' } })
    const seen: EmployeeDefinition[] = []
    function Harness() {
      const [value, setValue] = useState(start)
      return (
        <>
          <AccessFields
            value={value}
            onChange={(next) => {
              seen.push(next)
              setValue(next)
            }}
            sections={['actions']}
            repos={['site']}
            others={[
              { id: 'e-ada2', name: 'Ada' },
              { id: 'e-lin3', name: 'Lin' }
            ]}
          />
          <CanDo value={value} repos={['site']} others={[{ id: 'e-ada2', name: 'Ada' }, { id: 'e-lin3', name: 'Lin' }]} heading="What Max can do" />
        </>
      )
    }
    setSnapshot()
    render(<Harness />)
    const group = screen.getByRole('group', { name: 'May hand tasks to' })
    const ada = within(group).getByRole('checkbox', { name: 'Ada' }) as HTMLInputElement
    expect(ada.checked).toBe(false)
    expect(screen.queryByText(/May hand tasks to Ada/)).toBeNull()
    await user.click(ada)
    expect(seen.at(-1)!.access.delegate_to).toEqual(['e-ada2'])
    await user.click(within(group).getByRole('checkbox', { name: 'Lin' }))
    expect(seen.at(-1)!.access.delegate_to).toEqual(['e-ada2', 'e-lin3'])
    expect(screen.getByText('May hand tasks to Ada, Lin.')).toBeTruthy()
    await user.click(within(group).getByRole('checkbox', { name: 'Ada' }))
    expect(seen.at(-1)!.access.delegate_to).toEqual(['e-lin3'])
  })
})

describe('the Team page’s lead', () => {
  it('tags the lead’s card, and makes another employee lead or removes the lead', async () => {
    const user = userEvent.setup()
    setSnapshot({ lead: 'e-ada2' })
    fakeApi.setOrganizationLead = vi.fn(async () => ({ id: 'o1', name: 'Acme', createdAt: NOW }))
    render(<TeamPage orgId="o1" data={{ employees: [], error: '', reload: vi.fn() }} />)
    const cards = screen.getAllByRole('listitem').filter((li) => li.classList.contains('employee-card'))
    const card = (name: string) => cards.find((c) => within(c).queryByRole('button', { name }))!
    const ada = card('Ada')
    expect(within(ada).getByText('Lead')).toBeTruthy()
    expect(within(card('Max')).queryByText('Lead')).toBeNull()
    await user.click(within(card('Max')).getByRole('button', { name: 'Make lead' }))
    expect(fakeApi.setOrganizationLead).toHaveBeenCalledWith('o1', 'e-max1')
    await waitFor(() => expect(storeModule.showToast).toHaveBeenCalledWith('Max is now Acme’s lead: unaddressed work and escalations go to Max.'))
    await user.click(within(ada).getByRole('button', { name: 'Remove as lead' }))
    expect(fakeApi.setOrganizationLead).toHaveBeenLastCalledWith('o1', null)
  })
})
