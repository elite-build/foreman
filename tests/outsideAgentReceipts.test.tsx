// @vitest-environment jsdom
// docs/agent-access.md §7, "Who did it": a message an outside agent sent says so under it, and Home → Recent says an
// outside agent answered its worker's question, by the name it signed in with.
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { eventText } from '../src/renderer/src/components/Attention'
import type { RendererT } from '../src/renderer/src/i18n'
import { createT } from '../src/shared/i18n'
import type { AttentionEvent } from '../src/shared/attention'
import { fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
vi.mock('../src/renderer/src/components/composer/Composer', () => ({ AttachmentChip: () => null, Composer: () => null }))

const at = '2026-11-10T10:00:00.000Z'
const session = { id: 's1', workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], title: 'Importer', createdAt: at } as never
const workspace = { id: 'w1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1' } as never

beforeEach(() => {
  resetFake()
  Object.assign(fakeState, { approvals: [], activeSession: { w1: 's1' }, chatJump: null })
  fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a message an outside agent sent', () => {
  it('says who sent it under the message, and a person’s message says nothing', () => {
    fakeState.chats = {
      s1: [
        { kind: 'user', id: 'u1', turnId: 't1', text: 'Build the importer', at, origin: { kind: 'outside', grantId: 'g1', name: 'Claude Code' } },
        { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed' },
        { kind: 'user', id: 'u2', turnId: 't2', text: 'Mine', at },
        { kind: 'turn-end', id: 'e2', turnId: 't2', outcome: 'completed' }
      ]
    }
    render(<ChatView session={session} workspace={workspace} active />)
    expect(screen.getAllByText('Sent by Claude Code (outside agent)')).toHaveLength(1)
  })
})

describe('Home → Recent', () => {
  it('names the outside agent that answered a question', () => {
    const event = { id: 'x', kind: 'approval-answered', workspaceId: 'w1', topic: 'approval:s1', key: 'question:true', firstAt: at, at, count: 1, label: 'question', allowed: true, via: 'outside', by: 'Claude Code' } as AttentionEvent
    const t = createT('en') as unknown as RendererT
    expect(eventText(event, t).rest).toEqual(['by Claude Code (outside agent)'])
    expect(eventText({ ...event, via: 'phone' }, t).rest).toEqual(['on your phone'])
  })
})
