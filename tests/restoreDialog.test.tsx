// @vitest-environment jsdom
// Restore asks in a Dialog, not window.confirm (docs/agents.md 2.5): an agent whose own conversation can't be rewound is
// told "Restores files; the agent starts a fresh conversation", and one that can keeps the wording it always had.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
vi.mock('../src/renderer/src/components/composer/Composer', () => ({ AttachmentChip: () => null, Composer: () => null }))

const at = '2026-10-27T10:00:00.000Z'
const workspace = { id: 'w1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1' } as never
const session = (agent: string) => ({ id: 's1', workspaceId: 'w1', agent, status: 'idle', queue: [], title: 'Login bug', createdAt: at }) as never

beforeEach(() => {
  resetFake()
  Object.assign(fakeState, { approvals: [], activeSession: { w1: 's1' }, chatJump: null })
  fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
  fakeState.chats = {
    s1: [
      { kind: 'user', id: 'u1', turnId: 't1', text: 'Question 1', at, checkpoint: 'cp1' },
      { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Answer 1' },
      { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed' }
    ]
  }
  fakeApi.restoreCheckpoint = vi.fn(async () => undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const confirmSpy = () => vi.spyOn(window, 'confirm').mockImplementation(() => true)

describe('Restore confirmation', () => {
  it('says the agent starts a fresh conversation when it can’t rewind its own, and restores on confirm', async () => {
    const confirm = confirmSpy()
    const user = userEvent.setup()
    render(<ChatView session={session('cursor')} workspace={workspace} active />)
    const button = screen.getByRole('button', { name: 'Restore' })
    expect(button.title).toMatch(/starts a fresh conversation/)
    await user.click(button)
    const dialog = screen.getByRole('dialog', { name: 'Restore to before this message?' })
    expect(within(dialog).getByText(/Restores files; the agent starts a fresh conversation/)).toBeTruthy()
    expect(fakeApi.restoreCheckpoint).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(fakeApi.restoreCheckpoint).toHaveBeenCalledWith('s1', 't1'))
    expect(screen.queryByRole('dialog', { name: 'Restore to before this message?' })).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('keeps the existing wording for an agent that rolls its conversation back itself', async () => {
    const user = userEvent.setup()
    render(<ChatView session={session('claude')} workspace={workspace} active />)
    expect(screen.getByRole('button', { name: 'Restore' }).title).toBe('Undo this message and everything after it: files and conversation')
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    const dialog = screen.getByRole('dialog', { name: 'Restore to before this message?' })
    expect(within(dialog).getByText('Restore files and conversation to before this message? Later changes are discarded.')).toBeTruthy()
  })

  it('Cancel (and Escape) restore nothing', async () => {
    const user = userEvent.setup()
    render(<ChatView session={session('opencode')} workspace={workspace} active />)
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fakeApi.restoreCheckpoint).not.toHaveBeenCalled()
  })
})
