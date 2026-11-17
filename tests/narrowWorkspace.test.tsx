// @vitest-environment jsdom
// The workspace in a narrow window or at 200% zoom (narrowLayout.ts), as the view draws it. Above 1012 px nothing
// changes. Under it the header shows the list folded to the rail and offers it back (⌘B), Compare, Export, Hand off and
// Open in move into one More menu, and the Note bar is a chip in the tab strip. Under 700 px of the workspace's own width
// the side panel isn't beside the chat: a "Changes 3" button opens it as a sheet. The sidebar's rail carries the space
// switcher and the Team row only while the list is folded.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { WorkspaceView } from '../src/renderer/src/components/WorkspaceView'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const own: Record<string, unknown> = {
    activeSessionId: (s: { activeSession: Record<string, string> }, id: string) => s.activeSession[id],
    openSessions: (snapshot: { sessions: { workspaceId: string; closedAt?: string }[] }, id: string) => snapshot.sessions.filter((s) => s.workspaceId === id && !s.closedAt),
    timeAgo: () => 'now'
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})

// The view's neighbours: stand-ins that say what they show.
vi.mock('../src/renderer/src/components/BottomPanel', () => ({ BottomPanel: () => null }))
vi.mock('../src/renderer/src/components/ChatView', () => ({ ChatView: ({ session }: { session: { id: string } }) => <p>chat {session.id}</p> }))
vi.mock('../src/renderer/src/components/NoteBar', () => ({ NoteBar: ({ folded, open }: { folded?: boolean; open?: boolean }) => (folded && !open ? null : <p>note bar</p>) }))
vi.mock('../src/renderer/src/components/WorkspaceBrowser', () => ({ WorkspaceBrowser: () => null }))
vi.mock('../src/renderer/src/components/Changes', () => ({ ChangesList: () => <p>changes list</p>, FileDiffView: () => null }))
vi.mock('../src/renderer/src/components/CommitsView', () => ({ CommitsView: () => <p>commits list</p>, CommitFileView: () => null }))
vi.mock('../src/renderer/src/components/DiffSourceMenu', () => ({ DiffSourceMenu: () => null }))
vi.mock('../src/renderer/src/components/composer/AgentPicker', () => ({ AgentIcon: () => null }))
vi.mock('../src/renderer/src/components/agents/TerminalAgents', () => ({
  agentTabValue: () => '',
  showTerminalAgentTab: () => undefined,
  TerminalAgentBodies: () => null,
  TerminalAgentTabs: () => null,
  TerminalAgentLabel: () => null,
  useAgentTabs: () => ({ active: null }),
  useHasTerminalAgent: () => false
}))
vi.mock('../src/renderer/src/components/AutoReview', () => ({ AutoReviewBar: () => null, AutoReviewTabMark: () => null }))
vi.mock('../src/renderer/src/components/SetupHint', () => ({ SetupHint: () => null }))
vi.mock('../src/renderer/src/components/GitPanel', () => ({
  ChecksView: () => <p>checks list</p>,
  GitHeaderActions: () => null,
  MergedStatus: () => null,
  PrStatus: ({ children }: { children: unknown }) => children,
  MergedProgress: () => null,
  useGitStatus: () => ({ status: null, refresh: async () => undefined })
}))
vi.mock('../src/renderer/src/components/FileViewer', () => ({ FileViewer: () => null }))
vi.mock('../src/renderer/src/components/FilesTree', () => ({ FilesTree: () => <p>files tree</p> }))
vi.mock('../src/renderer/src/components/ArchivedView', () => ({ ArchivedPanel: () => null }))
vi.mock('../src/renderer/src/components/HandOffDialogs', () => ({ TransferBanner: () => null }))
vi.mock('../src/renderer/src/components/OpenIn', () => ({
  AppIcon: () => null,
  DefaultAppMenu: () => null,
  OpenInMenuItems: () => null,
  openDefault: () => false,
  useDefaultLabel: () => ({ id: null, name: '' })
}))
vi.mock('../src/renderer/src/openIn', () => ({ refreshOpenInApps: async () => undefined }))
vi.mock('../src/renderer/src/components/cloud/CloudBits', () => ({ CloudBanner: () => null, CloudPill: () => null, CloudSub: () => null, cloudAction: () => undefined, useCloudStatusPoll: () => undefined, useWakeOnOpen: () => undefined }))

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]
const original = fakeState.snapshot
const width = (px: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: px })
const file = (path: string) => ({ path, status: 'modified', additions: 1, deletions: 1, hunks: [] })

