// @vitest-environment jsdom
// The workflow dialogs on ui/: hand-off and reconcile, pairing, schedules, export and import, a comparison's Home row,
// and the second-opinion shortcut from its footer.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompareRow } from '../src/renderer/src/components/CompareDialogs'
import { PairDialog, ReconcileDialog, TransferBanner } from '../src/renderer/src/components/HandOffDialogs'
import { ExportDialog, ImportDialog } from '../src/renderer/src/components/PortDialogs'
import { ScheduleDialog } from '../src/renderer/src/components/ScheduleDialogs'
import { SecondOpinionDialog } from '../src/renderer/src/components/SecondOpinionDialog'
import { McpStatusDialog } from '../src/renderer/src/components/McpStatusDialog'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/components/LimitResume', () => ({ LimitResumeRows: () => null, useLimitResumes: () => [] }))
vi.mock('../src/renderer/src/components/composer/AgentPicker', () => ({
  AgentIcon: () => null,
  ModelChooser: () => <div>chooser</div>,
  opencodeModelParts: () => ({ name: '' })
}))

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <textarea aria-label="terminal" /> }))

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>

beforeEach(() => {
  resetFake()
  Object.assign(fakeState.snapshot, { repos: [{ id: 'r1', name: 'foreman', defaultBranch: 'main' }], workspaces: [], transfers: [], schedules: [], sessions: [] })
  for (const name of ['closePortDialog', 'openReconcile', 'openPairDialog', 'selectWorkspace', 'selectSession', 'openCompareArchive', 'openScheduleDialog', 'openHandOffDialog']) spy(name).mockClear()
})
afterEach(cleanup)

describe('reconcile', () => {
  const transfer = { id: 't1', role: 'source', workspaceId: 'w1', workspaceName: 'Login fix', peerId: 'p', peerName: 'Studio Mac', state: 'awaiting-ack', startedAt: '', updatedAt: '' }

  it('offers the two outcomes as buttons that call the store, and Escape leaves it', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.transfers = [transfer]
    render(<ReconcileDialog transferId="t1" />)
    const dialog = await screen.findByRole('dialog', { name: /Login fix/ })
    const buttons = within(dialog).getAllByRole('button')
    // Two choices and "Not now", each its own tab stop.
    expect(buttons.map((b) => b.getAttribute('type'))).toEqual(['button', 'button', 'button'])
    await user.click(buttons[0])
    await waitFor(() => expect(fakeApi.reconcileHandOff).toHaveBeenCalledWith('t1', 'keep-here'))
  })

  it('Escape closes it', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.transfers = [transfer]
    render(<ReconcileDialog transferId="t1" />)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(spy('openReconcile')).toHaveBeenCalledWith(null)
  })
})

describe('the transfer banner', () => {
  it('is a status line with its Reconcile button when the other Mac has not confirmed', () => {
    fakeState.snapshot.transfers = [{ id: 't1', state: 'awaiting-ack', live: false }]
    fakeState.snapshot.workspaces = [{ id: 'w1', transfer: { id: 't1', state: 'frozen', peerName: 'Studio Mac' } }]
    render(<TransferBanner workspaceId="w1" />)
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('Studio Mac')
    expect(within(banner).getByRole('button', { name: 'Reconcile…' })).toBeTruthy()
  })
})

describe('pairing', () => {
  it('the code field submits on Enter once address and code are valid', async () => {
    const user = userEvent.setup()
    render(<PairDialog kind="enter" />)
    await user.type(await screen.findByRole('textbox', { name: 'Address' }), '10.0.0.5')
    const code = screen.getByRole('textbox', { name: '6-digit code' })
    await user.type(code, '123456{Enter}')
    await waitFor(() => expect(fakeApi.pairWith).toHaveBeenCalledWith('10.0.0.5', 47631, '123456'))
  })
})

