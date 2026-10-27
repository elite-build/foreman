// @vitest-environment jsdom
// A long chat stays cheap while a turn streams: a new item or the next chunk of a reply renders the rows it changes, not
// the whole log; a tool call is written out for search only while there is a query; and the log follows its bottom from
// a ResizeObserver rather than measuring itself on every change.
import './domShims'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { fakeState, resetFake } from './rendererStore'

const counts = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  markdown: new Map<string, number>(),
  tools: new Map<string, number>(),
  forceOpen: new Map<string, boolean>()
}))

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
// Search, reduced to its query box.
vi.mock('../src/renderer/src/components/ChatSearch', () => ({
  ChatSearch: ({ onQuery }: { onQuery: (q: string) => void }) => <input aria-label="Find in chat" onChange={(e) => onQuery(e.target.value)} />
}))
// Each reply's Markdown and each tool row count their renders (neither memo'd here: what is measured is the chat's rows).
vi.mock('../src/renderer/src/components/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => {
    counts.markdown.set(text, (counts.markdown.get(text) ?? 0) + 1)
    return <div>{text}</div>
  }
}))
vi.mock('../src/renderer/src/components/ToolRow', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ToolRow: ({ item, forceOpen }: { item: { id: string }; forceOpen?: boolean }) => {
    counts.tools.set(item.id, (counts.tools.get(item.id) ?? 0) + 1)
    counts.forceOpen.set(item.id, Boolean(forceOpen))
    return <div data-tool={item.id}>tool {item.id}</div>
  }
}))
vi.mock('../src/renderer/src/components/composer/Composer', () => ({ AttachmentChip: () => null, Composer: () => null }))

const at = '2026-10-27T10:00:00.000Z'
const session = (over: Record<string, unknown> = {}) => ({ id: 's1', workspaceId: 'w1', agent: 'claude', status: 'running', turnId: 't2', queue: [], title: 'Login bug', createdAt: at, ...over }) as never
const workspace = { id: 'w1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1' } as never
const user = (n: number) => ({ kind: 'user', id: `u${n}`, turnId: `t${n}`, text: `Question ${n}`, at })
const reply = (n: number, text: string, streaming?: boolean) => ({ kind: 'assistant', id: `a${n}`, turnId: `t${n}`, text, streaming })
const tool = (id: string, turn: number, input: Record<string, unknown> = { command: 'ls' }) => ({ kind: 'tool', id, turnId: `t${turn}`, name: 'Bash', input, status: 'done', output: 'ok' })
const end = (n: number) => ({ kind: 'turn-end', id: `e${n}`, turnId: `t${n}`, outcome: 'completed' })

/** A store event: what a component selected is read again. */
const notify = () => act(() => counts.listeners.forEach((l) => l()))
const add = (...items: unknown[]) => {
  fakeState.chats = { s1: [...fakeState.chats.s1, ...items] }
  notify()
}

