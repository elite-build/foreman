// @vitest-environment jsdom
// A workspace in the Editor layout: the file opens in the middle while the chat stays beside it, and the side panel shows
// the one view the activity bar picked, under that view's name. Three panes is unchanged: one strip, the panel's tabs.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { WorkspaceView } from '../src/renderer/src/components/WorkspaceView'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const own: Record<string, unknown> = {
    activeSessionId: (s: { activeSession: Record<string, string> }, id: string) => s.activeSession[id],
    openSessions: (snapshot: { sessions: { workspaceId: string; closedAt?: string }[] }, id: string) => snapshot.sessions.filter((s) => s.workspaceId === id && !s.closedAt)
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})

// The view's neighbours: stand-ins that say what they show.
vi.mock('../src/renderer/src/components/BottomPanel', () => ({ BottomPanel: () => null }))
vi.mock('../src/renderer/src/components/ChatView', () => ({
  ChatView: ({ session, active, hidden }: { session: { id: string }; active: boolean; hidden?: boolean }) => (
    <p data-active={String(active)} data-hidden={String(Boolean(hidden))}>
      chat {session.id}
    </p>
  )
}))
vi.mock('../src/renderer/src/components/NoteBar', () => ({ NoteBar: () => null }))
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
  useAgentTabs: () => ({ active: null })
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
vi.mock('../src/renderer/src/components/FileViewer', () => ({ FileViewer: ({ path }: { path: string }) => <p>viewer {path}</p> }))
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
vi.mock('../src/renderer/src/components/cloud/CloudBits', () => ({ CloudBanner: () => null, CloudPill: () => null, useCloudStatusPoll: () => undefined, useWakeOnOpen: () => undefined }))

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]

function setUp(windowLayout: 'panes' | 'editor', extra: Record<string, unknown> = {}) {
  Object.assign(fakeState, {
    approvals: [],
    chats: {},
    activeSession: { w1: 's1' },
    browserTabs: {},
    unreadSessions: {},
    rightPanelOpen: true,
    leftPanelOpen: true,
    bottomPanelOpen: false,
    terminalFullscreen: null,
    tileZoom: null,
    fileRequest: null,
    chatRequest: null,
    checksPanelRequest: null,
    editorView: 'changes',
    ...extra
  })
  fakeState.snapshot = {
    ...fakeState.snapshot,
    workspaces: [{ id: 'w1', repoId: 'r1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w' }],
    sessions: [{ id: 's1', workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], title: 'Login bug' }],
    settings: { ...fakeState.snapshot.settings, windowLayout, terminalPlacement: 'panel-bottom', sidebarSide: 'left', sidePanelSide: 'right' }
  }
}

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
})
afterEach(cleanup)

describe('a workspace in the editor layout', () => {
  it('opens a file in the middle and keeps the chat on screen beside it', () => {
    setUp('editor', { fileRequest: { workspaceId: 'w1', path: 'src/login.ts', nonce: 1 } })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(screen.getByText('viewer src/login.ts')).toBeTruthy()
    const files = screen.getByRole('tablist', { name: 'Open files' })
    expect(within(files).getByRole('tab', { name: /login\.ts/ }).getAttribute('aria-selected')).toBe('true')

    const chat = screen.getByRole('complementary', { name: 'Chat' })
    expect(within(chat).getByRole('tab', { name: /Login bug/ })).toBeTruthy()
    expect(within(chat).getByText('chat s1').dataset).toMatchObject({ active: 'true', hidden: 'false' })
  })

  it('says where to find a file while none is open', async () => {
    setUp('editor')
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(screen.getByText(/open a file from changes or files/i)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Browse files' }))
    expect(spy('showEditorSidebar')).toHaveBeenCalledWith('files')
  })

  it('shows the view the activity bar picked, by name and without the side panel\'s tabs', () => {
    setUp('editor', { editorView: 'checks' })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    const panel = screen.getByRole('complementary', { name: 'Changes, files and checks' })
    expect(within(panel).getByRole('heading', { name: 'Checks' })).toBeTruthy()
    expect(within(panel).getByText('checks list')).toBeTruthy()
    expect(within(panel).queryByRole('tab')).toBeNull()
  })

  it('leaves the sidebar to the workspace list while Workspaces is the view', () => {
    setUp('editor', { editorView: 'workspaces' })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(screen.queryByRole('complementary', { name: 'Changes, files and checks' })).toBeNull()
  })

  it('asks the activity bar for Checks when something wants them shown', () => {
    setUp('editor', { checksPanelRequest: { workspaceId: 'w1', nonce: 1 } })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(spy('showEditorSidebar')).toHaveBeenCalledWith('checks')
  })

  it('hides and shows the chat from the header', async () => {
    setUp('editor')
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    const toggle = screen.getByRole('button', { name: /show or hide the chat/i })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(toggle)
    expect(spy('toggleRightPanel')).toHaveBeenCalled()
  })
})

describe('a workspace in three panes', () => {
  it('keeps the header buttons\' names when a narrow column hides their words', () => {
    setUp('panes')
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    const header = screen.getByRole('heading', { name: 'acme' }).closest('header')!
    for (const name of ['Compare…', 'Export…', 'Hand off…', 'Open']) {
      const button = within(header).getByRole('button', { name })
      expect(button.querySelector('.btn-label')?.textContent).toBe(name)
    }
  })

  it('keeps one strip over the chat and the side panel\'s tabs', () => {
    setUp('panes', { fileRequest: { workspaceId: 'w1', path: 'src/login.ts', nonce: 1 } })
    render(<WorkspaceView workspaceId="w1" hidden={false} />)
    expect(screen.queryByRole('complementary', { name: 'Chat' })).toBeNull()
    const strip = screen.getByRole('tablist', { name: 'Chats' })
    expect(within(strip).getByRole('tab', { name: /Login bug/ })).toBeTruthy()
    expect(within(strip).getByRole('tab', { name: /login\.ts/ }).getAttribute('aria-selected')).toBe('true')
    // The file is in front of the chat, as before.
    expect(screen.getByText('chat s1').dataset).toMatchObject({ hidden: 'true' })
    const panel = screen.getByRole('complementary', { name: 'Changes, files and checks' })
    expect(within(panel).getByRole('tab', { name: /Changes/ })).toBeTruthy()
  })
})