describe('export', () => {
  const info = { chats: [{ id: 'c1', title: 'Fix login', agent: 'claude', messages: 4, toolCalls: 2, attachments: 0, closed: false }], comments: 0, variables: 0, worktree: { available: false, reason: 'No branch', copyFiles: 0 } }

  it('says the passphrases differ on the field itself (invalid, announced)', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.workspaces = [{ id: 'w1', name: 'Login fix' }]
    fakeApi.exportInfo = vi.fn(async () => info)
    render(<ExportDialog workspaceId="w1" />)
    const first = await screen.findByLabelText('Passphrase')
    const again = screen.getByLabelText('Again')
    await user.type(first, 'correct horse')
    await user.type(again, 'correct hors')
    expect(again.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toContain('The passphrases differ.')
  })

  it('Selected share lists the chats as named checkboxes', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.workspaces = [{ id: 'w1', name: 'Login fix' }]
    fakeApi.exportInfo = vi.fn(async () => info)
    render(<ExportDialog workspaceId="w1" />)
    await user.click(await screen.findByRole('radio', { name: 'Selected share' }))
    const group = await screen.findByRole('group', { name: (n) => n === 'Chats to include' || n === 'portDialogs.export.chats' })
    const box = within(group).getByRole('checkbox', { name: /Fix login/ }) as HTMLInputElement
    expect(box.checked).toBe(true)
    await user.click(box)
    expect(box.checked).toBe(false)
    expect((screen.getByRole('button', { name: /^Export/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('import', () => {
  it('asks for the passphrase of an encrypted file in a named password field', async () => {
    const user = userEvent.setup()
    fakeApi.pickPath = vi.fn(async () => '/tmp/a.foreman')
    fakeApi.stageImport = vi.fn(async () => ({ kind: 'needs-passphrase' }))
    render(<ImportDialog />)
    await user.click(await screen.findByRole('button', { name: /Choose file/ }))
    const field = await screen.findByLabelText('Passphrase for this backup')
    expect(field.getAttribute('type')).toBe('password')
    await user.type(field, 'secret{Enter}')
    await waitFor(() => expect(fakeApi.stageImport).toHaveBeenLastCalledWith('/tmp/a.foreman', 'secret'))
  })
})

describe('schedules', () => {
  beforeEach(() => {
    fakeState.snapshot.settings.promptTemplates = [{ id: 'tpl', name: 'Nightly', body: 'Run the checks', source: 'personal' }]
  })

  it('names every field, shows the weekdays only for weekly, and each day is a toggle button', async () => {
    const user = userEvent.setup()
    render(<ScheduleDialog templateId="tpl" />)
    expect(await screen.findByRole('dialog', { name: /Nightly/ })).toBeTruthy()
    for (const name of ['Starts', 'Time', 'Time zone', 'Repeat']) expect(screen.getByLabelText(name)).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'On' })).toBeNull()
    await user.selectOptions(screen.getByLabelText('Repeat'), 'weekly')
    const days = within(screen.getByRole('group', { name: 'On' })).getAllByRole('button')
    expect(days).toHaveLength(7)
    expect(days.filter((d) => d.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    const other = days.find((d) => d.getAttribute('aria-pressed') === 'false')!
    await user.click(other)
    expect(other.getAttribute('aria-pressed')).toBe('true')
  })

  it('Approve saves the schedule it shows', async () => {
    const user = userEvent.setup()
    fakeApi.saveSchedule = vi.fn(async () => ({}))
    render(<ScheduleDialog templateId="tpl" />)
    await user.click(await screen.findByRole('button', { name: 'Approve schedule' }))
    await waitFor(() => expect(fakeApi.saveSchedule).toHaveBeenCalled())
    expect(fakeApi.saveSchedule.mock.calls[0][0]).toMatchObject({ templateId: 'tpl', repoId: 'r1', recurrence: 'once', afterRun: 'keep', afterRunDeleteBranch: false })
  })

  it('saves what happens after each run, and the branch choice only once archiving is picked', async () => {
    const user = userEvent.setup()
    fakeApi.saveSchedule = vi.fn(async () => ({}))
    render(<ScheduleDialog templateId="tpl" />)
    const after = await screen.findByRole('group', { name: 'After each run' })
    expect(screen.queryByRole('checkbox', { name: 'Also delete the branch when archiving' })).toBeNull()
    await user.click(within(after).getByRole('radio', { name: 'Archive it when the run completes' }))
    await user.click(screen.getByRole('checkbox', { name: 'Also delete the branch when archiving' }))
    await user.click(screen.getByRole('button', { name: 'Approve schedule' }))
    await waitFor(() => expect(fakeApi.saveSchedule).toHaveBeenCalled())
    expect(fakeApi.saveSchedule.mock.calls[0][0]).toMatchObject({ afterRun: 'archive', afterRunDeleteBranch: true })
  })
})

describe('a comparison on Home', () => {
  const ws = (id: string, name: string) => ({ id, name })
  const group = { id: 'g', prompt: 'Add a retry', members: [{ ws: ws('a', 'retry-a'), label: 'Sonnet', finished: false, session: { id: 'sa' } }, { ws: ws('b', 'retry-b'), label: 'Opus', finished: true, session: { id: 'sb' } }] }

  it('the row opens the first run; its menus are separate buttons with named menus', async () => {
    const user = userEvent.setup()
    render(<CompareRow group={group as never} />)
    await user.click(screen.getByRole('button', { name: /Add a retry/ }))
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('a')
    expect(spy('selectSession')).toHaveBeenCalledWith('a', 'sa')

    await user.click(screen.getByRole('button', { name: 'Continue in one…' }))
    const menu = await screen.findByRole('menu', { name: 'Continue in one…' })
    await user.click(within(menu).getByRole('menuitem', { name: /retry-b/ }))
    expect(spy('selectWorkspace')).toHaveBeenLastCalledWith('b')
  })

  it('"Archive others" asks which run to keep and opens the confirmation', async () => {
    const user = userEvent.setup()
    render(<CompareRow group={group as never} />)
    await user.click(screen.getByRole('button', { name: 'Archive others…' }))
    const menu = await screen.findByRole('menu', { name: 'Archive others…' })
    await user.click(within(menu).getByRole('menuitem', { name: /retry-a/ }))
    expect(spy('openCompareArchive')).toHaveBeenCalledWith({ compareId: 'g', keepWorkspaceId: 'a' })
  })
})

describe('second opinion', () => {
  it('Ctrl+Enter starts from a footer button too', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.sessions = [{ id: 's1', workspaceId: 'w1', agent: 'claude' }]
    storeModule.openSessions = () => []
    fakeApi.prepareHandOff = vi.fn(async () => ({ model: { agent: 'claude', model: 'claude-sonnet-4-5', fast: false }, message: 'Please review', tasks: [], answer: null, diff: null, defaultTaskTurnId: undefined }))
    fakeApi.startHandOff = vi.fn(async () => ({ session: { id: 's2' } }))
    render(<SecondOpinionDialog sourceId="s1" kind="review" />)
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    cancel.focus()
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(fakeApi.startHandOff).toHaveBeenCalled())
  })
})

describe('MCP status', () => {
  const servers = [
    { name: 'github', status: 'connected', tools: ['search', 'open'], transport: 'stdio', target: 'gh-mcp' },
    { name: 'linear', status: 'needs-auth', scope: 'user' }
  ]
  beforeEach(() => {
    fakeState.snapshot.sessions = [{ id: 's1', workspaceId: 'w1', agent: 'claude' }]
    fakeApi.mcpStatus = vi.fn(async () => ({ supported: true, live: true, servers }))
    spy('openMcpStatus').mockClear()
  })

  it('each server is a disclosure; opening one shows its facts, and a server needing sign-in offers Authenticate', async () => {
    const user = userEvent.setup()
    render(<McpStatusDialog sessionId="s1" />)
    const github = await screen.findByRole('button', { name: /github/i })
    expect(github.getAttribute('aria-expanded')).toBe('false')
    await user.click(github)
    expect(github.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(github.getAttribute('aria-controls')!)?.textContent).toContain('gh-mcp')
    const linear = screen.getByRole('button', { name: /linear/i })
    await user.click(linear)
    expect(github.getAttribute('aria-expanded')).toBe('false')
    expect(await screen.findByRole('button', { name: 'Authenticate' })).toBeTruthy()
  })

  it('Escape inside the sign-in terminal stays with the terminal; elsewhere it closes the dialog', async () => {
    const user = userEvent.setup()
    render(<McpStatusDialog sessionId="s1" />)
    await user.click(await screen.findByRole('button', { name: /linear/i }))
    await user.click(await screen.findByRole('button', { name: 'Authenticate' }))
    const terminal = await screen.findByLabelText('terminal')
    terminal.focus()
    await user.keyboard('{Escape}')
    expect(spy('openMcpStatus')).not.toHaveBeenCalled()
    ;(screen.getByRole('button', { name: 'Refresh status' }) as HTMLElement).focus()
    await user.keyboard('{Escape}')
    expect(spy('openMcpStatus')).toHaveBeenCalledWith(null)
  })
})
