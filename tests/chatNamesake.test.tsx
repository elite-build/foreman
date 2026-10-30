// @vitest-environment jsdom
// A workspace named after a person introduces them in a divider at the top of its chat, whether or not the chat has
// started: a workspace created with a task has its first message straight away, so an empty-chat greeting never shows.
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
vi.mock('../src/renderer/src/components/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }))
vi.mock('../src/renderer/src/components/composer/Composer', () => ({ AttachmentChip: () => null, Composer: () => null }))

const at = '2026-10-27T10:00:00.000Z'
const session = { id: 's1', workspaceId: 'w1', agent: 'claude', status: 'running', turnId: 't1', queue: [], title: 'Retry', createdAt: at } as never
const workspace = (over: Record<string, unknown> = {}) => ({ id: 'w1', name: 'curie', branch: 'yatin/curie', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1', ...over }) as never

beforeEach(() => {
  resetFake()
  Object.assign(fakeState, { approvals: [], chats: { s1: [] }, activeSession: { w1: 's1' }, chatJump: null })
  fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
})
afterEach(cleanup)

const divider = (container: HTMLElement) => container.querySelector('.chat-namesake')

describe('the namesake divider', () => {
  it('shows above the first message of a chat that has started', () => {
    fakeState.chats = { s1: [{ kind: 'user', id: 'u1', turnId: 't1', text: 'Add retry with backoff', at }] }
    const { container } = render(<ChatView session={session} workspace={workspace({ namesake: 'curie' })} active />)
    const line = divider(container)
    expect(line?.textContent).toContain("It's named after Marie Curie.")
    expect(line?.textContent).toContain('radioactivity')
    expect(screen.getByRole('button', { name: 'Marie Curie' })).toBeTruthy()
    // It comes before the conversation, not after it.
    const message = screen.getByText('Add retry with backoff')
    expect(line!.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows once in an empty chat, above the greeting', () => {
    const { container } = render(<ChatView session={session} workspace={workspace({ namesake: 'curie' })} active />)
    expect(container.querySelectorAll('.chat-namesake')).toHaveLength(1)
    expect(container.querySelector('.chat-greeting')?.textContent).not.toContain('Marie Curie')
  })

  it('stays after a task-based rename, from the stored namesake', () => {
    const { container } = render(<ChatView session={session} workspace={workspace({ name: 'retry-sync', branch: 'yatin/retry-sync', namesake: 'curie' })} active />)
    expect(divider(container)?.textContent).toContain('Marie Curie')
  })

  it('is absent for a name that is not a person', () => {
    const { container } = render(<ChatView session={session} workspace={workspace({ name: 'lisbon', branch: 'yatin/lisbon' })} active />)
    expect(divider(container)).toBeNull()
  })
})
