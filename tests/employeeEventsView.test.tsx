// @vitest-environment jsdom
// Event triggers in the window (docs/ai-employees.md §8): the Edit view's trigger dialog takes the event kind
// (its source, its events as checkboxes, its repository, branch glob, whose pull requests, memory paths, debounce and
// prompt, with what is wrong said where it is typed); the Triggers tab says each in words with its last firing ("fired
// for #42, 10:31", "skipped: chain guard"); the approval plan lists them; Automations' schedules leave them out.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultEmployee, type EmployeeDefinition, type EmployeeSummary, type EmployeeView } from '../src/shared/employees'
import type { EmployeeTrigger, EmployeeTriggerState, EventTrigger } from '../src/shared/employeeTriggers'
import { formatDateTime } from '../src/shared/i18n/time'
import { TriggersField, TriggersTab } from '../src/renderer/src/components/employees/EmployeeTriggers'
import { ApproveDialog } from '../src/renderer/src/components/employees/ApproveDialog'
import { ScheduleOverview } from '../src/renderer/src/components/automations/details'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot
const NOW = '2026-11-13T10:00:00.000Z'
const MERGED: EventTrigger = { id: 't-prm1', kind: 'event', source: 'pull-request', on: ['merged'], repo: 'site', debounce: 60, overlap: 'skip', enabled: true }
const MEMORY: EventTrigger = { id: 't-mem1', kind: 'event', source: 'memory', paths: ['memory/org/docs/**'], prompt: 'Read what changed and update the index', debounce: 0, overlap: 'coalesce', enabled: true }

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
  triggers: [MERGED, MEMORY],
  ...patch
})

const view = (patch: Partial<EmployeeView> = {}): EmployeeView => ({ ...summary(), blob: 'b1', text: '', definition: max([MERGED, MEMORY]), fingerprint: 'f'.repeat(64), ...patch })

const FIRED_AT = '2026-11-13T10:31:00.000Z'
const STATES: EmployeeTriggerState[] = [
  { orgId: 'o1', employeeId: 'e-max1', triggerId: 't-prm1', timing: '', firings: [{ plannedAt: FIRED_AT, at: FIRED_AT, outcome: 'fired', subject: '#42', taskId: 'task-1' }] },
  { orgId: 'o1', employeeId: 'e-max1', triggerId: 't-mem1', timing: '', firings: [{ plannedAt: FIRED_AT, at: FIRED_AT, outcome: 'skipped', skip: 'chain', subject: 'abc1234' }] }
]

function setSnapshot(states: EmployeeTriggerState[] = STATES) {
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
    employees: { o1: { head: 'h1', employees: [summary()] } },
    employeeTriggers: states,
    settings: { ...original.settings, aiEmployees: true }
  }
}

