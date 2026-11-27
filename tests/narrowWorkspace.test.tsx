// @vitest-environment jsdom
// The workspace in a narrow window or at 200% zoom (narrowLayout.ts), as the view draws it, and its header at every
// width: the name opens the workspace's menu (Compare, Export, Hand off once a computer is paired…), and the Note bar
// folds into the header's Note button. Under 1060 px the header shows the list folded to the rail and offers it back
// (⌘B). Under 700 px of the workspace's own width the side panel isn't beside the chat: a "Changes 3" button opens it
// as a sheet. The sidebar's rail has the spaces and the modes at every width, and the one + too while the list is
// folded away.
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

function setUp(extra: Record<string, unknown> = {}, snapshot: Record<string, unknown> = {}) {
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
    settings: { ...original.settings, windowLayout: 'panes', terminalPlacement: 'panel-bottom', sidebarSide: 'left', sidePanelSide: 'right' },
    ...snapshot
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

describe('a workspace above 1060 px', () => {
  it('has Open, the side panel beside the chat and its toggle', async () => {
    width(1200)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(within(header()).getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(within(header()).getByRole('button', { name: /toggle side panel/i })).toBeTruthy()
    expect(within(header()).queryByRole('button', { name: /^Changes/ })).toBeNull()
    expect(within(header()).queryByRole('button', { name: /workspace list/i })).toBeNull()
    expect(sidePanel().style.display).toBe('')
    expect(await within(sidePanel()).findByText('changes list')).toBeTruthy()
    expect(spy('setPanelSheet')).toHaveBeenLastCalledWith(false)
  })
})

describe('the workspace header at any width', () => {
  for (const px of [1200, 900]) {
    it(`keeps the name and Open, and no row of action buttons (${px} px)`, () => {
      width(px)
      setUp()
      render(<WorkspaceView workspaceId="w1" hidden={false} />)
      expect(within(header()).getByRole('button', { name: 'lisbon' }).getAttribute('aria-haspopup')).toBe('menu')
      expect(within(header()).getByRole('button', { name: 'Open' })).toBeTruthy()
      for (const name of ['Compare…', 'Export…', 'Hand off…', 'More']) expect(within(header()).queryByRole('button', { name })).toBeNull()
    })
  }

  it('opens the workspace’s menu from its name: each action named and said what it does', async () => {
    const user = userEvent.setup()
    width(1200)
    setUp({}, { pairedDevices: [{ id: 'd1', name: 'Studio', pairedAt: '2026-11-01T00:00:00Z' }] })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    await user.click(within(header()).getByRole('button', { name: 'lisbon' }))
    const menu = screen.getByRole('menu', { name: 'lisbon' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((i) => i.querySelector('.ui-menu__label')?.textContent ?? i.textContent)).toEqual(expect.arrayContaining(['Copy branch name', 'Copy path', 'Compare…', 'Export…', 'Hand off…', 'Archive workspace…']))
    expect(within(menu).getByRole('menuitem', { name: /Export…/ }).textContent).toContain('Export this workspace as a .foreman file')
    await user.click(within(menu).getByRole('menuitem', { name: /Hand off…/ }))
    expect(spy('openHandOffTo')).toHaveBeenCalledWith({ workspaceId: 'w1' })
  })

  it('leaves Hand off out until a computer is paired', async () => {
    const user = userEvent.setup()
    width(1200)
    setUp({}, { pairedDevices: [] })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    await user.click(within(header()).getByRole('button', { name: 'lisbon' }))
    const menu = screen.getByRole('menu', { name: 'lisbon' })
    expect(within(menu).getByRole('menuitem', { name: /Export…/ })).toBeTruthy()
    expect(within(menu).queryByRole('menuitem', { name: /Hand off…/ })).toBeNull()
  })

  it('folds the Note bar into a Note button in the header, which opens it', async () => {
    width(1200)
    setUp()
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(screen.queryByText('note bar')).toBeNull()
    const note = within(header()).getByRole('button', { name: 'Note' })
    expect(note.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(note)
    expect(screen.getByText('note bar')).toBeTruthy()
    expect(note.getAttribute('aria-expanded')).toBe('true')
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
    sidebarMode: 'work',
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
  it('has the spaces and the modes, so every space and mode stays one click away; picking a mode asks for the list', async () => {
    const user = userEvent.setup()
    setUpSpace()
    render(<Sidebar list={false} folded />)
    const spaces = screen.getByRole('navigation', { name: 'Spaces' })
    const acme = within(spaces).getByRole('button', { name: 'Acme' })
    expect(acme.textContent).toBe('A')
    expect(acme.getAttribute('aria-pressed')).toBe('true')
    const modes = screen.getByRole('tablist', { name: 'Sidebar' })
    expect(within(modes).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Inbox', 'Work', 'Team', 'Channels'])
    await user.click(within(modes).getByRole('tab', { name: 'Team' }))
    // The store shows the list beside the rail when a mode is picked in a narrow window (setSidebarMode).
    expect(spy('setSidebarMode')).toHaveBeenCalledWith('team')
    // The list itself stays folded away: no panel, no Find.
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Find' })).toBeNull()
  })

  it('carries New as one +, by the modes, opening the list, and Automations at its foot, since the list is folded away', async () => {
    const user = userEvent.setup()
    setUpSpace()
    render(<Sidebar list={false} folded />)
    const rail = document.querySelector('.sidebar-rail') as HTMLElement
    const add = within(rail).getByRole('button', { name: 'More to make' })
    expect(add.getAttribute('aria-haspopup')).toBe('dialog')
    expect(add.compareDocumentPosition(screen.getByRole('tablist', { name: 'Sidebar' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(rail).getByRole('button', { name: /^Automations/ })).toBeTruthy()
    await user.click(add)
    expect(spy('openOverlay')).toHaveBeenCalledWith('new')
  })

  it('has one New while the list shows beside it: under the top row', () => {
    setUpSpace()
    render(<Sidebar />)
    expect(screen.queryByRole('button', { name: 'More to make' })).toBeNull()
    const main = screen.getByRole('button', { name: 'New workspace' })
    expect(main.closest('.sidebar-new')).not.toBeNull()
    expect((document.querySelector('.sidebar-top') as HTMLElement).contains(main)).toBe(false)
  })

  it('has no Team or Channels in Personal, where there is no team', () => {
    setUpSpace()
    fakeState.space = null
    render(<Sidebar list={false} folded />)
    expect(screen.getByRole('button', { name: 'Personal' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('tab', { name: /^Team|^Channels/ })).toBeNull()
  })
})
