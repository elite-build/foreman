// @vitest-environment jsdom
// The bottom panel: a header for the selected entry, and a rail of two vertical ui/ TabLists (run scripts and Setup,
// then terminals). Several run scripts run at once; rename and close come from the terminal's own menu.
import './domShims'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BottomPanel } from '../src/renderer/src/components/BottomPanel'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

const hoisted = vi.hoisted(() => ({
  bridge: { pathForFile: () => '', send: { saveTerminals: vi.fn(), ptyKill: vi.fn() } },
  ui: { handler: null as null | ((command: string, workspaceId: string) => void) }
}))

vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule
  const onUiCommand = (handler: (command: string, workspaceId: string) => void) => {
    hoisted.ui.handler = handler
    return () => undefined
  }
  return new Proxy(base, { get: (target, name: string) => (name === 'bridge' ? hoisted.bridge : name === 'onUiCommand' ? onUiCommand : target[name]), has: () => true })
})
// xterm needs a real canvas: the terminals are stand-ins that show how they were mounted, report a PTY when they
// mount, and offer what the terminal's own menu and process would do.
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: (props: { kind: string; command?: string; visible: boolean; onSpawn?: (id: string) => void; onExit?: (code: number) => void; onRename?: () => void; onClose?: () => void }) => {
    useEffect(() => props.onSpawn?.(`pty-${props.command ?? props.kind}`), [])
    return (
      <div data-testid={`view-${props.kind}`} data-command={props.command} data-visible={String(props.visible)}>
        terminal view
        {props.onExit && <button onClick={() => props.onExit!(1)}>exit {props.command}</button>}
        {props.onRename && <button onClick={props.onRename}>menu rename</button>}
        {props.onClose && <button onClick={props.onClose}>menu close</button>}
      </div>
    )
  }
}))
vi.mock('../src/renderer/src/components/SetupLog', () => ({ SetupLog: () => <div>setup log</div> }))
vi.mock('../src/renderer/src/components/Sidebar', () => ({ lucideIcon: () => undefined }))

const workspace = { id: 'w1', repoId: 'r1', state: 'ready', portBase: 3000, direct: false, cloud: false } as never
const store = storeModule as Record<string, Mock>

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  hoisted.ui.handler = null
  store.activeSessionId.mockReturnValue(undefined)
  fakeApi.savedTerminals = vi.fn(async () => null)
  fakeState.autoRun = {}
  fakeState.terminalFullscreen = null
  fakeState.snapshot.platform = 'linux'
  fakeState.snapshot.repoSettings = { r1: { values: { runScripts: [{ name: 'dev', command: 'npm run dev', default: true }], previewUrls: [] } } }
  fakeState.snapshot.spotlight = {}
  fakeState.snapshot.repos = [{ id: 'r1', name: 'acme' }]
  fakeState.snapshot.settings.terminalCopyOnSelect = false
  fakeState.snapshot.settings.savedCommands = []
  fakeState.snapshot.repoCommands = {}
})
afterEach(cleanup)

const scripts = () => within(screen.getByRole('tablist', { name: 'Scripts' })).getAllByRole('tab')
const terms = () => within(screen.getByRole('tablist', { name: 'Terminals' })).getAllByRole('tab')
const names = (tabs: HTMLElement[]) => tabs.map((t) => t.querySelector('.rail-label')?.textContent)
const header = () => document.querySelector('.bottom-head') as HTMLElement
const twoScripts = () =>
  (fakeState.snapshot.repoSettings.r1.values.runScripts = [
    { name: 'dev', command: 'npm run dev', default: true },
    { name: 'docs', command: 'npm run docs' }
  ])

