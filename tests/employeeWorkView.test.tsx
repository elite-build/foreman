// @vitest-environment jsdom
// An AI employee's work in the window (docs/ai-employees.md §6, §10): Ask <name>… on one line, with its repository
// limited to the ones the employee may work in, and Run now; the Tasks and Runs tabs with each state as a glyph and a
// word, the reason a task waits or closed, and Stop, Retry and Cancel; Needs you as decision cards (a question, a task to
// retry, a memory change, an employee paused for failures); the Team page's rows of what waits; the sidebar's Team rows
// with the current task and how many need you; and the banner on a workspace an employee's run made.
import './domShims'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeAction } from '../src/shared/employeeActions'
import type { EmployeeRun, EmployeeTask, EmployeeWorkView } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeSummary } from '../src/shared/employees'
import type { Workspace } from '../src/shared/types'
import { AskEmployee, EmployeeRuns, EmployeesNeedYou, EmployeeTasks, TaskRow } from '../src/renderer/src/components/employees/EmployeeWork'
import { EmployeeRunBanner } from '../src/renderer/src/components/employees/EmployeeRunBanner'
import { EmployeesView } from '../src/renderer/src/components/employees/EmployeesView'
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
// A decision card's buttons, in order (decline · alternate · main), each with its key hint.
const footButtons = (card: HTMLElement) =>
  within(card)
    .getAllByRole('button')
    .filter((b) => b.closest('.decision-foot-acts'))
    .map((b) => b.textContent?.trim())

beforeEach(() => {
  resetFake()
  for (const name of ['selectWorkspace', 'openEmployees', 'showToast']) spy(name).mockReset()
  fakeState.space = 'o1'
  // The sidebar's Team row shows its employees (folded away otherwise).
  fakeState.teamOpen = true
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
  delete fakeState.space
  delete fakeState.teamOpen
})

