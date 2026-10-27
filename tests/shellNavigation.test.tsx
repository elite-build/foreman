// @vitest-environment jsdom
// The shell's riskiest surfaces (design system phase 3, batch B1): the sidebar's rows (open, rename, archive, the
// right-click menu), the repository rail and its Add menu, the filters, and the command palette.
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { CommandPalette } from '../src/renderer/src/components/Overlays'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]

const repo = { id: 'r1', name: 'kite', rootPath: '/code/kite', defaultBranch: 'main' }
const ws = { id: 'w1', repoId: 'r1', name: 'fix-login', branch: 'fix-login', state: 'ready', createdAt: '2026-01-01T00:00:00Z', path: '/code/kite/w1' }

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  fakeApi.updateWorkspace = vi.fn(async () => undefined)
  fakeApi.forgetRecentRepo = vi.fn(async () => undefined)
  Object.assign(fakeState, {
    selectedWorkspaceId: null,
    settingsPage: null,
    approvals: [],
    unread: {},
    unreadSessions: {},
    sidebarView: { repo: null, query: '', filter: 'all', showFinished: false }
  })
  Object.assign(fakeState.snapshot, {
    platform: 'linux',
    repos: [repo],
    workspaces: [ws],
    sessions: [],
    recentRepos: ['/home/me/older', '/home/me/oldest'],
    homeDir: '/home/me',
    keepAwake: { keepAwake: false },
    repoSettings: {},
    attentionHistory: { events: [] },
    schedules: [],
    occurrences: [],
    appVersion: undefined
  })
  fakeState.snapshot.settings = { ...fakeState.snapshot.settings, showResourceUsage: false, coloredSidebarDiffs: false, sidebarSide: 'left', keepAwakeBatteryCutoff: false }
})
afterEach(cleanup)

const row = () => screen.getByRole('button', { name: /fix-login/ })

describe('sidebar rows', () => {
  it('a workspace row is a button that opens the workspace', async () => {
    render(<Sidebar />)
    await userEvent.setup().click(row())
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('w1')
  })

  it('the archive button is its own named button and does not open the row', async () => {
    render(<Sidebar />)
    await userEvent.setup().click(screen.getByRole('button', { name: /archive workspace/i }))
    expect(spy('openArchiveDialog')).toHaveBeenCalledWith('w1')
    expect(spy('selectWorkspace')).not.toHaveBeenCalled()
  })

  it('right-click opens a menu; Rename swaps the title for a field that Enter saves', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    fireEvent.contextMenu(row(), { clientX: 40, clientY: 40 })
    const menu = await screen.findByRole('menu', { name: 'fix-login' })
    await user.click(within(menu).getByRole('menuitem', { name: /rename/i }))
    const field = await screen.findByRole('textbox', { name: /rename/i })
    expect((field as HTMLInputElement).value).toBe('fix-login')
    await user.clear(field)
    await user.type(field, 'login-fix{Enter}')
    expect(fakeApi.updateWorkspace).toHaveBeenCalledWith('w1', { name: 'login-fix' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /rename/i })).toBeNull())
  })

  it('Escape in the rename field cancels without saving', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    fireEvent.contextMenu(row(), { clientX: 40, clientY: 40 })
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /rename/i }))
    const field = await screen.findByRole('textbox', { name: /rename/i })
    await user.type(field, 'x{Escape}')
    expect(fakeApi.updateWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: /rename/i })).toBeNull()
  })

  it('the menu sets a status with a radio item and shows the current one checked', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.workspaces = [{ ...ws, status: 'in-review' }]
    render(<Sidebar />)
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })
    const menu = await screen.findByRole('menu')
    const radios = within(menu).getAllByRole('menuitemradio')
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    await user.click(within(menu).getAllByRole('menuitemradio', { checked: false })[0])
    expect(fakeApi.updateWorkspace).toHaveBeenCalledWith('w1', { status: expect.any(String) })
  })

  it('Escape closes the menu and keeps the row', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(row()).toBeTruthy()
  })
})

