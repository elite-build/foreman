// @vitest-environment jsdom
// Phase A of the accessibility plan: the chat as turns a screen reader can walk. One h2 for the chat, an h3 per turn
// ("Turn 7, Claude, 14:02, finished, 4 tool calls"), an h4 per message, the agent's own Markdown headings below those; the
// jump keys that move focus to a heading; the chat-switch focus rule; and the throttled render of a streaming reply.
import '../domShims'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatClock } from '../../src/shared/i18n/time'
import { ChatView, resetChatFocusMemory } from '../../src/renderer/src/components/ChatView'
import { TilesView } from '../../src/renderer/src/components/tiles/TilesView'
import { announce } from '../../src/renderer/src/announce'
import { matchShortcut, SHORTCUTS, type ShortcutActions, type ShortcutContext } from '../../src/renderer/src/shortcuts'
import { fakeState, resetFake } from '../rendererStore'

vi.mock('../../src/renderer/src/store', async () => {
  const base = (await import('../rendererStore')).storeModule
  // The real command channel: a jump key is an event on the window, heard by the chat on screen.
  const own: Record<string, unknown> = {
    activeSessionId: (s: { activeSession?: Record<string, string> }, workspaceId: string) => s.activeSession?.[workspaceId],
    sendUiCommand: (command: string, workspaceId: string) => window.dispatchEvent(new CustomEvent('foreman:command', { detail: { command, workspaceId } })),
    onUiCommand: (handler: (command: string, workspaceId: string) => void) => {
      const listener = (e: Event) => handler((e as CustomEvent).detail.command, (e as CustomEvent).detail.workspaceId)
      window.addEventListener('foreman:command', listener)
      return () => window.removeEventListener('foreman:command', listener)
    }
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})
vi.mock('../../src/renderer/src/announce', () => ({ announce: vi.fn() }))
// The chat's neighbours are not what is under test.
vi.mock('../../src/renderer/src/components/composer/Composer', () => ({ Composer: () => <button type="button">composer</button>, AttachmentChip: () => null }))
vi.mock('../../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))

const at = '2026-10-24T14:02:00'
const clock = formatClock(at, 'en')
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], title: 'Login bug', createdAt: at, ...over }) as never
const workspace = { id: 'w1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1' } as never

const user = (n: number) => ({ kind: 'user', id: `u${n}`, turnId: `t${n}`, text: `Question ${n}`, at })
const reply = (n: number, text: string, streaming = false) => ({ kind: 'assistant', id: `a${n}`, turnId: `t${n}`, text, streaming })
const tool = (n: number, k: number) => ({ kind: 'tool', id: `x${n}-${k}`, turnId: `t${n}`, name: 'Bash', input: { command: `ls ${k}` }, status: 'done', output: 'ok' })
const end = (n: number, outcome = 'completed') => ({ kind: 'turn-end', id: `e${n}`, turnId: `t${n}`, outcome })

// Three turns: finished with two tool calls and headings of its own, failed with one, and one still running with none.
const LOG = [
  user(1), reply(1, '# Summary\n\nDone.\n\n## Details\n\nMore.\n\n### Deeper\n\nEven more.'), tool(1, 1), tool(1, 2), end(1),
  user(2), reply(2, 'It broke.'), tool(2, 1), end(2, 'error'),
  user(3), reply(3, 'Working on it', true)
]

const level = (h: Element) => Number(h.getAttribute('aria-level') ?? h.tagName.slice(1))
const outline = (root: HTMLElement) => [...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].map((h) => ({ level: level(h), text: h.textContent ?? '' }))
const command = (name: string, workspaceId = 'w1') => act(() => void window.dispatchEvent(new CustomEvent('foreman:command', { detail: { command: name, workspaceId } })))

function show(items: unknown[], { active = true, s = session('s1'), headingLevel }: { active?: boolean; s?: never; headingLevel?: 2 | 3 } = {}) {
  fakeState.chats = { ...fakeState.chats, [(s as { id: string }).id]: items }
  return <ChatView session={s} workspace={workspace} active={active} headingLevel={headingLevel} />
}