beforeEach(() => {
  resetFake()
  counts.markdown.clear()
  counts.tools.clear()
  counts.forceOpen.clear()
  Object.assign(fakeState, { approvals: [], activeSession: { w1: 's1' }, chatJump: null })
  fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
  fakeState.snapshot.settings.notAbsolutelyRight = false
  // Two finished turns with replies and tool calls, and a third streaming.
  fakeState.chats = {
    s1: [user(1), tool('x1', 1), reply(1, 'First answer'), end(1), user(3), tool('x3', 3, { pattern: 'needle-in-the-input' }), reply(3, 'Third answer'), end(3), user(2), reply(2, 'Sec', true)]
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('rendering a streaming chat', () => {
  it('renders only the new and the streaming rows when the running turn adds to the log', () => {
    render(<ChatView session={session()} workspace={workspace} active />)
    counts.markdown.clear()
    counts.tools.clear()

    // The next chunk of the streaming reply, then a tool call it makes.
    fakeState.chats = { s1: [...fakeState.chats.s1.slice(0, -1), reply(2, 'Second', true)] }
    notify()
    add(tool('x2', 2))

    expect(counts.markdown.get('First answer')).toBeUndefined()
    expect(counts.markdown.get('Third answer')).toBeUndefined()
    expect(counts.tools.get('x1')).toBeUndefined()
    expect(counts.tools.get('x3')).toBeUndefined()
    expect(counts.tools.get('x2')).toBe(1)
  })

  it('still renders the streaming reply as it grows', () => {
    vi.useFakeTimers()
    const { container } = render(<ChatView session={session()} workspace={workspace} active />)
    fakeState.chats = { s1: [...fakeState.chats.s1.slice(0, -1), reply(2, 'Second answer', true)] }
    notify()
    act(() => void vi.advanceTimersByTime(400))
    expect(container.textContent).toContain('Second answer')
    fakeState.chats = { s1: [...fakeState.chats.s1.slice(0, -1), reply(2, 'Second answer, finished')] }
    notify()
    expect(container.textContent).toContain('Second answer, finished')
    vi.useRealTimers()
  })
})

describe('search through tool calls', () => {
  it('writes no tool call out while the search is empty, and finds one by its input once searched', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const { getByLabelText } = render(<ChatView session={session()} workspace={workspace} active />)
    const needle = fakeState.chats.s1[5].input
    expect(stringify.mock.calls.some(([value]) => value === needle)).toBe(false)
    expect(counts.forceOpen.get('x3')).toBe(false)

    fireEvent.change(getByLabelText('Find in chat'), { target: { value: 'needle-in-the' } })
    expect(counts.forceOpen.get('x3')).toBe(true)
    expect(counts.forceOpen.get('x1')).toBe(false)
    // Written out once, and kept: the next keystroke searches the same text.
    const written = stringify.mock.calls.filter(([value]) => value === needle).length
    fireEvent.change(getByLabelText('Find in chat'), { target: { value: 'needle-in-the-in' } })
    expect(counts.forceOpen.get('x3')).toBe(true)
    expect(stringify.mock.calls.filter(([value]) => value === needle).length).toBe(written)
  })
})

describe('following the bottom of the log', () => {
  /** A ResizeObserver whose notifications the test sends, as the browser does after a layout. */
  function observers() {
    const live = new Set<() => void>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly fire: () => void
        constructor(callback: () => void) {
          this.fire = () => callback()
        }
        observe() {
          live.add(this.fire)
        }
        unobserve() {}
        disconnect() {
          live.delete(this.fire)
        }
      }
    )
    return { resized: () => act(() => live.forEach((fire) => fire())), count: () => live.size }
  }
  /** jsdom has no layout: give the log a height, a content height and a scroll offset of its own. */
  function measure(el: HTMLElement) {
    const box = { top: 0, height: 1000, client: 300 }
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => box.top, set: (v: number) => (box.top = Math.max(0, Math.min(v, box.height - box.client))) })
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.client })
    return box
  }
  afterEach(() => vi.unstubAllGlobals())

  it('stays at the bottom as the log grows, and stays put once the reader scrolls up', () => {
    const ro = observers()
    const { container } = render(<ChatView session={session()} workspace={workspace} active />)
    expect(ro.count()).toBe(1)
    const log = container.querySelector<HTMLElement>('.chat-scroll')!
    const box = measure(log)
    log.scrollTop = 700
    fireEvent.scroll(log)

    // The reply grows (a throttled render, a row drawn for the first time): the observer hears it, the log follows.
    box.height = 1400
    ro.resized()
    expect(log.scrollTop).toBe(1100)

    // The reader scrolls up: growth no longer moves the log.
    log.scrollTop = 200
    fireEvent.scroll(log)
    box.height = 1800
    ro.resized()
    expect(log.scrollTop).toBe(200)
  })

  it('stops observing while the chat is hidden, and observes again when it is shown', () => {
    const ro = observers()
    const { rerender } = render(<ChatView session={session()} workspace={workspace} active />)
    expect(ro.count()).toBe(1)
    rerender(<ChatView session={session()} workspace={workspace} active={false} hidden />)
    expect(ro.count()).toBe(0)
    rerender(<ChatView session={session()} workspace={workspace} active />)
    expect(ro.count()).toBe(1)
  })
})
