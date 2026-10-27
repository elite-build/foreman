// @vitest-environment jsdom
// A minimized or hidden window (main's window-visibility event): components hear that it went hidden and then nothing more
// (no renders, no frames, no timers) while agents stream; endless animations pause; clocks stop. Shown again, everything
// catches up in one render, with nothing unmounted or hidden in between, so focus and scroll positions are untouched.
import './domShims'

// The bridge to the main process, in place before the store module reads `window.foreman`.
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

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClock } from '../src/renderer/src/clock'
import { useGitStatus } from '../src/renderer/src/components/GitPanel'
import { flushStore, getState, initStore, loadChat, useStore, useWindowVisible } from '../src/renderer/src/store'

const at = new Date().toISOString()
const snapshot = () => ({
  platform: 'win32',
  settings: { language: undefined, agentPrefs: {}, loadouts: [] },
  repos: [],
  repoSettings: {},
  workspaces: [{ id: 'w1', repoId: 'r1', name: 'one', branch: 'one', baseBranch: 'main', path: '/w/one', state: 'ready' }],
  sessions: [{ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm', status: 'running', queue: [], createdAt: at }],
  catalog: { agents: {} },
  agentKeys: {}
})
const streaming = (text: string) => ({ kind: 'assistant', id: 'a1', turnId: 't1', text, streaming: true })
const emit = (event: unknown) => act(() => bridge.events.handler!(event))
const visibility = (visible: boolean) => emit({ type: 'window-visibility', visible })

const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const runFrame = () =>
  act(() => {
    const due = [...frames.values()]
    frames.clear()
    for (const frame of due) frame(performance.now())
  })

let renders = 0
function Chat() {
  const items = useStore((s) => s.chats.s1)
  renders++
  return <input aria-label="Draft" data-testid="chat" readOnly value={items?.map((i) => ('text' in i ? i.text : '')).join('|') ?? ''} />
}

let clockRenders = 0
function GitStatusReader() {
  useGitStatus('w1', true, true)
  return null
}

function Clock() {
  const now = useClock(30_000)
  const visible = useWindowVisible()
  clockRenders++
  return <p data-testid="clock">{`${now}:${visible}`}</p>
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
  clockRenders = 0
})
afterEach(() => {
  cleanup()
  bridge.events.handler?.({ type: 'window-visibility', visible: true })
  flushStore()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a hidden window', () => {
  it('reaches the store from main, and marks the page so endless animations pause', () => {
    expect(getState().windowVisible).toBe(true)
    visibility(false)
    expect(getState().windowVisible).toBe(false)
    expect(document.documentElement.hasAttribute('data-window-hidden')).toBe(true)
    visibility(true)
    expect(getState().windowVisible).toBe(true)
    expect(document.documentElement.hasAttribute('data-window-hidden')).toBe(false)
  })

  it('renders nothing while agents stream, then catches up in one render, the same elements still mounted and focused', async () => {
    const view = render(<Chat />)
    const input = view.getByTestId('chat') as HTMLInputElement
    input.focus()
    visibility(false)
    renders = 0
    for (let n = 1; n <= 50; n++) emit({ type: 'chat-item', sessionId: 's1', item: streaming('x'.repeat(n)) })
    emit({ type: 'state', snapshot: { ...snapshot(), sessions: [{ ...snapshot().sessions[0], status: 'idle' }] } })
    // The state is current for whatever reads it; nobody was told, and nothing waits on a frame or a timer.
    expect(getState().chats.s1).toEqual([streaming('x'.repeat(50))])
    expect(renders).toBe(0)
    expect(frames.size).toBe(0)
    await runFrame()
    expect(renders).toBe(0)
    expect(input.value).toBe('')

    visibility(true)
    expect(renders).toBe(1)
    expect(input.value).toBe('x'.repeat(50))
    // Nothing was unmounted or hidden on the way: the same element, still focused.
    expect(view.getByTestId('chat')).toBe(input)
    expect(document.activeElement).toBe(input)
    // Shown, it follows the store as before.
    emit({ type: 'chat-item', sessionId: 's1', item: streaming('after') })
    await runFrame()
    expect(input.value).toBe('after')
  })

  it('is visible again when the window gains focus, whatever main last said', () => {
    visibility(false)
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(getState().windowVisible).toBe(true)
  })

  it('stops clocks while hidden, and they catch up when shown', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-10-27T10:00:00Z') })
    const view = render(<Clock />)
    const start = Date.now()
    expect(vi.getTimerCount()).toBe(1)
    act(() => void vi.advanceTimersByTime(30_000))
    expect(view.getByTestId('clock').textContent).toBe(`${start + 30_000}:true`)

    visibility(false)
    expect(view.getByTestId('clock').textContent).toBe(`${start + 30_000}:false`)
    expect(vi.getTimerCount()).toBe(0)
    clockRenders = 0
    act(() => void vi.advanceTimersByTime(10 * 60_000))
    expect(clockRenders).toBe(0)

    visibility(true)
    expect(view.getByTestId('clock').textContent).toBe(`${start + 30_000 + 10 * 60_000}:true`)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stops polling git status while hidden, and reads it again once shown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const gitStatus = (bridge.invoke.gitStatus = vi.fn(async () => null))
    render(<GitStatusReader />)
    await act(async () => undefined)
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await act(async () => void vi.advanceTimersByTime(10_000))
    expect(gitStatus).toHaveBeenCalledTimes(2)

    visibility(false)
    await act(async () => void vi.advanceTimersByTime(10 * 60_000))
    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

    visibility(true)
    expect(gitStatus).toHaveBeenCalledTimes(3)
  })
})
