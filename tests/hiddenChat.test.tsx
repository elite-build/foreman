// @vitest-environment jsdom
// A chat that is not on screen (its workspace switched away from, another tab in front) stays mounted but stops working:
// no renders on store events, no live timer, and its scroll position back where it was when it is shown again.
import './domShims'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { fakeState, resetFake } from './rendererStore'

const counts = vi.hoisted(() => ({ markdown: 0, composer: 0, listeners: new Set<() => void>() }))

// The fake store, but live: a component re-renders when what it selected changes, as with the real one.
vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const { fakeState: state } = await import('./rendererStore')
  const subscribe = (listener: () => void) => {
    counts.listeners.add(listener)
    return () => void counts.listeners.delete(listener)
  }
  const own: Record<string, unknown> = {
    useStore: (selector: (s: typeof state) => unknown) => useSyncExternalStore(subscribe, () => selector(state))
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
// Each reply's Markdown counts the renders of the transcript.
vi.mock('../src/renderer/src/components/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => {
    counts.markdown++
    return <div>{text}</div>
  }
}))
// The composer follows the snapshot, as the real one does (settings, comments, templates).
vi.mock('../src/renderer/src/components/composer/Composer', async () => {
  const { useStore } = await import('../src/renderer/src/store')
  return {
    AttachmentChip: () => null,
    Composer: () => {
      useStore((s) => s.snapshot?.settings)
      counts.composer++
      return <button type="button">composer</button>
    }
  }
})

const at = '2026-10-27T10:00:00.000Z'
const session = (over: Record<string, unknown> = {}) => ({ id: 's1', workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], title: 'Login bug', createdAt: at, ...over }) as never
const workspace = (over: Record<string, unknown> = {}) => ({ id: 'w1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1', ...over }) as never
const user = (n: number) => ({ kind: 'user', id: `u${n}`, turnId: `t${n}`, text: `Question ${n}`, at })
const reply = (n: number, text: string) => ({ kind: 'assistant', id: `a${n}`, turnId: `t${n}`, text })
const end = (n: number) => ({ kind: 'turn-end', id: `e${n}`, turnId: `t${n}`, outcome: 'completed' })

/** A store event: what a component selected is read again. */
const notify = () => act(() => counts.listeners.forEach((l) => l()))
/** A `state` event: a whole new snapshot, as main sends it. */
const newSnapshot = () => {
  fakeState.snapshot = { ...fakeState.snapshot, settings: { ...fakeState.snapshot.settings } }
  notify()
}

