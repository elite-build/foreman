// @vitest-environment jsdom
// The renderer store with streaming appends: an append extends the preview it continues, one it can't continue is
// skipped until the next whole item puts the preview right, the finished item replaces the preview, and a chat
// opened mid-stream starts from the preview main still holds.
import './domShims'

const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  const events: { handler?: (event: unknown) => void } = {}
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: (handler: (event: unknown) => void) => {
      events.handler = handler
      return () => undefined
    },
    send: { setUnread: vi.fn() },
    browser: { command: vi.fn(async () => undefined) }
  }
  return { invoke, events }
})

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { flushStore, getState, initStore, loadChat } from '../src/renderer/src/store'

const at = new Date().toISOString()
const snapshot = {
  platform: 'win32',
  settings: { language: undefined, agentPrefs: {}, loadouts: [] },
  repos: [],
  repoSettings: {},
  workspaces: [{ id: 'w1', repoId: 'r1', name: 'one', branch: 'one', baseBranch: 'main', path: '/w/one', state: 'ready' }],
  sessions: ['s1', 's2', 's3'].map((id) => ({ id, workspaceId: 'w1', agent: 'claude', model: 'm', status: 'running', queue: [], createdAt: at })),
  catalog: { agents: {} },
  agentKeys: {}
}
const preview = (text: string) => ({ kind: 'assistant', id: 'a1', turnId: 't1', text, streaming: true })
const emit = (event: unknown) => bridge.events.handler!(event)
const append = (sessionId: string, from: number, text: string) => emit({ type: 'chat-append', sessionId, itemId: 'a1', from, text })
const text = (sessionId: string) => getState().chats[sessionId]?.map((i) => ('text' in i ? i.text : '')).join('|')

beforeAll(async () => {
  bridge.invoke.getSnapshot = vi.fn(async () => snapshot)
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  bridge.invoke.getChat = vi.fn(async () => [])
  await initStore()
})

describe('streaming appends in the renderer store', () => {
  it('applies appends, skips one it cannot continue, and recovers from the next whole item', async () => {
    await loadChat('s1')
    emit({ type: 'chat-item', sessionId: 's1', item: { kind: 'user', id: 'u1', turnId: 't1', text: 'go', at } })
    emit({ type: 'chat-item', sessionId: 's1', item: preview('Hel') })
    append('s1', 3, 'lo')
    expect(text('s1')).toBe('go|Hello')
    const before = getState().chats.s1
    // Missed " there": this one starts past the text held.
    append('s1', 11, ' again')
    expect(getState().chats.s1).toBe(before)
    // The periodic whole resend puts it right, and appends continue from there.
    emit({ type: 'chat-item', sessionId: 's1', item: preview('Hello there again') })
    append('s1', 17, '!')
    expect(text('s1')).toBe('go|Hello there again!')
    // The finished item replaces the preview; a late append doesn't touch it.
    emit({ type: 'chat-item', sessionId: 's1', item: { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Hello there again!' } })
    append('s1', 18, '?')
    expect(getState().chats.s1.at(-1)).toEqual({ kind: 'assistant', id: 'a1', turnId: 't1', text: 'Hello there again!' })
    flushStore()
  })

  it('ignores appends for a chat that is not loaded', () => {
    append('s2', 0, 'x')
    expect(getState().chats.s2).toBeUndefined()
  })

  it('opens a chat mid-stream from the preview main holds, so the appends that follow apply', async () => {
    let resolve!: (items: unknown[]) => void
    bridge.invoke.getChat = vi.fn(() => new Promise((r) => (resolve = r)))
    const loading = loadChat('s3')
    expect(bridge.invoke.getChat).toHaveBeenCalledWith('s3', true)
    // While loading: an older whole preview and an append that can't apply yet.
    emit({ type: 'chat-item', sessionId: 's3', item: preview('Hi') })
    append('s3', 2, ' th')
    resolve([preview('Hi there')])
    await loading
    expect(text('s3')).toBe('Hi there')
    append('s3', 8, ', you')
    expect(text('s3')).toBe('Hi there, you')
    flushStore()
  })
})
