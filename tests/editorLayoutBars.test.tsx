// @vitest-environment jsdom
// The Editor layout's bars: the activity bar picks what the sidebar shows, and the status bar sums up the workspace on
// screen along the bottom of the window.
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { EditorViews } from '../src/renderer/src/components/editor/EditorViews'
import { StatusBar } from '../src/renderer/src/components/editor/StatusBar'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  Object.assign(fakeState, { approvals: [], unread: {}, unreadSessions: {} })
  Object.assign(fakeState.snapshot, {
    repos: [{ id: 'r1', name: 'kite', rootPath: '/code/kite', defaultBranch: 'main' }],
    workspaces: [
      {
        id: 'w1',
        repoId: 'r1',
        name: 'curie',
        branch: 'yatin/login',
        state: 'ready',
        createdAt: '2026-01-01T00:00:00Z',
        path: '/code/kite/w1',
        diffStat: { additions: 7, deletions: 3 },
        prInfo: { number: 42, state: 'OPEN' }
      }
    ],
    sessions: [{ id: 's1', workspaceId: 'w1', agent: 'claude', status: 'running', title: 'Chat', createdAt: '2026-01-01T00:00:00Z' }],
    repoSettings: {},
    attentionHistory: { events: [] },
    schedules: [],
    occurrences: []
  })
})
afterEach(cleanup)

describe('the activity bar', () => {
  it('offers each view as a toggle, says which one the sidebar shows, and picks one', async () => {
    render(<EditorViews shown="changes" available={new Set(['workspaces', 'changes', 'commits', 'checks'])} />)
    const bar = screen.getByRole('navigation', { name: 'Views' })
    expect(bar).toBeTruthy()
    const changes = screen.getByRole('button', { name: 'Changes' })
    expect(changes.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Workspaces' }).getAttribute('aria-pressed')).toBe('false')
    // Nothing to browse (a cloud workspace): Files is there, but off.
    expect((screen.getByRole('button', { name: 'Files' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Commits' }))
    expect(spy('pickEditorSidebar')).toHaveBeenCalledWith('commits')
    await userEvent.click(changes)
    expect(spy('pickEditorSidebar')).toHaveBeenCalledWith('changes')
  })

  it('presses nothing while the sidebar is hidden', () => {
    render(<EditorViews shown={null} available={new Set(['workspaces'])} />)
    for (const button of screen.getAllByRole('button')) expect(button.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the status bar', () => {
  it('shows the branch, what changed, that the agent is working, the pull request and the repository', () => {
    render(<StatusBar workspaceId="w1" />)
    const bar = screen.getByRole('contentinfo', { name: 'Workspace status' })
    expect(bar.textContent).toContain('yatin/login')
    expect(bar.textContent).toContain('+7')
    expect(bar.textContent).toContain('-3')
    expect(bar.textContent).toContain('Working…')
    expect(bar.textContent).toContain('PR #42 open')
    expect(bar.textContent).toContain('kite')
  })

  it('stays, empty, with no workspace on screen', () => {
    render(<StatusBar workspaceId={null} />)
    expect(screen.getByRole('contentinfo', { name: 'Workspace status' }).textContent).toBe('')
  })
})