describe('the rail', () => {
  it('lists the run scripts and Setup, then the terminals, as vertical tablists, with the default script selected', () => {
    render(<BottomPanel workspace={workspace} visible />)
    for (const name of ['Scripts', 'Terminals']) expect(screen.getByRole('tablist', { name }).getAttribute('aria-orientation')).toBe('vertical')
    expect(names(scripts())).toEqual(['dev', 'Setup'])
    expect(names(terms())).toEqual(['Terminal 1'])
    expect(scripts()[0].getAttribute('aria-selected')).toBe('true')
    // The header names what is selected, with its command.
    expect(within(header()).getByText('dev')).toBeTruthy()
    expect(within(header()).getByText('npm run dev')).toBeTruthy()
  })

  it('↑ ↓ move within a list and select; only the selected panel shows', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    scripts()[0].focus()
    await user.keyboard('{ArrowDown}')
    expect(scripts()[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(scripts()[1])
    expect(screen.getByText('setup log').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
    await user.click(terms()[0])
    // The terminal starts the first time it is shown, and the earlier panels stay mounted but hidden.
    expect(screen.getByTestId('view-shell').getAttribute('data-visible')).toBe('true')
    expect(screen.getByText('setup log').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('+ opens another terminal and shows it', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(names(terms())).toEqual(['Terminal 1', 'Terminal 2'])
    expect(terms()[1].getAttribute('aria-selected')).toBe('true')
  })

  it('shows Setup running and failing on its entry, in words for screen readers', () => {
    const { rerender } = render(<BottomPanel workspace={{ ...(workspace as object), state: 'setting-up' } as never} visible />)
    expect(scripts()[1].textContent).toContain('Running setup…')
    expect(scripts()[1].getAttribute('aria-selected')).toBe('true')
    rerender(<BottomPanel workspace={{ ...(workspace as object), state: 'setup-failed' } as never} visible />)
    expect(scripts()[1].textContent).toContain('Setup failed')
  })
})

describe('a terminal’s name and closing come from its own menu', () => {
  async function startRename(user: ReturnType<typeof userEvent.setup>) {
    await user.click(terms()[0])
    await user.click(screen.getByRole('button', { name: 'menu rename' }))
    return screen.getByRole('textbox', { name: 'Rename terminal' }) as HTMLInputElement
  }

  it('the rail has no close buttons', () => {
    render(<BottomPanel workspace={workspace} visible />)
    expect(screen.queryByRole('button', { name: 'Close Terminal 1' })).toBeNull()
  })

  it('Rename opens a focused field in the header; Enter keeps the name', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    const field = await startRename(user)
    expect(header().contains(field)).toBe(true)
    expect(document.activeElement).toBe(field)
    await user.keyboard('build{Enter}')
    expect(screen.queryByRole('textbox', { name: 'Rename terminal' })).toBeNull()
    expect(names(terms())).toEqual(['build'])
  })

  it('Escape cancels, and an empty name goes back to "Terminal {n}"', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await startRename(user)
    await user.keyboard('oops{Escape}')
    expect(names(terms())).toEqual(['Terminal 1'])
    const field = await startRename(user)
    await user.clear(field)
    await user.keyboard('{Enter}')
    expect(names(terms())).toEqual(['Terminal 1'])
  })

  it('Close removes the terminal and goes back to the run script', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(terms()[0])
    await user.click(screen.getByRole('button', { name: 'menu close' }))
    expect(within(screen.getByRole('tablist', { name: 'Terminals' })).queryAllByRole('tab')).toHaveLength(0)
    expect(scripts()[0].getAttribute('aria-selected')).toBe('true')
  })
})

describe('running scripts', () => {
  it('Run is in the header with its shortcut, named by its title', () => {
    render(<BottomPanel workspace={workspace} visible />)
    const run = within(header()).getAllByRole('button').find((b) => b.title === 'Run dev: npm run dev')!
    expect(run).toBeTruthy()
    expect(run.querySelector('kbd')?.textContent).toBe('CtrlR')
  })

  it('several scripts run at once, each in its own terminal; Stop ends only the selected one', async () => {
    const user = userEvent.setup()
    twoScripts()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(within(header()).getByRole('button', { name: /^Run/ }))
    await user.click(scripts()[1])
    await user.click(within(header()).getByRole('button', { name: /^Run/ }))
    expect(screen.getAllByTestId('view-run').map((v) => v.getAttribute('data-command'))).toEqual(['dev', 'docs'])
    expect(scripts()[0].title).toBe('dev · Running')
    expect(scripts()[1].title).toBe('docs · Running')
    await user.click(within(header()).getByRole('button', { name: /^Stop/ }))
    expect(hoisted.bridge.send.ptyKill).toHaveBeenCalledWith('pty-docs')
    expect(hoisted.bridge.send.ptyKill).toHaveBeenCalledTimes(1)
    expect(scripts()[0].title).toBe('dev · Running')
    expect(scripts()[1].title).toBe('docs')
  })

  it('a run that ends by itself says how; one ended by Stop does not', async () => {
    const user = userEvent.setup()
    twoScripts()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(within(header()).getByRole('button', { name: /^Run/ }))
    await user.click(screen.getByRole('button', { name: 'exit dev' }))
    expect(scripts()[0].title).toBe('dev · Exited with 1')
    expect(within(header()).getByText('Exited with 1')).toBeTruthy()
    await user.click(scripts()[1])
    await user.click(within(header()).getByRole('button', { name: /^Run/ }))
    await user.click(within(header()).getByRole('button', { name: /^Stop/ }))
    await user.click(screen.getByRole('button', { name: 'exit docs' }))
    expect(scripts()[1].title).toBe('docs')
  })

  it('⌘R starts and stops the selected script', async () => {
    const user = userEvent.setup()
    twoScripts()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(scripts()[1])
    // The shortcut arrives as a UI command, outside any event React knows about.
    const press = () => act(() => hoisted.ui.handler!('run', 'w1'))
    press()
    expect(screen.getByTestId('view-run').getAttribute('data-command')).toBe('docs')
    press()
    expect(hoisted.bridge.send.ptyKill).toHaveBeenCalledWith('pty-docs')
  })

  it('several preview URLs: the arrow lists them with their expanded ports', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.repoSettings.r1.values.previewUrls = [
      { name: 'App', url: 'http://localhost:$FOREMAN_PORT' },
      { name: 'Docs', url: 'http://localhost:${FOREMAN_PORT}' },
      { name: 'Legacy', url: 'http://localhost:$(( SWITCHYARD_PORT + 2 ))' },
      { name: 'Custom', url: 'http://localhost:$APP_PORT' }
    ]
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(screen.getByRole('button', { name: 'Choose a preview' }))
    const items = within(screen.getByRole('menu', { name: 'Choose a preview' })).getAllByRole('menuitem')
    expect(items).toHaveLength(4)
    expect(items[0].textContent).toContain('http://localhost:3000')
    expect(items[1].textContent).toContain('http://localhost:3000')
    expect(items[2].textContent).toContain('http://localhost:3002')
    expect(items[3].textContent).toContain('http://localhost:$APP_PORT')
  })
})

