// @vitest-environment jsdom
// An employee's triggers in the window (docs/ai-employees.md §8): the Triggers tab says each in words with what it asks,
// its next time and its last firing here, with a switch that turns it off on this computer; the Edit view's Triggers
// section adds one in a dialog with the kind, a live preview of the next three times and the floor's error, and says
// saving means approving again; the approval plan lists the triggers in words; Automations lists them with the hat and
// name, read-only, with "Edit on Max’s page"; and a Team card says when it next runs.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEmployee, type EmployeeDefinition, type EmployeeSummary, type EmployeeView } from '../src/shared/employees'
import type { EmployeeTrigger, EmployeeTriggerState } from '../src/shared/employeeTriggers'
import { TriggersField, TriggersTab } from '../src/renderer/src/components/employees/EmployeeTriggers'
import { ApproveDialog } from '../src/renderer/src/components/employees/ApproveDialog'
import { TeamPage } from '../src/renderer/src/components/employees/TeamPage'
import { ScheduleOverview } from '../src/renderer/src/components/automations/details'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot
const NOW = '2026-11-13T10:00:00.000Z'
const MONDAYS: EmployeeTrigger = { id: 't-mon1', kind: 'cron', cron: '0 9 * * 1', timezone: 'Europe/London', prompt: 'Draft the week’s update', repo: 'site', missed: 'skip', overlap: 'skip', enabled: true }
const OFF: EmployeeTrigger = { id: 't-off1', kind: 'interval', every: '90m', timezone: 'UTC', missed: 'run-once', overlap: 'coalesce', enabled: false }

function max(triggers?: EmployeeTrigger[]): EmployeeDefinition {
  const d = defaultEmployee({ id: 'e-max1', colour: 'orange', repos: [], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max', role: 'Marketing', responsibilities: ['Write posts'] } })
  return { ...d, access: { ...d.access, repos: { site: 'write', api: 'read' } }, ...(triggers ? { triggers } : {}) }
}

const summary = (patch: Partial<EmployeeSummary> = {}): EmployeeSummary => ({
  id: 'e-max1',
  path: 'bots/e-max1.toml',
  name: 'Max',
  role: 'Marketing',
  colour: 'orange',
  agent: 'claude',
  model: 'claude-sonnet-5-5',
  responsibilities: ['Write posts'],
  problems: [],
  state: 'active',
  changed: false,
  triggers: [MONDAYS, OFF],
  ...patch
})

const view = (patch: Partial<EmployeeView> = {}): EmployeeView => ({ ...summary(), blob: 'b1', text: '', definition: max([MONDAYS, OFF]), fingerprint: 'f'.repeat(64), ...patch })

const STATES: EmployeeTriggerState[] = [
  { orgId: 'o1', employeeId: 'e-max1', triggerId: 't-mon1', timing: 'x', nextAt: '2026-11-16T09:00:00.000Z', firings: [{ plannedAt: '2026-11-09T09:00:00.000Z', at: '2026-11-09T09:20:00.000Z', outcome: 'skipped', skip: 'missed' }] },
  { orgId: 'o1', employeeId: 'e-max1', triggerId: 't-off1', timing: '', firings: [] }
]

function setSnapshot({ employees = [summary()], states = STATES }: { employees?: EmployeeSummary[]; states?: EmployeeTriggerState[] } = {}) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'acme-memory', rootPath: 'C:\\code\\acme-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'site', rootPath: 'C:\\code\\site', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'api', name: 'api', rootPath: 'C:\\code\\api', defaultBranch: 'main', spaceId: 'o1' }
    ],
    organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: NOW }],
    workspaces: [],
    schedules: [],
    occurrences: [],
    employees: { o1: { head: 'h1', employees } },
    employeeTriggers: states,
    settings: original.settings
  }
}

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>

