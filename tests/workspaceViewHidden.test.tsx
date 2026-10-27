// @vitest-environment jsdom
// A workspace switched away from stays mounted (App) so its terminals keep running, but it stops re-rendering on every
// store event: it holds what it read from the snapshot until it is shown again. Its terminal panel reads the workspace
// live, is never unmounted by hiding, and keeps following the workspace while hidden.
import './domShims'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceView } from '../src/renderer/src/components/WorkspaceView'
import { fakeState, resetFake } from './rendererStore'

const seen = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  workspaceRenders: 0,
  chats: [] as { id: string; hidden?: boolean; active: boolean }[],
  panel: { mounts: 0, unmounts: 0, states: [] as string[], visible: [] as boolean[] }
}))

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
    seen.panel.states.push(workspace.state)
    seen.panel.visible.push(visible)
    useEffect(() => {
      seen.panel.mounts++
      return () => void seen.panel.unmounts++
    }, [])
    return <div className="terminal-stand-in" />
  }
}))
vi.mock('../src/renderer/src/components/ChatView', () => ({
  ChatView: ({ session, active, hidden }: { session: { id: string }; active: boolean; hidden?: boolean }) => {
    seen.chats.push({ id: session.id, active, hidden })
    return null
  }
}))
vi.mock('../src/renderer/src/components/NoteBar', () => ({
  // Rendered by every render of the workspace view: it counts them.
  NoteBar: () => {
    seen.workspaceRenders++
    return null
  }
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

const ws = (state = 'ready') => ({ id: 'w1', repoId: 'r1', name: 'acme', branch: 'fix', baseBranch: 'main', state, path: '/w' })
const chat = (title: string) => ({ id: 's1', workspaceId: 'w1', agent: 'claude', status: 'running', queue: [], title })

/** A `state` event: a whole new snapshot, with new workspace and session objects, as main sends it. */
function stateEvent(workspace = ws(), title = 'Login bug') {
  fakeState.snapshot = { ...fakeState.snapshot, workspaces: [workspace], sessions: [chat(title)] }
  act(() => seen.listeners.forEach((l) => l()))
}

/** App: re-renders on every snapshot, and renders the workspace with the same props each time. */
function Host({ hidden }: { hidden: boolean }) {
  useSyncExternalStore(
    (l) => {
      seen.listeners.add(l)
      return () => void seen.listeners.delete(l)
    },
    () => fakeState.snapshot
  )
  return <WorkspaceView workspaceId="w1" hidden={hidden} />
}

beforeEach(() => {
  resetFake()
  seen.workspaceRenders = 0
  seen.chats = []
  seen.panel = { mounts: 0, unmounts: 0, states: [], visible: [] }
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
  fakeState.snapshot = { ...fakeState.snapshot, workspaces: [ws()], sessions: [chat('Login bug')], settings: { ...fakeState.snapshot.settings, terminalPlacement: 'panel-bottom' } }
})
afterEach(cleanup)

describe('a hidden workspace', () => {
  it('does not re-render on store events, and catches up in one render when shown', () => {
    const { rerender } = render(<Host hidden={false} />)
    // On screen it follows every snapshot, as before.
    const shown = seen.workspaceRenders
    stateEvent()
    expect(seen.workspaceRenders).toBeGreaterThan(shown)

    rerender(<Host hidden />)
    expect(seen.chats.at(-1)).toEqual({ id: 's1', active: false, hidden: true })
    const hidden = seen.workspaceRenders
    const chatRenders = seen.chats.length
    for (let i = 0; i < 5; i++) stateEvent(ws(), `Title ${i}`)
    expect(seen.workspaceRenders).toBe(hidden)
    expect(seen.chats.length).toBe(chatRenders)
    expect(document.body.textContent).not.toContain('Title 4')

    rerender(<Host hidden={false} />)
    expect(seen.workspaceRenders - hidden).toBeLessThanOrEqual(2)
    expect(document.body.textContent).toContain('Title 4')
    expect(seen.chats.at(-1)).toEqual({ id: 's1', active: true, hidden: false })
  })
})

describe('the terminal panel', () => {
  it('survives hiding and showing, and follows the workspace while hidden', () => {
    const { rerender } = render(<Host hidden={false} />)
    expect(seen.panel.mounts).toBe(1)
    expect(seen.panel.visible.at(-1)).toBe(true)

    rerender(<Host hidden />)
    expect(seen.panel.visible.at(-1)).toBe(false)
    // Setup starts again while the workspace is hidden: the panel hears it (it switches to its Setup tab on that).
    stateEvent(ws('setting-up'))
    expect(seen.panel.states.at(-1)).toBe('setting-up')
    // The rest of the view did not render for it.
    expect(document.body.textContent).not.toContain('Running setup')

    rerender(<Host hidden={false} />)
    expect(seen.panel.visible.at(-1)).toBe(true)
    // One terminal panel throughout: never torn down, so its terminals and their output are the same ones.
    expect(seen.panel.mounts).toBe(1)
    expect(seen.panel.unmounts).toBe(0)
    expect(document.querySelectorAll('.terminal-stand-in')).toHaveLength(1)
  })
})
