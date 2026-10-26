// @vitest-environment jsdom
// Integrations and remote workspaces on ui/: the connection dialogs, the Slack rule editor, and the cloud pieces Home,
// the sidebar and the header share (the pill's menu, the banners, Runs on).
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudBanner, CloudPill, CloudSub, CloudTerminalBand } from '../src/renderer/src/components/cloud/CloudBits'
import { RunsOnField } from '../src/renderer/src/components/cloud/RunsOn'
import { RepoCloudTab } from '../src/renderer/src/components/settings/RepoCloudTab'
import { AddConnectionDialog, PersonPicker } from '../src/renderer/src/components/settings/integrations/AddConnectionDialog'
import { RemoveDialog, RenameDialog } from '../src/renderer/src/components/settings/integrations/ConnectionDialogs'
import { SlackRulesTab } from '../src/renderer/src/components/settings/integrations/SlackRulesTab'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const slack = {
  id: 'slack1',
  service: 'slack',
  name: 'Acme Slack',
  auth: { kind: 'token' },
  identity: { user: 'bot', org: 'Acme', orgId: 'T1' },
  slack: { me: { id: 'U0', name: 'Me' }, destinations: [{ id: 'C1', name: 'reviews' }] },
  agentAccess: 'off',
  usedBy: 0,
  isDefault: true,
  rev: 1
}

const cloudWs = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'w1', name: 'fix-login', repoId: 'r1', state: 'ready', cloud: { provider: 'vercel', status, ...extra } }) as any

beforeEach(() => {
  resetFake()
  fakeState.snapshot.integrations = { connections: [], rules: [], people: [], suggestions: {} }
  fakeState.snapshot.sessions = []
  fakeState.snapshot.workspaces = []
  fakeState.snapshot.repos = []
  fakeState.snapshot.slackAsks = []
  fakeState.snapshot.repoSettings = {}
  fakeState.snapshot.settings.cloud = {}
  ;(storeModule.openArchiveDialog as ReturnType<typeof vi.fn>).mockClear()
})
afterEach(cleanup)

