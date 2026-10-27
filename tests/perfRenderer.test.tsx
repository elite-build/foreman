// @vitest-environment jsdom
// Load benchmark (renderer side): twelve workspaces, each with a chat of finished turns and a running turn streaming a
// reply, one workspace on screen. The real renderer store hears main's events through the bridge (chat-item, chat-append
// and state, as main sends them) and animation frames run when the test says, so every count is the same on every run.
// Guards (docs/performance.md): hidden chats render nothing while they stream, the chat on screen renders at most once a
// frame, finished rows never render again, and the store's subscriptions don't grow with the number of rows.
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

const counts = vi.hoisted(() => ({
  // Store subscriptions mounted now (each `useStore` is one; a hidden Activity takes its subtree's down).
  subscriptions: 0,
  // Renders of a chat's body (its one `useHeldStore`), by session.
  chat: new Map<string, number>(),
  markdown: new Map<string, number>(),
  tools: new Map<string, number>(),
  composer: new Map<string, number>(),
  // Renders of a live clock ("running for 12s"), in any chat.
  clock: 0
}))
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

// The real store, with each `useStore` counted while it is mounted.
vi.mock('../src/renderer/src/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/src/store')>()
  const { useEffect } = await import('react')
  return {
    ...real,
    useStore: <T,>(selector: Parameters<typeof real.useStore<T>>[0]) => {
      useEffect(() => {
        counts.subscriptions++
        return () => void counts.subscriptions--
      }, [])
      return real.useStore(selector)
    }
  }
})
// ChatView reads its log through useHeldStore once per render: that counts the chat's renders.
vi.mock('../src/renderer/src/heldStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/src/heldStore')>()
  return {
    useHeldStore: ((selector, held) => {
      const value = real.useHeldStore(selector, held)
      const items = value as { turnId?: string }[] | undefined
      bump(counts.chat, items?.[0]?.turnId?.split(':')[0] ?? 'unknown')
      return value
    }) satisfies typeof real.useHeldStore
  }
})
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
vi.mock('../src/renderer/src/clock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/src/clock')>()
  return {
    useClock: (everyMs: number) => {
      counts.clock++
      return real.useClock(everyMs)
    }
  }
})
// Each reply's Markdown (memo'd, as the real one is) and each tool row count their renders: a finished reply by its text,
// a streaming one by its chat ("Live 3: …").
vi.mock('../src/renderer/src/components/Markdown', async () => {
  const { memo } = await import('react')
  return {
    Markdown: memo(function Markdown({ text }: { text: string }) {
      bump(counts.markdown, text.startsWith('History') ? text : `live:${text.split(':')[0]}`)
      return <div>{text.slice(0, 40)}</div>
    })
  }
})
vi.mock('../src/renderer/src/components/ToolRow', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ToolRow: ({ item }: { item: { id: string } }) => {
    bump(counts.tools, item.id)
    return <div>tool {item.id}</div>
  }
}))
// The composer follows the settings, as the real one does.
vi.mock('../src/renderer/src/components/composer/Composer', async () => {
  const { useStore } = await import('../src/renderer/src/store')
  return {
    AttachmentChip: () => null,
    Composer: ({ session }: { session: { id: string } }) => {
      useStore((s) => s.snapshot?.settings)
      bump(counts.composer, session.id)
      return null
    }
  }
})

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { LocaleProvider } from '../src/renderer/src/i18n'
import { flushStore, getState, initStore, loadChat, useStore } from '../src/renderer/src/store'
import type { AppSnapshot, ChatItem } from '../src/shared/types'

const AGENTS = 12
const FRAMES = 240
// A new text block every 60 frames (3 s), with a tool call between blocks; a state change (context usage) every 20.
const BLOCK_FRAMES = 60
const STATE_EVERY = 20
const DELTA = 'streams a few more words '

const at = '2026-10-27T10:00:00.000Z'
const sid = (i: number) => `s${i}`

/** What main sends: fresh objects every time, as a structured clone over IPC is. */
function mainSnapshot(usage: number[]): AppSnapshot {
  return {
    platform: 'win32',
    settings: { language: 'en', agentPrefs: {}, loadouts: [], promptTemplates: [] },
    repos: [],
    repoSettings: {},
    repoTemplates: {},
    comments: [],
    workspaces: Array.from({ length: AGENTS }, (_, i) => ({ id: `w${i}`, repoId: 'r1', name: `ws ${i}`, branch: `b${i}`, baseBranch: 'main', path: `/w/${i}`, state: 'ready', createdAt: at })),
    sessions: Array.from({ length: AGENTS }, (_, i) => ({
      id: sid(i), workspaceId: `w${i}`, agent: 'claude', model: 'm', status: 'running', turnId: `${sid(i)}:live`, turnStartedAt: at, queue: [], title: `agent ${i}`, createdAt: at,
      contextUsage: { used: usage[i], limit: 200_000 }
    })),
    catalog: { agents: {} },
    agentKeys: {}
  } as unknown as AppSnapshot
}