function setUp(extra: Record<string, unknown> = {}) {
  Object.assign(fakeState, {
    approvals: [],
    chats: {},
    activeSession: { w1: 's1' },
    browserTabs: {},
    unread: {},
    unreadSessions: {},
    rightPanelOpen: true,
    leftPanelOpen: true,
    narrowList: false,
    panelSheet: false,
    panelSheetOpen: false,
    bottomPanelOpen: false,
    workspaceFocus: {},
    tileZoom: null,
    fileRequest: null,
    chatRequest: null,
    checksPanelRequest: null,
    editorView: 'workspaces',
    ...extra
  })
  fakeState.snapshot = {
    ...original,
    workspaces: [{ id: 'w1', repoId: 'r1', name: 'lisbon', branch: 'fix-login-redirect', baseBranch: 'main', state: 'ready', path: '/w' }],
    sessions: [{ id: 's1', workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], title: 'Fix login redirect' }],
    settings: { ...original.settings, windowLayout: 'panes', terminalPlacement: 'panel-bottom', sidebarSide: 'left', sidePanelSide: 'right' }
  }
  fakeApi.getDiff = vi.fn(async () => ({ scope: 'all', files: [file('src/login.ts'), file('src/redirect.ts'), file('src/session.ts')] }))
}

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  width(1024)
  fakeState.snapshot = original
})

const header = () => screen.getByRole('heading', { name: 'lisbon' }).closest('header')!
// Found by its class: hidden, it has no accessible name to find it by.
const sidePanel = () => document.querySelector<HTMLElement>('aside.side-panel')!

describe('a workspace above 1012 px', () => {
  it('is as it was: the header’s own buttons, the side panel beside the chat and its toggle, the Note bar', async () => {
    width(1200)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    for (const name of ['Compare…', 'Export…', 'Hand off…', 'Open']) expect(within(header()).getByRole('button', { name })).toBeTruthy()
    expect(within(header()).queryByRole('button', { name: 'More' })).toBeNull()
    expect(within(header()).getByRole('button', { name: /toggle side panel/i })).toBeTruthy()
    expect(within(header()).queryByRole('button', { name: /^Changes/ })).toBeNull()
    expect(within(header()).queryByRole('button', { name: /workspace list/i })).toBeNull()
    expect(sidePanel().style.display).toBe('')
    expect(await within(sidePanel()).findByText('changes list')).toBeTruthy()
    expect(screen.getByText('note bar')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Note/ })).toBeNull()
    expect(spy('setPanelSheet')).toHaveBeenLastCalledWith(false)
  })
})

