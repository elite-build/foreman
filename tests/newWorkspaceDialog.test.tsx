// @vitest-environment jsdom
// The New workspace dialog on ui/: the branch combobox, the worktree cards, attachment thumbnails, and Escape through
// nested layers (the list closes first, then the dialog).
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStatuses } from '../src/renderer/src/agentReadiness'
import { NewWorkspaceDialog } from '../src/renderer/src/components/NewWorkspaceDialog'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/components/Sidebar', () => ({ RepoIconView: () => null }))
vi.mock('../src/renderer/src/components/agents/TerminalAgents', () => ({ openTerminalAgent: () => undefined }))
vi.mock('../src/renderer/src/components/composer/Composer', () => ({
  AttachmentChip: ({ attachment }: { attachment: { name: string } }) => <span>{attachment.name}</span>,
  toBase64: () => 'AAEC'
}))
vi.mock('../src/renderer/src/components/composer/TemplatePicker', () => ({ TemplatePicker: () => null }))
vi.mock('../src/renderer/src/components/cloud/RunsOn', () => ({ RunsOnField: () => null, useCloudReadiness: () => undefined }))

const repo = { id: 'r1', name: 'foreman', rootPath: '/code/foreman', defaultBranch: 'main', remote: 'origin', hasOrigin: false }
const branches = [
  { name: 'main', local: true, remote: true, isDefault: true, checkedOutAt: '/code/foreman' },
  { name: 'feature/login', local: true, remote: false, isDefault: false },
  { name: 'feature/other', local: true, remote: false, isDefault: false, checkedOutAt: '/code/other' }
]
const trees = [
  { path: '/code/foreman', head: 'a', isMain: true, dirty: 0, branch: 'main' },
  { path: '/code/foreman-wt', head: 'b', isMain: false, dirty: 2, branch: 'wt' },
  { path: '/code/taken', head: 'c', isMain: false, dirty: 0, branch: 'x', workspaceId: 'w9' }
]

beforeEach(() => {
  resetFake()
  Object.assign(fakeState.snapshot, {
    repos: [repo],
    repoSettings: {},
    homeDir: '/home/me',
    workspaces: [],
    transfers: [],
    schedules: []
  })
  fakeState.snapshot.settings.autoRenameBranches = true
  fakeState.snapshot.settings.privacyMode = false
  fakeState.snapshot.settings.loadouts = [{ agent: 'claude', model: 'claude-sonnet-4-5', fast: false }]
  fakeApi.listBranches = vi.fn(async () => branches)
  fakeApi.listWorktrees = vi.fn(async () => trees)
  fakeApi.pickFiles = vi.fn(async () => ['/tmp/notes.txt'])
  ;(storeModule.openNewWorkspace as ReturnType<typeof vi.fn>).mockClear()
})
afterEach(cleanup)

const closed = () => storeModule.openNewWorkspace as ReturnType<typeof vi.fn>

describe('the branch combobox', () => {
  it('is a named combobox; arrows open its list, Enter chooses, and the choice shows as the placeholder', async () => {
    const user = userEvent.setup()
    render(<NewWorkspaceDialog repoId="r1" />)
    const dialog = await screen.findByRole('dialog', { name: 'New workspace' })
    const box = await within(dialog).findByRole('combobox', { name: 'Start from' })
    expect(box.getAttribute('placeholder')).toBe('main')
    await user.click(box)
    const list = await screen.findByRole('listbox', { name: 'Start from' })
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('feature/login')]))
    await user.type(box, 'login')
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(box.getAttribute('placeholder')).toBe('feature/login')
    // Choosing didn't submit or close the dialog.
    expect(closed()).not.toHaveBeenCalled()
  })

  it('Escape closes the list first, and only the next Escape closes the dialog', async () => {
    const user = userEvent.setup()
    render(<NewWorkspaceDialog repoId="r1" />)
    const box = await screen.findByRole('combobox', { name: 'Start from' })
    await user.click(box)
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeTruthy()
    expect(closed()).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(closed()).toHaveBeenCalledWith(null)
  })

  it('names why an existing branch cannot be chosen, and keeps it disabled', async () => {
    const user = userEvent.setup()
    render(<NewWorkspaceDialog repoId="r1" />)
    await user.click(await screen.findByRole('radio', { name: 'Check out an existing branch' }))
    const box = await screen.findByRole('combobox', { name: 'Existing branch' })
    const list = await screen.findByRole('listbox', { name: 'Existing branch' })
    const taken = within(list).getByRole('option', { name: /feature\/other/ })
    expect(taken.getAttribute('aria-disabled')).toBe('true')
    expect(taken.textContent).toContain('Checked out in')
    await user.click(taken)
    expect(box.getAttribute('placeholder')).toBe('Choose a branch')
  })
})

