// @vitest-environment jsdom
// The Tiles layout: a tile per workspace with its chat, focus follows the tile looked at, and one can open full size.
import './domShims'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from '../src/renderer/src/store'
import { TilesView } from '../src/renderer/src/components/tiles/TilesView'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
// The chat itself is tested on its own; a tile only has to show the right one.
vi.mock('../src/renderer/src/components/ChatView', () => ({
  ChatView: ({ session, active, hidden }: { session: { id: string }; active: boolean; hidden?: boolean }) => (
    <p data-active={String(active)} data-hidden={String(Boolean(hidden))}>
      chat {session.id}
    </p>
  )
}))

const spy = (name: string) => (store as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]

const repo = { id: 'r1', name: 'kite', rootPath: '/code/kite', defaultBranch: 'main' }
const workspace = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  repoId: 'r1',
  name,
  branch: `yatin/${name}`,
  state: 'ready',
  createdAt: '2026-01-01T00:00:00Z',
  path: `/code/kite/${id}`,
  ...extra
})
const session = (id: string, workspaceId: string) => ({ id, workspaceId, agent: 'claude', status: 'idle', title: 'Chat', createdAt: '2026-01-01T00:00:00Z' })

beforeEach(() => {
  resetFake()
  vi.clearAllMocks()
  spy('activeSessionId').mockImplementation((s: typeof fakeState, id: string) => s.snapshot.sessions.find((x: { workspaceId: string }) => x.workspaceId === id)?.id)
  Object.assign(fakeState, {
    selectedWorkspaceId: 'w1',
    approvals: [],
    unread: {},
    unreadSessions: {},
    leftPanelOpen: true,
    tiles: [],
    tileCount: 4,
    sidebarView: { repo: null, query: '', filter: 'all', showFinished: false }
  })
  Object.assign(fakeState.snapshot, {
    platform: 'linux',
    repos: [repo],
    workspaces: [workspace('w1', 'curie', { diffStat: { additions: 142, deletions: 18 } }), workspace('w2', 'noether'), workspace('w3', 'old', { state: 'archived' })],
    sessions: [session('s1', 'w1')],
    repoSettings: {},
    attentionHistory: { events: [] },
    schedules: [],
    occurrences: []
  })
  fakeState.snapshot.settings = { ...fakeState.snapshot.settings, sidebarSide: 'left', windowLayout: 'tiles' }
})
afterEach(cleanup)

describe('tiles', () => {
  it('shows a tile for each live workspace, with its chat, and remembers them', () => {
    render(<TilesView hidden={false} />)
    expect(screen.getByRole('heading', { name: 'curie' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'noether' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'old' })).toBeNull()
    expect(screen.getByText('chat s1')).toBeTruthy()
    // A workspace with no open chat says so rather than showing an empty tile.
    expect(screen.getByText(/no chat open/i)).toBeTruthy()
    expect(spy('setTiles')).toHaveBeenCalledWith(['w1', 'w2'])
  })

  it('hides the tiles\' chats while another view is in front, so they stop following the store', () => {
    const { rerender } = render(<TilesView hidden={false} />)
    expect(screen.getByText('chat s1').dataset).toMatchObject({ active: 'true', hidden: 'false' })
    rerender(<TilesView hidden />)
    expect(screen.getByText('chat s1').dataset).toMatchObject({ active: 'false', hidden: 'true' })
  })

  it('looking at a tile selects its workspace; the selected one is not selected again', () => {
    render(<TilesView hidden={false} />)
    // The selected tile says so to a screen reader too, not only with its edge.
    expect(screen.getByRole('region', { name: 'curie' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('region', { name: 'noether' }).hasAttribute('aria-current')).toBe(false)
    fireEvent.pointerDown(screen.getByRole('region', { name: 'noether' }))
    expect(spy('selectWorkspace')).toHaveBeenCalledWith('w2')
    fireEvent.pointerDown(screen.getByRole('region', { name: 'curie' }))
    expect(spy('selectWorkspace')).toHaveBeenCalledTimes(1)
  })

  it('a tile opens its workspace full size', async () => {
    render(<TilesView hidden={false} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open noether full size' }))
    expect(spy('zoomTile')).toHaveBeenCalledWith('w2')
  })

  it('the count is a radio group of 2, 4 and 6', async () => {
    render(<TilesView hidden={false} />)
    const group = screen.getByRole('radiogroup', { name: 'Tiles on screen' })
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3)
    await userEvent.setup().click(screen.getByRole('radio', { name: '6' }))
    expect(spy('setTileCount')).toHaveBeenCalledWith(6)
  })

  it('a workspace opened from the sidebar takes the place of the tile looked at least recently', () => {
    Object.assign(fakeState, { tiles: ['w1', 'w2'], tileCount: 2, selectedWorkspaceId: 'w4' })
    fakeState.snapshot.workspaces = [...fakeState.snapshot.workspaces, workspace('w4', 'hopper')]
    render(<TilesView hidden={false} />)
    expect(screen.getByRole('heading', { name: 'hopper' })).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2)
  })
})