describe('a workspace in a narrow window', () => {
  it('offers the list folded to the rail back from the header (⌘B)', async () => {
    width(900)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    await userEvent.click(within(header()).getByRole('button', { name: 'Show the workspace list (Ctrl+B)' }))
    expect(spy('toggleLeftPanel')).toHaveBeenCalled()
  })

  it('once the list is beside the rail again, the header offers nothing more for it', () => {
    width(900)
    setUp({ narrowList: true })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(within(header()).queryByRole('button', { name: /workspace list|show sidebar/i })).toBeNull()
  })

  it('puts Compare, Export, Hand off and Open in into one More menu, each named and said what it does', async () => {
    const user = userEvent.setup()
    width(900)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    for (const name of ['Compare…', 'Export…', 'Hand off…', 'Open']) expect(within(header()).queryByRole('button', { name })).toBeNull()
    await user.click(within(header()).getByRole('button', { name: 'More' }))
    const menu = screen.getByRole('menu', { name: 'More' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((i) => i.querySelector('.ui-menu__label')?.textContent ?? i.textContent)).toEqual(expect.arrayContaining(['Compare…', 'Export…', 'Hand off…', 'Copy path', 'Archive workspace…']))
    expect(within(menu).getByRole('menuitem', { name: /Export…/ }).textContent).toContain('Export this workspace as a .foreman file')
    await user.click(within(menu).getByRole('menuitem', { name: /Hand off…/ }))
    expect(spy('openHandOffTo')).toHaveBeenCalledWith({ workspaceId: 'w1' })
  })

  it('shows the Note bar as a chip at the end of the tab strip, which opens it', async () => {
    width(900)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(screen.queryByText('note bar')).toBeNull()
    const chip = within(screen.getByRole('tablist', { name: 'Chats' })).getByRole('button', { name: /^Note/ })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(chip)
    expect(screen.getByText('note bar')).toBeTruthy()
    expect(chip.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the side panel beside the chat while both fit (900 px with the rail)', () => {
    width(900)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(sidePanel().style.display).toBe('')
    expect(within(header()).queryByRole('button', { name: /^Changes/ })).toBeNull()
  })
})

describe('the side panel at 200% zoom (660 px)', () => {
  it('leaves the chat the width and opens from a "Changes 3" button in the header', async () => {
    width(660)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(spy('setPanelSheet')).toHaveBeenLastCalledWith(true)
    expect(sidePanel().style.display).toBe('none')
    const open = await within(header()).findByRole('button', { name: 'Changes 3' })
    expect(open.getAttribute('aria-haspopup')).toBe('dialog')
    expect(open.title).toBe('Show changes, files and checks (Ctrl+Alt+B)')
    expect(within(header()).queryByRole('button', { name: /toggle side panel/i })).toBeNull()
    await userEvent.click(open)
    expect(spy('openPanelSheet')).toHaveBeenCalledWith(true)
  })

  it('is a sheet over the chat, holding the panel itself, closed by Escape', async () => {
    width(660)
    setUp({ panelSheetOpen: true })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    const sheet = screen.getByRole('dialog', { name: 'Changes, files and checks' })
    expect(sheet.textContent).toContain('lisbon · fix-login-redirect')
    expect(within(sheet).getByRole('tab', { name: /Changes/ })).toBeTruthy()
    expect(await within(sheet).findByText('changes list')).toBeTruthy()
    // One copy of the panel: it moved into the sheet, out of the hidden side panel.
    expect(sidePanel().querySelector('.panel-host')).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(spy('openPanelSheet')).toHaveBeenCalledWith(false)
  })

  it('puts the panel back in its place when the sheet closes (here: the workspace goes off screen)', () => {
    width(660)
    setUp({ panelSheetOpen: true })
    const view = render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(sidePanel().querySelector('.panel-host')).toBeNull()
    view.rerender(<WorkspaceView workspaceId="w1" hidden />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sidePanel().querySelector('.panel-host')).toBeTruthy()
    expect(spy('setPanelSheet')).toHaveBeenLastCalledWith(false)
  })
})

// ---- the sidebar's rail ----

const repo = (id: string, spaceId?: string) => ({ id, name: id, rootPath: `/code/${id}`, defaultBranch: 'main', ...(spaceId ? { spaceId } : {}) })

function setUpSpace() {
  Object.assign(fakeState, {
    selectedWorkspaceId: null,
    settingsPage: null,
    approvals: [],
    unread: {},
    unreadSessions: {},
    sidebarView: { repo: null, query: '', filter: 'all', showFinished: false },
    railNames: false,
    space: 'o1',
    employeesView: null
  })
  fakeState.snapshot = {
    ...original,
    platform: 'linux',
    repos: [repo('site', 'o1'), repo('acme-memory', 'o1'), repo('blog')],
    organizations: [{ id: 'o1', name: 'Acme', memoryRepoId: 'acme-memory', createdAt: '2026-11-05T00:00:00.000Z' }],
    employees: { o1: { head: 'h1', employees: [{ id: 'e-1', name: 'Ada', colour: 'pink', state: 'active', problems: [] }] } },
    workspaces: [],
    sessions: [],
    recentRepos: [],
    homeDir: '/home/me',
    keepAwake: { keepAwake: false },
    repoSettings: {},
    attentionHistory: { events: [] },
    schedules: [],
    occurrences: [],
    settings: { ...original.settings, showResourceUsage: false, coloredSidebarDiffs: false, sidebarSide: 'left', keepAwakeBatteryCutoff: false, views: undefined }
  }
}

describe('the rail with the list folded', () => {
  it('carries the space switcher, as the space’s initial opening the same menu, and Team, opening the Team page', async () => {
    const user = userEvent.setup()
    setUpSpace()
    render(<Sidebar list={false} folded />)
    const rail = screen.getByRole('navigation', { name: 'Repositories' })
    const space = within(rail).getByRole('button', { name: 'Space: Acme' })
    expect(space.textContent).toBe('A')
    await user.click(space)
    const menu = screen.getByRole('menu', { name: 'Spaces' })
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    await user.keyboard('{Escape}')
    await user.click(within(rail).getByRole('button', { name: 'Team' }))
    expect(spy('openEmployees')).toHaveBeenCalledWith({ orgId: 'o1', page: 'team' })
    // The list itself stays folded away.
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('carries the one + and the Automations icon, since the top row they live in is folded away', async () => {
    const user = userEvent.setup()
    setUpSpace()
    render(<Sidebar list={false} folded />)
    const rail = screen.getByRole('navigation', { name: 'Repositories' })
    // Space, +, Team lead the rail; Automations comes after the repositories.
    const names = within(rail)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? '')
    expect(names.slice(0, 3)).toEqual(['Space: Acme', 'New', 'Team'])
    expect(names.some((n) => n.startsWith('Automations'))).toBe(true)
    await user.click(within(rail).getByRole('button', { name: 'New' }))
    expect(screen.getByRole('menuitem', { name: /New workspace/ }).textContent).toContain('in site')
    expect(screen.getByRole('menuitem', { name: /New organization…/ })).toBeTruthy()
  })

  it('has none of them while the list shows beside it (the top row and the Team section are there instead)', () => {
    setUpSpace()
    render(<Sidebar />)
    const rail = screen.getByRole('navigation', { name: 'Repositories' })
    expect(within(rail).queryByRole('button', { name: /^Space:/ })).toBeNull()
    expect(within(rail).queryByRole('button', { name: /^Team/ })).toBeNull()
    expect(within(rail).queryByRole('button', { name: 'New' })).toBeNull()
    expect(within(rail).queryByRole('button', { name: /^Automations/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Space: Acme' })).toBeTruthy()
  })

  it('has no Team tile in Personal, where there is no team', () => {
    setUpSpace()
    fakeState.space = null
    render(<Sidebar list={false} folded />)
    const rail = screen.getByRole('navigation', { name: 'Repositories' })
    expect(within(rail).getByRole('button', { name: 'Space: Personal' })).toBeTruthy()
    expect(within(rail).queryByRole('button', { name: /^Team/ })).toBeNull()
  })
})