beforeEach(() => {
  resetFake()
  fakeApi.setEmployeeTriggerOff = vi.fn(async () => undefined)
  setSnapshot()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('the Triggers tab', () => {
  it('says each event trigger in words, with its debounce and its last firing here', () => {
    render(<TriggersTab orgId="o1" employee={view()} />)
    const [pull, memory] = within(screen.getByRole('list', { name: 'Max’s triggers' })).getAllByRole('listitem')
    expect(within(pull).getByText('When a pull request merges in site')).toBeTruthy()
    const time = formatDateTime(FIRED_AT, 'en', { hour: '2-digit', minute: '2-digit' })
    expect(pull.textContent).toContain(`work through its responsibilities and report · last: fired for #42, ${time}`)
    expect(pull.textContent).toContain('in site · events within 60 s become one run · if the last isn’t done: Skip it')
    expect(within(memory).getByText('When memory changes under memory/org/docs/**')).toBeTruthy()
    expect(memory.textContent).toContain('Read what changed and update the index · last: skipped: chain guard')
    expect(within(pull).getByRole('switch', { name: 'Run on this computer: When a pull request merges in site' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('the Edit view’s event triggers', () => {
  it('adds a pull-request trigger: its events, repository, branch, whose pull requests, debounce and prompt', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TriggersField value={max()} onChange={onChange} approved />)
    await user.click(screen.getByRole('button', { name: 'Add a trigger' }))
    const dialog = screen.getByRole('dialog', { name: 'Add a trigger for Max' })
    await user.click(within(dialog).getByRole('radio', { name: 'Event' }))
    // A pull request merging in its first repository, to start with; no missed rule for events.
    expect((within(dialog).getByRole('combobox', { name: 'Source' }) as HTMLSelectElement).value).toBe('pull-request')
    expect((within(dialog).getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement).value).toBe('site')
    expect(within(dialog).queryByRole('group', { name: 'When Foreman missed a time' })).toBeNull()
    const events = within(dialog).getByRole('group', { name: 'Events' })
    expect((within(events).getByRole('checkbox', { name: 'Merged' }) as HTMLInputElement).checked).toBe(true)
    // With no event ticked, it says what is wrong and Done waits.
    await user.click(within(events).getByRole('checkbox', { name: 'Merged' }))
    expect(within(dialog).getByRole('alert').textContent).toBe('Trigger 1 listens to no event: give “on” one or more of merged, ci-failed, review-requested, changes-requested, approved.')
    expect((within(dialog).getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(within(events).getByRole('checkbox', { name: 'Approved' }))
    await user.click(within(events).getByRole('checkbox', { name: 'CI failed' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Branch' }), 'release/*')
    await user.click(within(dialog).getByRole('radio', { name: 'Only people’s' }))
    const debounce = within(dialog).getByRole('spinbutton', { name: 'Debounce (seconds)' })
    await user.clear(debounce)
    await user.type(debounce, '120')
    await user.type(within(dialog).getByRole('textbox', { name: 'What it asks' }), 'Write the release note')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Repository' }), 'api')
    expect(dialog.textContent).toContain('Its own work never starts it. At most 3 event runs per pull request, issue or memory path in 10 minutes')
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect((onChange.mock.calls[0][0] as EmployeeDefinition).triggers).toEqual([
      {
        id: expect.stringMatching(/^t-[a-z2-9]{4}$/),
        kind: 'event',
        source: 'pull-request',
        on: ['ci-failed', 'approved'],
        branch: 'release/*',
        authored_by: 'people',
        debounce: 120,
        prompt: 'Write the release note',
        repo: 'api',
        overlap: 'skip',
        enabled: true
      }
    ])
  })

  it('switches the source: memory takes paths, one a line, and a bad one is said where it is typed', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TriggersField value={max([MERGED])} onChange={onChange} approved={false} />)
    expect(screen.getByText('When a pull request merges in site')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Change: When a pull request merges in site' }))
    const dialog = screen.getByRole('dialog', { name: 'Change Max’s trigger' })
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Source' }), 'memory')
    const paths = within(dialog).getByRole('textbox', { name: 'Memory paths' }) as HTMLTextAreaElement
    expect(paths.value).toBe('memory/org/docs/**')
    await user.type(paths, '{Enter}../secrets')
    expect(within(dialog).getByRole('alert').textContent).toContain('“../secrets” isn’t a pattern Foreman can use')
    await user.type(paths, '{Backspace}'.repeat('../secrets'.length) + 'memory/org/data/*.md')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect((onChange.mock.calls[0][0] as EmployeeDefinition).triggers).toEqual([
      { id: 't-prm1', kind: 'event', source: 'memory', paths: ['memory/org/docs/**', 'memory/org/data/*.md'], repo: 'site', debounce: 60, overlap: 'skip', enabled: true }
    ])
  })
})

describe('event triggers elsewhere', () => {
  it('lists them in words in the approval plan, with the debounce and the self guard', () => {
    render(<ApproveDialog definition={max([{ ...MERGED, branch: 'release/*', authored_by: 'employees' }])} memory="acme-memory" names={(id) => id} onConfirm={async () => undefined} onClose={() => undefined} />)
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain('When a pull request merges in site (branch release/*, by an employee) · work through its responsibilities and report · in site · events within 60 s become one run; its own work never starts it')
  })

  it('leaves them out of Automations’ schedules: they have no times, and live on the employee’s Triggers tab', () => {
    render(<ScheduleOverview />)
    expect(screen.queryByRole('list', { name: 'Schedules' })).toBeNull()
  })
})