describe('the source choices and existing worktrees', () => {
  it('lists worktrees as radio cards; one that is already a workspace is disabled with its reason on the card', async () => {
    const user = userEvent.setup()
    render(<NewWorkspaceDialog repoId="r1" />)
    await user.click(await screen.findByRole('radio', { name: 'Existing worktree' }))
    const group = await screen.findByRole('group', { name: 'Worktree' })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    // The main checkout is not offered.
    expect(radios).toHaveLength(2)
    const taken = radios.find((r) => r.disabled)!
    const described = taken.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent)
    expect(described).toContain('Already a workspace')
    await user.click(radios.find((r) => !r.disabled)!)
    expect(radios.find((r) => !r.disabled)!.checked).toBe(true)
    // The submit button waits for a choice.
    expect(screen.getByRole('button', { name: /Add workspace/ })).toBeTruthy()
  })

  it('the source switch is one radio group with one tab stop', async () => {
    render(<NewWorkspaceDialog repoId="r1" />)
    const modes = await screen.findByRole('radiogroup', { name: 'Workspace source' })
    const stops = within(modes).getAllByRole('radio').filter((r) => r.tabIndex === 0)
    expect(stops).toHaveLength(1)
  })
})

describe('the first message', () => {
  it('Ctrl+Enter in the message creates the workspace', async () => {
    const user = userEvent.setup()
    storeModule.createWorkspace = vi.fn(async () => true)
    render(<NewWorkspaceDialog repoId="r1" />)
    const message = await screen.findByRole('textbox', { name: /First message/ })
    await user.type(message, 'fix the login bug')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(storeModule.createWorkspace).toHaveBeenCalled())
    expect((storeModule.createWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][1].prompt).toBe('fix the login bug')
  })

  it('an attached file shows as a chip, and the remove button is named after it', async () => {
    const user = userEvent.setup()
    render(<NewWorkspaceDialog repoId="r1" />)
    await user.click(await screen.findByRole('button', { name: /Attach/ }))
    await screen.findByText('notes.txt')
  })

  it('a pasted picture is a thumbnail with a named remove button', async () => {
    const user = userEvent.setup()
    fakeApi.stageAttachment = vi.fn(async () => '/tmp/staged.png')
    render(<NewWorkspaceDialog repoId="r1" />)
    const message = await screen.findByRole('textbox', { name: /First message/ })
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    ;(file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => new Uint8Array([1, 2, 3]).buffer
    fireEvent.paste(message, { clipboardData: { files: [file] } })
    const remove = await screen.findByRole('button', { name: 'Remove shot.png' })
    expect(screen.getByText('shot.png')).toBeTruthy()
    await user.click(remove)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove shot.png' })).toBeNull())
  })
})