describe('full screen', () => {
  it('its button is always in the header, named with its shortcut, whatever is selected', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(within(header()).getByRole('button', { name: 'Fullscreen (Ctrl⇧J)' }))
    expect(store.toggleTerminalFullscreen).toHaveBeenCalledWith('w1')
    await user.click(terms()[0])
    expect(within(header()).getByRole('button', { name: 'Fullscreen (Ctrl⇧J)' })).toBeTruthy()
  })

  it('in full screen it leaves it', () => {
    fakeState.terminalFullscreen = 'w1'
    render(<BottomPanel workspace={workspace} visible />)
    expect(within(header()).getByRole('button', { name: 'Exit fullscreen (Ctrl⇧J or Esc)' })).toBeTruthy()
  })
})

describe('without a run script', () => {
  beforeEach(() => {
    fakeState.snapshot.repoSettings.r1.values.runScripts = []
  })

  it('the Run entry offers to set one up, and no Run button pretends to run', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    expect(names(scripts())).toEqual(['Run', 'Setup'])
    expect(within(header()).queryByRole('button', { name: /^Run/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Set up a run script' }))
    expect(store.openSettingsPage).toHaveBeenCalledWith({ section: 'repo', repoId: 'r1', tab: 'scripts' })
  })

  it('asking the agent puts the set-up prompt in the chat, without sending it; with no chat it is off', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<BottomPanel workspace={workspace} visible />)
    expect((screen.getByRole('button', { name: 'Ask the agent to suggest one' }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    store.activeSessionId.mockReturnValue('s1')
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(screen.getByRole('button', { name: 'Ask the agent to suggest one' }))
    expect(store.fillComposer).toHaveBeenCalledWith('w1', 's1', expect.stringContaining('.foreman/settings.toml'), 'default-setup-repo')
  })

  it('Open a terminal shows one', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(screen.getByRole('button', { name: 'Open a terminal' }))
    expect(terms()[0].getAttribute('aria-selected')).toBe('true')
  })
})
