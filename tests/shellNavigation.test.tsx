// @vitest-environment jsdom
// The shell's riskiest surfaces (design system phase 3, batch B1): the sidebar's rows (open, rename, archive, the
// right-click menu), its rail (the spaces, the modes and the tools at its foot), Work by repository or by state, Inbox,
// the + menu, and the command palette.
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { CommandPalette, NewList } from '../src/renderer/src/components/Overlays'
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
    sidebarMode: 'work'
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

  it('is titled with what it is for, its first titled chat, and renaming it renames that chat', async () => {
    const user = userEvent.setup()
    const sessions = fakeState.snapshot.sessions
    fakeState.snapshot.sessions = [{ id: 's1', workspaceId: 'w1', title: 'Fix the login redirect', agent: 'claude', model: 'm', status: 'idle', queue: [] }]
    try {
      render(<Sidebar />)
      const titled = screen.getByRole('button', { name: /^Fix the login redirect/ })
      fireEvent.focus(titled)
      expect(screen.getByRole('group', { name: 'Fix the login redirect' }).textContent).toContain('kite · fix-login')
      fakeApi.updateSession = vi.fn(async () => undefined)
      fireEvent.contextMenu(titled, { clientX: 40, clientY: 40 })
      await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /rename/i }))
      const field = (await screen.findByRole('textbox', { name: /rename/i })) as HTMLInputElement
      expect(field.value).toBe('Fix the login redirect')
      await user.clear(field)
      await user.type(field, 'Keep the return path{Enter}')
      expect(fakeApi.updateSession).toHaveBeenCalledWith('s1', { title: 'Keep the return path' })
      expect(fakeApi.updateWorkspace).not.toHaveBeenCalled()
    } finally {
      fakeState.snapshot.sessions = sessions
    }
  })

  it('is two lines, selected or not: its title, then what it is doing and since when, even when that is nothing', () => {
    spy('timeAgo').mockReturnValue('2h ago')
    try {
      render(<Sidebar />)
      expect(row().querySelector('.ws-title')?.textContent).toBe('fix-login')
      expect(row().querySelector('.ws-label')?.textContent).toBe('Idle · 2h ago')
      cleanup()
      fakeState.selectedWorkspaceId = 'w1'
      render(<Sidebar />)
      expect(row().querySelector('.ws-label')?.textContent).toBe('Idle · 2h ago')
    } finally {
      spy('timeAgo').mockReset()
    }
  })

  it('in Work, a repository is a card holding its heading and rows', () => {
    render(<Sidebar />)
    const repo = screen.getByRole('region', { name: 'kite' })
    expect(repo.classList.contains('ui-card')).toBe(true)
    expect(within(repo).getByRole('heading', { level: 3 }).textContent).toContain('kite')
    expect(repo.contains(row())).toBe(true)
  })

  it('the hover card (on focus too) says where it is and its shortcut', () => {
    render(<Sidebar />)
    expect(row().querySelector('.ws-sub')).toBeNull()
    fireEvent.focus(row())
    const card = screen.getByRole('group', { name: 'fix-login' })
    // No chat has a title, so the row is titled with the workspace's name; the card adds its repository (the branch is the name).
    expect(card.textContent).toContain('kite')
    expect(card.textContent).toContain('Ctrl1 opens it')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'fix-login' })).toBeNull()
    cleanup()
    // The open workspace's row adds no line of its own, so the list never changes its rhythm under the pointer.
    fakeState.selectedWorkspaceId = 'w1'
    render(<Sidebar />)
    expect(row().querySelector('.ws-sub')).toBeNull()
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
  it('Work lists each repository under a heading of its own, its workspaces under it; Group by turns it to states', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const kite = screen.getByRole('heading', { level: 3, name: 'kite · 1' })
    expect(within(kite).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    await user.click(within(kite).getByRole('button'))
    expect(spy('toggleSidebarGroup')).toHaveBeenCalledWith('repo:r1')
    await user.click(screen.getByRole('button', { name: 'Group by' }))
    const menu = screen.getByRole('menu', { name: 'Group by' })
    expect(within(menu).getAllByRole('menuitemradio').map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['Repository', 'true'],
      ['State', 'false']
    ])
    await user.click(within(menu).getByRole('menuitemradio', { name: 'State' }))
    expect(spy('setSidebarGroupBy')).toHaveBeenCalledWith('state')
  })

  it('has no filter tabs: a filter saved by the old sidebar lists all of Work', () => {
    fakeState.sidebarView = { ...fakeState.sidebarView, filter: 'pinned' }
    render(<Sidebar />)
    expect(screen.queryByRole('tab', { name: /^All|^Pinned/ })).toBeNull()
    // fix-login isn't pinned, and is listed.
    expect(row()).toBeTruthy()
    fakeState.sidebarView = { ...fakeState.sidebarView, filter: 'all' }
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
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeTruthy()
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
    // A comparison is a group of its own in Work by state; by repository its workspaces are rows in their repository.
    fakeState.sidebarView = { ...fakeState.sidebarView, groupBy: 'state' }
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

// The one way to add anything: New, a split button under the top row. Its main half makes what the mode is about; its ▾
// (and Ctrl+Shift+N) opens the list of everything to make in the middle of the window, the mode's own item first.
describe('New', () => {
  const options = () => screen.getAllByRole('option')

  it('is the only add control: a split button under the top row, with both tour steps about adding on it', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    const main = screen.getByRole('button', { name: 'New workspace' })
    expect(main.closest('.sidebar-top')).toBeNull()
    expect(main.textContent).toContain('Ctrl+N')
    expect(main.getAttribute('data-tour')).toBe('new-workspace')
    expect(main.closest('[data-tour="add-repo"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /add repository/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull()
    await user.click(main)
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('r1')
    const more = screen.getByRole('button', { name: /^More to make/ })
    expect(more.getAttribute('aria-haspopup')).toBe('dialog')
    await user.click(more)
    expect(spy('openOverlay')).toHaveBeenCalledWith('new')
  })

  it('lists the mode’s own item first, then the rest of the space, then the ways to bring something in', async () => {
    const user = userEvent.setup()
    render(<NewList />)
    const first = options()[0]
    expect(first.textContent).toContain('New workspace')
    expect(first.textContent).toContain('in kite')
    expect(screen.getByRole('group', { name: 'In Work' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Bring into Foreman' })).toBeTruthy()
    await user.click(first)
    expect(spy('openOverlay')).toHaveBeenCalledWith(null)
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('r1')
  })

  it('reaches an automation, a repository (open, clone, quick start), and an organization', async () => {
    const user = userEvent.setup()
    const pick = async (name: RegExp) => {
      cleanup()
      render(<NewList />)
      await user.click(screen.getByRole('option', { name }))
    }
    await pick(/New automation…/)
    expect(spy('openAutomations')).toHaveBeenCalled()
    await pick(/github/i)
    expect(spy('openAddRepoDialog')).toHaveBeenCalledWith('clone')
    await pick(/Quick start/)
    expect(spy('openAddRepoDialog')).toHaveBeenCalledWith('quick-start')
    await pick(/New organization…/)
    expect(spy('openCreateOrganization')).toHaveBeenCalledWith(true)
  })

  it('adds a repository from its main half when there is none to work in', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.repos = []
    fakeState.snapshot.workspaces = []
    render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'Add a repository' }))
    expect(spy('addRepository')).toHaveBeenCalled()
    expect(spy('openNewWorkspace')).not.toHaveBeenCalled()
  })

  it('lists recent folders only once something is typed, each opening the folder', async () => {
    const user = userEvent.setup()
    render(<NewList />)
    expect(screen.queryByRole('option', { name: /older/ })).toBeNull()
    await user.keyboard('older')
    await user.click(screen.getByRole('option', { name: /~\/older/ }))
    expect(spy('openRecentRepo')).toHaveBeenCalledWith('/home/me/older')
  })
})

describe('the rail’s foot and the list’s footer', () => {
  it('has Automations, the palette, shortcuts, report a problem, the tour and Quick settings on the rail, each named with its key', () => {
    render(<Sidebar />)
    const tools = document.querySelector('.rail-tools') as HTMLElement
    expect(within(tools).getByRole('button', { name: /^Automations/ }).getAttribute('data-tour')).toBe('automations')
    expect(within(tools).getByRole('button', { name: /^Command palette \(/ })).toBeTruthy()
    expect(within(tools).getByRole('button', { name: /^Keyboard shortcuts/ })).toBeTruthy()
    expect(within(tools).getByRole('button', { name: /^Report a problem/ })).toBeTruthy()
    expect(within(tools).getByRole('button', { name: 'Welcome tour' }).getAttribute('data-tour')).toBe('help')
    const gear = within(tools).getByRole('button', { name: 'Quick settings' })
    expect(gear.getAttribute('data-tour')).toBe('settings')
    expect(gear.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('the gear opens the first six Quick tiles over the work, and All settings opens Settings on Quick', async () => {
    const user = userEvent.setup()
    const settings = fakeState.snapshot.settings
    fakeState.snapshot.settings = {
      ...settings,
      theme: 'system',
      zoom: 1,
      notifications: true,
      defaultPlanMode: false,
      agentInstances: [],
      reviewModel: { agent: 'claude', model: 'claude-opus-5-5[1m]', effort: 'high', fast: false }
    }
    try {
      render(<Sidebar />)
      await user.click(screen.getByRole('button', { name: 'Quick settings' }))
      const pop = screen.getByRole('dialog', { name: 'Quick settings' })
      expect(within(pop).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['New chats use', 'Theme', 'App zoom', 'Agent notifications', 'Plan first', 'Review model'])
      expect(within(pop).getByText('6 of 10 tiles')).toBeTruthy()
      await user.click(within(pop).getByRole('button', { name: /^All settings/ }))
      expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'quick' })
      expect(screen.queryByRole('dialog', { name: 'Quick settings' })).toBeNull()
    } finally {
      fakeState.snapshot.settings = settings
    }
  })

  it('shows Archived with its count and the running version, which opens Settings at the update check', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.appVersion = '1.2.3'
    fakeState.snapshot.workspaces = [ws, { ...ws, id: 'w2', state: 'archived' }]
    try {
      render(<Sidebar />)
      const footer = document.querySelector('.sidebar-footer') as HTMLElement
      await user.click(within(footer).getByRole('button', { name: 'Archived · 1' }))
      expect(spy('openOverlay')).toHaveBeenCalledWith('archived')
      await user.click(within(footer).getByRole('button', { name: 'v1.2.3' }))
      expect(spy('openSettingsPage')).toHaveBeenCalledWith({ section: 'general', scrollTo: 'check-for-updates' })
    } finally {
      fakeState.snapshot.appVersion = undefined
      fakeState.snapshot.workspaces = [ws]
    }
  })

  it('shows no version without one', () => {
    render(<Sidebar />)
    expect(screen.queryByRole('button', { name: /^v\d/ })).toBeNull()
  })
})

describe('the rail', () => {
  it('shows the spaces, then the modes as tabs: Inbox and Work in Personal, Work picked', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    expect(within(screen.getByRole('navigation', { name: 'Spaces' })).getByRole('button', { name: 'Personal' }).getAttribute('aria-pressed')).toBe('true')
    const modes = screen.getByRole('tablist', { name: 'Sidebar' })
    expect(modes.getAttribute('aria-orientation')).toBe('vertical')
    expect(within(modes).getAllByRole('tab').map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Inbox', 'false'],
      ['Work', 'true']
    ])
    // The list beside is the picked mode's panel, named by its tab; the title says the space and the mode.
    expect(screen.getByRole('tabpanel', { name: 'Work' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('PersonalWork')
    await user.click(within(modes).getByRole('tab', { name: 'Inbox' }))
    expect(spy('setSidebarMode')).toHaveBeenCalledWith('inbox')
    // The tour's Needs you step points at Inbox.
    expect(within(modes).getByRole('tab', { name: 'Inbox' }).getAttribute('data-tour')).toBe('needs-you')
  })

  it('counts what a project’s people ask on Channels, and Inbox says how much waits there and opens it', async () => {
    const user = userEvent.setup()
    const at = '2026-01-01T00:00:00Z'
    const extra = {
      organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', createdAt: at }],
      employees: { o1: { head: 'h', employees: [] } },
      projects: { o1: [{ id: 'p1', orgId: 'o1', slug: 'csv', title: 'CSV', requirement: 'CSV', repoId: 'site', pmId: 'e-pri1', phase: 'working', plans: [], parts: {}, replans: 0, steps: [{ kind: 'part', partId: 'qa', round: 1, taskId: 't2', employeeId: 'e-qui1', state: 'running', startedAt: at }], artifacts: {}, waits: [], decisions: [], notes: [], createdAt: at, updatedAt: at }] },
      employeeWork: { o1: { tasks: [{ id: 't2', orgId: 'o1', employeeId: 'e-qui1', requestId: 'r', rootId: 't2', parentId: null, title: 'QA', body: 'b', from: 'person', targetRepoId: 'site', state: 'waiting', waitingOn: 'person', question: { id: 'q', question: 'Which browser?', options: [], runId: 'run', askedAt: at }, createdAt: at, updatedAt: at }], runs: [], last: {}, proposals: [], roots: {}, actions: [], decided: [], revision: 1 } }
    }
    Object.assign(fakeState.snapshot, extra, { repos: [repo, { id: 'mem', name: 'acme-memory', rootPath: '/code/mem', defaultBranch: 'main', spaceId: 'o1' }, { id: 'site', name: 'site', rootPath: '/code/site', defaultBranch: 'main', spaceId: 'o1' }] })
    Object.assign(fakeState, { space: 'o1', sidebarMode: 'inbox' })
    try {
      render(<Sidebar />)
      const modes = screen.getByRole('tablist', { name: 'Sidebar' })
      expect(within(modes).getByRole('tab', { name: 'Channels · 1 needs you' })).toBeTruthy()
      await user.click(screen.getByRole('button', { name: '1 waits for you in Channels' }))
      expect(spy('setSidebarMode')).toHaveBeenCalledWith('channels')
    } finally {
      for (const key of Object.keys(extra)) delete fakeState.snapshot[key]
      delete fakeState.space
    }
  })

  it('a repository’s ⋯ opens its menu: a workspace in it, its settings, its path, remove', async () => {
    const user = userEvent.setup()
    render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'More for kite' }))
    const menu = screen.getByRole('menu', { name: 'More for kite' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New workspace…', 'Repository settings…', 'Copy path', 'Remove repository…'])
    await user.click(within(menu).getByRole('menuitem', { name: 'New workspace…' }))
    expect(spy('openNewWorkspace')).toHaveBeenCalledWith('r1')
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

  it('opens New workspace, from New and from Ctrl+N alike, on the organization’s repository, never its memory repository', async () => {
    const newWorkspace = async () => {
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'New workspace' }))
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

  it('offers New workspace in a code repository’s menu; the memory repository is never listed', async () => {
    fakeState.snapshot.workspaces = [{ ...ws, repoId: 'site' }]
    render(<Sidebar />)
    expect(screen.queryByText(/acme-memory/)).toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'site · 1' })).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'More for site' }))
    const menu = await screen.findByRole('menu', { name: 'More for site' })
    expect(within(menu).getByRole('menuitem', { name: /new workspace/i })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /repository settings/i })).toBeTruthy()
    fakeState.snapshot.workspaces = [ws]
  })

  it('has Team and Channels beside Inbox and Work, and never a Memory mode', () => {
    render(<Sidebar />)
    expect(within(screen.getByRole('tablist', { name: 'Sidebar' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Inbox', 'Work', 'Team', 'Channels'])
    expect(screen.queryByRole('tab', { name: /memory/i })).toBeNull()
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

// The sidebar's top: the space and the mode, Group by (Work), Find and the one +; the rail: the spaces with ▲ where else
// something waits, the modes with Inbox's ▲. Every count is the shared needs-you count: kite's stopped archive in Personal;
// in Acme, Ada's question (lima), Max's held push and Ada's memory proposal.
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
    Object.assign(fakeState, { space: 'o1', memoryView: null, employeesView: null, automations: null, assistantOpen: false })
  })
  afterEach(() => {
    for (const key of ['organizations', 'employees', 'employeeWork']) delete fakeState.snapshot[key]
    for (const key of ['space', 'memoryView', 'employeesView', 'automations', 'assistantOpen']) delete fakeState[key]
    fakeState.sidebarMode = 'work'
    fakeState.sidebarView = { repo: null, query: '', filter: 'all', showFinished: false }
  })

  it('names the space and the mode at the top; the rail says where else something waits, and what waits here on Inbox', () => {
    render(<Sidebar />)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('AcmeWork')
    const spaces = screen.getByRole('navigation', { name: 'Spaces' })
    // Acme is shown, so its tile says nothing waits (its count is on Inbox); Personal's says kite's stopped archive.
    expect(within(spaces).getByRole('button', { name: 'Acme' }).getAttribute('aria-pressed')).toBe('true')
    const personal = within(spaces).getByRole('button', { name: 'Personal · 1 needs you' })
    expect(personal.querySelector('.rail-badge')?.textContent).toBe('1')
    const inbox = screen.getByRole('tab', { name: 'Inbox · 3 need you' })
    expect(inbox.querySelector('.rail-badge')?.textContent).toBe('3')
    expect(screen.queryByText('Nothing running')).toBeNull()
  })

  it('puts Group by and Find in the top row, New under it; Automations and the Assistant at the rail’s foot', () => {
    render(<Sidebar />)
    const top = document.querySelector('.sidebar-top') as HTMLElement
    expect(within(top).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Group by', 'Find'])
    expect(top.nextElementSibling?.matches('.sidebar-new')).toBe(true)
    const rail = document.querySelector('.sidebar-rail') as HTMLElement
    // Automations and the Assistant are icons whose names carry what the entries' rows said.
    expect(within(rail).getByRole('button', { name: 'Automations · templates & schedules' })).toBeTruthy()
    expect(within(rail).getByRole('button', { name: /^Assistant/ }).getAttribute('aria-keyshortcuts')).toBe('Control+Shift+A')
    // Top to bottom on the rail: the spaces, the modes, the tools.
    const order = ['.rail-spaces', '.rail-modes', '.rail-tools'].map((sel) => rail.querySelector(sel)!)
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('makes an employee from Team and a project from Channels; the list leads with each', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.organizations = [{ id: 'o1', name: 'Acme', memoryRepoId: 'mem', programManagerId: 'ada', createdAt: '2026-11-05T00:00:00Z' }]
    fakeState.sidebarMode = 'team'
    const team = render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'New employee' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'new' })
    team.unmount()
    fakeState.sidebarMode = 'channels'
    const channels = render(<Sidebar />)
    await user.click(screen.getByRole('button', { name: 'New project' }))
    expect(spy('openEmployees')).toHaveBeenLastCalledWith({ orgId: 'o1', page: 'channel', mention: expect.any(Number) })
    // Neither section has a + of its own.
    expect(screen.queryByRole('button', { name: 'New channel' })).toBeNull()
    channels.unmount()
    render(<NewList />)
    const [first] = screen.getAllByRole('option')
    expect(first.textContent).toContain('New project')
    expect(first.textContent).toContain('@Ada plans it with you')
    expect(screen.getByRole('option', { name: /New employee/ }).textContent).toContain('joins Acme')
    fakeState.sidebarMode = 'work'
  })

  it('finds in Work: the matches alone, under their repository', () => {
    // Find matches a workspace's name as well as what it is for (the row's title).
    fakeState.sidebarView = { ...fakeState.sidebarView, query: 'lima' }
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: /^Which day does 2\.4 launch\?/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Write the launch post/ })).toBeNull()
    // A search lists what it found: the heading is plain, not a fold.
    expect(screen.getByRole('heading', { level: 3, name: 'site · 1' }).querySelector('button')).toBeNull()
  })

  it('lists in Inbox what waits, oldest first: the push, Ada’s question and the proposal, each with its hat', async () => {
    fakeState.sidebarMode = 'inbox'
    render(<Sidebar />)
    const panel = screen.getByRole('tabpanel', { name: 'Inbox · 3 need you' })
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('AcmeInbox')
    // Oldest first: the push (09:20), Ada's question in lima (09:35, titled with her task), the proposal (09:40).
    const rows = within(panel).getAllByRole('button').filter((b) => b.classList.contains('ws-flow'))
    expect(rows.map((r) => r.querySelector('.ws-title')?.textContent)).toEqual(['Push of max/launch-2.4', 'Which day does 2.4 launch?', 'Memory proposal'])
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
    // What waits in Personal is a link under the list, to that space's Inbox.
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Personal · 1 needs you' }))
    expect(spy('setSpace')).toHaveBeenCalledWith(null, { home: false })
  })

  it('says so when nothing waits in Inbox', () => {
    fakeState.sidebarMode = 'inbox'
    Object.assign(fakeState.snapshot, { organizations: [], repos: [repo], workspaces: [ws], employees: undefined, employeeWork: undefined })
    fakeState.space = null
    render(<Sidebar />)
    expect(screen.getByText('Nothing needs you in Personal.')).toBeTruthy()
  })

  it('in Work, a line above the repositories says how much waits in Inbox, and goes there', async () => {
    render(<Sidebar />)
    await userEvent.setup().click(screen.getByRole('button', { name: '3 need you in Inbox' }))
    expect(spy('setSidebarMode')).toHaveBeenCalledWith('inbox')
  })

  it('by state, heads every group with one button that folds it, by click, Enter or Space, remembered, and still says ▲ 3 folded', async () => {
    fakeState.sidebarView = { ...fakeState.sidebarView, groupBy: 'state' }
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
    expect(screen.getByRole('button', { name: /^Write the launch post/ })).toBeTruthy()
    cleanup()

    // A search lists exactly what it found: no fold, every row shown.
    fakeState.sidebarView = { ...fakeState.sidebarView, query: 'l' }
    render(<Sidebar />)
    const found = screen.getByRole('region', { name: 'Needs your attention' })
    expect(within(found).queryByRole('button', { name: /^Needs your attention/ })).toBeNull()
    expect(within(found).getAllByRole('button').filter((b) => b.classList.contains('ws-flow'))).toHaveLength(3)
  })

  it('lists the team in Team and the channels in Channels, each with the link that opens its page', async () => {
    const user = userEvent.setup()
    fakeState.sidebarMode = 'team'
    render(<Sidebar />)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('AcmeTeam')
    const team = screen.getByRole('list', { name: 'Employees of Acme' })
    expect(within(team).getAllByRole('button').map((b) => b.getAttribute('aria-label')?.split(' · ')[0])).toEqual(['Ada', 'Max'])
    // Team and Channels have no Find and no Group by: the top row is the title alone, New under it.
    expect(within(document.querySelector('.sidebar-top') as HTMLElement).queryAllByRole('button')).toEqual([])
    expect(screen.getByRole('button', { name: 'New employee' }).closest('.sidebar-new')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Team page' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
    cleanup()
    fakeState.sidebarMode = 'channels'
    render(<Sidebar />)
    expect(screen.getByRole('list', { name: 'Channels in Acme' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'All channels' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'channels' })
  })

  it('marks the Team page and All channels links while their page is open', () => {
    Object.assign(fakeState, { sidebarMode: 'team', employeesView: { orgId: 'o1', page: 'team' } })
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'Team page' }).getAttribute('aria-current')).toBe('page')
    cleanup()
    Object.assign(fakeState, { sidebarMode: 'channels', employeesView: { orgId: 'o1', page: 'channels' } })
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'All channels' }).getAttribute('aria-current')).toBe('page')
    cleanup()
    fakeState.employeesView = { orgId: 'o1', page: 'team' }
    render(<Sidebar />)
    expect(screen.getByRole('button', { name: 'All channels' }).getAttribute('aria-current')).toBeNull()
  })

  it('shows an employee’s run on one line, titled with its task, with its hat at the end, and the question it asks', () => {
    render(<Sidebar />)
    const limaRow = screen.getByRole('button', { name: /^Which day does 2\.4 launch\?/ })
    const label = limaRow.querySelector('.ws-label')!
    expect(limaRow.querySelector('.ws-hat svg.ui-hard-hat')).not.toBeNull()
    expect(label.textContent).toBe('Ada asks · Which day does Atlas 2.4 launch?')
    // A run that needs nothing still says whose it is.
    const kyotoRow = screen.getByRole('button', { name: /^Write the launch post/ })
    expect(kyotoRow.querySelector('.ws-label')?.textContent).toBe('Max’s run')
    // Its name and branch are in its hover card.
    fireEvent.focus(kyotoRow)
    expect(screen.getByRole('group', { name: 'Write the launch post' }).textContent).toContain('site · kyoto · max/launch-2.4')
  })

  it('counts what a project waits on on the Channels tab, not Inbox: it is in its channel', () => {
    const planning = { id: 'p1', orgId: 'o1', slug: 'csv', title: 'CSV', requirement: 'CSV', repoId: 'site', pmId: 'ada', phase: 'planning', plans: [], parts: {}, replans: 0, steps: [], artifacts: {}, waits: [{ id: 'w', kind: 'plan', since: NOW }], decisions: [], notes: [], createdAt: NOW, updatedAt: NOW }
    fakeState.snapshot.projects = { o1: [planning] }
    try {
      render(<Sidebar />)
      const channels = screen.getByRole('tab', { name: 'Channels · 1 needs you' })
      expect(channels.querySelector('.rail-badge')?.textContent).toBe('1')
      // Inbox keeps its 3: the plan isn't a row there.
      expect(screen.getByRole('tab', { name: 'Inbox · 3 need you' })).toBeTruthy()
    } finally {
      delete fakeState.snapshot.projects
    }
  })

  it('never shows the memory repository, and counts what waits on it (a proposal) on Inbox', () => {
    render(<Sidebar />)
    expect(screen.getByRole('tab', { name: 'Inbox · 3 need you' })).toBeTruthy()
    expect(document.querySelector('.sidebar')!.textContent).not.toContain('acme-memory')
    expect(screen.queryByRole('button', { name: /memory/i })).toBeNull()
  })

  it('in Personal: no Team or Channels, its own count on Inbox, and Acme’s 3 on Acme’s tile', () => {
    fakeState.space = null
    render(<Sidebar />)
    expect(within(screen.getByRole('tablist', { name: 'Sidebar' })).getAllByRole('tab').map((t) => t.getAttribute('aria-label') ?? t.textContent)).toEqual(['Inbox · 1 needs you', 'Work'])
    expect(screen.getByRole('button', { name: 'Acme · 3 need you' })).toBeTruthy()
    expect(screen.queryByText('Memory proposal')).toBeNull()
  })

  it('with no organization, shows nothing of employees: Personal alone, and no ▲ elsewhere', () => {
    Object.assign(fakeState.snapshot, { organizations: [], repos: [repo], workspaces: [ws], employees: undefined, employeeWork: undefined })
    fakeState.space = null
    render(<Sidebar />)
    const spaces = screen.getByRole('navigation', { name: 'Spaces' })
    expect(within(spaces).getByRole('button', { name: 'Personal' }).getAttribute('aria-pressed')).toBe('true')
    expect(spaces.querySelector('.rail-badge')).toBeNull()
    expect(screen.queryByRole('tab', { name: /Team|Channels/ })).toBeNull()
  })

  it('keeps New to what Personal has: no employee or project', () => {
    fakeState.space = null
    render(<NewList />)
    expect(screen.queryByRole('option', { name: /New employee/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /New project/ })).toBeNull()
    expect(screen.getByRole('option', { name: /New automation…/ })).toBeTruthy()
  })
})
