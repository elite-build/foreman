// @vitest-environment jsdom
// An AI employee's outward actions in the window (docs/ai-employees.md §6.6, §9): Needs you shows each held action's
// exact preview (Slack: channel and text; Linear: issue and change; a push: branch and commits ahead; a pull request:
// title, description, base ← branch and diff stat) with Send, Edit then send (the words only) and Skip; one Foreman isn't
// sure was sent asks for a check first; a task's chain lists its actions; the Team page says what was decided for you
// and which can't be undone, or that nothing was; and the approval plan says each class's rule, and that a shell isn't held.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeAction, EmployeeActionPayload } from '../src/shared/employeeActions'
import type { EmployeeTask, EmployeeWorkView } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeSummary } from '../src/shared/employees'
import { EmployeesNeedYou, TaskChain } from '../src/renderer/src/components/employees/EmployeeWork'
import { ActionRules, DecidedForYou } from '../src/renderer/src/components/employees/HeldActions'
import { ApproveDialog } from '../src/renderer/src/components/employees/ApproveDialog'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const original = fakeState.snapshot
const NOW = '2026-11-13T10:00:00.000Z'

const summary: EmployeeSummary = { id: 'e-max1', path: 'bots/e-max1.toml', name: 'Max', role: 'Marketing', colour: 'orange', responsibilities: [], problems: [], state: 'active', changed: false }

const task: EmployeeTask = { id: 't1', orgId: 'o1', employeeId: 'e-max1', requestId: 'r1', rootId: 't1', parentId: null, title: 'Ship the launch post', body: 'Ship it', from: 'person', targetRepoId: 'site', state: 'running', createdAt: NOW, updatedAt: NOW }

const PAYLOADS: Record<string, EmployeeActionPayload> = {
  slack: { kind: 'slack-post', connectionId: 'c-slack', connection: 'Acme Slack', channel: 'C1', channelName: 'launches', text: 'We shipped 1.1' },
  linear: { kind: 'linear', connectionId: 'c-lin', connection: 'Acme Linear', tool: 'save_comment', args: { issueId: 'ENG-12', body: 'Shipped in 1.1' }, issue: 'ENG-12' },
  push: { kind: 'push', connectionId: 'c-gh', connection: 'Acme GitHub', workspaceId: 'ws-1', branch: 'max/launch', base: 'main', head: 'abc', ahead: 2, commits: [{ sha: 'abc1234', subject: 'Write the launch post' }, { sha: 'def5678', subject: 'Fix a typo' }] },
  pr: {
    kind: 'pull-request',
    connectionId: 'c-gh',
    connection: 'Acme GitHub',
    workspaceId: 'ws-1',
    branch: 'max/launch',
    base: 'main',
    head: 'abc',
    ahead: 1,
    commits: [{ sha: 'abc1234', subject: 'Write the launch post' }],
    diffStat: { files: 3, insertions: 40, deletions: 2 },
    title: 'Launch post',
    body: 'Adds the 1.1 launch post.'
  }
}

const action = (id: string, payload: EmployeeActionPayload, patch: Partial<EmployeeAction> = {}): EmployeeAction => ({
  id,
  orgId: 'o1',
  employeeId: 'e-max1',
  taskId: 't1',
  runId: 'run-1',
  repoId: 'site',
  kind: payload.kind,
  payload,
  policy: 'held',
  state: 'held',
  key: `k-${id}`,
  createdAt: NOW,
  updatedAt: NOW,
  ...patch
})

function setSnapshot(work: Partial<EmployeeWorkView>) {
  fakeState.snapshot = {
    ...original,
    repos: [
      { id: 'mem', name: 'acme-memory', rootPath: 'C:\\code\\acme-memory', defaultBranch: 'main', spaceId: 'o1' },
      { id: 'site', name: 'site', rootPath: 'C:\\code\\site', defaultBranch: 'main', spaceId: 'o1' }
    ],
    organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: NOW }],
    workspaces: [],
    employees: { o1: { head: 'h1', employees: [summary] } },
    employeeWork: { o1: { tasks: [task], runs: [], last: {}, proposals: [], revision: 1, ...work } },
    settings: { ...original.settings, aiEmployees: true }
  }
}

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const rowOf = (headline: string) => screen.getByText(headline).closest('li') as HTMLElement

