// @vitest-environment jsdom
// An AI employee's work in the window (docs/ai-employees.md §6, §10): Ask <name>… with its repository limited to the
// ones the employee may work in, and Run now; the Tasks and Runs tabs with each state as a glyph and a word, the reason a
// task waits or closed, and Stop, Retry and Cancel; the Team page's Needs you list; the sidebar's Team rows with the
// current task and how many need you; and the strip on a workspace an employee's run made.
import './domShims'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeRun, EmployeeTask, EmployeeWorkView } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeSummary } from '../src/shared/employees'
import type { Workspace } from '../src/shared/types'
import { AskEmployee, EmployeeRuns, EmployeesNeedYou, EmployeeTasks, TaskRow } from '../src/renderer/src/components/employees/EmployeeWork'
import { EmployeeRunBanner } from '../src/renderer/src/components/employees/EmployeeRunBanner'
import { TeamPage } from '../src/renderer/src/components/employees/TeamPage'
import { TeamSection } from '../src/renderer/src/components/employees/TeamSection'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

// ui/ui.css with its @imports inlined, as the app loads it.
const uiStylesheet = () =>
  readFileSync('src/renderer/src/ui/ui.css', 'utf8').replace(/@import '\.\/(css\/[\w-]+\.css)';/g, (_, file: string) => readFileSync(`src/renderer/src/ui/${file}`, 'utf8'))

const original = fakeState.snapshot
const NOW = '2026-11-13T10:00:00.000Z'

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
  ...patch
})

const task = (patch: Partial<EmployeeTask> = {}): EmployeeTask => ({
  id: 't1',
  orgId: 'o1',
  employeeId: 'e-max1',
  requestId: 'r1',
  rootId: 't1',
  parentId: null,
  title: 'Draft the launch post',
  body: 'Draft the launch post',
  from: 'person',
  targetRepoId: 'site',
  state: 'running',
  createdAt: NOW,
  updatedAt: NOW,
  ...patch
})

const run = (patch: Partial<EmployeeRun> = {}): EmployeeRun => ({
  id: 'r1',
  taskId: 't1',
  employeeId: 'e-max1',
  orgId: 'o1',
  attempt: 1,
  state: 'running',
  started: true,
  turnIds: ['turn-1'],
  agent: 'claude',
  model: 'claude-sonnet-5-5',
  repoId: 'site',
  access: 'write',
  profile: 'no-shell',
  memoryBase: 'abcdef1234',
  workspaceId: 'ws-1',
  sessionId: 's-1',
  createdAt: NOW,
  startedAt: NOW,
  updatedAt: NOW,
  ...patch
})

const definition = defaultEmployee({ id: 'e-max1', colour: 'orange', repos: [], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max' } })
const max = { ...definition, access: { ...definition.access, repos: { site: 'write' as const, api: 'read' as const, docs: 'none' as const } } }

function setSnapshot({ work, employees = [summary()], workspaces = [] as Workspace[] }: { work?: EmployeeWorkView; employees?: EmployeeSummary[]; workspaces?: Workspace[] } = {}) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'acme-memory', rootPath: 'C:\\code\\acme-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'site', rootPath: 'C:\\code\\site', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'api', name: 'api', rootPath: 'C:\\code\\api', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'docs', name: 'docs', rootPath: 'C:\\code\\docs', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'blog', name: 'blog', rootPath: 'C:\\code\\blog', defaultBranch: 'main' }
    ],
    organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: NOW }],
    workspaces,
    employees: { o1: { head: 'h1', employees } },
    employeeWork: work ? { o1: work } : undefined,
    settings: original.settings
  }
}

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>

beforeEach(() => {
  resetFake()
  for (const name of ['selectWorkspace', 'openEmployees', 'showToast']) spy(name).mockReset()
  fakeState.space = 'o1'
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
})

