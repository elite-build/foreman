// @vitest-environment jsdom
// The bottom panel on ui/ Tabs: Run, Setup and terminal tabs, rename in place, the tab's own menu, and the toolbar.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomPanel } from '../src/renderer/src/components/BottomPanel'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule
  const bridge = { pathForFile: () => '', send: { saveTerminals: vi.fn(), ptyKill: vi.fn() } }
  return new Proxy(base, { get: (target, name: string) => (name === 'bridge' ? bridge : target[name]), has: () => true })
})
// xterm needs a real canvas: the terminals are stand-ins that show how they were mounted.
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: (props: { kind: string; visible: boolean; onRename?: () => void }) => (
    <div data-testid={`view-${props.kind}`} data-visible={String(props.visible)}>
      terminal view
    </div>
  )
}))
vi.mock('../src/renderer/src/components/SetupLog', () => ({ SetupLog: () => <div>setup log</div> }))
vi.mock('../src/renderer/src/components/Sidebar', () => ({ lucideIcon: () => undefined }))

const workspace = { id: 'w1', repoId: 'r1', state: 'ready', portBase: 3000, direct: false, cloud: false } as never

beforeEach(() => {
  resetFake()
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

const tabs = () => within(screen.getByRole('tablist')).getAllByRole('tab')

describe('the tab strip', () => {
  it('is a tablist of Run, Setup and Terminal 1, with Run selected and one Tab stop', () => {
    render(<BottomPanel workspace={workspace} visible />)
    expect(tabs().map((t) => t.textContent)).toEqual(['Run', 'Setup', 'Terminal 1'])
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1])
  })

  it('arrow keys move and select; only the selected panel shows', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    tabs()[0].focus()
    await user.keyboard('{ArrowRight}')
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    expect(screen.getByText('setup log').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
    await user.keyboard('{ArrowRight}')
    expect(tabs()[2].getAttribute('aria-selected')).toBe('true')
    // The terminal starts the first time its tab is shown, and the earlier panels stay mounted but hidden.
    expect(screen.getByTestId('view-shell').getAttribute('data-visible')).toBe('true')
    expect(screen.getByText('setup log').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('+ opens another terminal and shows it', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(tabs().map((t) => t.textContent)).toEqual(['Run', 'Setup', 'Terminal 1', 'Terminal 2'])
    expect(tabs()[3].getAttribute('aria-selected')).toBe('true')
  })

  it('each terminal tab has its own named close button, outside the tab; closing the last goes back to Run', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(tabs()[2])
    const close = screen.getByRole('button', { name: 'Close Terminal 1' })
    expect(tabs()[2].contains(close)).toBe(false)
    await user.click(close)
    expect(tabs().map((t) => t.textContent)).toEqual(['Run', 'Setup'])
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
  })
})

describe('renaming a terminal tab', () => {
  async function startRename(user: ReturnType<typeof userEvent.setup>) {
    await user.dblClick(tabs()[2])
    return screen.getByRole('textbox', { name: 'Rename terminal' }) as HTMLInputElement
  }

  it('double-click swaps the tab for a focused, selected field; Enter keeps the name', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    const field = await startRename(user)
    expect(document.activeElement).toBe(field)
    // The tab button stays in the DOM, hidden, so its panel keeps its name; the close button stays too.
    expect(screen.getByRole('button', { name: 'Close Terminal 1' })).toBeTruthy()
    await user.keyboard('build{Enter}')
    expect(screen.queryByRole('textbox', { name: 'Rename terminal' })).toBeNull()
    expect(tabs().map((t) => t.textContent)).toContain('build')
  })

  it('Escape cancels without keeping what was typed, and does not leave the field to the panel', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await startRename(user)
    await user.keyboard('oops{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Rename terminal' })).toBeNull()
    expect(tabs().map((t) => t.textContent)).toEqual(['Run', 'Setup', 'Terminal 1'])
  })

  it('an empty name goes back to "Terminal {n}"; leaving the field keeps what was typed', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    let field = await startRename(user)
    await user.type(field, 'api')
    await user.click(screen.getByRole('tab', { name: 'Run' }))
    expect(tabs().map((t) => t.textContent)).toContain('api')
    field = await startRename(user)
    await user.clear(field)
    await user.keyboard('{Enter}')
    expect(tabs().map((t) => t.textContent)).toEqual(['Run', 'Setup', 'Terminal 1'])
  })

  it('arrow keys in the field edit the text and do not switch tabs', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await startRename(user)
    const selected = tabs().findIndex((t) => t.getAttribute('aria-selected') === 'true')
    await user.keyboard('ab{ArrowLeft}{ArrowRight}')
    expect(tabs().findIndex((t) => t.getAttribute('aria-selected') === 'true')).toBe(selected)
  })
})

describe('the tab menu', () => {
  it('right-click opens the tab entries, named for the tab; Rename starts the field', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.pointer({ keys: '[MouseRight]', target: tabs()[2] })
    const menu = screen.getByRole('menu', { name: 'Terminal 1' })
    expect(within(menu).queryByRole('menuitem', { name: /^Copy$/ })).toBeNull()
    await user.click(within(menu).getByRole('menuitem', { name: /Rename/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Rename terminal' })).toBeTruthy()
  })

  it('its zoom row changes that tab only and keeps the menu open', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.pointer({ keys: '[MouseRight]', target: tabs()[2] })
    await user.click(screen.getByRole('menuitem', { name: 'Zoom in' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Back to 100%' }).textContent).not.toBe('100%')
  })

  it('Close terminal removes the tab', async () => {
    const user = userEvent.setup()
    render(<BottomPanel workspace={workspace} visible />)
    await user.pointer({ keys: '[MouseRight]', target: tabs()[2] })
    await user.click(screen.getByRole('menuitem', { name: /Close terminal/ }))
    expect(tabs().map((t) => t.textContent)).toEqual(['Run', 'Setup'])
  })
})

describe('the toolbar', () => {
  it('one run script: a Run button with its shortcut, named by its title', () => {
    render(<BottomPanel workspace={workspace} visible />)
    const buttons = screen.getAllByRole('button', { name: /Run/ })
    const run = buttons.find((b) => b.title === 'Run dev: npm run dev')!
    expect(run).toBeTruthy()
    expect(run.querySelector('kbd')?.textContent).toBe('CtrlR')
  })

  it('several run scripts: a split button whose arrow lists them', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.repoSettings.r1.values.runScripts = [
      { name: 'dev', command: 'npm run dev', default: true },
      { name: 'docs', command: 'npm run docs' }
    ]
    render(<BottomPanel workspace={workspace} visible />)
    await user.click(screen.getByRole('button', { name: 'Choose a run script' }))
    const menu = screen.getByRole('menu', { name: 'Choose a run script' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.querySelector('.ui-menu__label')?.textContent)).toEqual(['dev', 'docs'])
    await user.click(within(menu).getByRole('menuitem', { name: /docs/ }))
    expect(screen.getByTestId('view-run')).toBeTruthy()
    // Running swaps the button for Stop.
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
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

  it('without a run script, the empty state offers the settings button', () => {
    fakeState.snapshot.repoSettings.r1.values.runScripts = []
    render(<BottomPanel workspace={workspace} visible />)
    expect(screen.getByRole('button', { name: 'Open scripts settings' })).toBeTruthy()
  })
})