beforeEach(() => {
  resetFake()
  for (const name of ['openEmployees', 'showToast']) spy(name).mockReset()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('Needs you: held outward actions', () => {
  it('previews a Slack post (channel, account, text) with Send, Edit then send and Skip', async () => {
    setSnapshot({ actions: [action('a1', PAYLOADS.slack)] })
    fakeApi.sendEmployeeAction = vi.fn(async () => action('a1', PAYLOADS.slack, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    expect(screen.getByRole('heading', { name: 'Outward actions waiting for you · 1' })).toBeTruthy()
    const row = rowOf('Max wants to post to Slack')
    expect(within(row).getByText('Held for you')).toBeTruthy()
    expect(within(row).getByText('For “Ship the launch post”')).toBeTruthy()
    expect(within(row).getByText('#launches')).toBeTruthy()
    expect(within(row).getByText('Acme Slack')).toBeTruthy()
    expect(within(row).getByText('We shipped 1.1')).toBeTruthy()
    expect(within(row).getByText('Once sent, this can’t be undone.')).toBeTruthy()
    await userEvent.click(within(row).getByRole('button', { name: 'Send' }))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a1', {})
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Sent for Max.'))
  })

  it('Edit then send changes only the words: no field for the channel', async () => {
    setSnapshot({ actions: [action('a1', PAYLOADS.slack)] })
    fakeApi.sendEmployeeAction = vi.fn(async () => action('a1', PAYLOADS.slack, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const row = rowOf('Max wants to post to Slack')
    await userEvent.click(within(row).getByRole('button', { name: 'Edit then send' }))
    expect(within(row).getAllByRole('textbox').map((b) => b.getAttribute('aria-label') ?? b.id)).toHaveLength(1)
    const text = within(row).getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(text.value).toBe('We shipped 1.1')
    expect(within(row).getByText('Only the words can change: where it goes and as whom stay as recorded.')).toBeTruthy()
    await userEvent.clear(text)
    await userEvent.type(text, 'We shipped 1.1 today')
    await userEvent.click(within(row).getByRole('button', { name: 'Send edited' }))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a1', { edits: { text: 'We shipped 1.1 today' } })
  })

  it('Skip sends nothing', async () => {
    setSnapshot({ actions: [action('a1', PAYLOADS.slack)] })
    fakeApi.skipEmployeeAction = vi.fn(async () => action('a1', PAYLOADS.slack, { state: 'skipped' }))
    render(<EmployeesNeedYou orgId="o1" />)
    await userEvent.click(within(rowOf('Max wants to post to Slack')).getByRole('button', { name: 'Skip' }))
    expect(fakeApi.skipEmployeeAction).toHaveBeenCalledWith('a1')
    expect(fakeApi.sendEmployeeAction).toBeUndefined()
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Skipped: nothing was sent for Max.'))
  })

  it('previews a Linear change: the issue, the tool and its arguments, and that it can be changed back', async () => {
    setSnapshot({ actions: [action('a2', PAYLOADS.linear)] })
    render(<EmployeesNeedYou orgId="o1" />)
    const row = rowOf('Max wants to change Linear')
    // The issue it changes, then the change: the tool and each argument it was given.
    expect(within(row).getAllByText('ENG-12')).toHaveLength(2)
    expect(within(row).getByText('save_comment')).toBeTruthy()
    expect(within(row).getByText('issueId')).toBeTruthy()
    expect(within(row).getByText('Shipped in 1.1')).toBeTruthy()
    expect(within(row).getByText('Acme Linear')).toBeTruthy()
    expect(within(row).getByText('Once sent, it can be changed back in Linear.')).toBeTruthy()
    await userEvent.click(within(row).getByRole('button', { name: 'Edit then send' }))
    expect((within(row).getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement).value).toBe('Shipped in 1.1')
  })

  it('previews a push: the branch and the commits ahead, with no Edit', () => {
    setSnapshot({ actions: [action('a3', PAYLOADS.push)] })
    render(<EmployeesNeedYou orgId="o1" />)
    const row = rowOf('Max wants to push a branch')
    expect(within(row).getByText('max/launch')).toBeTruthy()
    expect(within(row).getByText('2 commits ahead of main')).toBeTruthy()
    expect(within(row).getByText('Write the launch post')).toBeTruthy()
    expect(within(row).getByText('Fix a typo')).toBeTruthy()
    expect(within(row).getByText('Acme GitHub')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Edit then send' })).toBeNull()
    expect(within(row).getByRole('button', { name: 'Send' })).toBeTruthy()
  })

  it('previews a pull request: title, description, base ← branch, diff stat and commits; edits its title and description', async () => {
    setSnapshot({ actions: [action('a4', PAYLOADS.pr)] })
    fakeApi.sendEmployeeAction = vi.fn(async () => action('a4', PAYLOADS.pr, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const row = rowOf('Max wants to open a pull request')
    expect(within(row).getByText('Launch post')).toBeTruthy()
    expect(within(row).getByText('Adds the 1.1 launch post.')).toBeTruthy()
    expect(within(row).getByText('main ← max/launch')).toBeTruthy()
    expect(within(row).getByText('3 files, +40 −2')).toBeTruthy()
    expect(within(row).getByText('1 commit ahead of main')).toBeTruthy()
    expect(within(row).getByText('It pushes the branch first and opens the pull request as a draft.')).toBeTruthy()
    await userEvent.click(within(row).getByRole('button', { name: 'Edit then send' }))
    const title = within(row).getByRole('textbox', { name: 'Title' })
    await userEvent.type(title, ' for 1.1')
    await userEvent.click(within(row).getByRole('button', { name: 'Send edited' }))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a4', { edits: { title: 'Launch post for 1.1' } })
  })

  it('asks for a check first when Foreman isn’t sure it was sent: It arrived, or send again after checking', async () => {
    setSnapshot({ actions: [action('a5', PAYLOADS.slack, { state: 'uncertain', reason: 'Foreman closed while sending this.' })] })
    fakeApi.confirmEmployeeAction = vi.fn(async () => action('a5', PAYLOADS.slack, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const row = rowOf('Max wants to post to Slack')
    expect(within(row).getByText('Maybe sent')).toBeTruthy()
    expect(within(row).getByText('Foreman isn’t sure this was sent')).toBeTruthy()
    expect(within(row).getByText(/Check whether it arrived before anything else\. Foreman closed while sending this\./)).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Send' })).toBeNull()
    await userEvent.click(within(row).getByRole('button', { name: 'It arrived' }))
    expect(fakeApi.confirmEmployeeAction).toHaveBeenCalledWith('a5')
    await userEvent.click(within(row).getByRole('button', { name: 'It didn’t arrive: send again' }))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a5', { checked: true })
  })

  it('says why a failed one wasn’t sent, and offers Send again', async () => {
    setSnapshot({ actions: [action('a6', PAYLOADS.push, { state: 'failed', result: { error: 'The repository’s GitHub connection changed since this was recorded.' } })] })
    fakeApi.sendEmployeeAction = vi.fn(async () => {
      throw new Error('Not sent: no remote')
    })
    render(<EmployeesNeedYou orgId="o1" />)
    const row = rowOf('Max wants to push a branch')
    expect(within(row).getByText('The repository’s GitHub connection changed since this was recorded.')).toBeTruthy()
    await userEvent.click(within(row).getByRole('button', { name: 'Send again' }))
    expect((await within(row).findByRole('alert')).textContent).toBe('Not sent: no remote')
  })
})

describe('a task’s chain: its outward actions', () => {
  it('lists each with its state, whether a person edited it, and where it went', async () => {
    setSnapshot({})
    fakeApi.employeeTaskChain = vi.fn(async () => ({
      task,
      children: [],
      transitions: [],
      actions: [
        action('a1', PAYLOADS.slack, { state: 'sent', decidedBy: 'person', edited: true, result: { link: 'https://acme.slack.com/archives/C1/p1' } }),
        action('a2', PAYLOADS.push, { state: 'skipped' }),
        action('a3', PAYLOADS.linear, { state: 'sent', policy: 'allowed', decidedBy: 'definition' })
      ]
    }))
    render(<TaskChain task={task} />)
    const list = await screen.findByRole('list', { name: 'Outward actions' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.ui-status__label')?.textContent)).toEqual(['Sent', 'Skipped', 'Sent'])
    expect(within(rows[0]).getByText('Slack post to #launches')).toBeTruthy()
    expect(within(rows[0]).getByText('edited by you')).toBeTruthy()
    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Open' }))
    expect(fakeApi.openExternal).toHaveBeenCalledWith('https://acme.slack.com/archives/C1/p1')
    expect(within(rows[1]).getByText('Push of max/launch')).toBeTruthy()
    expect(within(rows[2]).getByText('Linear change save_comment on ENG-12')).toBeTruthy()
    expect(within(rows[2]).getByText('as its definition allows')).toBeTruthy()
  })
})

describe('Decided for you (the Team page)', () => {
  it('lists what went out without asking, how to revisit it, and plainly which can’t be undone', async () => {
    setSnapshot({
      decided: [
        action('d1', PAYLOADS.slack, { state: 'sent', policy: 'allowed', decidedBy: 'definition', sentAt: NOW, result: { link: 'https://acme.slack.com/archives/C1/p1' } }),
        action('d2', PAYLOADS.linear, { state: 'sent', policy: 'allowed', decidedBy: 'definition', sentAt: NOW })
      ]
    })
    render(<DecidedForYou orgId="o1" />)
    expect(screen.getByRole('heading', { name: 'Decided for you' })).toBeTruthy()
    expect(screen.getByText('In the last day, 2 outward actions went out without asking you, as their employees’ definitions allow:')).toBeTruthy()
    const slack = screen.getByText('Max: Slack post to #launches').closest('li') as HTMLElement
    expect(within(slack).getByText('Can’t be undone')).toBeTruthy()
    await userEvent.click(within(slack).getByRole('button', { name: 'Open' }))
    expect(fakeApi.openExternal).toHaveBeenCalledWith('https://acme.slack.com/archives/C1/p1')
    await userEvent.click(within(slack).getByRole('button', { name: 'Change Max’s rule' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'employee', id: 'e-max1', edit: true })
    const linear = screen.getByText('Max: Linear change save_comment on ENG-12').closest('li') as HTMLElement
    expect(within(linear).getByText('Can be changed back in Linear')).toBeTruthy()
  })

  it('says plainly when nothing was decided for you', () => {
    setSnapshot({ decided: [] })
    render(<DecidedForYou orgId="o1" />)
    expect(screen.getByText('In the last day, nothing was decided for you: every outward action waited for you, or there were none.')).toBeTruthy()
  })
})

describe('each class’s rule in words', () => {
  const base = defaultEmployee({ id: 'e-max1', colour: 'orange', repos: [], loadouts: [{ agent: 'claude', model: 'claude-sonnet-5-5' }], text: { name: 'Max' } })

  it('lists Foreman’s four routes with their rule, held when unlisted, and a class it can’t hold', () => {
    const d = { ...base, access: { ...base.access, actions: { 'slack-post': 'allowed' as const, push: 'never' as const, newsletter: 'held' as const } } }
    render(<ActionRules definition={d} />)
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items[0]).toMatch(/^Slack messages\s*Allowed\s*Recorded, then sent at once without asking you\. A sent message, push or pull request can’t be undone\./)
    expect(items[1]).toMatch(/^Linear changes\s*Held\s*Not listed, so held for you: it goes only when you press Send\./)
    expect(items[2]).toMatch(/^Pushes\s*Never\s*Refused: nothing is sent, and the employee is told why\./)
    // Not listed itself, but a pull request pushes its branch, so it takes the pushes' Never.
    expect(items[3]).toMatch(/^Pull requests\s*Never\s*Refused: nothing is sent, and the employee is told why\.\s*A pull request pushes its branch, so it follows the stricter rule for pushes\.$/)
    expect(items[4]).toMatch(/^newsletter\s*Held\s*Foreman has no route of its own for this, so it can’t hold it/)
    expect(screen.getByText('No shell: Foreman’s own routes above are its only way out.')).toBeTruthy()
  })

  it('says plainly in the approval plan that a shell-profile employee’s shell isn’t held', () => {
    setSnapshot({})
    const d = { ...base, access: { ...base.access, profile: 'shell' as const, mcp: ['github', 'foreman-slack'] } }
    render(<ApproveDialog definition={d} memory="acme-memory" names={(id) => id} onConfirm={async () => undefined} onClose={() => undefined} />)
    const text = screen.getByRole('dialog').textContent ?? ''
    expect(text).toContain('Its shell is not held: a command it runs (git push, gh, curl) acts at once, outside these rules.')
    expect(text).toContain('The MCP servers it keeps (github) act with no hold.')
    expect(text).toMatch(/Slack messages\s*Held\s*Recorded, then held for you: it goes only when you press Send\./)
  })
})