/** A chat of `turns` finished turns (a message, a tool call, a reply, its end), then the running turn's message. */
function history(i: number, turns: number): ChatItem[] {
  const items: ChatItem[] = []
  for (let n = 0; n < turns; n++) {
    const turnId = `${sid(i)}:t${n}`
    items.push(
      { kind: 'user', id: `${turnId}:u`, turnId, text: `Question ${n}`, at },
      { kind: 'tool', id: `${turnId}:tool`, turnId, name: 'Read', input: { file_path: `src/f${n}.ts` }, status: 'done', output: 'ok' },
      { kind: 'assistant', id: `${turnId}:a`, turnId, text: `History ${i}.${n}: the answer.` },
      { kind: 'turn-end', id: `${turnId}:end`, turnId, outcome: 'completed' }
    )
  }
  items.push({ kind: 'user', id: `${sid(i)}:live:u`, turnId: `${sid(i)}:live`, text: 'Now the big one', at })
  return items
}

// Animation frames run when the test says so.
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const runFrame = () =>
  act(() => {
    const due = [...frames.values()]
    frames.clear()
    for (const frame of due) frame(performance.now())
  })
const emit = (event: unknown) => bridge.events.handler!(event)

/** App, reduced to what matters here: it re-renders on every snapshot and renders each workspace's chat, one on screen. */
function Shell() {
  const snapshot = useStore((s) => s.snapshot)
  const selected = useStore((s) => s.selectedWorkspaceId)
  return (
    <LocaleProvider>
      {snapshot?.sessions.map((session) => {
        const workspace = snapshot.workspaces.find((w) => w.id === session.workspaceId)!
        const shown = workspace.id === selected
        return <ChatView key={session.id} session={session} workspace={workspace} active={shown} hidden={!shown} />
      })}
    </LocaleProvider>
  )
}

async function mount(turns: number) {
  let usage = Array.from({ length: AGENTS }, () => 1000)
  bridge.invoke.getSnapshot = vi.fn(async () => mainSnapshot(usage))
  bridge.invoke.pendingApprovals = vi.fn(async () => [])
  bridge.invoke.attentionHistory = vi.fn(async () => ({ events: [] }))
  bridge.invoke.getChat = vi.fn(async (id: string) => history(Number(id.slice(1)), turns))
  await initStore()
  // The store is the module's own, kept between tests: a chat loaded by an earlier test starts over from main's copy.
  for (let i = 0; i < AGENTS; i++) {
    if (getState().chats[sid(i)]) emit({ type: 'chat-reset', sessionId: sid(i), items: history(i, turns) })
    else await loadChat(sid(i))
  }
  flushStore()
  const view = render(<Shell />)
  await act(async () => {})
  return {
    view,
    setUsage: (i: number, used: number) => {
      usage = usage.slice()
      usage[i] = used
      emit({ type: 'state', snapshot: mainSnapshot(usage) })
    }
  }
}