beforeEach(() => {
  resetFake()
  resetChatFocusMemory()
  vi.mocked(announce).mockClear()
  Object.assign(fakeState, { approvals: [], chats: {}, activeSession: { w1: 's1' }, selectedWorkspaceId: 'w1' })
  fakeState.snapshot.platform = 'linux'
  fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
  fakeState.snapshot.settings.forkToNewTab = false
  fakeState.snapshot.settings.notAbsolutelyRight = false
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the chat outline', () => {
  it('is one h2, an h3 per turn, an h4 per message, and the agent\'s headings below those', () => {
    render(show(LOG, { s: session('s1', { status: 'running' }) }))
    const log = screen.getByRole('region', { name: 'Chat: Login bug' })
    expect(outline(log).map((h) => `${h.level} ${h.text}`)).toEqual([
      '2 Chat: Login bug',
      `3 Turn 1, Claude Code, ${clock}, finished, 2 tool calls`,
      `4 You, ${clock}`,
      `4 Claude Code, reply to your ${clock} message`,
      '5 Summary',
      '6 Details',
      '6 Deeper',
      `3 Turn 2, Claude Code, ${clock}, failed, 1 tool call`,
      `4 You, ${clock}`,
      `4 Claude Code, reply to your ${clock} message`,
      // No outcome yet, and no tool calls: just who and when, plus that it is running.
      `3 Turn 3, Claude Code, ${clock}, running`,
      `4 You, ${clock}`,
      `4 Claude Code, reply to your ${clock} message`
    ])
  })

  it('never skips a level going down, and the agent\'s headings are never above h5', () => {
    render(show(LOG))
    const levels = outline(screen.getByRole('region', { name: 'Chat: Login bug' })).map((h) => h.level)
    levels.forEach((l, i) => expect(l, `heading ${i}`).toBeLessThanOrEqual((levels[i - 1] ?? 1) + 1))
    // The Markdown headings keep their own elements, so they look as they did; the level is what a reader hears.
    for (const h of screen.getAllByRole('heading', { name: /Summary|Details|Deeper/ })) expect(level(h)).toBeGreaterThanOrEqual(5)
    expect(screen.getByRole('heading', { name: 'Summary' }).tagName).toBe('H1')
  })

  it('shifts a reply that starts at ## so its top heading is still h5, with no skip from the message heading', () => {
    render(show([user(1), reply(1, '## What changed\n\nText.\n\n### Why\n\nMore.'), end(1)]))
    expect(level(screen.getByRole('heading', { name: 'What changed' }))).toBe(5)
    expect(level(screen.getByRole('heading', { name: 'Why' }))).toBe(6)
    const levels = outline(screen.getByRole('region', { name: 'Chat: Login bug' })).map((h) => h.level)
    levels.forEach((l, i) => expect(l, `heading ${i}`).toBeLessThanOrEqual((levels[i - 1] ?? 1) + 1))
  })

  it('has no region or section per turn: the chat keeps its one region, and a turn is an article', () => {
    render(show(LOG))
    const log = screen.getByRole('region', { name: 'Chat: Login bug' })
    expect(within(log).queryAllByRole('region')).toEqual([])
    expect(log.querySelectorAll('section')).toHaveLength(0)
    expect(log.querySelectorAll('article[data-turn]')).toHaveLength(3)
    // Each turn is named by its heading; its messages are articles inside it.
    const turn = within(log).getByRole('article', { name: new RegExp(`^Turn 1, `) })
    expect(within(turn).getAllByRole('article').map((a) => a.textContent?.slice(0, 8))).toEqual([`You, ${clock}`.slice(0, 8), `Claude C`])
  })

  it('numbers the user turns in the log; a message steered into a running turn stays in that turn', () => {
    const steered = { ...user(1), id: 'u1b', text: 'Also this', steered: true }
    render(show([user(1), reply(1, 'Hm'), steered, end(1), user(2), reply(2, 'Ok'), end(2)]))
    expect(outline(screen.getByRole('region')).filter((h) => h.level === 3).map((h) => h.text.split(',')[0])).toEqual(['Turn 1', 'Turn 2'])
  })

  it('leaves the line where the chat switched agents outside any turn', () => {
    const switched = { kind: 'notice', id: 'n1', turnId: 't2', level: 'info', text: '', switched: { to: 'codex', model: 'gpt', carried: 'history' } }
    render(show([user(1), reply(1, 'Ok'), end(1), switched, user(2), reply(2, 'Again'), end(2)]))
    const separator = screen.getByRole('separator')
    expect(separator.closest('[data-turn]')).toBeNull()
    expect(screen.getAllByRole('article', { name: /^Turn / })).toHaveLength(2)
  })

  it('inside a tile the chat is one level lower, so no level is skipped under the tile\'s h2', () => {
    render(show(LOG, { headingLevel: 3 }))
    const log = screen.getByRole('region', { name: 'Chat: Login bug' })
    const levels = outline(log).map((h) => h.level)
    expect(levels.slice(0, 4)).toEqual([3, 4, 5, 5])
    expect(Math.max(...levels)).toBe(6)
  })
})