describe('sidebar filters and search', () => {
  it('the filters are a tab list; choosing one sets the filter', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const tabs = screen.getByRole('tablist')
    expect(within(tabs).getAllByRole('tab')).toHaveLength(4)
    await user.click(within(tabs).getByRole('tab', { name: /running/i }))
    expect(spy('setSidebarFilter')).toHaveBeenCalledWith('running')
  })

  it('the search field filters by typing and clears with Escape', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const search = screen.getByRole('searchbox')
    await user.type(search, 'x')
    expect(spy('setSidebarQuery')).toHaveBeenLastCalledWith('x')
    await user.keyboard('{Escape}')
    expect(spy('setSidebarQuery')).toHaveBeenLastCalledWith('')
  })
})

describe('sidebar footer', () => {
  it('shows the running version, which opens Settings at the update check', async () => {
    fakeState.snapshot.appVersion = '0.1.0'
    render(<Sidebar />)
    const version = screen.getByRole('button', { name: 'v0.1.0' })
    expect(version.getAttribute('title')).toBe('Foreman 0.1.0. Open Settings to check for updates.')
    await userEvent.setup().click(version)
    expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'general', scrollTo: 'check-for-updates' })
  })

  it('shows no version without one', () => {
    render(<Sidebar />)
    expect(screen.queryByRole('button', { name: /^v\d/ })).toBeNull()
  })
})

describe('repository rail', () => {
  it('a repository tile is a toggle button named by the repository', async () => {
    render(<Sidebar />)
    const tile = screen.getByRole('button', { name: 'kite' })
    expect(tile.getAttribute('aria-pressed')).toBe('false')
    await userEvent.setup().click(tile)
    expect(spy('showRepoHome')).toHaveBeenCalledWith('r1')
  })

  it('right-click on a tile opens the repository menu', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'kite' }), { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'kite' })
    await user.click(within(menu).getByRole('menuitem', { name: /new workspace/i }))
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('r1')
  })

  it('the Add button opens a menu of ways in; a choice opens its dialog', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const add = screen.getByRole('button', { name: /add repository/i })
    expect(add.getAttribute('aria-haspopup')).toBe('menu')
    await user.click(add)
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThanOrEqual(3)
    await user.click(within(menu).getByRole('menuitem', { name: /github/i }))
    expect(spy('openAddRepoDialog')).toHaveBeenCalledWith('clone')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a recent folder opens from its Open button; its × forgets it and leaves the menu open', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: /add repository/i }))
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove /home/me/older from recents' }))
    expect(fakeApi.forgetRecentRepo).toHaveBeenCalledWith('/home/me/older')
    expect(screen.getByRole('menu')).toBeTruthy()
    // The Open button of that row (found by its title, the path: its name waits on the new catalogue key).
    await user.click(menu.querySelector('[role="menuitem"][title="/home/me/older"]') as HTMLElement)
    expect(spy('openRecentRepo')).toHaveBeenCalledWith('/home/me/older')
  })
})

describe('command palette', () => {
  const field = () => screen.getByRole('combobox')

  beforeEach(() => {
    fakeState.overlay = 'palette'
  })

  it('lists commands under group headings, and typing narrows them to the matches alone', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    expect(screen.getAllByRole('option').length).toBeGreaterThan(5)
    expect(document.querySelector('.ui-listbox__heading')).not.toBeNull()
    await user.type(field(), 'toggle sidebar')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(document.querySelector('.ui-listbox__heading')).toBeNull()
  })

  it('Enter runs the first match, which closes the palette first', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await user.type(field(), 'toggle sidebar{Enter}')
    expect(spy('openOverlay')).toHaveBeenCalledWith(null)
    expect(spy('toggleLeftPanel')).toHaveBeenCalled()
  })

  it('arrow keys move the active option and Enter runs that one', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await user.type(field(), 'toggle')
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(2)
    await user.keyboard('{ArrowDown}')
    expect(field().getAttribute('aria-activedescendant')).toBe(options[1].id)
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(field().getAttribute('aria-activedescendant')).toBe(options[options.length - 1].id)
  })

  it('clicking an option runs it', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await user.type(field(), 'toggle sidebar')
    await user.click(screen.getByRole('option'))
    expect(spy('toggleLeftPanel')).toHaveBeenCalled()
  })

  it('Escape closes the overlay from the field', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    await user.type(field(), 'x{Escape}')
    expect(spy('openOverlay')).toHaveBeenCalledWith(null)
  })

  it('is a named dialog that holds focus on its field', () => {
    render(<CommandPalette />)
    expect(screen.getByRole('dialog', { name: /palette/i })).toBeTruthy()
    expect(document.activeElement).toBe(field())
  })
})