beforeEach(() => {
  frames.clear()
  // Only the clock the chat's throttled reply and live timer read moves, by 50 ms a frame; the store's frame fallback too.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(at).getTime() + 1000 })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.set(++frameId, cb), frameId))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  counts.chat.clear()
  counts.markdown.clear()
  counts.tools.clear()
  counts.composer.clear()
  counts.clock = 0
})
afterEach(() => {
  cleanup()
  flushStore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('twelve agents streaming at once (renderer)', () => {
  it('renders only the chat on screen, at most once a frame, and never a finished row again', async () => {
    const { view, setUsage } = await mount(20)
    const shown = getState().selectedWorkspaceId
    expect(shown).toBe('w0')
    expect(view.container.textContent).toContain('History 0.19')

    // From here, every render is one the stream caused.
    const historyRenders = new Map(counts.markdown)
    const historyTools = new Map(counts.tools)
    counts.chat.clear()
    counts.composer.clear()
    counts.clock = 0
    for (const key of [...counts.markdown.keys()]) if (key.startsWith('live:')) counts.markdown.delete(key)

    const texts = new Map<string, string>()
    let events = 0
    let chatRendersInFrames = 0
    let maxChatRendersInAFrame = 0
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < AGENTS; i++) {
        const block = Math.floor(f / BLOCK_FRAMES)
        const turnId = `${sid(i)}:live`
        const id = `${turnId}:a${block}`
        const was = texts.get(id)
        if (was === undefined) {
          // A block's first preview goes whole, and the tool call before it (after the first block).
          if (block > 0) {
            const tool = { kind: 'tool', id: `${turnId}:tool${block}`, turnId, name: 'Bash', input: { command: 'npm test' } }
            emit({ type: 'chat-item', sessionId: sid(i), item: { kind: 'assistant', id: `${turnId}:a${block - 1}`, turnId, text: texts.get(`${turnId}:a${block - 1}`) } })
            emit({ type: 'chat-item', sessionId: sid(i), item: { ...tool, status: 'running' } })
            emit({ type: 'chat-item', sessionId: sid(i), item: { ...tool, status: 'done', output: 'ok' } })
            events += 3
          }
          const text = `Live ${i}: ${DELTA}`
          texts.set(id, text)
          emit({ type: 'chat-item', sessionId: sid(i), item: { kind: 'assistant', id, turnId, text, streaming: true } })
        } else {
          texts.set(id, was + DELTA)
          emit({ type: 'chat-append', sessionId: sid(i), itemId: id, from: was.length, text: DELTA })
        }
        events++
      }
      if (f % STATE_EVERY === STATE_EVERY - 1) {
        // One agent's context usage moved (each in turn, the one on screen among them).
        setUsage((f / STATE_EVERY) % AGENTS | 0, 1000 + f)
        events++
      }
      const before = counts.chat.get(sid(0)) ?? 0
      await runFrame()
      const rendered = (counts.chat.get(sid(0)) ?? 0) - before
      chatRendersInFrames += rendered
      maxChatRendersInAFrame = Math.max(maxChatRendersInAFrame, rendered)
      // 50 ms pass: the reply's throttled text and the live timer move on their own.
      await act(async () => void vi.advanceTimersByTime(50))
    }
    const shownChatRenders = counts.chat.get(sid(0)) ?? 0
    const others = (map: Map<string, number>, key: (i: number) => string) => Array.from({ length: AGENTS - 1 }, (_, n) => map.get(key(n + 1)) ?? 0).reduce((a, b) => a + b, 0)
    const hiddenChatRenders = others(counts.chat, sid)
    const hiddenComposerRenders = others(counts.composer, sid)
    const hiddenReplyRenders = others(counts.markdown, (i) => `live:Live ${i}`)
    const shownReplyRenders = counts.markdown.get('live:Live 0') ?? 0
    const finishedMarkdown = [...historyRenders.entries()].filter(([text, n]) => text.startsWith('History') && counts.markdown.get(text) !== n)
    const finishedTools = [...historyTools.entries()].filter(([id, n]) => counts.tools.get(id) !== n)
    const seconds = (FRAMES * 50) / 1000

    console.info(
      `[perf] renderer, ${AGENTS} agents, ${FRAMES} frames (${seconds} s), ${events} events: chat on screen rendered ${shownChatRenders}x (max ${maxChatRendersInAFrame} in a frame), ` +
      `its streaming reply's Markdown ${shownReplyRenders}x, its composer ${counts.composer.get(sid(0)) ?? 0}x, live clocks ${counts.clock}x; ` +
      `hidden chats: ${hiddenChatRenders} chat, ${hiddenReplyRenders} reply, ${hiddenComposerRenders} composer renders; ` +
      `finished rows re-rendered: ${finishedMarkdown.length} of ${historyRenders.size} replies, ${finishedTools.length} of ${historyTools.size} tool calls`
    )

    // The stream reached the store, and the chat on screen shows it.
    expect(getState().chats[sid(5)].at(-1)).toMatchObject({ text: texts.get(`${sid(5)}:live:a3`) })
    expect(view.container.textContent).toContain('Live 0: streams a few more words')
    // Hidden workspaces' chats: nothing renders while they stream (not the chat, not its reply, not its composer).
    expect(hiddenChatRenders).toBe(0)
    expect(hiddenReplyRenders).toBe(0)
    expect(hiddenComposerRenders).toBe(0)
    // Only the chat on screen has a live clock ticking: it renders with its chat, and once a second of its own (the hidden
    // chats' eleven clocks ticking would add ~12 renders each). Its composer renders no more often than the chat.
    expect(counts.clock).toBeLessThanOrEqual(shownChatRenders + seconds + 2)
    expect(counts.composer.get(sid(0)) ?? 0).toBeLessThanOrEqual(shownChatRenders)
    // The chat on screen: at most one render a frame, however many events the frame carried.
    expect(maxChatRendersInAFrame).toBeLessThanOrEqual(1)
    expect(shownChatRenders).toBeLessThanOrEqual(FRAMES)
    // Its streaming reply's Markdown is throttled (STREAM_RENDER_MS, 300 ms), not drawn every frame: ~3 a second.
    expect(shownReplyRenders).toBeGreaterThan(0)
    expect(shownReplyRenders).toBeLessThanOrEqual(seconds * 4 + 8)
    // Finished turns' rows: never drawn again.
    expect(historyRenders.size).toBeGreaterThan(0)
    expect(finishedMarkdown).toEqual([])
    expect(finishedTools).toEqual([])
  })

  it('keeps the store subscriptions the same however long the chats are', async () => {
    const short = await mount(2)
    const few = counts.subscriptions
    short.view.unmount()
    expect(counts.subscriptions).toBe(0)
    const long = await mount(40)
    const many = counts.subscriptions
    console.info(`[perf] renderer store subscriptions: ${few} with 2 turns a chat, ${many} with 40 (${AGENTS} chats, one on screen)`)
    expect(long.view.container.textContent).toContain('History 0.39')
    expect(many).toBe(few)
    // A handful per chat on screen and per hidden chat, not one per row.
    expect(many).toBeLessThan(AGENTS * 10)
  })
})
