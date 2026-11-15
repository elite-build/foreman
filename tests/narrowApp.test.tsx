// @vitest-environment jsdom
// The window in a narrow width (narrowLayout.ts), as App lays it out: under 1012 px the sidebar is its rail alone (the
// space switcher on top) and ⌘B is what brings the list back; above it the sidebar is as it was.
import './domShims'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { App } from '../src/renderer/src/App'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

// Everything beside the sidebar: stand-ins.
vi.mock('../src/renderer/src/components/WorkspaceView', () => ({ WorkspaceView: () => <p>workspace</p> }))
vi.mock('../src/renderer/src/components/Home', () => ({ Home: () => <p>home</p> }))
vi.mock('../src/renderer/src/components/Overlays', () => ({ Overlays: () => null }))
vi.mock('../src/renderer/src/components/Announcer', () => ({ Announcer: () => null, ToastHost: () => null }))
vi.mock('../src/renderer/src/components/Tour', () => ({ Tour: () => null }))
vi.mock('../src/renderer/src/components/StopSafely', () => ({ StopSafely: () => null }))
vi.mock('../src/renderer/src/components/WhatsNew', async (real) => ({ ...(await real<object>()), WhatsNew: () => null }))
vi.mock('../src/renderer/src/components/DropFolder', () => ({ DropFolder: () => null }))
vi.mock('../src/renderer/src/components/computers/RemoteBanner', () => ({ RemoteBanner: () => null }))
vi.mock('../src/renderer/src/components/computers/BrowserBanner', () => ({ BrowserBanner: () => null }))
vi.mock('../src/renderer/src/components/computers/ControlRequestDialog', () => ({ ControlRequestDialog: () => null }))

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]
const original = fakeState.snapshot
const width = (px: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: px })

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  Object.assign(fakeState, {
    selectedWorkspaceId: null,
    settingsPage: null,
    automations: null,
    assistantOpen: false,
    memoryView: null,
    employeesView: null,
    leftPanelOpen: true,
    narrowList: false,
    rightPanelOpen: true,
    railNames: false,
    unread: {},
    unreadSessions: {},
    backgroundArchives: [],
    archiveRuns: {},
    sidebarView: { repo: null, query: '', filter: 'all', showFinished: false },
    space: null,
    editorView: 'workspaces'
  })
  fakeState.snapshot = {
    ...original,
    platform: 'win32',
    repos: [{ id: 'r1', name: 'atlas', rootPath: '/code/atlas', defaultBranch: 'main' }],
    workspaces: [],
    sessions: [],
    recentRepos: [],
    homeDir: '/home/me',
    keepAwake: { keepAwake: false },
    repoSettings: {},
    attentionHistory: { events: [] },
    schedules: [],
    occurrences: [],
    settings: { ...original.settings, windowLayout: 'panes', sidebarSide: 'left', showResourceUsage: false, tourSeen: true, keepAwakeBatteryCutoff: false }
  }
})
afterEach(() => {
  cleanup()
  width(1024)
  fakeState.snapshot = original
})

const rail = () => screen.getByRole('navigation', { name: 'Repositories' })
const list = () => screen.queryByRole('searchbox', { name: /find a workspace/i })

describe('the sidebar in a narrow window', () => {
  it('is its rail alone, with the space switcher on top, and Ctrl+B asks for the list', () => {
    width(900)
    render(<App />)
    expect(rail()).toBeTruthy()
    expect(list()).toBeNull()
    expect(within(rail()).getByRole('button', { name: 'Space: Personal' })).toBeTruthy()
    act(() => void fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true }))
    expect(spy('toggleLeftPanel')).toHaveBeenCalled()
  })

  it('shows the list beside the rail once asked for', () => {
    width(900)
    fakeState.narrowList = true
    render(<App />)
    expect(list()).toBeTruthy()
    expect(within(rail()).queryByRole('button', { name: /^Space:/ })).toBeNull()
  })

  it('above 1012 px is as it was: the rail and the list', () => {
    width(1012)
    render(<App />)
    expect(list()).toBeTruthy()
    expect(within(rail()).queryByRole('button', { name: /^Space:/ })).toBeNull()
  })

  it('hidden with Ctrl+B is hidden at any width', () => {
    width(900)
    fakeState.leftPanelOpen = false
    render(<App />)
    expect(screen.queryByRole('navigation', { name: 'Repositories' })).toBeNull()
  })
})