describe('add connection dialogs', () => {
  it('GitHub: the accounts are a radio list in a dialog; one already added is disabled and says so', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    fakeApi.ghAccountsForIntegrations = vi.fn(async () => [
      { login: 'octo', active: true, connected: false },
      { login: 'old', active: false, connected: true }
    ])
    fakeApi.addConnection = vi.fn(async () => ({ ok: true, connection: { name: 'octo' } }))
    render(<AddConnectionDialog service="github" onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Add GitHub account' })
    const group = await within(dialog).findByRole('group', { name: 'Account' })
    const [octo, old] = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(octo.checked).toBe(true)
    expect(old.disabled).toBe(true)
    expect(document.getElementById(old.getAttribute('aria-describedby')!)?.textContent).toBe('added')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fakeApi.addConnection).toHaveBeenCalledWith({ service: 'github', name: undefined, auth: { kind: 'gh-account', login: 'octo' } }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('Escape and the close button close the dialog', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    fakeApi.ghAccountsForIntegrations = vi.fn(async () => [])
    render(<AddConnectionDialog service="github" onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('Linear: the key field is named by its label, shows and hides, and Enter checks and saves', async () => {
    const user = userEvent.setup()
    fakeApi.addConnection = vi.fn(async () => ({ ok: true, connection: { name: 'Acme', isDefault: true } }))
    render(<AddConnectionDialog service="linear" onClose={() => undefined} />)
    const save = screen.getByRole('button', { name: 'Check and save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const key = screen.getByLabelText('Personal API key') as HTMLInputElement
    expect(key.type).toBe('password')
    await user.type(key, 'lin_api_abc')
    expect(save.disabled).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(key.type).toBe('text')
    expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy()
    await user.type(key, '{Enter}')
    await waitFor(() =>
      expect(fakeApi.addConnection).toHaveBeenCalledWith({ service: 'linear', name: undefined, auth: { kind: 'token' }, token: 'lin_api_abc', agentAccess: 'read', allowDuplicate: false })
    )
  })

  it('Linear: the agent access choice is one radio group with one tab stop', async () => {
    const user = userEvent.setup()
    render(<AddConnectionDialog service="linear" onClose={() => undefined} />)
    const group = screen.getByRole('radiogroup', { name: 'What agents may do' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    await user.click(radios[2])
    expect(radios[2].getAttribute('aria-checked')).toBe('true')
  })

  it('Linear: a key for a workspace already added gets a warning with two ways on; an error shows under the field', async () => {
    const user = userEvent.setup()
    fakeApi.addConnection = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'duplicate', duplicateOf: 'Work', identity: { user: 'y', org: 'Acme' } })
      .mockResolvedValueOnce({ ok: false, error: 'Key rejected' })
    render(<AddConnectionDialog service="linear" onClose={() => undefined} />)
    await user.type(screen.getByLabelText('Personal API key'), 'k{Enter}')
    const callout = await screen.findByText(/already uses/)
    expect(callout.closest('[role="note"]')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add anyway' }))
    await waitFor(() => expect(fakeApi.addConnection).toHaveBeenLastCalledWith(expect.objectContaining({ allowDuplicate: true })))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Key rejected')
    expect((screen.getByLabelText('Personal API key') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true')
  })

  it('Slack: the people search is a combobox; picking a person reports them', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    fakeApi.slackPeople = vi.fn(async () => [{ id: 'U1', name: 'Priya', handle: 'priya', email: 'p@acme.io' }])
    render(<PersonPicker connectionId="slack1" value={null} onChange={onChange} />)
    const box = screen.getByRole('combobox', { name: 'Search by name or email' })
    await user.type(box, 'pr')
    const option = await screen.findByRole('option', { name: /Priya/ })
    await user.click(option)
    expect(onChange).toHaveBeenCalledWith({ id: 'U1', name: 'Priya' })
  })

  it('Slack: a picked person shows with a named button to change them', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PersonPicker connectionId="slack1" value={{ id: 'U1', name: 'Priya' }} onChange={onChange} />)
    expect(screen.getByText('Priya')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /change/i }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('Rename names its field, saves on Enter and on the button; Remove waits for the impact', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    fakeApi.updateConnection = vi.fn(async () => ({ ok: true }))
    render(<RenameDialog connection={slack as any} onClose={onClose} />)
    const name = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Work Slack{Enter}')
    await waitFor(() => expect(fakeApi.updateConnection).toHaveBeenCalledWith('slack1', { name: 'Work Slack' }))
    cleanup()
    let release: (v: unknown) => void = () => undefined
    fakeApi.connectionRemovalImpact = vi.fn(() => new Promise((r) => (release = r)))
    fakeApi.removeConnection = vi.fn(async () => undefined)
    render(<RemoveDialog connection={slack as any} onClose={onClose} />)
    const remove = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    release({ repos: ['web'], isDefault: false, rules: 0 })
    await waitFor(() => expect(remove.disabled).toBe(false))
    await user.click(remove)
    await waitFor(() => expect(fakeApi.removeConnection).toHaveBeenCalledWith('slack1'))
  })
})

describe('Slack rules', () => {
  const open = async () => {
    const user = userEvent.setup()
    fakeState.snapshot.integrations = { connections: [slack], rules: [], people: [], suggestions: {} }
    fakeState.snapshot.repos = [{ id: 'r1', name: 'web' }]
    fakeApi.slackDeliveries = vi.fn(async () => [])
    fakeApi.saveSlackRule = vi.fn(async (rule: any) => ({ ...rule, id: 'rule1' }))
    render(<SlackRulesTab />)
    await user.click(screen.getByRole('button', { name: 'New rule' }))
    return user
  }

  it('the editor sentence is four named selects', async () => {
    await open()
    for (const name of ['When', 'in', 'message']) expect(screen.getByRole('combobox', { name })).toBeTruthy()
    const when = screen.getByRole('combobox', { name: 'When' }) as HTMLSelectElement
    expect(when.value).toBe('review-requested')
  })

  it('an agent event offers "only when away"; choosing Send automatically saves it as auto', async () => {
    const user = await open()
    expect(screen.queryByRole('checkbox', { name: /away from this Mac/ })).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'When' }), 'agent-needs-me')
    const away = screen.getByRole('checkbox', { name: /away from this Mac/ }) as HTMLInputElement
    await user.click(away)
    expect(away.checked).toBe(true)
    // An agent event can only message me, which sends without asking: no mode choice.
    expect(screen.queryByRole('group', { name: 'Sending' })).toBeNull()
    await user.selectOptions(screen.getByRole('combobox', { name: 'When' }), 'review-requested')
    await user.selectOptions(screen.getByRole('combobox', { name: 'message' }), 'reviewer')
    const sending = screen.getByRole('group', { name: 'Sending' })
    await user.click(within(sending).getByRole('radio', { name: 'Send automatically' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fakeApi.saveSlackRule).toHaveBeenCalledWith(expect.objectContaining({ event: 'review-requested', mode: 'auto', recipient: 'reviewer' })))
  })

  it('the template is a labelled text area with its help', async () => {
    const user = await open()
    const template = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    expect(template.getAttribute('aria-describedby')).toBeTruthy()
    await user.clear(template)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the cloud pill, banners and terminal band', () => {
  it('the pill is a menu button named by its status; Wake wakes, and the menu closes with focus back on the pill', async () => {
    const user = userEvent.setup()
    render(<CloudPill ws={cloudWs('sleeping')} />)
    const pill = screen.getByRole('button', { name: /Remote sandbox actions: asleep/ })
    expect(pill.getAttribute('aria-haspopup')).toBe('menu')
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    await user.click(pill)
    const menu = screen.getByRole('menu', { name: 'Remote sandbox actions' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Wake', 'Restart', 'Archive workspace…'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Wake' }))
    expect(fakeApi.cloudWake).toHaveBeenCalledWith('w1')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(pill)
  })

  it('a running sandbox can Sleep; Archive opens the archive dialog; Escape closes', async () => {
    const user = userEvent.setup()
    render(<CloudPill ws={cloudWs('running')} />)
    await user.click(screen.getByRole('button', { name: /Remote sandbox actions/ }))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Sleep', 'Restart', 'Archive workspace…'])
    await user.click(screen.getByRole('menuitem', { name: 'Archive workspace…' }))
    expect(storeModule.openArchiveDialog).toHaveBeenCalledWith('w1')
    await user.click(screen.getByRole('button', { name: /Remote sandbox actions/ }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('the sidebar sub-line says the status in words', () => {
    render(<CloudSub ws={cloudWs('sleeping')} />)
    expect(screen.getByText('asleep')).toBeTruthy()
  })

  it('a sleeping banner is a status with a Wake button', async () => {
    const user = userEvent.setup()
    render(<CloudBanner ws={cloudWs('sleeping')} />)
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('Vercel')
    await user.click(within(banner).getByRole('button', { name: 'Wake' }))
    expect(fakeApi.cloudWake).toHaveBeenCalledWith('w1')
  })

  it('a failed sandbox offers Restart; a gone one only says so', () => {
    const { unmount } = render(<CloudBanner ws={cloudWs('failed', { error: 'boom' })} />)
    expect(screen.getByRole('status').textContent).toContain('boom')
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
    unmount()
    render(<CloudBanner ws={cloudWs('gone')} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('the terminal band offers Wake', async () => {
    const user = userEvent.setup()
    render(<CloudTerminalBand workspaceId="w1" />)
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Wake' }))
    expect(fakeApi.cloudWake).toHaveBeenCalledWith('w1')
  })
})

describe('New workspace: Runs on', () => {
  it('at the running limit it is refused in an alert, with a button to put each running sandbox to sleep', async () => {
    const user = userEvent.setup()
    const repo = { id: 'r1', name: 'web' } as any
    fakeState.snapshot.repoSettings = { r1: { values: { setupSteps: [] } } }
    const running = cloudWs('running')
    const asleep = { ...cloudWs('sleeping'), id: 'w2', name: 'other' }
    render(
      <RunsOnField
        repo={repo}
        readiness={{ offer: true, block: 'limit', running: [running, asleep], cap: 2, capScope: 'app', provider: 'vercel' } as any}
        value="cloud"
        onChange={() => undefined}
        onLeave={() => undefined}
      />
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('All 2 remote workspaces you allow are running')
    const sleepRunning = within(alert).getByRole('button', { name: 'Sleep fix-login' }) as HTMLButtonElement
    expect((within(alert).getByRole('button', { name: 'Sleep other' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(sleepRunning)
    expect(fakeApi.cloudSleep).toHaveBeenCalledWith('w1')
  })
})

describe('Repository → Remote', () => {
  it('the provider picker is radio cards: the unconnected providers are disabled and say why', async () => {
    fakeState.snapshot.settings.cloud = { enabled: true }
    fakeState.snapshot.integrations = { connections: [{ id: 'v1', service: 'vercel', name: 'Acme', auth: { kind: 'token' }, usedBy: 0, isDefault: true, rev: 1 }], rules: [], people: [], suggestions: {} }
    const repo = { id: 'r1', name: 'web', cloud: { enabled: false } } as any
    fakeState.snapshot.repos = [repo]
    fakeState.snapshot.repoSettings = { r1: { values: { setupSteps: [] } } }
    render(<RepoCloudTab repo={repo} />)
    const group = screen.getByRole('group', { name: 'Runs on' })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.length).toBeGreaterThanOrEqual(4)
    const vercel = radios.find((r) => r.checked)!
    expect(vercel.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(vercel.getAttribute('aria-describedby')!)?.textContent).toContain('Connected · Acme')
    const off = radios.filter((r) => r.disabled)
    expect(off.length).toBeGreaterThan(0)
    expect(within(group).getAllByText(/Not connected|Coming soon/).length).toBe(off.length)
  })
})
