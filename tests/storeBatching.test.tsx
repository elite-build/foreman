// @vitest-environment jsdom
// The renderer store with many agents streaming: events from main change the state at once (getState() is fresh),
// but components hear about them at most once an animation frame. What the user does still shows straight away.
import './domShims'

// The bridge to the main process, in place before the store module reads `window.foreman`.
const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  const events: { handler?: (event: unknown) => void } = {}
  const setUnread = vi.fn()
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: (handler: (event: unknown) => void) => {
      events.handler = handler
      return () => undefined
    },
    send: { setUnread },
    browser: { command: vi.fn(async () => undefined) }
  }
  return { invoke, events, setUnread }
})

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushStore, getState, initStore, loadChat, openBrowserTab, selectWorkspace, useStore } from '../src/renderer/src/store'

const at = new Date().toISOString()
const session = (status: string) => ({ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm', status, queue: [], createdAt: at })
const snapshot = (status = 'running') => ({
  platform: 'win32',
  settings: { language: undefined, agentPrefs: {}, loadouts: [] },
  repos: [],
  repoSettings: {},
  workspaces: [
    { id: 'w1', repoId: 'r1', name: 'one', branch: 'one', baseBranch: 'main', path: '/w/one', state: 'ready' },
    { id: 'w2', repoId: 'r1', name: 'two', branch: 'two', baseBranch: 'main', path: '/w/two', state: 'ready' }
  ],
  sessions: [session(status)],
  catalog: { agents: {} },
  agentKeys: {}
})
const streaming = (text: string) => ({ kind: 'assistant', id: 'a1', turnId: 't1', text, streaming: true })
const emit = (event: unknown) => bridge.events.handler!(event)

// Animation frames run when the test says so.
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const runFrame = () =>
  act(() => {
    const due = [...frames.values()]
    frames.clear()
    for (const frame of due) frame(performance.now())
  })

let renders = 0
let selected = 0
function Chat() {
  const items = useStore((s) => {
    selected++
    return s.chats.s1
  })
  renders++
  return <p data-testid="chat">{items?.map((i) => ('text' in i ? i.text : '')).join('|')}</p>
}

beforeEach(async () => {
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.set(++frameId, cb), frameId))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  bridge.invoke.getSnapshot = vi.fn(async () => snapshot())
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  bridge.invoke.getChat = vi.fn(async () => [])
  await initStore()
  await loadChat('s1')
  renders = 0
  selected = 0
})
afterEach(() => {
  cleanup()
  flushStore()
  vi.unstubAllGlobals()
})

describe('store notifications from main', () => {
  it('N streaming chat items notify components once, on the next frame, with the last text', async () => {
    const view = render(<Chat />)
    renders = 0
    selected = 0
    for (let n = 1; n <= 40; n++) emit({ type: 'chat-item', sessionId: 's1', item: streaming('x'.repeat(n)) })
    // State is current at once; nothing has been told yet.
    expect(getState().chats.s1).toEqual([streaming('x'.repeat(40))])
    expect(selected).toBe(0)
    expect(renders).toBe(0)
    expect(frames.size).toBe(1)
    await runFrame()
    expect(renders).toBe(1)
    expect(view.getByTestId('chat').textContent).toBe('x'.repeat(40))
    // Nothing left to say: no further frame, no further render.
    expect(frames.size).toBe(0)
  })

  it('falls back to a timer when no animation frame runs (a hidden window)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const view = render(<Chat />)
      emit({ type: 'chat-item', sessionId: 's1', item: streaming('hello') })
      expect(view.getByTestId('chat').textContent).not.toBe('hello')
      await act(() => void vi.advanceTimersByTime(150))
      expect(view.getByTestId('chat').textContent).toBe('hello')
    } finally {
      vi.useRealTimers()
    }
  })

  it('what the user does shows at once, along with any events waiting for the frame', () => {
    const view = render(<Chat />)
    emit({ type: 'chat-item', sessionId: 's1', item: streaming('partial') })
    act(() => selectWorkspace('w2'))
    expect(view.getByTestId('chat').textContent).toBe('partial')
    expect(getState().selectedWorkspaceId).toBe('w2')
  })

  it('a snapshot is one change, keeps the browser tabs object when no tab went away, and still updates the dock badge at once', async () => {
    act(() => openBrowserTab('w2', 'http://localhost:5173/'))
    const tabs = getState().browserTabs
    act(() => selectWorkspace('w2'))
    bridge.setUnread.mockClear()
    // The agent in w1 finishes while w2 is on screen: w1 and its chat are unread, and main hears so before the frame.
    emit({ type: 'state', snapshot: snapshot('idle') })
    expect(getState().browserTabs).toBe(tabs)
    expect(getState().snapshot?.sessions[0].status).toBe('idle')
    expect(getState().unreadSessions).toEqual({ s1: true })
    expect(bridge.setUnread).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    await runFrame()
    // An archived workspace's tab goes.
    emit({ type: 'state', snapshot: { ...snapshot('idle'), workspaces: snapshot().workspaces.map((w) => (w.id === 'w2' ? { ...w, state: 'archived' } : w)) } })
    expect(getState().browserTabs).toEqual({})
  })
})
