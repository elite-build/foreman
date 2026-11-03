// @vitest-environment jsdom
// The terminal's menus and find bar on ui/: the output menu's zoom row, the panel's + menu (new terminals and saved commands), Open in's
// default-app menu, and the find bar's toggles and keys.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalFind } from '../src/renderer/src/components/TerminalFind'
import { TerminalMenu } from '../src/renderer/src/components/TerminalMenu'
import { NewMenu } from '../src/renderer/src/components/NewTerminalMenu'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/theme', () => ({ terminalSearchColors: () => ({}) }))

beforeEach(() => {
  resetFake()
  fakeState.snapshot.settings.terminalShell = 'auto'
  fakeState.snapshot.settings.savedCommands = []
  fakeState.snapshot.repoCommands = {}
})
afterEach(cleanup)

function tabActions(over: Partial<Parameters<typeof TerminalMenu>[0]['tab'] & object> = {}) {
  return {
    onRename: vi.fn(),
    fullscreen: false,
    onFullscreen: vi.fn(),
    copyOnSelect: false,
    onCopyOnSelect: vi.fn(),
    zoom: 1,
    onZoom: vi.fn(),
    onFind: vi.fn(),
    onClose: vi.fn(),
    ...over
  }
}

describe('the terminal menu', () => {
  it('is a context menu named for its tab, with the zoom steps in one control row', async () => {
    const tab = tabActions()
    render(<TerminalMenu x={10} y={10} label="Terminal 2" dismiss={vi.fn()} tab={tab} />)
    const menu = screen.getByRole('menu', { name: 'Terminal 2' })
    expect(menu.className).toContain('terminal-menu')
    const row = within(menu).getByRole('group', { name: 'Zoom' })
    expect(within(row).getAllByRole('menuitem').map((b) => b.getAttribute('aria-label'))).toEqual(['Zoom out', 'Back to 100%', 'Zoom in'])
    expect(within(row).getByRole('menuitem', { name: 'Back to 100%' }).textContent).toBe('100%')
  })

  it('zoom steps keep the menu open; the percentage resets', async () => {
    const user = userEvent.setup()
    const tab = tabActions({ zoom: 1.2 })
    const dismiss = vi.fn()
    render(<TerminalMenu x={10} y={10} dismiss={dismiss} tab={tab} />)
    await user.click(screen.getByRole('menuitem', { name: 'Zoom in' }))
    expect(tab.onZoom).toHaveBeenCalledTimes(1)
    expect((tab.onZoom as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeGreaterThan(1.2)
    await user.click(screen.getByRole('menuitem', { name: 'Zoom out' }))
    expect((tab.onZoom as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBeLessThan(1.2)
    await user.click(screen.getByRole('menuitem', { name: 'Back to 100%' }))
    expect(tab.onZoom).toHaveBeenLastCalledWith(1)
    expect(dismiss).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('arrow keys move between the zoom buttons and leave the row with Up and Down', async () => {
    const user = userEvent.setup()
    render(<TerminalMenu x={0} y={0} dismiss={vi.fn()} tab={tabActions()} />)
    const out = screen.getByRole('menuitem', { name: 'Zoom out' })
    out.focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Back to 100%' }))
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Zoom in' }))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Find/ }))
  })

  it('activating an entry dismisses first, then runs it', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    const tab = tabActions({ onFind: () => order.push('find') })
    render(<TerminalMenu x={0} y={0} dismiss={() => order.push('dismiss')} tab={tab} />)
    await user.click(screen.getByRole('menuitem', { name: /Find/ }))
    expect(order).toEqual(['dismiss', 'find'])
  })

  it('Copy on select is a checkbox item that reports the flipped value', async () => {
    const user = userEvent.setup()
    const tab = tabActions({ copyOnSelect: true })
    render(<TerminalMenu x={0} y={0} dismiss={vi.fn()} tab={tab} />)
    const item = screen.getByRole('menuitemcheckbox', { name: 'Copy on select' })
    expect(item.getAttribute('aria-checked')).toBe('true')
    await user.click(item)
    expect(tab.onCopyOnSelect).toHaveBeenCalledWith(false)
  })

  it('Escape dismisses the menu and tells the terminal to take focus back', async () => {
    const user = userEvent.setup()
    const dismiss = vi.fn()
    const onEscape = vi.fn()
    render(<TerminalMenu x={0} y={0} dismiss={dismiss} onEscape={onEscape} tab={tabActions()} />)
    await user.keyboard('{Escape}')
    expect(dismiss).toHaveBeenCalled()
    expect(onEscape).toHaveBeenCalled()
  })

  it('output entries: Copy and Send need a selection, and say why in the tooltip', () => {
    const actions = { hasSelection: false, onCopy: vi.fn(), onSend: vi.fn(), onSelectAll: vi.fn(), onPaste: vi.fn() }
    render(<TerminalMenu x={0} y={0} dismiss={vi.fn()} actions={actions} />)
    expect((screen.getByRole('menuitem', { name: /^Copy/ }) as HTMLButtonElement).disabled).toBe(true)
    const send = screen.getByRole('menuitem', { name: /Send selection to chat/ }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.title).toBe('Select some output first')
    expect((screen.getByRole('menuitem', { name: /Select all/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the find bar', () => {
  function fakeSearch() {
    let listener: ((r: { resultIndex: number; resultCount: number }) => void) | undefined
    return {
      onDidChangeResults: (fn: typeof listener) => ((listener = fn), { dispose: vi.fn() }),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      clearDecorations: vi.fn(),
      emit: (resultIndex: number, resultCount: number) => listener?.({ resultIndex, resultCount })
    }
  }

  it('options are toggle buttons; Enter and Shift+Enter step; Escape closes', async () => {
    const user = userEvent.setup()
    const search = fakeSearch()
    const onClose = vi.fn()
    render(<TerminalFind search={search as never} focusRequest={0} onClose={onClose} />)
    const input = screen.getByRole('textbox', { name: 'Find in terminal' })
    expect(document.activeElement).toBe(input)
    const matchCase = screen.getByRole('button', { name: 'Match case' })
    expect(matchCase.getAttribute('aria-pressed')).toBe('false')
    await user.click(matchCase)
    expect(matchCase.getAttribute('aria-pressed')).toBe('true')
    await user.type(input, 'err')
    expect(search.findNext).toHaveBeenLastCalledWith('err', expect.objectContaining({ caseSensitive: true, incremental: true }))
    search.findNext.mockClear()
    await user.keyboard('{Enter}')
    expect(search.findNext).toHaveBeenCalledWith('err', expect.objectContaining({ incremental: false }))
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(search.findPrevious).toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
    expect(search.clearDecorations).toHaveBeenCalled()
  })

  it('the step buttons are named and wait for a match', async () => {
    const user = userEvent.setup()
    const search = fakeSearch()
    render(<TerminalFind search={search as never} focusRequest={0} onClose={vi.fn()} />)
    const next = screen.getByRole('button', { name: /Next match/ }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    await user.type(screen.getByRole('textbox'), 'x')
    search.emit(0, 3)
    await waitFor(() => expect(next.disabled).toBe(false))
    await user.click(next)
    expect(search.findNext).toHaveBeenLastCalledWith('x', expect.objectContaining({ incremental: false }))
  })
})

describe('the + menu', () => {
  const found = {
    paths: { pwsh: 'C:/pwsh.exe', powershell: 'C:/powershell.exe', gitbash: null, cmd: 'C:/cmd.exe', wsl: null },
    custom: { command: '', path: null }
  }
  const mine = { id: 'c1', name: 'Dev server', command: 'npm run dev', scope: 'repo' as const, repoId: 'r1' }
  const everywhere = { id: 'c2', name: 'Lint', command: 'npm run lint', scope: 'all' as const }
  const shared = { id: 'c3', name: 'Seed', command: 'make seed', scope: 'repo' as const, repoId: 'r1', source: 'repo' as const, approved: false }
  const menu = (over: Partial<Parameters<typeof NewMenu>[0]> = {}) => (
    <NewMenu repoId="r1" repoName="acme" shells={false} disabled={false} onTerminal={vi.fn()} onCommand={vi.fn()} {...over} />
  )
  const trigger = () => screen.getByRole('button', { name: 'New terminal or saved command' })

  it('New terminal comes first and takes focus; it opens a plain tab', async () => {
    const user = userEvent.setup()
    const onTerminal = vi.fn()
    render(menu({ onTerminal }))
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    await user.click(trigger())
    const items = screen.getAllByRole('menuitem')
    expect(items[0].textContent).toBe('New terminal')
    expect(document.activeElement).toBe(items[0])
    await user.keyboard('{Enter}')
    expect(onTerminal).toHaveBeenCalledWith(undefined)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('on Windows it looks the shells up when it opens and lists the other ones found for a one-off tab', async () => {
    const user = userEvent.setup()
    fakeApi.detectShells = vi.fn(async () => found)
    const onTerminal = vi.fn()
    render(menu({ shells: true, onTerminal }))
    expect(fakeApi.detectShells).not.toHaveBeenCalled()
    await user.click(trigger())
    expect(fakeApi.detectShells).toHaveBeenCalled()
    await screen.findByText('New terminal in another shell')
    // The default shell is New terminal itself, so it isn't listed again; shells that weren't found aren't offered.
    const shells = screen.getAllByRole('menuitem').filter((i) => i.title.startsWith('C:/'))
    expect(shells.length).toBeGreaterThan(0)
    expect(shells.some((i) => i.textContent?.includes('Git Bash'))).toBe(false)
    await user.click(shells[0])
    expect(onTerminal).toHaveBeenCalledWith(expect.any(String))
  })

  it('elsewhere it never looks for shells', async () => {
    const user = userEvent.setup()
    fakeApi.detectShells = vi.fn(async () => found)
    render(menu())
    await user.click(trigger())
    expect(fakeApi.detectShells).not.toHaveBeenCalled()
    expect(screen.queryByText('New terminal in another shell')).toBeNull()
  })

  it('lists this repo’s saved commands, then all repos’, and runs one', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.settings.savedCommands = [mine, everywhere]
    fakeState.snapshot.repoCommands = { r1: [shared] }
    const onCommand = vi.fn()
    render(menu({ onCommand }))
    await user.click(trigger())
    const list = screen.getByRole('menu', { name: 'New terminal or saved command' })
    const repoGroup = within(list).getByRole('group', { name: 'acme' })
    expect(within(repoGroup).getAllByRole('menuitem').map((i) => i.title)).toEqual(['npm run dev', 'make seed'])
    const allGroup = within(list).getByRole('group', { name: 'All repos' })
    expect(within(allGroup).getAllByRole('menuitem')).toHaveLength(1)
    // A repo's own command that still needs approval says so.
    expect(within(repoGroup).getByRole('menuitem', { name: /Seed/ }).textContent).toMatch(/approval|asks|repo/i)
    await user.click(within(allGroup).getByRole('menuitem', { name: /Lint/ }))
    expect(onCommand).toHaveBeenCalledWith(everywhere)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('says when there are no saved commands, and still offers Edit commands…', async () => {
    const user = userEvent.setup()
    render(menu())
    await user.click(trigger())
    expect(screen.getByText('No saved commands for this repo yet.')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Edit commands/ })).toBeTruthy()
  })

  it('Escape closes it and gives + its focus back', async () => {
    const user = userEvent.setup()
    render(menu())
    await user.click(trigger())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('is off while the workspace is not ready', () => {
    render(menu({ disabled: true }))
    expect((trigger() as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Settings → Terminal: the Shell list', () => {
  const found = {
    paths: { pwsh: 'C:/pwsh.exe', powershell: 'C:/powershell.exe', gitbash: null, cmd: 'C:/cmd.exe', wsl: null },
    custom: { command: '', path: null }
  }

  it('is a popover with a listbox: lookups on open, missing shells disabled, picking saves and closes', async () => {
    const { TerminalShellSection } = await import('../src/renderer/src/components/settings/ShellSettings')
    const user = userEvent.setup()
    fakeApi.detectShells = vi.fn(async () => found)
    fakeApi.updateSettings = vi.fn(async () => ({}))
    fakeState.snapshot.settings.terminalShell = 'auto'
    fakeState.snapshot.settings.scriptShell = 'cmd'
    fakeState.snapshot.settings.terminalShellCustom = ''
    render(<TerminalShellSection />)
    const trigger = await screen.findByRole('button', { name: 'Shell' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fakeApi.detectShells.mockClear()
    await user.click(trigger)
    expect(fakeApi.detectShells).toHaveBeenCalled()
    const list = screen.getByRole('listbox', { name: 'Shell' })
    const options = within(list).getAllByRole('option')
    const gitBash = options.find((o) => o.textContent?.includes('Git Bash'))!
    expect(gitBash.getAttribute('aria-disabled')).toBe('true')
    await user.click(within(list).getByRole('option', { name: /Command Prompt/ }))
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ terminalShell: 'cmd' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