describe('the jump keys', () => {
  const turnHeadings = () => screen.getAllByRole('heading', { name: /^Turn \d/ })

  it('latest reply focuses the latest turn\'s heading, and scrolls it into view', () => {
    const scroll = vi.spyOn(window.Element.prototype, 'scrollIntoView')
    render(show(LOG))
    command('chat-latest-reply')
    expect(document.activeElement).toBe(turnHeadings()[2])
    expect(document.activeElement?.tagName).toBe('H3')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1')
    // The turn, not the one-pixel heading, is scrolled to; a reduced-motion preference would make it 'auto'.
    expect(scroll).toHaveBeenCalled()
    expect((scroll.mock.contexts.at(-1) as Element).matches('article[data-turn]')).toBe(true)
    scroll.mockRestore()
  })

  it('previous turn goes one turn back from a heading, from inside a turn, and from the composer', () => {
    render(show(LOG))
    const headings = turnHeadings()
    headings[2].focus()
    command('chat-previous-turn')
    expect(document.activeElement).toBe(headings[1])
    // From a control inside turn 2 (a tool row), the turn before it.
    const inside = within(headings[1].closest('article')!).getAllByRole('button')[0]
    inside.focus()
    command('chat-previous-turn')
    expect(document.activeElement).toBe(headings[0])
    // From the composer, the latest turn is the one before "the end".
    screen.getByRole('button', { name: 'composer' }).focus()
    command('chat-previous-turn')
    expect(document.activeElement).toBe(headings[2])
  })

  it('previous turn on the first turn says so and leaves focus where it was', () => {
    render(show(LOG))
    const first = turnHeadings()[0]
    first.focus()
    command('chat-previous-turn')
    expect(document.activeElement).toBe(first)
    expect(announce).toHaveBeenCalledWith('This is the first turn', 'chat:jump')
  })

  it('says there are no turns in a chat without one', () => {
    render(show([]))
    command('chat-latest-reply')
    expect(announce).toHaveBeenCalledWith('No turns yet', 'chat:jump')
  })

  it('what needs me focuses the approval panel, or the plan, or says nothing needs you', () => {
    fakeState.approvals = [{ kind: 'tool', id: 'ap1', sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' } }]
    const { rerender } = render(show(LOG))
    // The panel took focus when it arrived; focus moves away (reading the log), and the key brings it back.
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    command('chat-needs-me')
    expect(document.activeElement?.classList.contains('approval-panel')).toBe(true)
    expect(document.activeElement?.getAttribute('role')).toBe('group')

    fakeState.approvals = [{ kind: 'plan', id: 'pl1', sessionId: 's1', plan: '# Steps\n\n1. one\n2. two' }]
    rerender(show(LOG))
    ;(document.activeElement as HTMLElement | null)?.blur()
    command('chat-needs-me')
    expect(document.activeElement?.getAttribute('role')).toBe('heading')
    expect(document.activeElement?.textContent?.trim()).toBe('Plan')
    // The plan card is a sibling of the turns: level 3. Its Markdown headings sit under it.
    expect(level(document.activeElement!)).toBe(3)
    expect(level(screen.getByRole('heading', { name: 'Steps' }))).toBe(4)

    command('chat-needs-none')
    expect(announce).toHaveBeenCalledWith('Nothing needs you', 'chat:jump')
  })

  it('goes only to the chat on screen, in the workspace it was sent to', () => {
    const { rerender } = render(show(LOG, { active: false }))
    command('chat-latest-reply')
    expect(document.activeElement).toBe(document.body)
    rerender(show(LOG))
    command('chat-latest-reply', 'w2')
    expect(document.activeElement).toBe(document.body)
  })
})

describe('the registry entries for the jump keys', () => {
  const entry = (id: string) => SHORTCUTS.find((e) => e.id === id)!
  const ctx = (over: Record<string, unknown> = {}) => {
    const actions = new Proxy({}, { get: (target: Record<string, unknown>, key: string) => (target[key] ??= vi.fn()) }) as unknown as ShortcutActions & Record<string, ReturnType<typeof vi.fn>>
    return { actions, ctx: { platform: 'win', ws: { id: 'w1' }, session: { id: 's1' }, state: { approvals: [], unreadSessions: {} }, snapshot: { sessions: [] }, actions, ...over } as unknown as ShortcutContext }
  }

  it('are on Ctrl+Alt+], Ctrl+Alt+[ and Ctrl+Alt+. (Cmd+Option on macOS), and nothing else', () => {
    for (const [id, code] of [['chat.latestReply', 'BracketRight'], ['chat.previousTurn', 'BracketLeft'], ['chat.needsMe', 'Period']] as const) {
      const e = { code, ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }
      expect(matchShortcut(e, 'win32')?.id).toBe(id)
      expect(matchShortcut({ ...e, ctrlKey: false, metaKey: true }, 'darwin')?.id).toBe(id)
      expect(entry(id).group).toBe('chat')
    }
    // Ctrl+Period (zen) is a different chord.
    expect(matchShortcut({ code: 'Period', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 'win32')?.id).toBe('zen.toggle')
  })

  it('latest reply and previous turn are commands for the open workspace, and only with a chat open', () => {
    const { actions, ctx: c } = ctx()
    entry('chat.latestReply').run!(c)
    entry('chat.previousTurn').run!(c)
    expect(actions.command).toHaveBeenNthCalledWith(1, 'chat-latest-reply', 'w1')
    expect(actions.command).toHaveBeenNthCalledWith(2, 'chat-previous-turn', 'w1')
    expect(entry('chat.latestReply').when!({ ...c, session: undefined })).toBe(false)
  })

  it('what needs me: this chat\'s panel first, else the next chat that needs attention, else says so', () => {
    vi.useFakeTimers()
    const here = ctx({ state: { approvals: [{ sessionId: 's1' }], unreadSessions: {} } })
    entry('chat.needsMe').run!(here.ctx)
    expect(here.actions.command).toHaveBeenCalledWith('chat-needs-me', 'w1')
    expect(here.actions.selectWorkspace).not.toHaveBeenCalled()

    const other = ctx({ state: { approvals: [{ sessionId: 's2' }], unreadSessions: {} }, snapshot: { sessions: [{ id: 's2', workspaceId: 'w2' }] } })
    entry('chat.needsMe').run!(other.ctx)
    expect(other.actions.selectWorkspace).toHaveBeenCalledWith('w2')
    expect(other.actions.selectSession).toHaveBeenCalledWith('w2', 's2')
    // Its panel takes focus once the chat has opened.
    expect(other.actions.command).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(other.actions.command).toHaveBeenCalledWith('chat-needs-me', 'w2')

    const none = ctx()
    entry('chat.needsMe').run!(none.ctx)
    expect(none.actions.command).toHaveBeenCalledWith('chat-needs-none', 'w1')
  })
})

describe('switching chats', () => {
  const second = session('s2', { title: 'Docs' })
  // Both chats stay mounted, as in the workspace view; the one not shown is hidden.
  const both = (shown: 's1' | 's2') => (
    <>
      <button type="button">sidebar entry</button>
      <div hidden={shown !== 's1'}>{show(LOG, { active: shown === 's1' })}</div>
      <div hidden={shown !== 's2'}>{show(LOG, { active: shown === 's2', s: second })}</div>
    </>
  )

  it('announces the chat and focuses its heading when focus was in the old chat\'s log', () => {
    const { rerender } = render(both('s1'))
    // The first chat shown is not a switch.
    expect(announce).not.toHaveBeenCalled()
    screen.getAllByRole('heading', { name: /^Turn 1/, hidden: true })[0].focus()
    rerender(both('s2'))
    expect(announce).toHaveBeenCalledWith('Switched to Docs in acme', 'chat:switch')
    expect(document.activeElement?.textContent).toBe('Chat: Docs')
    expect(document.activeElement?.tagName).toBe('H2')
  })

  it('announces but leaves focus alone when it was in the composer or the sidebar', () => {
    const { rerender } = render(both('s1'))
    const sidebar = screen.getByRole('button', { name: 'sidebar entry' })
    sidebar.focus()
    rerender(both('s2'))
    expect(announce).toHaveBeenCalledWith('Switched to Docs in acme', 'chat:switch')
    expect(document.activeElement).toBe(sidebar)

    screen.getAllByRole('button', { name: 'composer', hidden: true })[0].focus()
    rerender(both('s1'))
    expect(announce).toHaveBeenLastCalledWith('Switched to Login bug in acme', 'chat:switch')
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'composer', hidden: true })[0])
  })

  it('says nothing when the same chat comes back into view (Settings closed, say)', () => {
    const { rerender } = render(both('s1'))
    rerender(<div>{show(LOG, { active: false })}</div>)
    rerender(both('s1'))
    expect(announce).not.toHaveBeenCalled()
  })
})

