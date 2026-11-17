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
import { shortcutActions } from '../src/renderer/src/App'
import { readFileSync } from 'node:fs'
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
    sidebarView: { repo: null, query: '', filter: 'all', showFinished: false },
    railNames: false
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

  it('the open workspace is the selected row, until the Assistant covers it: then only the Assistant is', () => {
    fakeState.snapshot.settings = { ...fakeState.snapshot.settings, assistantEnabled: true }
    Object.assign(fakeState, { selectedWorkspaceId: 'w1', assistantOpen: false })
    render(<Sidebar />)
    expect(row().getAttribute('aria-current')).toBe('true')
    cleanup()
    Object.assign(fakeState, { assistantOpen: true })
    render(<Sidebar />)
    expect(row().getAttribute('aria-current')).toBeNull()
    const assistant = screen.getByRole('button', { name: /Assistant/ })
    expect(assistant.getAttribute('aria-current')).toBe('true')
    // The workspace stays chosen, for when the Assistant closes.
    expect(fakeState.selectedWorkspaceId).toBe('w1')
    Object.assign(fakeState, { assistantOpen: false })
  })

  it('is one line; the selected row alone shows its branch under it, and the hover card (on focus too) says where it is and its shortcut', () => {
    render(<Sidebar />)
    expect(row().querySelector('.ws-sub')).toBeNull()
    fireEvent.focus(row())
    const card = screen.getByRole('group', { name: 'fix-login' })
    expect(card.textContent).toContain('kite · fix-login')
    expect(card.textContent).toContain('Ctrl1 opens it')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'fix-login' })).toBeNull()
    cleanup()
    fakeState.selectedWorkspaceId = 'w1'
    render(<Sidebar />)
    expect(row().querySelector('.ws-sub')?.textContent).toContain('kite · fix-login')
  })

  it('a click opens the workspace without popping its hover card; keyboard focus still opens it at once', async () => {
    // No hover first: the card would rightly open after its delay under a resting pointer.
    const user = userEvent.setup({ skipHover: true })
    render(<Sidebar />)
    await user.click(row())
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('w1')
    expect(document.activeElement).toBe(row())
    expect(screen.queryByRole('group', { name: 'fix-login' })).toBeNull()
    expect(row().getAttribute('aria-details')).toBeNull()
    // Tab on to the archive button and back: that focus is the keyboard's.
    await user.tab()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(row())
    expect(row().getAttribute('aria-details')).toBe(screen.getByRole('group', { name: 'fix-login' }).id)
  })

  it('the archive button is its own named button and does not open the row', async () => {
    render(<Sidebar />)
    await userEvent.setup().click(screen.getByRole('button', { name: /archive workspace/i }))
    expect(spy('openArchiveDialog')).toHaveBeenCalledWith('w1')
    expect(spy('selectWorkspace')).not.toHaveBeenCalled()
  })

  describe('while it archives in the background', () => {
    afterEach(() => {
      fakeState.archiveRuns = {}
    })

    it('says Archiving… and the step it is on, hides the archive button, and still opens the workspace', async () => {
      fakeState.snapshot.workspaces = [{ ...ws, diffStat: { additions: 12, deletions: 3 } }]
      fakeState.archiveRuns = { w1: { stopped: false, step: 'script' } }
      render(<Sidebar />)
      expect(row().textContent).toContain('Archiving… · Archive script')
      expect(screen.queryByRole('button', { name: /archive workspace/i })).toBeNull()
      expect(row().closest('.ws-row')?.textContent).not.toContain('+12')
      await userEvent.setup().click(row())
      expect(spy('selectWorkspace')).toHaveBeenCalledWith('w1')
    })

    it('before main reports a step it says Archiving… alone', () => {
      fakeState.archiveRuns = { w1: { stopped: false, step: null } }
      render(<Sidebar />)
      expect(row().textContent).toContain('Archiving…')
      expect(row().textContent).not.toContain('Archiving… ·')
    })

    it('stopped on a failure, it says so and opens the archive dialog, where Retry is', async () => {
      fakeState.archiveRuns = { w1: { stopped: true, step: 'script' } }
      render(<Sidebar />)
      expect(row().textContent).toContain('Archive stopped · needs you')
      await userEvent.setup().click(row())
      expect(spy('openArchiveDialog')).toHaveBeenCalledWith('w1')
      expect(spy('selectWorkspace')).not.toHaveBeenCalled()
    })
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

describe('save for later', () => {
  it('the row menu saves it for later, coming back tomorrow at 9:00', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('group', { name: 'Save for later' })).toBeTruthy()
    await user.click(within(menu).getByRole('menuitem', { name: /^Tomorrow · / }))
    const [id, patch] = (fakeApi.updateWorkspace as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(id).toBe('w1')
    const until = new Date(patch.later.until)
    expect([until.getHours(), until.getMinutes(), until.getDate()]).toEqual([9, 0, new Date(Date.now() + 86_400_000).getDate()])
  })

  it('a workspace put away leaves the list, and a line under it opens Later', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.workspaces = [{ ...ws, later: { at: '2026-01-01T00:00:00Z', until: '2999-01-01T09:00:00Z' } }]
    render(<Sidebar />)
    expect(screen.queryByRole('button', { name: /fix-login/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Later · 1' }))
    expect(spy('setSidebarFilter')).toHaveBeenCalledWith('later')
  })
})

describe('sidebar filters and search', () => {
  it('the filters are a tab list; choosing one sets the filter', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const tabs = screen.getByRole('tablist')
    expect(within(tabs).getAllByRole('tab')).toHaveLength(4)
    await user.click(within(tabs).getByRole('tab', { name: /working/i }))
    expect(spy('setSidebarFilter')).toHaveBeenCalledWith('working')
  })

  it('shows the tabs Settings turns on, in its order', () => {
    fakeState.snapshot.settings.views = [
      { id: 'pinned', tab: true, lane: false, home: false },
      { id: 'all', tab: true, lane: false, home: false },
      { id: 'needs-you', tab: false, lane: true, home: true },
      { id: 'working', tab: false, lane: true, home: true },
      { id: 'in-review', tab: true, lane: true, home: false }
    ]
    try {
      render(<Sidebar />)
      const tabs = within(screen.getByRole('tablist')).getAllByRole('tab')
      expect(tabs.map((tab) => tab.textContent)).toEqual(['Pinned', 'All', 'In review'])
      // The saved filter (All) stays selected.
      expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    } finally {
      delete (fakeState.snapshot.settings as { views?: unknown }).views
    }
  })

  it('Find is a small icon that opens the box in place; typing filters, and Escape clears and closes it, back on the icon', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    // Closed: no box, just ⌕ in the top row beside the switcher.
    expect(screen.queryByRole('searchbox')).toBeNull()
    const find = screen.getByRole('button', { name: 'Find' })
    expect(find.closest('.sidebar-top')).not.toBeNull()
    await user.click(find)
    // Open in place: the box takes the switcher's row, with focus in it; + stays.
    const search = screen.getByRole('searchbox', { name: 'Find a workspace…' })
    expect(search.closest('.sidebar-top')).not.toBeNull()
    expect(document.activeElement).toBe(search)
    expect(screen.queryByRole('button', { name: /^Space:/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy()
    await user.type(search, 'x')
    expect(spy('setSidebarQuery')).toHaveBeenLastCalledWith('x')
    await user.keyboard('{Escape}')
    expect(spy('setSidebarQuery')).toHaveBeenLastCalledWith('')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Find' }))
  })

  it('Escape closes Find even while a row’s hover card is open under the pointer, and closes the card too', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'Find' }))
    const search = screen.getByRole('searchbox')
    await user.type(search, 'fix')
    // The pointer rests on a row while focus stays in the box: the card opens after its delay.
    fireEvent.mouseEnter(row())
    await waitFor(() => expect(screen.getByRole('group', { name: 'fix-login' })).toBeTruthy())
    expect(document.activeElement).toBe(search)
    await user.keyboard('{Escape}')
    expect(spy('setSidebarQuery')).toHaveBeenLastCalledWith('')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('group', { name: 'fix-login' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Find' }))
  })

  it('opens Find by keyboard, and closes it when left empty', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    screen.getByRole('button', { name: 'Find' }).focus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    await user.tab()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Find' })).toBeTruthy()
  })

  it('keeps the box open while it has text, with Clear inside it', () => {
    fakeState.sidebarView = { ...fakeState.sidebarView, query: 'fix' }
    try {
      render(<Sidebar />)
      expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('fix')
      expect(screen.queryByRole('button', { name: 'Find' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
      expect(spy('setSidebarQuery')).toHaveBeenLastCalledWith('')
    } finally {
      fakeState.sidebarView = { repo: null, query: '', filter: 'all', showFinished: false }
    }
  })
})

// A comparison's (or a flow run's) workspaces are listed only in its own group, so its heading folds like every group's
// and, folded, still says ▲ and how many of them wait on the person.
describe('a comparison’s group', () => {
  const member = (id: string, label: string) => ({ ...ws, id, name: `oauth-${id}`, branch: `oauth-${id}`, path: `/code/kite/${id}`, compareId: 'cmp', compare: { prompt: 'Add OAuth', label } })
  const asking = { id: 's1', workspaceId: 'a', agent: 'codex', model: 'm', fastMode: false, planMode: false, status: 'idle', queue: [], createdAt: '2026-01-01T00:00:00Z' }
  beforeEach(() => {
    Object.assign(fakeState.snapshot, { workspaces: [member('a', 'Claude'), member('b', 'Codex')], sessions: [asking] })
    fakeState.approvals = [{ id: 'ap', sessionId: 's1', kind: 'tool', toolName: 'Bash' }]
  })
  afterEach(() => {
    fakeState.sidebarView = { repo: null, query: '', filter: 'all', showFinished: false }
  })

  it('is headed by a level-3 heading whose one button folds it under its own key', async () => {
    render(<Sidebar />)
    const heading = screen.getByRole('heading', { level: 3, name: 'Compare · “Add OAuth” · 2' })
    const fold = within(heading).getByRole('button')
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    await userEvent.setup().click(fold)
    expect(spy('toggleSidebarGroup')).toHaveBeenCalledWith('compare:cmp')
  })

  it('folded, its heading says ▲ and how many of its workspaces need you, and its rows are hidden', () => {
    fakeState.sidebarView = { ...fakeState.sidebarView, folded: ['compare:cmp'] }
    render(<Sidebar />)
    const head = screen.getByRole('button', { name: 'Compare · “Add OAuth” · 2 · 1 needs you' })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.querySelector('.sb-head-need [data-glyph="warn"]')).not.toBeNull()
    expect(document.getElementById(head.getAttribute('aria-controls')!)!.hidden).toBe(true)
  })

  it('open, its heading counts without ▲, as every open heading does', () => {
    render(<Sidebar />)
    const head = screen.getByRole('button', { name: 'Compare · “Add OAuth” · 2' })
    expect(head.querySelector('.sb-head-need')).toBeNull()
  })
})

// The one way to add anything (the 7a sidebar): a + at the end of the top row opens a menu of every kind of thing there
// is to add; no other + is left in the sidebar.
describe('the + menu', () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    const add = screen.getByRole('button', { name: 'New' })
    expect(add.getAttribute('aria-haspopup')).toBe('menu')
    await user.click(add)
    return screen.findByRole('menu', { name: 'New' })
  }

  it('is the only add control: no rail +, no New button, no Import… in the footer', () => {
    render(<Sidebar />)
    expect(screen.getAllByRole('button', { name: 'New' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /add repository/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new workspace/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull()
    // Both tour steps about adding point at it.
    const add = screen.getByRole('button', { name: 'New' })
    expect(add.getAttribute('data-tour')).toBe('new-workspace')
    expect(add.closest('[data-tour="add-repo"]')).not.toBeNull()
  })

  it('opens with focus on New workspace, which opens on the repository Ctrl+N uses; Escape closes it back on +', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const menu = await openMenu(user)
    const first = within(menu).getAllByRole('menuitem')[0]
    expect(first.textContent).toContain('New workspace')
    expect(first.textContent).toContain('in kite')
    expect(document.activeElement).toBe(first)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New' }))
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /New workspace/ }))
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('r1')
  })

  it('reaches an automation, a repository (open, clone, quick start), and an organization', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /New automation…/ }))
    expect(spy('openAutomations')).toHaveBeenCalled()
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /github/i }))
    expect(spy('openAddRepoDialog')).toHaveBeenCalledWith('clone')
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /Quick start/ }))
    expect(spy('openAddRepoDialog')).toHaveBeenCalledWith('quick-start')
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /New organization…/ }))
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('says why New workspace is off with no repository to work in', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.repos = []
    fakeState.snapshot.workspaces = []
    render(<Sidebar />)
    const item = within(await openMenu(user)).getByRole('menuitem', { name: /New workspace/ })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.textContent).toContain('Add a repository first')
    await user.click(item)
    expect(spy('openNewWorkspace')).not.toHaveBeenCalled()
  })

  it('lists recent folders, each opening from its Open button; its × forgets it and leaves the menu open', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove /home/me/older from recents' }))
    expect(fakeApi.forgetRecentRepo).toHaveBeenCalledWith('/home/me/older')
    expect(screen.getByRole('menu')).toBeTruthy()
    // The Open button of that row (found by its title, the path).
    await user.click(menu.querySelector('[role="menuitem"][title="/home/me/older"]') as HTMLElement)
    expect(spy('openRecentRepo')).toHaveBeenCalledWith('/home/me/older')
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

  it('the narrow rail is tiles alone: the name is the tile’s name and its tooltip', () => {
    render(<Sidebar />)
    const tile = screen.getByRole('button', { name: 'kite' })
    expect(tile.getAttribute('title')).toBe('kite')
    expect(document.querySelector('.repo-rail.names')).toBeNull()
    expect(document.querySelector('.rail-name')).toBeNull()
  })

  it('one toggle shows the names and, pressed again, hides them; nothing opens over the list', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Sidebar />)
    const toggle = screen.getByRole('button', { name: /^Show repository names \(Ctrl\+Shift\+N\)$/ })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    await user.click(toggle)
    expect(spy('toggleRailNames')).toHaveBeenCalledTimes(1)
    fakeState.railNames = true
    rerender(<Sidebar />)
    const pressed = screen.getByRole('button', { name: /^Show repository names/ })
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    await user.click(pressed)
    expect(spy('toggleRailNames')).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('with names shown, each tile has its name and what is going on in it beside it, as its description', async () => {
    fakeState.railNames = true
    render(<Sidebar />)
    const tile = screen.getByRole('button', { name: 'kite' })
    const item = tile.closest('.rail-item')!
    expect(item.querySelector('.rail-name-title')?.textContent).toBe('kite')
    expect(item.querySelector('.rail-name-line')?.textContent).toBe('1 workspace · main')
    expect(tile.getAttribute('aria-describedby')).toBe(item.querySelector('.rail-name-line')?.id)
    // The tooltip would repeat what the rail now says.
    expect(tile.getAttribute('title')).toBeNull()
    const all = screen.getByRole('button', { name: 'All repositories' }).closest('.rail-item')!
    expect(all.querySelector('.rail-name-line')?.textContent).toBe('1 repository')
    await userEvent.setup().click(tile)
    expect(spy('showRepoHome')).toHaveBeenCalledWith('r1')
  })

  it('what needs you is a ▲ and a count on the narrow tile, and words beside the wide one', () => {
    fakeState.snapshot.workspaces = [{ ...ws, archiveStopped: { step: 'script', detail: 'exit 1', at: '2026-01-01T00:00:00Z' } }]
    const { rerender } = render(<Sidebar />)
    const tile = screen.getByRole('button', { name: 'kite · 1 needs you' })
    const badge = tile.querySelector('.rail-badge')!
    expect(badge.querySelector('[data-glyph="warn"]')).not.toBeNull()
    expect(badge.textContent).toBe('1')
    fakeState.railNames = true
    rerender(<Sidebar />)
    const wide = screen.getByRole('button', { name: 'kite · 1 needs you' })
    expect(wide.querySelector('.rail-badge')).toBeNull()
    expect(wide.closest('.rail-item')?.querySelector('.rail-name-line')?.textContent).toBe('1 needs you')
  })

  it('right-click on a tile opens the repository menu', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'kite' }), { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'kite' })
    await user.click(within(menu).getByRole('menuitem', { name: /new workspace/i }))
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('r1')
  })

  it('names the command palette by its shortcut, with ⌘ for its icon (⌕ is Find)', () => {
    render(<Sidebar />)
    const rail = screen.getByRole('navigation', { name: 'Repositories' })
    expect(within(rail).getByRole('button', { name: /^Command palette \(/ })).toBeTruthy()
    expect(within(rail).queryByRole('button', { name: 'Find' })).toBeNull()
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

describe('the sidebar in an organization', () => {
  const memory = { id: 'mem', name: 'acme-memory', rootPath: '/code/acme-memory', defaultBranch: 'main', spaceId: 'o1' }
  const site = { id: 'site', name: 'site', rootPath: '/code/site', defaultBranch: 'main', spaceId: 'o1' }
  beforeEach(() => {
    Object.assign(fakeState.snapshot, { repos: [repo, memory, site], organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-05T00:00:00Z' }] })
    Object.assign(fakeState, { space: 'o1', memoryView: null, employeesView: null, automations: null, assistantOpen: false })
  })
  afterEach(() => {
    delete fakeState.snapshot.organizations
    for (const key of ['space', 'memoryView', 'employeesView', 'automations', 'assistantOpen']) delete fakeState[key]
  })

  it('opens New workspace, from the + menu and from Ctrl+N alike, on the organization’s repository, never its memory repository', async () => {
    const newWorkspace = async () => {
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'New' }))
      await user.click(screen.getByRole('menuitem', { name: /New workspace/ }))
    }
    render(<Sidebar />)
    await newWorkspace()
    expect(spy('openNewWorkspace')).toHaveBeenLastCalledWith('site')
    shortcutActions.newWorkspace(undefined)
    expect(spy('openNewWorkspace')).toHaveBeenLastCalledWith('site')
    // With the memory repository picked on the rail, too.
    cleanup()
    fakeState.sidebarView = { ...fakeState.sidebarView, repo: 'mem' }
    render(<Sidebar />)
    await newWorkspace()
    expect(spy('openNewWorkspace')).toHaveBeenLastCalledWith('site')
    shortcutActions.newWorkspace(undefined)
    expect(spy('openNewWorkspace')).toHaveBeenLastCalledWith('site')
    expect(spy('openNewWorkspace')).not.toHaveBeenCalledWith('mem')
  })

  it('offers no New workspace in the memory repository’s menu', async () => {
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Acme’s memory' }), { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'acme-memory' })
    expect(within(menu).queryByRole('menuitem', { name: /new workspace/i })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: /repository settings/i })).toBeTruthy()
  })

  it('rings the rail’s tile as Home only while Home is showing, not over the Team, an employee’s or the Memory page', () => {
    const ringed = () => document.querySelectorAll('.rail-tile-wrap.on-home').length
    const { rerender } = render(<Sidebar />)
    expect(ringed()).toBe(1)
    for (const page of [{ employeesView: { orgId: 'o1', page: 'team' } }, { employeesView: { orgId: 'o1', page: 'employee', id: 'e-max1' } }, { memoryView: 'o1' }, { automations: { selected: null } }]) {
      Object.assign(fakeState, page)
      rerender(<Sidebar />)
      expect(ringed()).toBe(0)
      Object.assign(fakeState, { memoryView: null, employeesView: null, automations: null })
    }
    rerender(<Sidebar />)
    expect(ringed()).toBe(1)
  })

  it('never scrolls the list sideways: the hidden archive button sits inside its row', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync('src/renderer/src/styles/sidebar.css', 'utf8')
    document.head.append(style)
    try {
      fakeState.snapshot.workspaces = [{ ...ws, repoId: 'site' }]
      render(<Sidebar />)
      expect(getComputedStyle(document.querySelector('.sidebar-scroll')!).overflowX).toBe('hidden')
      const archive = screen.getByRole('button', { name: /archive workspace/i })
      expect(getComputedStyle(archive).position).toBe('absolute')
      expect(getComputedStyle(archive).right).toBe('0px')
      expect(getComputedStyle(archive).top).toBe('0px')
    } finally {
      style.remove()
    }
  })
})

