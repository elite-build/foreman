// @vitest-environment jsdom
// Archived as an inbox: why each workspace was archived, the reason filter, bulk delete with what it would lose, and Keep.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchivedInbox } from '../src/renderer/src/components/ArchivedList'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const DAY = 24 * 60 * 60_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const archived = (id: string, name: string, extra: Record<string, unknown>) => ({ id, name, repoId: 'r1', branch: `b/${id}`, baseBranch: 'main', state: 'archived', archivedAt: ago(1), ...extra })

beforeEach(() => {
  resetFake()
  Object.assign(storeModule, { openSessions: () => [], timeAgo: () => '1d ago' })
  Object.assign(fakeState.snapshot, {
    repos: [{ id: 'r1', name: 'atlas', defaultBranch: 'main' }],
    workspaces: [
      archived('w1', 'lisbon', { archiveReason: { kind: 'merged', number: 42 } }),
      archived('w2', 'nightly-deps', { archiveReason: { kind: 'run', scheduleId: 's1' }, archivedAt: ago(25) }),
      archived('w3', 'seville', {}),
      { id: 'w4', name: 'osaka', repoId: 'r1', branch: 'b/w4', baseBranch: 'main', state: 'ready' }
    ]
  })
  fakeState.snapshot.settings.archiveCleanupDays = 0
})
afterEach(cleanup)

describe('the archived inbox', () => {
  it('says why each was archived and filters by it', async () => {
    const user = userEvent.setup()
    render(<ArchivedInbox />)
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).getByText('PR #42 merged')).toBeTruthy()
    expect(within(list).getByText('Run completed')).toBeTruthy()
    expect(within(list).getByText('Archived by you')).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'Merged PRs 1' }))
    expect(within(screen.getByRole('list')).getAllByRole('listitem').map((row) => row.textContent)).toEqual([expect.stringContaining('lisbon')])
    await user.click(screen.getByRole('radio', { name: 'Auto-archived 2' }))
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2)
  })

  it('deletes the selected ones, warning first about work that isn’t pushed', async () => {
    const user = userEvent.setup()
    fakeApi.archivedWork = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, branch: `b/${id}`, deletesBranch: true, unpushed: id === 'w2' ? 2 : 0, against: 'origin/main', uncommitted: false }))
    )
    render(<ArchivedInbox />)
    await user.click(screen.getByRole('checkbox', { name: 'Select lisbon' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select nightly-deps' }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Delete…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 archived workspaces?' })
    expect(fakeApi.archivedWork).toHaveBeenCalledWith(['w1', 'w2'])
    expect(await within(dialog).findByText('nightly-deps: 2 commits not on origin/main')).toBeTruthy()
    expect(within(dialog).getByText('2 local branches')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Delete and lose this work' }))
    await waitFor(() => expect(fakeApi.deleteArchived).toHaveBeenCalledWith(['w1', 'w2']))
  })

  it('says nothing is lost when everything is pushed', async () => {
    const user = userEvent.setup()
    fakeApi.archivedWork = vi.fn(async (ids: string[]) => ids.map((id) => ({ id, branch: `b/${id}`, deletesBranch: true, unpushed: 0, uncommitted: false })))
    render(<ArchivedInbox />)
    await user.click(screen.getByRole('button', { name: 'Delete lisbon…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete lisbon?' })
    expect(await within(dialog).findByText('Nothing to lose: every commit is pushed or on the base branch.')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Delete workspace' }))
    await waitFor(() => expect(fakeApi.deleteArchived).toHaveBeenCalledWith(['w1']))
  })

  it('with the cleanup on, shows when an auto-archived one goes and Keep spares it', async () => {
    const user = userEvent.setup()
    fakeState.snapshot.settings.archiveCleanupDays = 30
    render(<ArchivedInbox />)
    const run = screen.getAllByRole('listitem').find((row) => row.textContent?.includes('nightly-deps'))!
    expect(within(run).getByText('Deleted in 5 days')).toBeTruthy()
    // Archived by hand: never deleted on a timer, so no Keep.
    const mine = screen.getAllByRole('listitem').find((row) => row.textContent?.includes('seville'))!
    expect(within(mine).queryByRole('checkbox', { name: 'Keep' })).toBeNull()
    await user.click(within(run).getByRole('checkbox', { name: 'Keep' }))
    await waitFor(() => expect(fakeApi.keepArchived).toHaveBeenCalledWith('w2', true))
  })
})