describe('a streaming reply', () => {
  const text = () => screen.getByRole('article', { name: /reply to your/ }).textContent ?? ''

  it('renders its Markdown about every 300 ms, and the final text at once', () => {
    vi.useFakeTimers()
    const turn = (body: string, streaming: boolean) => show([user(1), reply(1, body, streaming)])
    const { rerender } = render(turn('Fix', true))
    expect(text()).toContain('Fix')
    // Flushes every 50 ms: nothing on screen changes until 300 ms after the last render.
    let body = 'Fix'
    for (const more of [' the', ' login', ' bug', ' by', ' trimming']) {
      act(() => void vi.advanceTimersByTime(50))
      body += more
      rerender(turn(body, true))
      expect(text()).not.toContain('login')
    }
    expect(screen.getByRole('article', { name: /reply to your/ }).getAttribute('aria-busy')).toBe('true')
    act(() => void vi.advanceTimersByTime(60))
    // The last text flushed by then, not each step in between.
    expect(text()).toContain('Fix the login bug by trimming')
    // The next flush waits for the next window ...
    body += ' the token'
    rerender(turn(body, true))
    expect(text()).not.toContain('the token')
    // ... but the end of the stream is not delayed.
    rerender(turn(`${body}.`, false))
    expect(text()).toContain('Fix the login bug by trimming the token.')
    expect(screen.getByRole('article', { name: /reply to your/ }).getAttribute('aria-busy')).toBeNull()
  })

  it('renders at most once per window however many flushes arrive', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(text()))
    const turn = (body: string) => show([user(1), reply(1, body, true)])
    const { rerender } = render(turn('a'))
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    for (let i = 1; i <= 12; i++) {
      act(() => void vi.advanceTimersByTime(50))
      rerender(turn(`a${'b'.repeat(i)}`))
    }
    act(() => void vi.advanceTimersByTime(300))
    // 650 ms of flushes: a handful of renders, not twelve.
    expect(new Set(seen).size).toBeLessThanOrEqual(4)
    observer.disconnect()
  })
})