// The sidebar's top (the 7a sidebar): one row of the space switcher, Automations, Assistant, Find and the one +; then, in
// the list, Team and Channels (organizations only), the tabs with their counts and the groups, every heading folding the
// same way. Every count is the shared needs-you count: kite's stopped archive in Personal; in Acme, Ada's question (lima),
// Max's held push and Ada's memory proposal.
describe('the sidebar’s heading, rows and counts', () => {
  const memory = { id: 'mem', name: 'acme-memory', rootPath: '/code/acme-memory', defaultBranch: 'main', spaceId: 'o1' }
  const site = { id: 'site', name: 'site', rootPath: '/code/site', defaultBranch: 'main', spaceId: 'o1' }
  const NOW = '2026-11-14T10:00:00.000Z'
  const lima = { id: 'lima', repoId: 'site', name: 'lima', branch: 'ada/launch-date', state: 'ready', createdAt: '2026-11-14T09:30:00.000Z', path: '/w/lima', startedBy: { via: 'employee', orgId: 'o1', employeeId: 'ada', runId: 'r3', taskId: 'date', title: 'Which day does 2.4 launch?' } }
  const kyoto = { id: 'kyoto', repoId: 'site', name: 'kyoto', branch: 'max/launch-2.4', state: 'ready', createdAt: '2026-11-14T09:00:00.000Z', path: '/w/kyoto', startedBy: { via: 'employee', orgId: 'o1', employeeId: 'max', runId: 'r2', taskId: 'launch', title: 'Write the launch post' } }
  const question = { id: 'date', orgId: 'o1', employeeId: 'ada', requestId: 'q', rootId: 'date', parentId: null, title: 'Which day does 2.4 launch?', body: '', from: 'person', targetRepoId: 'site', state: 'waiting', waitingOn: 'person', question: { id: 'q1', question: 'Which day does Atlas 2.4 launch?', options: ['Tue', 'Thu'], runId: 'r3', askedAt: '2026-11-14T09:35:00.000Z' }, createdAt: NOW, updatedAt: NOW }
  const push = { id: 'a1', orgId: 'o1', employeeId: 'max', taskId: 'launch', runId: 'r2', repoId: 'site', kind: 'push', payload: { kind: 'push', workspaceId: 'kyoto', branch: 'max/launch-2.4', base: 'main', head: 'abc', ahead: 1, commits: [], connection: 'gh' }, policy: 'held', state: 'held', key: 'k', createdAt: '2026-11-14T09:20:00.000Z', updatedAt: NOW }
  const proposal = { id: 'p1', orgId: 'o1', path: 'memory/org/PROJECT.md', kind: 'append', text: '- Thursdays.', employeeId: 'ada', runId: 'r3', createdAt: '2026-11-14T09:40:00.000Z' }
  const person = (id: string, name: string, colour: string) => ({ id, path: `bots/${id}.toml`, name, role: 'Writer', colour, responsibilities: [], problems: [], state: 'active', changed: false })
  beforeEach(() => {
    Object.assign(fakeState.snapshot, {
      repos: [repo, memory, site],
      organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: '2026-11-05T00:00:00Z' }],
      workspaces: [{ ...ws, archiveStopped: { step: 'script', detail: 'exit 1', at: '2026-11-14T08:00:00.000Z' } }, lima, kyoto],
      employees: { o1: { head: 'h', employees: [person('ada', 'Ada', 'pink'), person('max', 'Max', 'orange')] } },
      employeeWork: { o1: { tasks: [question], runs: [], last: {}, proposals: [proposal], actions: [push], revision: 1 } }
    })
    fakeState.snapshot.settings = { ...fakeState.snapshot.settings, assistantEnabled: true }
    Object.assign(fakeState, { space: 'o1', memoryView: null, employeesView: null, automations: null, assistantOpen: false, teamOpen: false })
  })
  afterEach(() => {
    for (const key of ['organizations', 'employees', 'employeeWork']) delete fakeState.snapshot[key]
    for (const key of ['space', 'memoryView', 'employeesView', 'automations', 'assistantOpen', 'teamOpen']) delete fakeState[key]
  })

  it('starts the top row with the space switcher: the space, where else something waits, and its line as tooltip and menu', async () => {
    render(<Sidebar />)
    const heading = screen.getByRole('heading', { level: 2 })
    const switcher = within(heading).getByRole('button', { name: 'Space: Acme · 1 in Personal' })
    // "1 repository": site, not the memory repository. The space's own count is on the tab and the rail, not repeated here.
    expect(switcher.getAttribute('title')).toBe('1 repository')
    expect(document.querySelector('.space-switcher-line')).toBeNull()
    await userEvent.setup().click(switcher)
    expect(screen.getByRole('menu', { name: 'Spaces' }).textContent).toMatch(/^1 repository/)
    // New organization… is in the + menu, the one place things are added.
    expect(screen.queryByRole('menuitem', { name: /New organization…/ })).toBeNull()
    expect(screen.queryByText('Nothing running')).toBeNull()
  })

  it('puts the switcher, Automations, the Assistant, Find and + on one row, then Team, Channels and the tabs in the list', () => {
    render(<Sidebar />)
    const top = document.querySelector('.sidebar-top') as HTMLElement
    const names = within(top)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? '')
    expect(names.map((n) => n.split(' · ')[0])).toEqual(['Space: Acme', 'Automations', 'Assistant', 'Find', 'New'])
    // Automations and the Assistant are icons whose names carry what the entries' rows said.
    expect(within(top).getByRole('button', { name: 'Automations · templates & schedules' })).toBeTruthy()
    expect(within(top).getByRole('button', { name: /^Assistant/ }).getAttribute('aria-keyshortcuts')).toBe('Control+Shift+A')
    // Top to bottom: the row, Team, Channels, the tabs, the groups.
    const order = ['.sidebar-top', '.team-section', '.projects-section', '.sidebar-filters', '.ws-group'].map((s) => document.querySelector(s)!)
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('offers an employee and a channel in the + menu, in an organization', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.organizations = [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', programManagerId: 'ada', createdAt: '2026-11-05T00:00:00Z' }]
    render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'New' }))
    const employee = screen.getByRole('menuitem', { name: /New employee/ })
    expect(employee.textContent).toContain('joins Acme')
    await user.click(employee)
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'new' })
    await user.click(screen.getByRole('button', { name: 'New' }))
    const channel = screen.getByRole('menuitem', { name: /New channel/ })
    expect(channel.textContent).toContain('@Ada plans it with you')
    await user.click(channel)
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channel', mention: expect.any(Number) })
    // Neither section has a + of its own.
    expect(screen.queryByRole('button', { name: /^New employee/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New channel' })).toBeNull()
  })

  it('hides Team and Channels while Find has text, so the matches are at the top', () => {
    fakeState.sidebarView = { ...fakeState.sidebarView, query: 'lima' }
    render(<Sidebar />)
    expect(document.querySelector('.team-section')).toBeNull()
    expect(document.querySelector('.projects-section')).toBeNull()
    expect(screen.getByRole('button', { name: /^lima/ })).toBeTruthy()
    fakeState.sidebarView = { repo: null, query: '', filter: 'all', showFinished: false }
  })

  it('says how many need you on the Needs you tab, with ▲, and lists the push and the proposal as rows in Needs your attention', async () => {
    render(<Sidebar />)
    const tab = screen.getByRole('tab', { name: 'Needs you · 3' })
    expect(tab.querySelector('[data-glyph="warn"]')).not.toBeNull()
    const group = screen.getByRole('region', { name: 'Needs your attention' })
    expect(within(group).getByRole('button', { name: 'Needs your attention · 3' })).toBeTruthy()
    // Oldest first: the push (09:20), Ada's question in lima (09:35), the proposal (09:40).
    const rows = within(group).getAllByRole('button').filter((b) => b.classList.contains('ws-flow'))
    expect(rows.map((r) => r.querySelector('.ws-title')?.textContent)).toEqual(['Push of max/launch-2.4', 'lima', 'Memory proposal'])
    expect(rows[0].querySelector('.ws-label')?.textContent).toBe('Held action · leaves this computer')
    expect(rows[2].querySelector('.ws-label')?.textContent).toBe('Memory proposal · PROJECT.md')
    // Each says whose it is by hat on its one line; its hover card (on focus too) says who, the repository and how long.
    expect(rows[0].querySelector('.ws-hat svg.ui-hard-hat')).not.toBeNull()
    expect(rows[0].querySelector('.ws-sub')).toBeNull()
    fireEvent.focus(rows[0])
    const card = screen.getByRole('group', { name: 'Push of max/launch-2.4' })
    expect(rows[0].getAttribute('aria-details')).toBe(card.id)
    expect(card.textContent).toContain('Max · site')
    await userEvent.setup().click(rows[0])
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
  })

  it('heads every group with one button that folds it, by click, Enter or Space, remembered, and still says ▲ 3 folded', async () => {
    render(<Sidebar />)
    const group = screen.getByRole('region', { name: 'Needs your attention' })
    const fold = within(group).getByRole('button', { name: 'Needs your attention · 3' })
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    const rows = document.getElementById(fold.getAttribute('aria-controls')!)!
    expect(group.contains(rows) && !rows.hidden).toBe(true)
    // One button: no separate chevron, nothing that opens a page.
    expect(within(group).getAllByRole('button').filter((b) => !b.classList.contains('ws-flow') && !b.classList.contains('ws-archive'))).toEqual([fold])
    const user = userEvent.setup()
    await user.click(fold)
    fold.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(spy('toggleSidebarGroup').mock.calls).toEqual([['attention'], ['attention'], ['attention']])
    cleanup()

    // Folded: the rows are hidden and the heading says it waits on you, by ▲ and in words.
    fakeState.sidebarView = { ...fakeState.sidebarView, folded: ['attention'] }
    render(<Sidebar />)
    const folded = screen.getByRole('region', { name: 'Needs your attention' })
    const head = within(folded).getByRole('button', { name: 'Needs your attention · 3 · 3 need you' })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.querySelector('.sb-head-need [data-glyph="warn"]')).not.toBeNull()
    expect(document.getElementById(head.getAttribute('aria-controls')!)!.hidden).toBe(true)
    // The other groups stay open.
    expect(screen.getByRole('button', { name: /^kyoto/ })).toBeTruthy()
    cleanup()

    // A filter lists exactly what it found: no fold, every row shown.
    fakeState.sidebarView = { ...fakeState.sidebarView, filter: 'needs-you' }
    render(<Sidebar />)
    const filtered = screen.getByRole('region', { name: 'Needs your attention' })
    expect(within(filtered).queryByRole('button', { name: /^Needs your attention/ })).toBeNull()
    expect(within(filtered).getAllByRole('button').filter((b) => b.classList.contains('ws-flow'))).toHaveLength(3)
    fakeState.sidebarView = { repo: null, query: '', filter: 'all', showFinished: false }
  })

  it('folds Team and Channels with the same kind of heading, and opens pages only from the links under them', async () => {
    const user = userEvent.setup()
    Object.assign(fakeState, { teamOpen: true, projectsOpen: true })
    render(<Sidebar />)
    const team = screen.getByRole('region', { name: 'Team' })
    // Two employees; Ada's question and proposal and Max's push wait (folded, the heading would say ▲ 3).
    const teamHead = within(team).getByRole('button', { name: 'Team · 2' })
    expect(teamHead.getAttribute('aria-expanded')).toBe('true')
    await user.click(teamHead)
    teamHead.focus()
    await user.keyboard('{Enter}')
    expect(spy('toggleTeamOpen')).toHaveBeenCalledTimes(2)
    expect(spy('openEmployees')).not.toHaveBeenCalled()
    await user.click(within(team).getByRole('button', { name: 'Team page' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
    const channels = screen.getByRole('region', { name: 'Channels' })
    const channelsHead = within(channels).getByRole('button', { name: 'Channels · 1' })
    channelsHead.focus()
    await user.keyboard(' ')
    expect(spy('toggleProjectsOpen')).toHaveBeenCalledTimes(1)
    await user.click(within(channels).getByRole('button', { name: 'All channels' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channels' })
    for (const key of ['projectsOpen']) delete fakeState[key]
  })

  it('marks the Team page and All channels links while their page is open', () => {
    Object.assign(fakeState, { teamOpen: true, projectsOpen: true, employeesView: { orgId: 'o1', page: 'team' } })
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Team page' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'All channels' }).getAttribute('aria-current')).toBeNull()
    cleanup()
    fakeState.employeesView = { orgId: 'o1', page: 'channels' }
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Team page' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('button', { name: 'All channels' }).getAttribute('aria-current')).toBe('page')
    delete fakeState.projectsOpen
  })

  it('shows an employee’s run on one line, with its hat at the end, and the question it asks', () => {
    render(<Sidebar />)
    const limaRow = screen.getByRole('button', { name: /^lima/ })
    const label = limaRow.querySelector('.ws-label')!
    expect(limaRow.querySelector('.ws-hat svg.ui-hard-hat')).not.toBeNull()
    expect(label.textContent).toBe('Ada asks · Which day does Atlas 2.4 launch?')
    // A run that needs nothing still says whose it is.
    const kyotoRow = screen.getByRole('button', { name: /^kyoto/ })
    expect(kyotoRow.querySelector('.ws-label')?.textContent).toBe('Max’s run · Write the launch post')
  })

  it('makes the memory repository a Brain tile that opens Memory, and counts the rail from the same list', async () => {
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'All repositories · 3 need you' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'site · 2 need you' })).toBeTruthy()
    const brain = screen.getByRole('button', { name: 'Acme’s memory · 1 needs you' })
    await userEvent.setup().click(brain)
    expect(spy('openMemory')).toHaveBeenCalledWith('o1')
    expect(spy('showRepoHome')).not.toHaveBeenCalledWith('mem')
    cleanup()
    fakeState.memoryView = 'o1'
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Acme’s memory · 1 needs you' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('in Personal: no Team row, its own count, and the heading points to Acme’s 3', () => {
    fakeState.space = null
    render(<Sidebar />)
    expect(document.querySelector('.team-section')).toBeNull()
    expect(screen.getByRole('button', { name: 'Space: Personal · 3 in Acme' }).getAttribute('title')).toBe('1 repository')
    expect(screen.getByRole('tab', { name: 'Needs you · 1' })).toBeTruthy()
    // No Team or Channels, so no employee or channel in the + menu either.
    expect(document.querySelector('.projects-section')).toBeNull()
    expect(screen.queryByText('Memory proposal')).toBeNull()
  })

  it('with no organization, shows nothing of employees: Personal, its repositories, no Team row and no ▲ elsewhere', () => {
    Object.assign(fakeState.snapshot, { organizations: [], repos: [repo], workspaces: [ws], employees: undefined, employeeWork: undefined })
    fakeState.space = null
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Space: Personal' }).getAttribute('title')).toBe('1 repository')
    expect(document.querySelector('.team-section')).toBeNull()
    expect(document.querySelector('.space-switcher-elsewhere')).toBeNull()
  })

  it('keeps the + menu to what Personal has: no employee or channel', async () => {
    const user = userEvent.setup()
    fakeState.space = null
    render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'New' }))
    const menu = screen.getByRole('menu', { name: 'New' })
    expect(within(menu).queryByRole('menuitem', { name: /New employee/ })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: /New channel/ })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: /New automation…/ })).toBeTruthy()
  })
})
