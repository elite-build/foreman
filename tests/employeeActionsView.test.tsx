// @vitest-environment jsdom
// An AI employee's outward actions in the window (docs/ai-employees.md §6.6, §9): Needs you shows each held action as a
// decision card with its exact preview (Slack: channel and text; Linear: issue and change; a push: branch, commits ahead,
// where it goes and as whom; a pull request: title, description, base ← branch and commits), a line saying what the main
// button sends, and buttons named for the act (Don't … · Edit, then … · the act, which has no key: it leaves this
// computer); one Foreman isn't sure was sent asks for a check first; a task's chain lists its actions; the Team page says
// what was decided for you and which can't be undone, or that nothing was; each class's rule in words; and a draft's plan
// says plainly that a shell isn't held.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmployeeAction, EmployeeActionPayload } from '../src/shared/employeeActions'
import type { EmployeeTask, EmployeeWorkView } from '../src/shared/employeeWork'
import { defaultEmployee, type EmployeeSummary, type EmployeeView } from '../src/shared/employees'
import { EmployeesNeedYou, TaskChain } from '../src/renderer/src/components/employees/EmployeeWork'
import { ActionRules, DecidedForYou } from '../src/renderer/src/components/employees/HeldActions'
import { EmployeeReview } from '../src/renderer/src/components/employees/EmployeePage'
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
    settings: original.settings
  }
}

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
// A decision card is a group named by what it decides.
const cardOf = (subject: string) => screen.getByRole('group', { name: subject })
// A button's name carries its key hint ("Don’t post Esc"); an outward one has none.
const button = (within_: HTMLElement, label: string) => within(within_).getByRole('button', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`) })
const buttonNames = (card: HTMLElement) =>
  within(card)
    .getAllByRole('button')
    .filter((b) => b.closest('.decision-foot-acts'))
    .map((b) => b.textContent?.trim())

beforeEach(() => {
  resetFake()
  for (const name of ['openEmployees', 'showToast']) spy(name).mockReset()
})
afterEach(() => {
  cleanup()
  fakeState.snapshot = original
})

describe('Needs you: held outward actions', () => {
  it('previews a Slack post (channel, account, text) as a card, says where it goes, and posts it on its named button', async () => {
    setSnapshot({ actions: [action('a1', PAYLOADS.slack)] })
    fakeApi.sendEmployeeAction = vi.fn(async () => action('a1', PAYLOADS.slack, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    expect(screen.getByRole('heading', { name: 'Needs you · 1' })).toBeTruthy()
    const card = cardOf('Post to #launches')
    expect(card.querySelector('.decision-head')?.textContent).toMatch(/^Needs you\s*·\s*Max\s*·\s*Slack message/)
    expect(within(card).getByText('For “Ship the launch post”')).toBeTruthy()
    expect(within(card).getByText('#launches')).toBeTruthy()
    expect(within(card).getByText('We shipped 1.1')).toBeTruthy()
    // What pressing it sends, where and as whom (said once, on this line), flagged as leaving this computer.
    expect(within(card).getByText('Leaves this computer')).toBeTruthy()
    expect(within(card).getByText('Posts this message to #launches in Slack as Acme Slack. It can’t be undone.')).toBeTruthy()
    // Decline · alternate · main, the main one last; the act that leaves this computer has no key.
    expect(buttonNames(card)).toEqual(['Don’t post Esc', 'Edit, then post Ctrl+Enter', 'Post to #launches'])
    const post = button(card, 'Post to #launches')
    expect(post.querySelector('kbd')).toBeNull()
    expect(post.className).toMatch(/primary/)
    await userEvent.click(post)
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a1', {})
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Sent for Max.'))
  })

  it('never sends on Enter: an outward act is pressed on its button', async () => {
    setSnapshot({ actions: [action('a1', PAYLOADS.slack)] })
    fakeApi.sendEmployeeAction = vi.fn(async () => action('a1', PAYLOADS.slack, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Post to #launches')
    card.focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(fakeApi.sendEmployeeAction).not.toHaveBeenCalled()
    // Ctrl+Enter took the alternate instead: Edit, then post.
    expect(within(card).getByRole('textbox', { name: 'Message' })).toBeTruthy()
  })

  it('Edit, then post changes only the words: no field for the channel', async () => {
    setSnapshot({ actions: [action('a1', PAYLOADS.slack)] })
    fakeApi.sendEmployeeAction = vi.fn(async () => action('a1', PAYLOADS.slack, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Post to #launches')
    await userEvent.click(button(card, 'Edit, then post'))
    expect(within(card).getAllByRole('textbox')).toHaveLength(1)
    const text = within(card).getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(text.value).toBe('We shipped 1.1')
    expect(within(card).getByText('Only the words can change: where it goes and as whom stay as recorded.')).toBeTruthy()
    expect(buttonNames(card)).toEqual(['Cancel Esc', 'Send edited'])
    await userEvent.clear(text)
    await userEvent.type(text, 'We shipped 1.1 today')
    await userEvent.click(button(card, 'Send edited'))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a1', { edits: { text: 'We shipped 1.1 today' } })
  })

  it('Don’t post sends nothing, on its button or on Esc', async () => {
    setSnapshot({ actions: [action('a1', PAYLOADS.slack)] })
    fakeApi.skipEmployeeAction = vi.fn(async () => action('a1', PAYLOADS.slack, { state: 'skipped' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Post to #launches')
    await userEvent.click(button(card, 'Don’t post'))
    expect(fakeApi.skipEmployeeAction).toHaveBeenCalledWith('a1')
    expect(fakeApi.sendEmployeeAction).toBeUndefined()
    await waitFor(() => expect(spy('showToast')).toHaveBeenCalledWith('Skipped: nothing was sent for Max.'))
    card.focus()
    await userEvent.keyboard('{Escape}')
    expect(fakeApi.skipEmployeeAction).toHaveBeenCalledTimes(2)
    expect(fakeApi.sendEmployeeAction).toBeUndefined()
  })

  it('previews a Linear change: the issue, the tool and its arguments, and that it can be changed back', async () => {
    setSnapshot({ actions: [action('a2', PAYLOADS.linear)] })
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Change ENG-12 in Linear')
    // The issue it changes, then the change: the tool and each argument it was given.
    expect(within(card).getAllByText('ENG-12')).toHaveLength(2)
    expect(within(card).getByText('save_comment')).toBeTruthy()
    expect(within(card).getByText('issueId')).toBeTruthy()
    expect(within(card).getByText('Shipped in 1.1')).toBeTruthy()
    expect(within(card).getByText('Changes Linear as Acme Linear. It can be changed back in Linear.')).toBeTruthy()
    expect(buttonNames(card)).toEqual(['Don’t change Esc', 'Edit, then change Ctrl+Enter', 'Make this change'])
    await userEvent.click(button(card, 'Edit, then change'))
    expect((within(card).getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement).value).toBe('Shipped in 1.1')
  })

  it('previews a push: the branch and the commits ahead, where it goes and as whom, with no Edit', () => {
    setSnapshot({ actions: [action('a3', PAYLOADS.push)] })
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Push max/launch to site')
    expect(within(card).getByText('max/launch')).toBeTruthy()
    expect(within(card).getByText('2 commits ahead of main')).toBeTruthy()
    expect(within(card).getByText('Write the launch post')).toBeTruthy()
    expect(within(card).getByText('Fix a typo')).toBeTruthy()
    expect(within(card).getByText('Pushes 2 commits of max/launch to origin (site) as Acme GitHub. It leaves this computer and can’t be undone.')).toBeTruthy()
    expect(buttonNames(card)).toEqual(['Don’t push Esc', 'Push branch'])
    expect(button(card, 'Push branch').querySelector('kbd')).toBeNull()
  })

  it('says a push’s remote, its URL and the login when they were recorded, and lists the files it changes', () => {
    const push = { ...PAYLOADS.push, ahead: 1, repo: 'acme-site', remote: 'upstream', remoteUrl: 'github.com/acme/site', login: 'maxbot', files: [{ path: 'posts/launch.md', insertions: 40, deletions: 2 }] } as EmployeeActionPayload
    setSnapshot({ actions: [action('a3', push)] })
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Push max/launch to acme-site')
    expect(within(card).getByText('Pushes 1 commit of max/launch to upstream (github.com/acme/site) as @maxbot. It leaves this computer and can’t be undone.')).toBeTruthy()
    expect(within(card).getByText('posts/launch.md')).toBeTruthy()
    expect(within(card).getByText('+40 −2')).toBeTruthy()
  })

  it('previews a pull request: title, description, base ← branch and commits; edits its title and description', async () => {
    setSnapshot({ actions: [action('a4', PAYLOADS.pr)] })
    fakeApi.sendEmployeeAction = vi.fn(async () => action('a4', PAYLOADS.pr, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Open a draft pull request “Launch post” in site')
    expect(within(card).getByText('Launch post')).toBeTruthy()
    expect(within(card).getByText('Adds the 1.1 launch post.')).toBeTruthy()
    expect(within(card).getByText('main ← max/launch')).toBeTruthy()
    expect(within(card).getByText('1 commit ahead of main')).toBeTruthy()
    // It pushes the branch first and opens the pull request as a draft: the line above the buttons says so.
    expect(within(card).getByText('Pushes max/launch to origin (site) and opens a draft pull request into main, as Acme GitHub. It can’t be undone.')).toBeTruthy()
    expect(buttonNames(card)).toEqual(['Don’t open Esc', 'Edit, then open Ctrl+Enter', 'Open draft pull request'])
    await userEvent.click(button(card, 'Edit, then open'))
    const title = within(card).getByRole('textbox', { name: 'Title' })
    await userEvent.type(title, ' for 1.1')
    await userEvent.click(button(card, 'Send edited'))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a4', { edits: { title: 'Launch post for 1.1' } })
  })

  it('asks for a check first when Foreman isn’t sure it was sent: It arrived, or send again after checking', async () => {
    setSnapshot({ actions: [action('a5', PAYLOADS.slack, { state: 'uncertain', reason: 'Foreman closed while sending this.' })] })
    fakeApi.confirmEmployeeAction = vi.fn(async () => action('a5', PAYLOADS.slack, { state: 'sent' }))
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Post to #launches')
    expect(within(card).getByText('Foreman isn’t sure this was sent')).toBeTruthy()
    expect(within(card).getByText(/Check whether it arrived before anything else\. Foreman closed while sending this\./)).toBeTruthy()
    expect(within(card).getByText('It arrived records it as sent and sends nothing. It didn’t arrive sends it again.')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: /^Post to/ })).toBeNull()
    // Sending again leaves this computer, so it has no key; It arrived only records.
    expect(buttonNames(card)).toEqual(['It didn’t arrive: send again', 'It arrived Enter'])
    await userEvent.click(button(card, 'It arrived'))
    expect(fakeApi.confirmEmployeeAction).toHaveBeenCalledWith('a5')
    await userEvent.click(button(card, 'It didn’t arrive: send again'))
    expect(fakeApi.sendEmployeeAction).toHaveBeenCalledWith('a5', { checked: true })
  })

  it('says why a failed one wasn’t sent, and offers Send again', async () => {
    setSnapshot({ actions: [action('a6', PAYLOADS.push, { state: 'failed', result: { error: 'The repository’s GitHub connection changed since this was recorded.' } })] })
    fakeApi.sendEmployeeAction = vi.fn(async () => {
      throw new Error('Not sent: no remote')
    })
    render(<EmployeesNeedYou orgId="o1" />)
    const card = cardOf('Push max/launch to site')
    expect(within(card).getByText('It wasn’t sent')).toBeTruthy()
    expect(within(card).getByText('The repository’s GitHub connection changed since this was recorded.')).toBeTruthy()
    await userEvent.click(button(card, 'Send again'))
    expect((await within(card).findByRole('alert')).textContent).toBe('Not sent: no remote')
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
    const d = { ...base, access: { ...base.access, repos: { site: 'write' as const }, actions: { 'slack-post': 'allowed' as const, push: 'never' as const, newsletter: 'held' as const } } }
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

  it('leaves pushes and pull requests out for an employee with no Write access, and says it can’t do either', () => {
    const d = { ...base, access: { ...base.access, repos: { site: 'read' as const, docs: 'read' as const }, actions: { push: 'allowed' as const } } }
    const { unmount } = render(<ActionRules definition={d} />)
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(items.map((i) => i.split(/\s/)[0])).toEqual(['Slack', 'Linear'])
    expect(items.some((i) => /^(Pushes|Pull requests)/.test(i))).toBe(false)
    expect(screen.getByText('It has no Write access to any repository, so it can’t push or open pull requests.')).toBeTruthy()
    unmount()
    // Given Write access somewhere, both are listed again, and the line goes.
    render(<ActionRules definition={{ ...d, access: { ...d.access, repos: { site: 'write' as const } } }} />)
    expect(screen.getAllByRole('listitem').map((li) => li.textContent?.split(/\s/)[0])).toEqual(['Slack', 'Linear', 'Pushes', 'Pull'])
    expect(screen.queryByText(/no Write access/)).toBeNull()
  })

  it('says plainly in a draft’s plan that a shell-profile employee’s shell, and the MCP servers it keeps, aren’t held', () => {
    setSnapshot({})
    const d = { ...base, access: { ...base.access, profile: 'shell' as const, mcp: ['github', 'foreman-slack'] } }
    const view: EmployeeView = { ...summary, state: 'draft', blob: 'b1', text: null, definition: d }
    render(<EmployeeReview employee={view} definition={d} memory="acme-memory" organization="Acme" names={(id) => id} />)
    const group = (name: string) =>
      within(screen.getByRole('heading', { name }).closest('section')!)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    const can = group('Can')
    expect(can).toContain('Use a shell and its tools Nothing it runs there waits for you.')
    expect(can).toContain('Use github Nothing it does with them waits for you.')
    // It keeps Foreman's Slack tools, so a Slack post is held for you; it keeps no Linear tools, so it can't change Linear.
    expect(group('Asks you first')).toContain('Before each Slack post')
    expect(group('Can’t')).toContain('Change Linear It keeps no Linear tools.')
    expect(group('Can’t')).not.toContain('Use a shell')
  })
})