describe('Ask <name>… and Run now', () => {
  it('offers only the repositories the employee may work in, writers first, and asks with the words and the repository', async () => {
    setSnapshot()
    fakeApi.askEmployee = vi.fn(async () => task())
    render(<AskEmployee orgId="o1" employee={summary()} definition={max} />)
    expect(screen.getByRole('heading', { name: 'Ask Max…' })).toBeTruthy()
    const repo = screen.getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement
    expect([...repo.options].map((o) => o.textContent)).toEqual(['site · Write', 'api · Read'])
    const ask = screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement
    expect(ask.disabled).toBe(true)
    await userEvent.type(screen.getByRole('textbox', { name: 'What should Max do?' }), 'Draft the launch post')
    await userEvent.selectOptions(repo, 'api')
    await userEvent.click(ask)
    expect(fakeApi.askEmployee).toHaveBeenCalledWith('o1', 'e-max1', { body: 'Draft the launch post', repoId: 'api' })
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Asked Max: Draft the launch post'))
    expect((screen.getByRole('textbox', { name: 'What should Max do?' }) as HTMLTextAreaElement).value).toBe('')
  })

  it('Run now asks for the standing responsibilities, and says when the work was held or refused', async () => {
    setSnapshot()
    fakeApi.runEmployeeNow = vi.fn(async () => task({ state: 'open', hold: 'queued', reason: 'Waiting for Max’s current run to finish.' }))
    render(<AskEmployee orgId="o1" employee={summary()} definition={max} />)
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(fakeApi.runEmployeeNow).toHaveBeenCalledWith('o1', 'e-max1', { repoId: 'site' })
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Max runs it later: Waiting for Max’s current run to finish.'))
    fakeApi.askEmployee = vi.fn(async () => task({ state: 'waiting', reason: 'Max has had 6 runs today, its limit.' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'What should Max do?' }), 'More')
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Max can’t run it yet: Max has had 6 runs today, its limit.'))
  })

  it('says why it can’t be asked while it is a draft or changed since approval, and that a paused one’s work waits', () => {
    setSnapshot()
    const { unmount } = render(<AskEmployee orgId="o1" employee={summary({ state: 'draft' })} definition={max} />)
    expect(screen.getByText('Approve Max on this computer before asking it to do anything.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull()
    unmount()
    const second = render(<AskEmployee orgId="o1" employee={summary({ changed: true })} definition={max} />)
    expect(screen.getByText(/changed since it was approved/)).toBeTruthy()
    second.unmount()
    render(<AskEmployee orgId="o1" employee={summary({ state: 'paused' })} definition={max} />)
    expect(screen.getByText('Max is paused: what you ask waits, and runs when you resume it.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy()
  })
})

describe('the Tasks and Runs tabs', () => {
  it('lists tasks with their state, why they wait or closed, their result, and Stop, Retry and Cancel', async () => {
    setSnapshot({ work: { tasks: [], runs: [], last: {}, proposals: [], revision: 1 }, workspaces: [{ id: 'ws-2', repoId: 'site', name: 'ws', branch: 'b', baseBranch: 'main', path: '', portBase: 1, state: 'ready', createdAt: NOW, startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e-max1', runId: 'r2', taskId: 't2', title: 'Fix the README' } }] })
    fakeApi.listEmployeeTasks = vi.fn(async () => [
      task(),
      task({ id: 't2', title: 'Fix the README', state: 'waiting', waitingOn: 'person', reason: 'Foreman closed while this ran; retry or cancel.' }),
      task({ id: 't3', title: 'Old post', state: 'closed', closureReason: 'done', resultSummary: 'Posted the draft to docs/launch.md.' }),
      task({ id: 't4', title: 'Broken one', state: 'closed', closureReason: 'blocked', closureDetail: 'The model is overloaded.' }),
      task({ id: 't5', title: 'Stopped one', state: 'open', hold: 'stopped', reason: 'Stopped by you.' })
    ])
    fakeApi.listEmployeeRuns = vi.fn(async () => [run()])
    render(<EmployeeTasks orgId="o1" employee={summary()} />)
    const list = await screen.findByRole('list', { name: 'Tasks of Max' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.ui-status__label')?.textContent)).toEqual(['Running', 'Needs you', 'Done', 'Blocked', 'Stopped'])
    expect(within(rows[1]).getByText('Foreman closed while this ran; retry or cancel.')).toBeTruthy()
    expect(within(rows[2]).getByText('Posted the draft to docs/launch.md.')).toBeTruthy()
    expect(within(rows[3]).getByText('The model is overloaded.')).toBeTruthy()
    // Running: Stop and Cancel, no Retry. Waiting: Retry, Cancel and its workspace. Done: nothing. Blocked: Retry.
    expect(within(rows[0]).queryByRole('button', { name: 'Retry' })).toBeNull()
    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Stop' }))
    expect(fakeApi.stopEmployeeRun).toHaveBeenCalledWith('r1')
    await userEvent.click(within(rows[1]).getByRole('button', { name: 'Retry' }))
    expect(fakeApi.retryEmployeeTask).toHaveBeenCalledWith('t2')
    await userEvent.click(within(rows[1]).getByRole('button', { name: 'Open its workspace' }))
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('ws-2')
    await userEvent.click(within(rows[1]).getByRole('button', { name: 'Cancel task' }))
    expect(fakeApi.cancelEmployeeTask).toHaveBeenCalledWith('t2')
    // Done: no action, only its chain and receipts to open.
    expect(within(rows[2]).queryAllByRole('button').map((b) => b.textContent)).toEqual(['Chain and receipts'])
    expect(within(rows[3]).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(within(rows[4]).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('reads the lists again when the organization’s work moves, and says when there is none', async () => {
    setSnapshot({ work: { tasks: [], runs: [], last: {}, proposals: [], revision: 1 } })
    fakeApi.listEmployeeTasks = vi.fn(async () => [])
    fakeApi.listEmployeeRuns = vi.fn(async () => [])
    const { rerender } = render(<EmployeeTasks orgId="o1" employee={summary()} />)
    expect(await screen.findByText('No tasks yet. Ask Max something, or use Run now.')).toBeTruthy()
    setSnapshot({ work: { tasks: [], runs: [], last: {}, proposals: [], revision: 2 } })
    rerender(<EmployeeTasks orgId="o1" employee={summary()} />)
    await waitFor(() => expect(fakeApi.listEmployeeTasks).toHaveBeenCalledTimes(2))
  })

  it('lists runs with their state, attempt and task, what they ran on, the memory commits and why they ended', async () => {
    setSnapshot({ work: { tasks: [], runs: [], last: {}, proposals: [], revision: 1 } })
    fakeApi.listEmployeeTasks = vi.fn(async () => [task({ state: 'waiting', reason: 'Stopped: it asked a question.' })])
    fakeApi.listEmployeeRuns = vi.fn(async () => [
      run({ id: 'r2', attempt: 2, state: 'needs-you', reason: 'Stopped: it asked a question.', memoryCommit: '9876543210', usage: { durationMs: 65_000 } }),
      run({ id: 'r1', attempt: 1, state: 'uncertain', reason: 'Foreman closed while this ran; retry or cancel.' })
    ])
    render(<EmployeeRuns orgId="o1" employee={summary()} />)
    const list = await screen.findByRole('list', { name: 'Runs of Max' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.ui-status__label')?.textContent)).toEqual(['Needs you', 'Uncertain'])
    expect(within(rows[0]).getByText('Attempt 2 · Draft the launch post')).toBeTruthy()
    expect(within(rows[0]).getByText('Stopped: it asked a question.')).toBeTruthy()
    expect(within(rows[0]).getByText(/^site \(writes, no shell\) · Claude Code/)).toBeTruthy()
    expect(within(rows[0]).getByText('Read memory at abcdef1 · Saved memory as 9876543')).toBeTruthy()
    expect(within(rows[0]).queryByRole('button', { name: 'Stop' })).toBeNull()
  })
})

describe('Needs you, the Team rows and a run’s workspace', () => {
  const work: EmployeeWorkView = {
    tasks: [task(), task({ id: 't2', title: 'Fix the README', state: 'waiting', waitingOn: 'person', reason: 'Stopped: it asked for permission to use Bash.' })],
    runs: [run()],
    last: {},
    proposals: [],
    revision: 3
  }

  it('lists the organization’s tasks that wait for a person, with Retry and Cancel', async () => {
    setSnapshot({ work })
    render(<EmployeesNeedYou orgId="o1" />)
    const list = screen.getByRole('list', { name: 'Tasks in Acme waiting for you' })
    const [row] = within(list).getAllByRole('listitem')
    expect(within(row).getByText('Max: Fix the README')).toBeTruthy()
    expect(within(row).getByText('Stopped: it asked for permission to use Bash.')).toBeTruthy()
    await userEvent.click(within(row).getByRole('button', { name: 'Retry' }))
    expect(fakeApi.retryEmployeeTask).toHaveBeenCalledWith('t2')
  })

  it('shows an employee’s question with its options and an answer in your own words; one answer, never Retry', async () => {
    const asking = task({ id: 't3', title: 'Write the launch post', state: 'waiting', waitingOn: 'person', reason: 'Asks: Which launch?', question: { id: 'q1', question: 'Which launch: 1.0.23 or 1.1?', options: ['1.0.23', '1.1'], runId: 'r1', askedAt: NOW } })
    setSnapshot({ work: { ...work, tasks: [asking] } })
    fakeApi.answerEmployeeQuestion = vi.fn(async () => ({ ...asking, state: 'running' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const [row] = within(screen.getByRole('list', { name: 'Tasks in Acme waiting for you' })).getAllByRole('listitem')
    expect(within(row).getByText('Asks you')).toBeTruthy()
    expect(within(row).getByText('Max asks:')).toBeTruthy()
    expect(within(row).getByText('Which launch: 1.0.23 or 1.1?')).toBeTruthy()
    // A question waits for its answer, not a retry; it can still be canceled.
    expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(within(row).getByRole('button', { name: 'Cancel task' })).toBeTruthy()
    const send = within(row).getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    // An option, then the person's own words instead.
    await userEvent.click(within(row).getByRole('radio', { name: '1.1' }))
    expect(send.disabled).toBe(false)
    await userEvent.click(within(row).getByRole('radio', { name: 'In my own words' }))
    expect(send.disabled).toBe(true)
    await userEvent.type(within(row).getByRole('textbox', { name: 'Your answer, in your own words' }), '1.1, with the new pricing')
    await userEvent.click(send)
    expect(fakeApi.answerEmployeeQuestion).toHaveBeenCalledWith('t3', 'q1', '1.1, with the new pricing')
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Answer sent. Max goes on with the task.'))
  })

  it('says why a second answer was refused, and takes a question without options in your own words', async () => {
    const asking = task({ id: 't3', state: 'waiting', waitingOn: 'person', question: { id: 'q1', question: 'What tone?', options: [], runId: 'r1', askedAt: NOW } })
    setSnapshot({ work: { ...work, tasks: [asking] } })
    fakeApi.answerEmployeeQuestion = vi.fn(async () => {
      throw new Error('This question was already answered. Each question takes one answer; its task went on with the first.')
    })
    render(<EmployeesNeedYou orgId="o1" />)
    expect(screen.queryByRole('radio')).toBeNull()
    await userEvent.type(screen.getByRole('textbox', { name: 'Your answer' }), 'Casual')
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already answered')
  })

  it('lists memory proposals with who proposed what and why, with Keep and Retire', async () => {
    const proposals = [
      { id: 'p1', orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append' as const, text: '- 2026-11-13: We launch on Thursdays.\n', employeeId: 'e-max1', runId: 'r1', taskId: 't1', why: 'A fact for the whole organization goes in memory/org/PROJECT.md, which a person keeps.', createdAt: NOW },
      { id: 'p2', orgId: 'o1', path: 'memory/org/instructions.md', kind: 'write' as const, text: 'Be brief.', expectedBlob: 'abc', employeeId: 'e-max1', runId: 'r1', createdAt: NOW }
    ]
    setSnapshot({ work: { ...work, tasks: [], proposals } })
    fakeApi.keepMemoryProposal = vi.fn(async () => ({ ok: true, commit: 'c1' }))
    render(<EmployeesNeedYou orgId="o1" />)
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Memory proposals · 2' })
    const [first, second] = within(list).getAllByRole('listitem')
    expect(within(first).getByText('Max proposes adding to memory/org/PROJECT.md')).toBeTruthy()
    expect(within(first).getByText(/which a person keeps/)).toBeTruthy()
    expect(within(first).getByLabelText('Proposed text for memory/org/PROJECT.md').textContent).toBe('- 2026-11-13: We launch on Thursdays.\n')
    expect(within(second).getByText('Max proposes a new version of memory/org/instructions.md')).toBeTruthy()
    await userEvent.click(within(first).getByRole('button', { name: 'Keep' }))
    expect(fakeApi.keepMemoryProposal).toHaveBeenCalledWith('o1', 'p1')
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Kept: memory/org/PROJECT.md is updated.'))
    await userEvent.click(within(second).getByRole('button', { name: 'Retire' }))
    expect(fakeApi.retireMemoryProposal).toHaveBeenCalledWith('o1', 'p2')
    // Keep refused because the file moved on: it says so, and the proposal stays.
    fakeApi.keepMemoryProposal = vi.fn(async () => ({ ok: false, path: 'memory/org/instructions.md', conflict: { blob: 'b', text: 'x' } }))
    await userEvent.click(within(second).getByRole('button', { name: 'Keep' }))
    expect((await within(second).findByRole('alert')).textContent).toContain('memory/org/instructions.md changed since this was proposed')
  })

  it('shows a partial result, and Foreman’s when a run ended without one, as neither done nor failed', () => {
    const partial = task({ id: 't4', title: 'Posts', state: 'closed', closureReason: 'blocked', closureDetail: 'Partly done; left: the pricing post', result: { status: 'partial', summary: 'Two of three', runId: 'r1', at: NOW } })
    const synthetic = task({ id: 't5', title: 'Notes', state: 'closed', closureReason: 'blocked', result: { status: 'partial', summary: 'x', synthetic: true, runId: 'r1', at: NOW } })
    render(
      <ul>
        <TaskRow task={partial} runs={[]} />
        <TaskRow task={synthetic} runs={[]} />
      </ul>
    )
    expect(screen.getByText('Partly done')).toBeTruthy()
    expect(screen.getByText('Ended without a result')).toBeTruthy()
    // Both can be retried.
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2)
  })

  it('shows each employee’s current task in the sidebar, Working while it runs, and one Needs you state when a task waits', () => {
    // Only running: Working, with the task under the name.
    setSnapshot({ work: { ...work, tasks: [task()] } })
    const { unmount } = render(<TeamSection />)
    const running = screen.getByRole('button', { name: /Max/ })
    expect(within(running).getByText('On: Draft the launch post')).toBeTruthy()
    expect(within(running).getByText('Working')).toBeTruthy()
    unmount()
    // A task waits for the person as well: one state (Needs you, its count), and the line says what waits.
    setSnapshot({ work })
    render(<TeamSection />)
    const row = screen.getByRole('button', { name: /Max/ })
    expect(within(row).getByText('Needs you · 1')).toBeTruthy()
    expect(within(row).getByText(/^Waiting for you: Fix the README/)).toBeTruthy()
    expect(within(row).queryByText('Working')).toBeNull()
    expect(row.querySelectorAll('.ui-status')).toHaveLength(1)
  })

  it('lays the sidebar row out as a hat beside the name and role, the task line under them, and one state (the real-app fixes)', () => {
    const long = 'Draft the launch post for 1.0.23 with every change since 1.0.22 and the changelog email'
    // A waiting employee: one glyph and one word, never “Idle” beside “Waiting for you”.
    setSnapshot({ work: { tasks: [task({ title: long, state: 'waiting', waitingOn: 'person', reason: 'Asks: which version?' })], runs: [], last: {}, proposals: [], revision: 1 } })
    render(<TeamSection />)
    const row = screen.getByRole('button', { name: /Max/ })
    // (a) The button is the grid the hat and both lines sit in: the hat, the name-and-role line and the state-and-task line
    // are its own children.
    expect(row.classList.contains('team-row-main')).toBe(true)
    const [hat, who, line] = Array.from(row.children)
    expect(hat.tagName.toLowerCase()).toBe('svg')
    expect(who.classList.contains('team-row-who')).toBe(true)
    expect(line.classList.contains('team-row-line')).toBe(true)
    // (b) Name and role share the first line; the state and then the task are the line under them, the task the part that truncates.
    expect(who.querySelector('.team-row-name')?.textContent).toBe('Max')
    expect(who.querySelector('.team-row-role')?.textContent).toBe('Marketing')
    const [state, doing] = Array.from(line.children)
    expect(doing.classList.contains('team-row-doing')).toBe(true)
    expect(doing.textContent).toContain(long)
    expect(doing.getAttribute('title')).toContain(long)
    // (c) One state: Needs you with its glyph.
    expect(state.classList.contains('ui-status')).toBe(true)
    expect(row.querySelectorAll('.ui-status')).toHaveLength(1)
    expect(row.querySelectorAll('svg.ui-glyph, .ui-glyph')).toHaveLength(1)
    expect(within(row).getByText('Needs you · 1')).toBeTruthy()
    expect(within(row).queryByText('Idle')).toBeNull()
  })

  it('keeps the sidebar row a grid with the app’s stylesheets in the app’s order, so the hat sits beside the name', () => {
    // The earlier check passed while the app showed the hat on a line of its own: jsdom loads no stylesheet, and in the
    // app ui/ui.css comes after every feature sheet (main.tsx), so `.ui-pressable { display: block }` beat a lone
    // `.team-row-main { display: flex }` of the same weight. Load them as the app does and ask for the computed layout.
    const sheets = [readFileSync('src/renderer/src/components/employees/employees.css', 'utf8'), uiStylesheet()]
    const styles = sheets.map((css) => {
      const style = document.createElement('style')
      style.textContent = css
      document.head.append(style)
      return style
    })
    try {
      setSnapshot({ work: { ...work, tasks: [task()] } })
      render(<TeamSection />)
      const row = screen.getByRole('button', { name: /Max/ })
      const [hat, who, line] = Array.from(row.children)
      expect(getComputedStyle(row).display).toBe('grid')
      // The hat in the first column, beside the name; the name and the state-and-task line in the second, one under the other.
      expect(getComputedStyle(hat).gridColumn).toBe('1')
      expect(getComputedStyle(hat).gridRow).toBe('1')
      expect(getComputedStyle(who).gridColumn).toBe('2')
      expect(getComputedStyle(who).gridRow).toBe('1')
      expect(getComputedStyle(line).gridColumn).toBe('2')
      // Each line stays one line: the task gives way (ellipsis), never the name or the state.
      for (const el of [who, line]) {
        expect(getComputedStyle(el).display).toBe('flex')
        expect(getComputedStyle(el).whiteSpace).toBe('nowrap')
      }
      const doing = line.querySelector('.team-row-doing')!
      expect(getComputedStyle(doing).textOverflow).toBe('ellipsis')
      expect(getComputedStyle(line.querySelector('.ui-status')!).flexShrink).toBe('0')
    } finally {
      for (const style of styles) style.remove()
    }
  })

  it('says a usage limit’s hold in words on the task, the Team card and the sidebar row, and leaves it out of Needs you', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 13, 10, 0))
      const reset = new Date(2026, 10, 13, 23, 30).toISOString()
      const held = task({ title: 'Weekly report', state: 'open', hold: 'usage-limit', reason: `Waiting for the usage limit to reset at ${reset}. It runs again then, as a fresh run.`, limitHold: { agent: 'claude', resetAt: reset, retryAt: reset } })
      const view: EmployeeWorkView = { tasks: [held], runs: [run({ state: 'queued', attempt: 2, started: false })], last: {}, proposals: [], revision: 1 }
      setSnapshot({ work: view })
      // The task: its state and when it goes again, in this computer's time; Cancel stays, Retry isn't needed.
      const { unmount } = render(
        <ul>
          <TaskRow task={held} runs={view.runs} />
        </ul>
      )
      expect(screen.getByText('Held: usage limit')).toBeTruthy()
      expect(screen.getByText('Waiting for the usage limit to reset at 23:30')).toBeTruthy()
      expect(screen.queryByText(/2026-11-13T/)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Cancel task' })).toBeTruthy()
      unmount()
      // The sidebar row: the line says it, and the state isn't Needs you (it clears itself).
      const side = render(<TeamSection />)
      const row = screen.getByRole('button', { name: /Max/ })
      expect(within(row).getByText('Held: Weekly report. Waiting for the usage limit to reset at 23:30')).toBeTruthy()
      expect(within(row).getByText('Idle')).toBeTruthy()
      expect(within(row).queryByText(/Needs you/)).toBeNull()
      side.unmount()
      // The Team card says it too, with the work queued and nothing needing the person.
      const card = render(<TeamPage orgId="o1" data={{ employees: [], error: '', reload: vi.fn() }} />)
      const [teamCard] = screen.getAllByRole('listitem').filter((li) => li.classList.contains('employee-card'))
      expect(within(teamCard).getByText('Held: Weekly report. Waiting for the usage limit to reset at 23:30')).toBeTruthy()
      expect(within(teamCard).getByText('1 queued')).toBeTruthy()
      expect(within(teamCard).queryByText(/Needs you/)).toBeNull()
      card.unmount()
      // Needs you doesn't list it.
      const needs = render(<EmployeesNeedYou orgId="o1" />)
      expect(needs.container.textContent).toBe('')
      needs.unmount()
      // A reset tomorrow says so; one Foreman wasn't told says when it tries again.
      const tomorrow = new Date(2026, 10, 14, 9, 0).toISOString()
      const retry = new Date(2026, 10, 13, 10, 15).toISOString()
      render(
        <ul>
          <TaskRow task={{ ...held, id: 't2', limitHold: { agent: 'claude', resetAt: tomorrow, retryAt: tomorrow } }} runs={[]} />
          <TaskRow task={{ ...held, id: 't3', limitHold: { agent: 'claude', retryAt: retry } }} runs={[]} />
        </ul>
      )
      expect(screen.getByText('Waiting for the usage limit to reset tomorrow at 09:00')).toBeTruthy()
      expect(screen.getByText('Waiting for the usage limit to reset. Foreman wasn’t told when, so it tries again at 10:15.')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says Needs you in the sidebar for an employee paused after two failing runs, and lists it in Needs you with Resume', async () => {
    const user = userEvent.setup()
    fakeApi.resumeEmployee = vi.fn(async () => undefined)
    setSnapshot({ employees: [summary({ state: 'paused', pausedKind: 'failures', pausedDetail: 'Stopped after the maximum of 30 minutes.' })], work: { tasks: [], runs: [], last: {}, proposals: [], revision: 1 } })
    const { unmount } = render(<TeamSection />)
    expect(within(screen.getByRole('button', { name: /Max/ })).getByText('Needs you · 1')).toBeTruthy()
    unmount()
    render(<EmployeesNeedYou orgId="o1" />)
    expect(screen.getByText('Max is paused: two runs in a row didn’t finish')).toBeTruthy()
    expect(screen.getByText(/The last: Stopped after the maximum of 30 minutes\./)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(fakeApi.resumeEmployee).toHaveBeenCalledWith('o1', 'e-max1')
  })

  it('marks a workspace an employee’s run made with its hat, its task and Stop, Retry or Cancel', async () => {
    const ws: Workspace = { id: 'ws-1', repoId: 'site', name: 'ws', branch: 'b', baseBranch: 'main', path: '', portBase: 1, state: 'ready', createdAt: NOW, startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e-max1', runId: 'r1', taskId: 't1', title: 'Draft the launch post' } }
    setSnapshot({ work, workspaces: [ws] })
    const { unmount } = render(<EmployeeRunBanner ws={ws} />)
    expect(screen.getByText('Max’s run')).toBeTruthy()
    expect(screen.getByText('Task: Draft the launch post')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(fakeApi.stopEmployeeRun).toHaveBeenCalledWith('r1')
    await userEvent.click(screen.getByRole('button', { name: 'Open Max' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-max1' })
    unmount()
    // Its task now waits for a person: Retry and Cancel instead of Stop.
    const waiting = { ...ws, startedBy: { ...ws.startedBy!, taskId: 't2', runId: 'r-old' } } as Workspace
    setSnapshot({ work, workspaces: [waiting] })
    const second = render(<EmployeeRunBanner ws={waiting} />)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(fakeApi.retryEmployeeTask).toHaveBeenCalledWith('t2')
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeTruthy()
    second.unmount()
    // A workspace no employee started: nothing.
    setSnapshot({ work, workspaces: [ws] })
    const { container } = render(<EmployeeRunBanner ws={{ ...ws, startedBy: undefined }} />)
    expect(container.textContent).toBe('')
  })
})