describe('Ask <name>… and Run now', () => {
  it('offers only the repositories the employee may work in, writers first, and asks with the words and the repository', async () => {
    setSnapshot()
    fakeApi.askEmployee = vi.fn(async () => task())
    const { unmount } = render(<AskEmployee orgId="o1" employee={summary()} definition={max} />)
    expect(screen.getByRole('heading', { name: 'Ask Max…' })).toBeTruthy()
    const repo = screen.getByRole('combobox', { name: 'Repository' }) as HTMLSelectElement
    expect([...repo.options].map((o) => o.textContent)).toEqual(['site · Write', 'api · Read'])
    // Ask is always there to press: an empty ask says what is missing, where it is typed, and sends nothing.
    const ask = screen.getByRole('button', { name: /^Ask/ }) as HTMLButtonElement
    expect(ask.disabled).toBe(false)
    expect(ask.textContent).toContain('Ctrl+Enter')
    await userEvent.click(ask)
    expect(screen.getByText('Say what Max should do first.')).toBeTruthy()
    expect(fakeApi.askEmployee).not.toHaveBeenCalled()
    const box = screen.getByRole('textbox', { name: 'Ask Max…' }) as HTMLInputElement
    await userEvent.type(box, 'Draft the launch post')
    expect(screen.queryByText('Say what Max should do first.')).toBeNull()
    await userEvent.selectOptions(repo, 'api')
    await userEvent.click(ask)
    expect(fakeApi.askEmployee).toHaveBeenCalledWith('o1', 'e-max1', { body: 'Draft the launch post', repoId: 'api' })
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Asked Max: Draft the launch post'))
    expect(box.value).toBe('')
    // Ctrl+Enter in the line asks too.
    await userEvent.type(box, 'Fix the README')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(fakeApi.askEmployee).toHaveBeenLastCalledWith('o1', 'e-max1', { body: 'Fix the README', repoId: 'api' })
    unmount()
    // With one repository to work in, there is nothing to choose.
    render(<AskEmployee orgId="o1" employee={summary()} definition={{ ...max, access: { ...max.access, repos: { site: 'write' as const } } }} />)
    expect(screen.queryByRole('combobox', { name: 'Repository' })).toBeNull()
  })

  it('Run now asks for the standing responsibilities, and says when the work was held or refused', async () => {
    setSnapshot()
    fakeApi.runEmployeeNow = vi.fn(async () => task({ state: 'open', hold: 'queued', reason: 'Waiting for Max’s current run to finish.' }))
    render(<AskEmployee orgId="o1" employee={summary()} definition={max} />)
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(fakeApi.runEmployeeNow).toHaveBeenCalledWith('o1', 'e-max1', { repoId: 'site' })
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Max runs it later: Waiting for Max’s current run to finish.'))
    fakeApi.askEmployee = vi.fn(async () => task({ state: 'waiting', reason: 'Max has had 6 runs today, its limit.' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Ask Max…' }), 'More')
    await userEvent.click(screen.getByRole('button', { name: /^Ask/ }))
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Max can’t run it yet: Max has had 6 runs today, its limit.'))
  })

  it('says why it can’t be asked while it is a draft or changed since approval, and that a paused one’s work waits', () => {
    setSnapshot()
    const { unmount } = render(<AskEmployee orgId="o1" employee={summary({ state: 'draft' })} definition={max} />)
    expect(screen.getByText('Approve Max on this computer before asking it to do anything.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Ask/ })).toBeNull()
    unmount()
    const second = render(<AskEmployee orgId="o1" employee={summary({ changed: true })} definition={max} />)
    expect(screen.getByText(/changed since it was approved/)).toBeTruthy()
    second.unmount()
    render(<AskEmployee orgId="o1" employee={summary({ state: 'paused' })} definition={max} />)
    expect(screen.getByText('Max is paused: what you ask waits, and runs when you resume it.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Ask/ })).toBeTruthy()
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
    // Done: no action, only its history (its chain and receipts) to open.
    expect(within(rows[2]).queryAllByRole('button').map((b) => b.textContent)).toEqual(['History'])
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

  it('lists the organization’s tasks that wait for a person as cards, with Retry and Cancel', async () => {
    setSnapshot({ work })
    render(<EmployeesNeedYou orgId="o1" />)
    expect(screen.getByRole('heading', { name: 'Needs you · 1' })).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Tasks in Acme waiting for you' })
    const [item] = within(list).getAllByRole('listitem')
    const card = within(item).getByRole('group', { name: 'Fix the README' })
    expect(card.querySelector('.decision-head')?.textContent).toMatch(/^Needs you\s*·\s*Max\s*·\s*Task/)
    expect(within(card).getByText('Stopped: it asked for permission to use Bash.')).toBeTruthy()
    expect(within(card).getByText('Retry starts Max on it again, in a fresh run.')).toBeTruthy()
    // Cancel task… declines (Esc), Retry is the main act (Enter): both stay on this computer.
    expect(footButtons(card)).toEqual(['Cancel task… Esc', 'Retry Enter'])
    await userEvent.click(within(card).getByRole('button', { name: /^Retry/ }))
    expect(fakeApi.retryEmployeeTask).toHaveBeenCalledWith('t2')
    await userEvent.click(within(card).getByRole('button', { name: /^Cancel task…/ }))
    expect(fakeApi.cancelEmployeeTask).toHaveBeenCalledWith('t2')
    // Enter on the card retries, as its key says.
    card.focus()
    await userEvent.keyboard('{Enter}')
    expect(fakeApi.retryEmployeeTask).toHaveBeenCalledTimes(2)
  })

  it('shows an employee’s question with its options and an answer in your own words; one answer, never Retry', async () => {
    const asking = task({ id: 't3', title: 'Write the launch post', state: 'waiting', waitingOn: 'person', reason: 'Which launch: 1.0.23 or 1.1?', question: { id: 'q1', question: 'Which launch: 1.0.23 or 1.1?', options: ['1.0.23', '1.1'], runId: 'r1', askedAt: NOW } })
    setSnapshot({ work: { ...work, tasks: [asking] } })
    fakeApi.answerEmployeeQuestion = vi.fn(async () => ({ ...asking, state: 'running' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const [item] = within(screen.getByRole('list', { name: 'Tasks in Acme waiting for you' })).getAllByRole('listitem')
    const card = within(item).getByRole('group', { name: 'Which launch: 1.0.23 or 1.1?' })
    expect(card.querySelector('.decision-head')?.textContent).toMatch(/^Needs you\s*·\s*Max\s*·\s*Question/)
    // The employee's words, once, in words around them.
    expect(within(card).getByText('Max asks: Which launch: 1.0.23 or 1.1?')).toBeTruthy()
    expect(within(card).getByText('Max carries on as soon as you answer.')).toBeTruthy()
    expect(within(card).queryByText(/never approves anything/)).toBeNull()
    // A question waits for its answer, not a retry; it can still be canceled, from More.
    expect(within(card).queryByRole('button', { name: /^Retry/ })).toBeNull()
    expect(footButtons(card)).toEqual(['Send answer Enter'])
    await userEvent.click(within(card).getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitem', { name: 'Cancel task…' })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    const send = within(card).getByRole('button', { name: /^Send answer/ }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    // An option (by its key too), then the person's own words instead.
    card.focus()
    await userEvent.keyboard('1')
    expect((within(card).getByRole('radio', { name: '1.0.23' }) as HTMLInputElement).checked).toBe(true)
    expect(send.disabled).toBe(false)
    await userEvent.click(within(card).getByRole('radio', { name: '1.1' }))
    expect(send.disabled).toBe(false)
    await userEvent.click(within(card).getByRole('radio', { name: 'In my own words' }))
    expect(send.disabled).toBe(true)
    await userEvent.type(within(card).getByRole('textbox', { name: 'Your answer, in your own words' }), '1.1, with the new pricing')
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
    await userEvent.click(screen.getByRole('button', { name: /^Send answer/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('already answered')
  })

  it('shows memory proposals as cards with the employee’s own reason, the change, and Discard or Add', async () => {
    const proposals = [
      { id: 'p1', orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append' as const, text: '- 2026-11-13: We launch on Thursdays.\n', employeeId: 'e-max1', runId: 'r1', taskId: 't1', why: 'Every launch this year went out on a Thursday.', createdAt: NOW },
      { id: 'p2', orgId: 'o1', path: 'memory/org/instructions.md', kind: 'write' as const, text: 'Be brief.', expectedBlob: 'abc', employeeId: 'e-max1', runId: 'r1', createdAt: NOW }
    ]
    setSnapshot({ work: { ...work, tasks: [task()], proposals } })
    fakeApi.keepMemoryProposal = vi.fn(async () => ({ ok: true, commit: 'c1' }))
    render(<EmployeesNeedYou orgId="o1" />)
    expect(screen.getByRole('heading', { name: 'Needs you · 2' })).toBeTruthy()
    const first = screen.getByRole('group', { name: 'Add to PROJECT.md' })
    const second = screen.getByRole('group', { name: 'Change instructions.md' })
    expect(first.querySelector('.decision-head')?.textContent).toMatch(/^Needs you\s*·\s*Max\s*·\s*Memory change/)
    // The employee's own reason and the task it came from; never Foreman's routing rule.
    expect(within(first).getByText('Max: “Every launch this year went out on a Thursday.”')).toBeTruthy()
    expect(within(first).getByText('From “Draft the launch post”')).toBeTruthy()
    expect(within(first).getByText('memory/org/PROJECT.md')).toBeTruthy()
    expect(within(first).getByLabelText('Proposed text for memory/org/PROJECT.md').textContent).toBe('+ Added: - 2026-11-13: We launch on Thursdays.')
    expect(within(first).getByText('Adds these lines to PROJECT.md in acme-memory, as your commit. Nothing leaves this computer.')).toBeTruthy()
    await userEvent.click(within(first).getByRole('button', { name: 'Open in the Memory view' }))
    expect(spy('openMemory')).toHaveBeenCalledWith('o1')
    // One without a reason says none; a new version shows the whole text.
    expect(within(second).queryByText(/^Max: “/)).toBeNull()
    expect(within(second).getByLabelText('Proposed text for memory/org/instructions.md').textContent).toBe('Be brief.')
    // Discard (Esc) · Add (Enter): Keep and Retire are gone.
    expect(footButtons(first)).toEqual(['Discard Esc', 'Add to PROJECT.md Enter'])
    expect(footButtons(second)).toEqual(['Discard Esc', 'Change instructions.md Enter'])
    expect(screen.queryByRole('button', { name: /^(Keep|Retire)/ })).toBeNull()
    await userEvent.click(within(first).getByRole('button', { name: /^Add to PROJECT\.md/ }))
    expect(fakeApi.keepMemoryProposal).toHaveBeenCalledWith('o1', 'p1')
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Added: memory/org/PROJECT.md is updated.'))
    await userEvent.click(within(second).getByRole('button', { name: /^Discard/ }))
    expect(fakeApi.retireMemoryProposal).toHaveBeenCalledWith('o1', 'p2')
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Discarded: nothing was written to memory/org/instructions.md.'))
    // Adding refused because the file moved on: it says so, and the proposal stays.
    fakeApi.keepMemoryProposal = vi.fn(async () => ({ ok: false, path: 'memory/org/instructions.md', conflict: { blob: 'b', text: 'x' } }))
    await userEvent.click(within(second).getByRole('button', { name: /^Change instructions\.md/ }))
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
    expect(within(row).getByText(/^Needs you: Fix the README/)).toBeTruthy()
    expect(within(row).queryByText('Working')).toBeNull()
    expect(row.querySelectorAll('.ui-status')).toHaveLength(1)
  })

  it('lays the sidebar row out as a hat beside the name and role, the task line under them, and one state (the real-app fixes)', () => {
    const long = 'Draft the launch post for 1.0.23 with every change since 1.0.22 and the changelog email'
    // A waiting employee: one glyph and one word, never “Idle” beside “Waiting for you”.
    setSnapshot({ work: { tasks: [task({ title: long, state: 'waiting', waitingOn: 'person', reason: 'which version?' })], runs: [], last: {}, proposals: [], revision: 1 } })
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
      expect(within(row).getByText('Held: Weekly report · Waiting for the usage limit to reset at 23:30')).toBeTruthy()
      expect(within(row).getByText('Idle')).toBeTruthy()
      expect(within(row).queryByText(/Needs you/)).toBeNull()
      side.unmount()
      // The Team card has its one state, with the work queued and nothing needing the person.
      const card = render(<TeamPage orgId="o1" data={{ employees: [], error: '', reload: vi.fn() }} />)
      const [teamCard] = screen.getAllByRole('listitem').filter((li) => li.classList.contains('employee-card'))
      expect(within(teamCard).getByText('Idle')).toBeTruthy()
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
    expect(screen.getByRole('heading', { name: 'Needs you · 1' })).toBeTruthy()
    const card = screen.getByRole('group', { name: 'Max is paused: two runs in a row didn’t finish' })
    expect(card.querySelector('.decision-head')?.textContent).toMatch(/Paused/)
    expect(within(card).getByText(/The last: Stopped after the maximum of 30 minutes\./)).toBeTruthy()
    expect(within(card).getByText('Resume lets Max run again; what waited for it runs then.')).toBeTruthy()
    expect(footButtons(card)).toEqual(['Resume Enter'])
    await user.click(within(card).getByRole('button', { name: /^Resume/ }))
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
    // While its run goes, Cancel isn't offered: Stop is.
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    unmount()
    // Its task now waits for a person: the banner says Needs you with what, and opens the same card under it, with Retry
    // there (not beside Stop, which is gone); Cancel task… is under More.
    const waiting = { ...ws, startedBy: { ...ws.startedBy!, taskId: 't2', runId: 'r-old' } } as Workspace
    setSnapshot({ work, workspaces: [waiting] })
    const second = render(<EmployeeRunBanner ws={waiting} />)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByText('Needs you · Task')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull()
    const review = screen.getByRole('button', { name: 'Review…' })
    expect(review.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(review)
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded')).toBe('true')
    const card = screen.getByRole('group', { name: 'Fix the README' })
    await userEvent.click(within(card).getByRole('button', { name: /^Retry/ }))
    expect(fakeApi.retryEmployeeTask).toHaveBeenCalledWith('t2')
    const banner = screen.getByRole('status')
    await userEvent.click(within(banner).getByRole('button', { name: 'More' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel task…' }))
    expect(fakeApi.cancelEmployeeTask).toHaveBeenCalledWith('t2')
    second.unmount()
    // A push the run asked for waits: the banner says so, never the task's own word (Done), and Review… opens its card.
    const done = task({ state: 'closed', closureReason: 'done' })
    const held: EmployeeAction = { id: 'a1', orgId: 'o1', employeeId: 'e-max1', taskId: 't1', runId: 'r1', repoId: 'site', kind: 'push', payload: { kind: 'push', workspaceId: 'ws-1', branch: 'max/launch', base: 'main', head: 'abc', ahead: 1, commits: [], connection: 'gh' }, policy: 'held', state: 'held', key: 'k1', createdAt: NOW, updatedAt: NOW }
    setSnapshot({ work: { tasks: [done], runs: [], last: {}, proposals: [], actions: [held], revision: 4 }, workspaces: [ws] })
    const third = render(<EmployeeRunBanner ws={ws} />)
    expect(screen.getByText('Needs you · Push')).toBeTruthy()
    expect(screen.queryByText('Done')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Review…' }))
    expect(screen.getByRole('group', { name: 'Push max/launch to site' })).toBeTruthy()
    third.unmount()
    // A workspace no employee started: nothing.
    setSnapshot({ work, workspaces: [ws] })
    const { container } = render(<EmployeeRunBanner ws={{ ...ws, startedBy: undefined }} />)
    expect(container.textContent).toBe('')
  })
})

describe('the Team rows say what waits for you, once', () => {
  const push = (patch: Partial<EmployeeAction> = {}): EmployeeAction => ({
    id: 'a1',
    orgId: 'o1',
    employeeId: 'e-max1',
    taskId: 't1',
    runId: 'r1',
    repoId: 'site',
    kind: 'push',
    payload: { kind: 'push', workspaceId: 'ws-1', branch: 'max/launch-2.4', base: 'main', head: 'abc1234', ahead: 2, commits: [], connection: 'gh' },
    policy: 'held',
    state: 'held',
    key: 'k1',
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  })

  it('says an employee’s question once, in words around it, with no reason from main beside it', () => {
    const asking = task({ title: 'Which day does 2.4 launch?', state: 'waiting', waitingOn: 'person', reason: 'Which day does Atlas 2.4 launch?', question: { id: 'q1', question: 'Which day does Atlas 2.4 launch?', options: [], runId: 'r1', askedAt: NOW } })
    setSnapshot({ work: { tasks: [asking], runs: [], last: {}, proposals: [], revision: 1 } })
    const { unmount } = render(<TeamSection />)
    const line = screen.getByRole('button', { name: /Max/ }).querySelector('.team-row-doing')!
    expect(line.textContent).toBe('Needs you: Which day does Atlas 2.4 launch?')
    expect(line.textContent).not.toContain('?.')
    unmount()
    // The Team card: Needs you, and the question once, as a row that opens into its card.
    render(<TeamPage orgId="o1" data={{ employees: [], error: '', reload: vi.fn() }} />)
    const [card] = screen.getAllByRole('listitem').filter((li) => li.classList.contains('employee-card'))
    expect(within(card).getByText('Needs you · 1')).toBeTruthy()
    const rows = within(card).getByRole('list', { name: 'What of Max needs you' })
    expect(within(rows).getAllByText('Which day does Atlas 2.4 launch?')).toHaveLength(1)
    expect(rows.textContent).not.toContain('?.')
    expect(within(rows).getByRole('button', { name: 'Answer…' })).toBeTruthy()
  })

  it('gives the reason for a held outward action and for a memory proposal, on the row and the card', async () => {
    setSnapshot({ work: { tasks: [], runs: [], last: {}, proposals: [], actions: [push()], revision: 1 } })
    const first = render(<TeamSection />)
    const row = screen.getByRole('button', { name: /Max/ })
    expect(within(row).getByText('Needs you · 1')).toBeTruthy()
    expect(within(row).getByText('Needs you: Push of max/launch-2.4')).toBeTruthy()
    first.unmount()
    // The Team card: a row for the push, whose button only opens it (it leaves this computer), and the card it opens.
    const card = render(<TeamPage orgId="o1" data={{ employees: [], error: '', reload: vi.fn() }} />)
    const [teamCard] = screen.getAllByRole('listitem').filter((li) => li.classList.contains('employee-card'))
    expect(within(teamCard).getByText('Needs you · 1')).toBeTruthy()
    const rows = within(teamCard).getByRole('list', { name: 'What of Max needs you' })
    expect(within(rows).getByText('Push')).toBeTruthy()
    expect(rows.textContent).toContain('Push max/launch-2.4 to site')
    await userEvent.click(within(rows).getByRole('button', { name: 'Review…' }))
    expect(fakeApi.sendEmployeeAction).toBeUndefined()
    expect(within(rows).getByText('Pushes 2 commits of max/launch-2.4 to origin (site) as gh. It leaves this computer and can’t be undone.')).toBeTruthy()
    expect(within(rows).getByRole('button', { name: 'Push branch' })).toBeTruthy()
    card.unmount()
    const proposal = { id: 'p1', orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append' as const, text: '- Thursdays.', employeeId: 'e-max1', runId: 'r1', createdAt: NOW }
    setSnapshot({ work: { tasks: [], runs: [], last: {}, proposals: [proposal], revision: 1 } })
    const side = render(<TeamSection />)
    expect(within(screen.getByRole('button', { name: /Max/ })).getByText('Proposes a memory change: memory/org/PROJECT.md')).toBeTruthy()
    side.unmount()
    // On the Team page, a change for the whole organization is in its own strip, not on Max's card, and its row's button
    // adds it at once (it stays on this computer).
    fakeApi.keepMemoryProposal = vi.fn(async () => ({ ok: true, commit: 'c1' }))
    render(<TeamPage orgId="o1" data={{ employees: [], error: '', reload: vi.fn() }} />)
    expect(screen.getByRole('heading', { name: 'For all of Acme · 1' })).toBeTruthy()
    const shared = screen.getByRole('list', { name: 'Waiting for you from all of Acme' })
    expect(within(shared).getByText('Memory change')).toBeTruthy()
    const [maxCard] = screen.getAllByRole('listitem').filter((li) => li.classList.contains('employee-card'))
    expect(within(maxCard).queryByRole('list', { name: 'What of Max needs you' })).toBeNull()
    await userEvent.click(within(shared).getByRole('button', { name: 'Add to PROJECT.md' }))
    expect(fakeApi.keepMemoryProposal).toHaveBeenCalledWith('o1', 'p1')
  })

  it('keeps the Team page open on Escape while an answer is typed, with focus on a button, and closes it once nothing is', async () => {
    const user = userEvent.setup()
    const close = storeModule.closeEmployees as ReturnType<typeof vi.fn>
    close.mockReset()
    fakeApi.listEmployees = vi.fn(async () => ({ employees: [] }))
    const asking = task({ state: 'waiting', waitingOn: 'person', question: { id: 'q1', question: 'Which launch?', options: [], runId: 'r1', askedAt: NOW } })
    setSnapshot({ work: { tasks: [asking], runs: [], last: {}, proposals: [], revision: 1 } })
    render(<EmployeesView route={{ orgId: 'o1', page: 'team' }} />)
    // The question is a row on Max's card; Answer… opens it.
    await user.click(screen.getByRole('button', { name: 'Answer…' }))
    const answer = screen.getByRole('textbox', { name: 'Your answer' })
    await user.type(answer, '1.1, on Thursday')
    // Focus moves to a button outside the card, where the field's own Escape no longer applies.
    const outside = screen.getByRole('button', { name: 'New employee' })
    outside.focus()
    await user.keyboard('{Escape}')
    expect(close).not.toHaveBeenCalled()
    expect((answer as HTMLTextAreaElement).value).toBe('1.1, on Thursday')
    await user.clear(answer)
    // Inside the card, Escape is the card's: it never closes the page around it.
    screen.getByRole('button', { name: /^Send answer/ }).focus()
    await user.keyboard('{Escape}')
    expect(close).not.toHaveBeenCalled()
    outside.focus()
    await user.keyboard('{Escape}')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('draws a draft with its own shape, never Working’s', () => {
    setSnapshot({ employees: [summary({ state: 'draft' }), summary({ id: 'e-ada1', name: 'Ada', colour: 'teal' })], work: { tasks: [task({ employeeId: 'e-ada1' })], runs: [], last: {}, proposals: [], revision: 1 } })
    render(<TeamSection />)
    const draft = screen.getByRole('button', { name: /Max/ }).querySelector('.ui-status')!
    const working = screen.getByRole('button', { name: /Ada/ }).querySelector('.ui-status')!
    expect(draft.textContent).toBe('Draft')
    expect(working.textContent).toBe('Working')
    expect(draft.querySelector('.ui-glyph')!.getAttribute('data-glyph')).not.toBe(working.querySelector('.ui-glyph')!.getAttribute('data-glyph'))
  })
})