beforeEach(() => {
  resetFake()
  counts.markdown = 0
  counts.composer = 0
  Object.assign(fakeState, { approvals: [], chats: { s1: [user(1), reply(1, 'First answer'), end(1)] }, activeSession: { w1: 's1' }, chatJump: null })
  fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
  fakeState.snapshot.settings.notAbsolutelyRight = false
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a running turn\'s timer', () => {
  const running = () => {
    fakeState.chats = { s1: [user(1)] }
    return session({ status: 'running', turnId: 't1' })
  }
  const timer = (root: HTMLElement) => root.querySelector('.live-timer')?.textContent

  it('ticks once a second and shows whole seconds', () => {
    vi.useFakeTimers({ now: new Date(at).getTime() + 5_400 })
    const every = vi.spyOn(globalThis, 'setInterval')
    const { container } = render(<ChatView session={running()} workspace={workspace()} active />)
    expect(timer(container)).toBe('5s')
    expect(every.mock.calls.map((c) => c[1])).toEqual([1000])
    act(() => void vi.advanceTimersByTime(500))
    expect(timer(container)).toBe('5s')
    act(() => void vi.advanceTimersByTime(500))
    expect(timer(container)).toBe('6s')
    act(() => void vi.advanceTimersByTime(60_000))
    expect(timer(container)).toBe('1m 6s')
  })

  it('stops while the chat is hidden, and catches up when it is shown', () => {
    vi.useFakeTimers({ now: new Date(at).getTime() + 5_000 })
    const s = running()
    const { container, rerender } = render(<ChatView session={s} workspace={workspace()} active />)
    expect(vi.getTimerCount()).toBe(1)
    rerender(<ChatView session={s} workspace={workspace()} active={false} hidden />)
    expect(vi.getTimerCount()).toBe(0)
    act(() => void vi.advanceTimersByTime(30_000))
    rerender(<ChatView session={s} workspace={workspace()} active />)
    expect(vi.getTimerCount()).toBe(1)
    expect(timer(container)).toBe('35s')
  })
})

describe('a hidden chat', () => {
  it('does not render on store events or its parent\'s renders, and catches up when shown', () => {
    const { container, rerender } = render(<ChatView session={session()} workspace={workspace()} active />)
    // Shown, it follows the store: a new snapshot renders its composer, a new item its transcript.
    newSnapshot()
    expect(counts.composer).toBeGreaterThan(1)
    rerender(<ChatView session={session()} workspace={workspace()} active={false} hidden />)
    const markdown = counts.markdown
    const composer = counts.composer

    fakeState.chats = { s1: [...fakeState.chats.s1, user(2), reply(2, 'Second answer')] }
    notify()
    newSnapshot()
    // Another chat's approval request.
    fakeState.approvals = [{ kind: 'question', id: 'q9', sessionId: 's9', questions: [{ question: 'Elsewhere?', options: [] }] }]
    notify()
    // The workspace view re-renders with new session and workspace objects on each snapshot.
    rerender(<ChatView session={session({ title: 'Renamed' })} workspace={workspace({ name: 'acme 2' })} active={false} hidden />)
    expect(counts.markdown).toBe(markdown)
    expect(counts.composer).toBe(composer)
    expect(container.textContent).not.toContain('Second answer')

    rerender(<ChatView session={session()} workspace={workspace()} active />)
    expect(container.textContent).toContain('Second answer')
    // Shown again, it follows the store again.
    const after = counts.composer
    newSnapshot()
    expect(counts.composer).toBeGreaterThan(after)
  })

  it('keeps its approval panel live, so a request is there the moment the chat is shown', () => {
    const { container, rerender } = render(<ChatView session={session()} workspace={workspace()} active={false} hidden />)
    fakeState.approvals = [{ kind: 'question', id: 'q1', sessionId: 's1', questions: [{ question: 'Which file?', options: [] }] }]
    notify()
    rerender(<ChatView session={session()} workspace={workspace()} active />)
    expect(container.querySelector('.approval-panel')).not.toBeNull()
  })
})

describe('the scroll position', () => {
  /** jsdom has no layout: give the log a height, a content height and a scroll offset of its own. */
  function measure(el: HTMLElement) {
    const box = { top: 0, height: 1000, client: 300 }
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => box.top, set: (v: number) => (box.top = Math.max(0, Math.min(v, box.height - box.client))) })
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.client })
    return box
  }
  /** What a browser does to a log hidden with display: none: no height, and back at the top. */
  function hide(el: HTMLElement, box: { top: number; client: number }) {
    box.client = 0
    box.top = 0
    fireEvent.scroll(el)
  }

  it('comes back where the reader left it after the workspace was switched away from', () => {
    const { container, rerender } = render(<ChatView session={session()} workspace={workspace()} active />)
    const log = container.querySelector<HTMLElement>('.chat-scroll')!
    const box = measure(log)
    log.scrollTop = 200
    fireEvent.scroll(log)

    rerender(<ChatView session={session()} workspace={workspace()} active={false} hidden />)
    hide(log, box)
    box.client = 300
    rerender(<ChatView session={session()} workspace={workspace()} active />)
    expect(log.scrollTop).toBe(200)
  })

  it('stays at the bottom when the reader was following the latest output', () => {
    const { container, rerender } = render(<ChatView session={session()} workspace={workspace()} active />)
    const log = container.querySelector<HTMLElement>('.chat-scroll')!
    const box = measure(log)
    log.scrollTop = 700
    fireEvent.scroll(log)

    rerender(<ChatView session={session()} workspace={workspace()} active={false} hidden />)
    hide(log, box)
    box.client = 300
    box.height = 1400
    rerender(<ChatView session={session()} workspace={workspace()} active />)
    expect(log.scrollTop).toBe(1100)
  })
})