describe('a signed-out agent', () => {
  it('stays selectable, is labelled in words, and offers sign-in that closes the dialog and opens its settings', async () => {
    const user = userEvent.setup()
    resetAgentStatuses()
    fakeApi.agentStatus = vi.fn(async (agent: string) => ({ agent, installed: true, ready: agent !== 'claude', method: 'ChatGPT login' }))
    render(<NewWorkspaceDialog repoId="r1" />)
    const dialog = await screen.findByRole('dialog', { name: 'New workspace' })
    expect(await within(dialog).findByText('Not signed in')).toBeTruthy()
    expect(within(dialog).getByText(/first message would fail/)).toBeTruthy()
    // Still chosen: the model select is not disabled.
    expect((within(dialog).getByRole('combobox', { name: 'Model' }) as HTMLElement).getAttribute('aria-disabled')).not.toBe('true')
    await user.click(within(dialog).getByRole('button', { name: 'Sign in to Claude Code' }))
    expect(closed()).toHaveBeenCalledWith(null)
    expect(storeModule.openSettingsPage).toHaveBeenCalledWith({ section: 'agents', agent: 'claude' })
  })
})

describe('integrations for the new workspace', () => {
  const connection = (patch: Record<string, unknown>) => ({ rev: 1, auth: { kind: 'token' }, createdAt: 'x', usedBy: 1, isDefault: true, ...patch })

  beforeEach(() => {
    fakeState.snapshot.integrations = {
      ...fakeState.snapshot.integrations,
      connections: [
        connection({ id: 'lin', service: 'linear', name: 'Acme Linear', agentAccess: 'read' }),
        connection({ id: 'sl', service: 'slack', name: 'Acme Slack', agentAccess: 'write', startsOff: true })
      ]
    } as typeof fakeState.snapshot.integrations
    fakeApi.integrationToolCosts = vi.fn(async () => [
      { service: 'linear' as const, tools: 12, tokens: 3400 },
      { service: 'slack' as const, tools: 1, tokens: 90 }
    ])
  })

  it('start from the defaults, show what each costs, and go with the workspace as switched', async () => {
    const user = userEvent.setup()
    storeModule.createWorkspace = vi.fn(async () => true)
    render(<NewWorkspaceDialog repoId="r1" />)
    const trigger = await screen.findByRole('button', { name: 'Integrations: Linear' })
    await user.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Integrations' })
    const linear = within(menu).getByRole('menuitemcheckbox', { name: /Linear/ })
    const slack = within(menu).getByRole('menuitemcheckbox', { name: /Slack/ })
    expect(linear.getAttribute('aria-checked')).toBe('true')
    expect(slack.getAttribute('aria-checked')).toBe('false')
    expect(within(menu).getByRole('group', { name: 'Off by default' }).contains(slack)).toBe(true)
    // The account and its access are named; the cost comes once the tools are listed.
    expect(linear.textContent).toContain('Acme Linear · read only')
    await waitFor(() => expect(linear.textContent).toContain('12 tools · ~3.4K tokens'))
    expect(menu.textContent).toContain('Switched on: ~3.4K tokens of tool definitions')
    // Switching keeps the menu open, so several can be switched in a row.
    await user.click(slack)
    expect(within(screen.getByRole('menu')).getByRole('menuitemcheckbox', { name: /Slack/ }).getAttribute('aria-checked')).toBe('true')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Integrations: Linear, Slack' })).toBeTruthy()
    await user.type(await screen.findByRole('textbox', { name: /First message/ }), 'triage')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(storeModule.createWorkspace).toHaveBeenCalled())
    expect((storeModule.createWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][1].integrations).toEqual({ linear: true, slack: true })
  })

  it('isn’t offered when no integration gives agents tools here', async () => {
    fakeState.snapshot.integrations = { ...fakeState.snapshot.integrations, connections: [] } as typeof fakeState.snapshot.integrations
    storeModule.createWorkspace = vi.fn(async () => true)
    render(<NewWorkspaceDialog repoId="r1" />)
    await typeAndSubmit()
    expect(screen.queryByRole('button', { name: /^Integrations/ })).toBeNull()
    expect((storeModule.createWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][1].integrations).toBeUndefined()
  })
})

async function typeAndSubmit() {
  const user = userEvent.setup()
  await user.type(await screen.findByRole('textbox', { name: /First message/ }), 'go')
  await user.keyboard('{Control>}{Enter}{/Control}')
  await waitFor(() => expect(storeModule.createWorkspace).toHaveBeenCalled())
}