describe('tiles', () => {
  const repo = { id: 'r1', name: 'kite', rootPath: '/code/kite', defaultBranch: 'main' }
  const ws = (name: string) => ({ id: 'w1', repoId: 'r1', name, branch: `yatin/${name}`, state: 'ready', createdAt: at, path: '/code/kite/w1', ...({} as object) })

  it('keeps the outline whole under a tile: the tile is h2, its chat h3, a turn h4, a message h5, the agent\'s headings h6', () => {
    Object.assign(fakeState, { leftPanelOpen: true, tiles: [], tileCount: 4, unread: {}, unreadSessions: {}, sidebarView: { repo: null, query: '', filter: 'all', showFinished: false } })
    Object.assign(fakeState.snapshot, { repos: [repo], workspaces: [ws('curie')], sessions: [session('s1')], repoSettings: {}, attentionHistory: { events: [] }, schedules: [], occurrences: [] })
    fakeState.snapshot.settings = { ...fakeState.snapshot.settings, sidebarSide: 'left', windowLayout: 'tiles' }
    fakeState.chats = { s1: LOG.slice(0, 5) }
    render(<TilesView hidden={false} />)
    const levels = outline(screen.getByRole('region', { name: 'curie' })).map((h) => h.level)
    expect(levels[0]).toBe(2)
    expect(levels.slice(0, 5)).toEqual([2, 3, 4, 5, 5])
    levels.forEach((l, i) => expect(l, `heading ${i}`).toBeLessThanOrEqual((levels[i - 1] ?? 1) + 1))
    expect(Math.max(...levels)).toBe(6)
  })
})