beforeEach(() => {
  resetFake()
  spy('openEmployees').mockReset()
  fakeApi.setEmployeeTriggerOff = vi.fn(async () => undefined)
  setSnapshot()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('the Triggers tab', () => {
  it('says each trigger in words, with what it asks, its next time and its last firing, and turns it off here with its switch', async () => {
    const user = userEvent.setup()
    render(<TriggersTab orgId="o1" employee={view()} />)
    const list = screen.getByRole('list', { name: 'Max’s triggers' })
    const [first, second] = within(list).getAllByRole('listitem')
    expect(within(first).getByText('Every Mon at 09:00 (Europe/London)')).toBeTruthy()
    expect(first.textContent).toContain('Draft the week’s update · next Mon 16 Nov · 09:00 GMT · last: skipped, Foreman wasn’t running')
    expect(first.textContent).toContain('in site · if missed: Skip it · if the last isn’t done: Skip it')
    const on = within(first).getByRole('switch', { name: 'Run on this computer: Every Mon at 09:00 (Europe/London)' })
    expect(on.getAttribute('aria-checked')).toBe('true')
    await user.click(on)
    expect(fakeApi.setEmployeeTriggerOff).toHaveBeenCalledWith('o1', 'e-max1', 't-mon1', true)
    // Off in its definition: said so, and its switch can't turn it on here.
    expect(within(second).getByText('Every 90 minutes (UTC)')).toBeTruthy()
    expect(second.textContent).toContain('work through its responsibilities and report · off in its definition')
    const off = within(second).getByRole('switch')
    expect(off.getAttribute('aria-checked')).toBe('false')
    expect((off as HTMLButtonElement).disabled).toBe(true)
  })

  it('says why its triggers don’t fire while it is a draft, changed or paused, and when it has none', () => {
    const { unmount } = render(<TriggersTab orgId="o1" employee={view({ state: 'draft' })} />)
    expect(screen.getByText('Max isn’t approved on this computer, so its triggers don’t fire. Approve it to start them.')).toBeTruthy()
    unmount()
    const changed = render(<TriggersTab orgId="o1" employee={view({ changed: true })} />)
    expect(screen.getByText('Max changed since approval, so its triggers don’t fire until you approve it again.')).toBeTruthy()
    changed.unmount()
    render(<TriggersTab orgId="o1" employee={view({ definition: max() })} />)
    expect(screen.getByText('Max has no triggers: it works only when asked. Add one in Edit.')).toBeTruthy()
  })
})

describe('the Edit view’s Triggers section', () => {
  it('adds a trigger in a dialog with a live preview and the floor’s error, and says saving means approving again', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TriggersField value={max()} onChange={onChange} approved />)
    expect(screen.getByText('Triggers are part of the definition: saving a new or changed trigger means approving Max again.')).toBeTruthy()
    expect(screen.getByText('None: it works only when asked.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add a trigger' }))
    const dialog = screen.getByRole('dialog', { name: 'Add a trigger for Max' })
    // A cron trigger to start with, Mondays at 09:00, and the next three times.
    const cron = within(dialog).getByRole('textbox', { name: 'Cron expression' }) as HTMLInputElement
    expect(cron.value).toBe('0 9 * * 1')
    expect(within(within(dialog).getByRole('group', { name: 'Next three times' })).getAllByRole('listitem')).toHaveLength(3)
    // Under the floor: said where it is typed, and Done waits.
    await user.clear(cron)
    await user.type(cron, '*/5 * * * *')
    expect(within(dialog).getByText('Trigger 1 would run 5 minutes apart; triggers run at most every 15 minutes.')).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true)
    // An interval instead: every 2 hours by default; 3 hours here, in api, collapsing missed times, coalescing.
    await user.click(within(dialog).getByRole('radio', { name: 'Interval' }))
    const amount = within(dialog).getByRole('spinbutton', { name: 'Every' })
    expect((amount as HTMLInputElement).value).toBe('2')
    await user.clear(amount)
    await user.type(amount, '3')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Unit' }), 'h')
    await user.type(within(dialog).getByRole('textbox', { name: 'What it asks' }), 'Check the dashboards')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Repository' }), 'api')
    await user.click(within(dialog).getByRole('radio', { name: /^Run once/ }))
    await user.click(within(dialog).getByRole('radio', { name: /^Coalesce/ }))
    expect(within(within(dialog).getByRole('group', { name: 'Next three times' })).getAllByRole('listitem')).toHaveLength(3)
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const saved = onChange.mock.calls[0][0] as EmployeeDefinition
    expect(saved.triggers).toEqual([{ id: expect.stringMatching(/^t-[a-z2-9]{4}$/), kind: 'interval', every: '3h', timezone: expect.any(String), prompt: 'Check the dashboards', repo: 'api', missed: 'run-once', overlap: 'coalesce', enabled: true }])
  })

  it('changes and removes a trigger, each named by what it says', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TriggersField value={max([MONDAYS])} onChange={onChange} approved={false} />)
    expect(screen.getByText('Triggers are part of the definition, so approving it approves them.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Remove: Every Mon at 09:00 (Europe/London)' }))
    expect((onChange.mock.calls[0][0] as EmployeeDefinition).triggers).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Change: Every Mon at 09:00 (Europe/London)' }))
    const dialog = screen.getByRole('dialog', { name: 'Change Max’s trigger' })
    await user.click(within(dialog).getByRole('checkbox', { name: /^On in the definition/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect((onChange.mock.calls[1][0] as EmployeeDefinition).triggers).toEqual([{ ...MONDAYS, enabled: false }])
  })
})

describe('triggers elsewhere', () => {
  it('lists them in words in the approval plan, with what the approval doesn’t cover', () => {
    render(<ApproveDialog definition={max([MONDAYS])} memory="acme-memory" names={(id) => id} onConfirm={async () => undefined} onClose={() => undefined} />)
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain('Every Mon at 09:00 (Europe/London) · Draft the week’s update · in site · missed times are skipped')
    expect(text).toContain('A trigger other than these, or a change to one of them.')
    expect(text).toContain('Two runs in a row that don’t finish pause it until you resume it.')
    expect(text).not.toContain('None: it runs only when asked.')
  })

  it('lists them with the schedules in Automations, read-only, with the hat and name and Edit on its page', async () => {
    const user = userEvent.setup()
    render(<ScheduleOverview />)
    const list = screen.getByRole('list', { name: 'Schedules' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Max · Every Mon at 09:00 (Europe/London)')
    expect(rows[0].textContent).toContain('Draft the week’s update · next Mon 16 Nov · 09:00 GMT')
    expect(rows[0].querySelector('svg.ui-hard-hat')).toBeTruthy()
    expect(rows[1].textContent).toContain('Off')
    await user.click(within(rows[0]).getByRole('button', { name: 'Edit on Max’s page' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-max1' })
  })

  it('says on a Team card when the employee next runs on its own, only while its triggers can fire', () => {
    const data = { employees: [], error: '', reload: vi.fn() }
    const { unmount } = render(<TeamPage orgId="o1" data={data} />)
    expect(screen.getByText('Next run Mon 16 Nov · 09:00 GMT')).toBeTruthy()
    unmount()
    setSnapshot({ employees: [summary({ state: 'paused', pausedKind: 'person' })] })
    render(<TeamPage orgId="o1" data={data} />)
    expect(screen.queryByText(/^Next run/)).toBeNull()
  })
})
