// @vitest-environment jsdom
// "Maximum agents running at once": a tab whose turn waits for an agent slot says Queued, in words and a shape (not a colour).
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceView } from '../src/renderer/src/components/WorkspaceView'
import { triageAll } from '../src/shared/triage'
import type { AppSnapshot, Session, Workspace } from '../src/shared/types'
import { fakeState, resetFake } from './rendererStore'

const seen = vi.hoisted(() => ({ listeners: new Set<() => void>() }))

// The fake store, but live: a component re-renders when what it selected changes, as with the real one.
vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const { fakeState: state } = await import('./rendererStore')
  const subscribe = (listener: () => void) => {
    seen.listeners.add(listener)
    return () => void seen.listeners.delete(listener)
  }
  const own: Record<string, unknown> = {
    useStore: (selector: (s: typeof state) => unknown) => useSyncExternalStore(subscribe, () => selector(state)),
    activeSessionId: (s: { activeSession: Record<string, string> }, id: string) => s.activeSession[id],
    openSessions: (snapshot: { sessions: { workspaceId: string; closedAt?: string }[] }, id: string) => snapshot.sessions.filter((s) => s.workspaceId === id && !s.closedAt)
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})

// The view's neighbours: stand-ins that say how they were rendered.
vi.mock('../src/renderer/src/components/BottomPanel', () => ({
  BottomPanel: ({ workspace, visible }: { workspace: { state: string }; visible: boolean }) => {
    void workspace
    void visible
    return null
  }
}))
vi.mock('../src/renderer/src/components/ChatView', () => ({
  ChatView: () => null
}))
vi.mock('../src/renderer/src/components/NoteBar', () => ({
  NoteBar: () => null
}))
vi.mock('../src/renderer/src/components/WorkspaceBrowser', () => ({ WorkspaceBrowser: () => null }))
vi.mock('../src/renderer/src/components/Changes', () => ({ ChangesList: () => null, FileDiffView: () => null }))
vi.mock('../src/renderer/src/components/CommitsView', () => ({ CommitsView: () => null, CommitFileView: () => null }))
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
  ChecksView: () => null,
  GitHeaderActions: () => null,
  MergedStatus: () => null,
  PrStatus: ({ children }: { children: unknown }) => children,
  useGitStatus: () => ({ status: null, refresh: async () => undefined })
}))
vi.mock('../src/renderer/src/components/FileViewer', () => ({ FileViewer: () => null }))
vi.mock('../src/renderer/src/components/FilesTree', () => ({ FilesTree: () => null }))
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

const ws = () => ({ id: 'w1', repoId: 'r1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w' })
const chat = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], title, ...extra })

function Host() {
  useSyncExternalStore(
    (l) => {
      seen.listeners.add(l)
      return () => void seen.listeners.delete(l)
    },
    () => fakeState.snapshot
  )
  return <WorkspaceView workspaceId="w1" hidden={false} />
}

beforeEach(() => {
  resetFake()
  Object.assign(fakeState, {
    approvals: [],
    chats: {},
    activeSession: { w1: 's1' },
    browserTabs: {},
    unreadSessions: {},
    rightPanelOpen: true,
    leftPanelOpen: true,
    bottomPanelOpen: true,
    terminalFullscreen: null,
    tileZoom: null,
    fileRequest: null,
    chatRequest: null,
    checksPanelRequest: null
  })
})
afterEach(cleanup)

describe('a queued tab', () => {
  it('says Queued in its tab, with the hollow (pending) shape', () => {
    const queued = chat('s2', 'Refactor', { waitingForSlot: new Date().toISOString(), queue: [{ id: 'm', turnId: 't', text: 'go', attachments: [] }] })
    fakeState.snapshot = { ...fakeState.snapshot, workspaces: [ws()], sessions: [chat('s1', 'Login bug'), queued], settings: { ...fakeState.snapshot.settings, terminalPlacement: 'panel-bottom', maxRunningAgents: 2 } }
    render(<Host />)
    const tab = screen.getByRole('tab', { name: /Refactor/ })
    expect(within(tab).getByText('Queued')).toBeTruthy()
    expect(tab.querySelector('[data-glyph="off"]')).not.toBeNull()
    // The idle tab next to it says nothing of the kind.
    expect(within(screen.getByRole('tab', { name: /Login bug/ })).queryByText('Queued')).toBeNull()
  })
})

describe('triage of a queued workspace', () => {
  it('is on its way (with the working ones), labelled Queued, without a spinner', () => {
    const workspace = { ...ws(), createdAt: '2026-01-01T00:00:00Z' } as unknown as Workspace
    const session = chat('s1', 'Refactor', { waitingForSlot: '2026-01-02T00:00:00Z', queue: [{ id: 'm', turnId: 't', text: 'go', attachments: [] }] }) as unknown as Session
    const [t] = triageAll({ snapshot: { workspaces: [workspace], sessions: [session], repos: [], settings: {} } as unknown as AppSnapshot, approvals: [], unread: {}, unreadSessions: {} }, null)
    expect(t).toMatchObject({ bucket: 'working', label: 'Queued', sessionId: 's1', since: '2026-01-02T00:00:00Z' })
    expect(t.spinning).toBeFalsy()
  })
})
