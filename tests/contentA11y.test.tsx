// @vitest-environment jsdom
// Phase 4, content accessibility: the chat as a named region of headed articles, announcements of what the agents are
// doing (debounced, and only for the chat on screen unless it needs you), the toast's live regions, and the terminal's
// screen reader setting reaching a terminal that is already open.
import './domShims'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/shared/i18n/en'
import { formatClock } from '../src/shared/i18n/time'
import { announcer, createAnnouncer } from '../src/renderer/src/announce'
import { sessionStatuses, spokenSnippet, statusEvents, type StatusMap } from '../src/renderer/src/agentStatus'
import { Announcer, ToastHost } from '../src/renderer/src/components/Announcer'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { TerminalView } from '../src/renderer/src/components/TerminalView'
import { AccessibilityPage } from '../src/renderer/src/components/settings/AccessibilityPage'
import { screenReaderMode, terminalOptions } from '../src/renderer/src/theme'
import { SETTINGS } from '../src/shared/settingsRegistry'
import { fakeApi, fakeState, resetFake } from './rendererStore'

// ---- the stand-ins: the store, and xterm (which needs a real canvas) ----

type FakeTerminal = { options: Record<string, unknown>; disposed: boolean }
const terminals: FakeTerminal[] = []

vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule
  const bridge = { pathForFile: () => '', send: { ptyKill: vi.fn(), ptyWrite: vi.fn(), ptyResize: vi.fn() } }
  const own: Record<string, unknown> = {
    bridge,
    listenPty: () => () => undefined,
    // The real one: the tab the workspace remembers.
    activeSessionId: (s: { activeSession?: Record<string, string> }, workspaceId: string) => s.activeSession?.[workspaceId],
    dismissToast: vi.fn(),
    runToastAction: vi.fn()
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    cols = 80
    rows = 24
    disposed = false
    parser = { registerOscHandler: () => ({ dispose: () => undefined }) }
    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      terminals.push(this as unknown as FakeTerminal)
    }
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    hasSelection() {
      return false
    }
    attachCustomKeyEventHandler() {}
    onSelectionChange() {
      return { dispose: () => undefined }
    }
    onData() {
      return { dispose: () => undefined }
    }
    onResize() {
      return { dispose: () => undefined }
    }
    dispose() {
      this.disposed = true
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class { serialize() { return '' } } }))
vi.mock('../src/renderer/src/components/TerminalFind', () => ({ TerminalFind: () => null }))
vi.mock('../src/renderer/src/components/TerminalMenu', () => ({ TerminalMenu: () => null }))
vi.mock('../src/renderer/src/components/cloud/CloudBits', () => ({ CloudTerminalBand: () => null }))
// The chat's neighbours are not what is under test.
vi.mock('../src/renderer/src/components/composer/Composer', () => ({ Composer: () => <div data-testid="composer" />, AttachmentChip: () => null }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))
vi.mock('../src/renderer/src/components/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }))

beforeEach(() => {
  resetFake()
  announcer.reset()
  terminals.length = 0
  fakeApi.ptySpawn = vi.fn(async () => 'pty-1')
  fakeState.toast = null
  fakeState.approvals = []
  fakeState.settingsPage = null
  fakeState.automations = null
  fakeState.assistantOpen = false
  fakeState.selectedWorkspaceId = 'w1'
  fakeState.activeSession = { w1: 's1' }
  fakeState.snapshot.platform = 'linux'
  fakeState.snapshot.screenReader = false
  fakeState.snapshot.settings.terminalScreenReader = 'off'
  fakeState.snapshot.settings.notAbsolutelyRight = false
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ---- the announcer ----

describe('the announcer', () => {
  it('speaks what was queued within the window together, a sentence each', () => {
    vi.useFakeTimers()
    const a = createAnnouncer({ delayMs: 500 })
    a.announce('Claude finished')
    a.announce('Codex needs you.')
    expect(a.current().text).toBe('')
    vi.advanceTimersByTime(500)
    expect(a.current().text).toBe('Claude finished. Codex needs you.')
  })

  it('lets a later message with the same key replace an earlier one, so a fast turn says only that it finished', () => {
    vi.useFakeTimers()
    const a = createAnnouncer({ delayMs: 500 })
    a.announce('Claude started working', 'status:s1')
    a.announce('Claude finished', 'status:s1')
    vi.advanceTimersByTime(500)
    expect(a.current().text).toBe('Claude finished.')
  })

  it('has a new nonce for every announcement, so the same words are spoken again, and empties after the hold', () => {
    vi.useFakeTimers()
    const a = createAnnouncer({ delayMs: 100, holdMs: 1000 })
    a.announce('Done')
    vi.advanceTimersByTime(100)
    const first = a.current()
    a.announce('Done')
    vi.advanceTimersByTime(100)
    expect(a.current().text).toBe(first.text)
    expect(a.current().nonce).toBeGreaterThan(first.nonce)
    vi.advanceTimersByTime(1000)
    expect(a.current().text).toBe('')
  })
})

// ---- what changed ----

const session = (id: string, over: Record<string, unknown> = {}) => ({ id, workspaceId: 'w1', agent: 'claude', status: 'idle', queue: [], ...over }) as never
const approval = (sessionId: string, kind: 'tool' | 'question' | 'plan' = 'tool') => ({ id: `a-${sessionId}`, sessionId, kind }) as never
const statuses = (sessions: never[], approvals: never[] = []): StatusMap => sessionStatuses(sessions, approvals)

describe('agent status events', () => {
  const open = (id: string) => id === 's1'

  it('says nothing for the first look', () => {
    expect(statusEvents(null, statuses([session('s1', { status: 'running' })]), [], open)).toEqual([])
  })

  it('says started and finished for the open chat only', () => {
    const idle = [session('s1'), session('s2')]
    const running = [session('s1', { status: 'running' }), session('s2', { status: 'running' })]
    expect(statusEvents(statuses(idle), statuses(running), running, open)).toEqual([{ sessionId: 's1', kind: 'started' }])
    const done = [session('s1', { lastTurn: { outcome: 'completed' } }), session('s2', { lastTurn: { outcome: 'completed' } })]
    expect(statusEvents(statuses(running), statuses(done), done, open)).toEqual([{ sessionId: 's1', kind: 'finished' }])
  })

  it('tells failed and stopped from finished by how the turn ended', () => {
    const running = statuses([session('s1', { status: 'running' })])
    const ended = (outcome: string) => [session('s1', { lastTurn: { outcome } })]
    for (const [outcome, kind] of [['error', 'failed'], ['interrupted', 'failed'], ['cancelled', 'stopped'], ['completed', 'finished']] as const) {
      expect(statusEvents(running, statuses(ended(outcome)), ended(outcome), open)).toEqual([{ sessionId: 's1', kind }])
    }
  })

  it('says a chat needs you wherever it is, and again only when what it needs changes', () => {
    const idle = statuses([session('s1'), session('s2')])
    const asked = statuses([session('s1'), session('s2')], [approval('s2', 'question')])
    expect(statusEvents(idle, asked, [], open)).toEqual([{ sessionId: 's2', kind: 'needs-question' }])
    expect(statusEvents(asked, asked, [], open)).toEqual([])
    const plan = statuses([session('s1'), session('s2')], [approval('s2', 'plan')])
    expect(statusEvents(asked, plan, [], open)).toEqual([{ sessionId: 's2', kind: 'needs-plan' }])
  })

  it('leaves closed tabs out', () => {
    expect(statuses([session('s1', { closedAt: '2026-10-24T10:00:00Z' })], [approval('s1')]).size).toBe(0)
  })
})

describe('spokenSnippet', () => {
  it('drops code blocks and Markdown marks, keeps link text, and cuts at a word', () => {
    expect(spokenSnippet('## Result\n\nI **fixed** the [login page](http://x.test):\n\n```ts\nconst a = 1\n```\n\n- done')).toBe('Result I fixed the login page: done')
    const long = spokenSnippet('word '.repeat(200), 40)
    expect(long.length).toBeLessThanOrEqual(41)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toMatch(/wor…$/)
  })
})

// ---- the Announcer component ----

describe('the status announcements for the open chat', () => {
  const setSessions = (sessions: never[]) => {
    fakeState.snapshot.sessions = sessions
  }
  const live = () => screen.getByRole('status').textContent
  const settle = () => act(() => void vi.advanceTimersByTime(800))

  beforeEach(() => {
    vi.useFakeTimers()
    fakeState.snapshot.workspaces = [{ id: 'w1', name: 'acme' }]
    setSessions([session('s1'), session('s2', { title: 'Other chat' })])
  })

  it('is one polite status region, named by nothing and empty at first', () => {
    render(<Announcer />)
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('')
  })

  it('announces started, then finished, for the open chat', () => {
    const { rerender } = render(<Announcer />)
    setSessions([session('s1', { status: 'running' }), session('s2', { title: 'Other chat' })])
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('Claude Code started working.')
    setSessions([session('s1', { lastTurn: { outcome: 'completed' } }), session('s2', { title: 'Other chat' })])
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('Claude Code finished.')
  })

  it('says only that a fast turn finished, and that a failed one failed', () => {
    const { rerender } = render(<Announcer />)
    setSessions([session('s1', { status: 'running' }), session('s2')])
    rerender(<Announcer />)
    setSessions([session('s1', { lastTurn: { outcome: 'error' } }), session('s2')])
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('Claude Code failed.')
  })

  it('says nothing about a chat that is not open, until it needs you', () => {
    const { rerender } = render(<Announcer />)
    setSessions([session('s1'), session('s2', { title: 'Other chat', status: 'running' })])
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('')
    setSessions([session('s1'), session('s2', { title: 'Other chat', lastTurn: { outcome: 'completed' } })])
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('')
    fakeState.approvals = [approval('s2', 'tool')]
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('acme, Other chat needs your approval.')
  })

  it('says nothing about the open chat while Settings covers it', () => {
    const { rerender } = render(<Announcer />)
    fakeState.settingsPage = { section: 'general' }
    setSessions([session('s1', { status: 'running' }), session('s2')])
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('')
  })

  it('announces a question for the open chat too', () => {
    const { rerender } = render(<Announcer />)
    fakeState.approvals = [approval('s1', 'question')]
    rerender(<Announcer />)
    settle()
    expect(live()).toBe('Claude Code has a question for you.')
  })
})

// ---- the chat log ----

describe('the chat as a log a screen reader can follow', () => {
  const at = '2026-10-24T14:02:00'
  const user = { kind: 'user', id: 'u1', turnId: 't1', text: 'Fix the login bug', at }
  const reply = (text: string, streaming = false) => ({ kind: 'assistant', id: 'a1', turnId: 't1', text, streaming })
  const workspace = { id: 'w1', name: 'acme', branch: 'fix', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1' } as never
  const chat = (over: Record<string, unknown> = {}) => session('s1', { title: 'Login bug', ...over })
  const show = (items: unknown[], active = true, s = chat()) => {
    fakeState.chats = { s1: items }
    return <ChatView session={s} workspace={workspace} active={active} />
  }
  const time = formatClock(at, 'en')

  beforeEach(() => {
    fakeState.snapshot.workspaces = [{ id: 'w1', repoId: 'r1' }]
    fakeState.snapshot.settings.forkToNewTab = false
    fakeState.chats = {}
  })

  it('is a region named for the chat, with an article per message that says who wrote it and when', () => {
    render(show([user, reply('Fixed it.')]))
    const region = screen.getByRole('region', { name: 'Chat: Login bug' })
    expect(region.getAttribute('aria-live')).toBeNull()
    expect(region.getAttribute('role')).not.toBe('log')
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('Chat: Login bug')
    expect(within(region).getByRole('article', { name: `You, ${time}` }).textContent).toContain('Fix the login bug')
    expect(within(region).getByRole('article', { name: `Claude Code, reply to your ${time} message` }).textContent).toContain('Fixed it.')
    expect(within(region).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([`You, ${time}`, `Claude Code, reply to your ${time} message`])
  })

  it('names a reply by the agent that answered it when the chat switched agents', () => {
    const switched = { kind: 'notice', id: 'n1', turnId: 't2', level: 'info', text: '', switched: { to: 'codex', model: 'gpt', carried: 'history' } }
    const later = { kind: 'user', id: 'u2', turnId: 't2', text: 'Again', at, agent: 'codex' }
    render(show([user, reply('Fixed it.'), switched, later, { kind: 'assistant', id: 'a2', turnId: 't2', text: 'Done too.' }]))
    expect(screen.getAllByRole('article').filter((a) => !a.hasAttribute('data-turn')).map((a) => a.getAttribute('aria-labelledby') && document.getElementById(a.getAttribute('aria-labelledby')!)?.textContent)).toEqual([
      `You, ${time}`,
      `Claude Code, reply to your ${time} message`,
      `You, ${time}`,
      `Codex, reply to your ${time} message`
    ])
  })

  it('does not announce an answer while it streams, and announces it once when it is finished', () => {
    vi.useFakeTimers()
    const { rerender } = render(show([user, reply('Fix', true)]))
    const live = () => announcer.current().text
    const settle = () => act(() => void vi.advanceTimersByTime(800))
    expect(screen.getByRole('article', { name: /reply to your/ }).getAttribute('aria-busy')).toBe('true')
    for (const text of ['Fixed the', 'Fixed the login', 'Fixed the login bug by']) {
      rerender(show([user, reply(text, true)]))
      settle()
      expect(live()).toBe('')
    }
    rerender(show([user, reply('Fixed the login bug by trimming the **token**.', false)]))
    settle()
    expect(live()).toBe('Claude Code: Fixed the login bug by trimming the token.')
    expect(screen.getByRole('article', { name: /reply to your/ }).getAttribute('aria-busy')).toBeNull()
    // Rendering again, with nothing new, says nothing more.
    announcer.reset()
    rerender(show([user, reply('Fixed the login bug by trimming the **token**.', false)]))
    settle()
    expect(live()).toBe('')
  })

  it('says nothing for an answer that finishes in a chat that is not on screen, or that was already finished', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(show([user, reply('Working', true)], false))
    rerender(show([user, reply('Working. Done.', false)], false))
    act(() => void vi.advanceTimersByTime(800))
    expect(announcer.current().text).toBe('')
    unmount()
    render(show([user, reply('An old answer.')]))
    act(() => void vi.advanceTimersByTime(800))
    expect(announcer.current().text).toBe('')
  })

  it('leaves the visible, searchable text of the chat as it was: the headings are for assistive technology only', () => {
    render(show([user, reply('Fixed it.')]))
    for (const heading of screen.getAllByRole('heading')) {
      expect(heading.className).toContain('sr-only')
      expect(heading.hasAttribute('data-search-ignore')).toBe(true)
    }
  })
})

// ---- the toast ----

describe('the toast hosts', () => {
  it('are a status and an alert that are always in the page, empty until a toast is shown', () => {
    const { rerender } = render(<ToastHost />)
    const status = screen.getByRole('status')
    const alert = screen.getByRole('alert')
    expect(status.textContent).toBe('')
    expect(alert.textContent).toBe('')
    fakeState.toast = { id: 1, text: 'Copied', kind: 'info' }
    rerender(<ToastHost />)
    // The same two elements: they were not inserted along with the text.
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('Copied')
    expect(alert.textContent).toBe('')
    fakeState.toast = { id: 2, text: 'Could not save', kind: 'error' }
    rerender(<ToastHost />)
    expect(screen.getByRole('alert')).toBe(alert)
    expect(alert.textContent).toBe('Could not save')
    expect(status.textContent).toBe('')
  })

  it('keep a toast button reachable', async () => {
    fakeState.toast = { id: 3, text: 'Deleted', kind: 'info', actions: [{ label: 'Undo' }] }
    render(<ToastHost />)
    expect(within(screen.getByRole('status')).getByRole('button', { name: 'Undo' })).toBeTruthy()
  })
})

// ---- the terminal's screen reader setting ----

describe('terminal screen reader support', () => {
  it('Automatic follows the OS; On and Off decide', () => {
    expect(screenReaderMode('auto', true)).toBe(true)
    expect(screenReaderMode('auto', false)).toBe(false)
    expect(screenReaderMode(undefined, undefined)).toBe(false)
    expect(screenReaderMode('on', false)).toBe(true)
    expect(screenReaderMode('off', true)).toBe(false)
    expect(terminalOptions({ terminalFont: '', terminalFontSize: 12, terminalScrollbackMb: 10, terminalScreenReader: 'on' }).screenReaderMode).toBe(true)
  })

  it('is a registered, searchable setting', () => {
    const entry = SETTINGS.find((s) => s.id === 'terminal-screen-reader')
    expect(entry?.page).toEqual({ section: 'accessibility' })
    expect(entry?.keywords).toContain('screen reader')
  })

  const shell = () => <TerminalView workspaceId="w1" kind="shell" visible />

  it('is given to a new terminal', () => {
    fakeState.snapshot.settings.terminalScreenReader = 'on'
    render(shell())
    expect(terminals).toHaveLength(1)
    expect(terminals[0].options.screenReaderMode).toBe(true)
  })

  it('reaches a terminal that is already open, without making a new one', () => {
    const { rerender } = render(shell())
    expect(terminals[0].options.screenReaderMode).toBe(false)
    fakeState.snapshot.settings.terminalScreenReader = 'on'
    rerender(shell())
    expect(terminals).toHaveLength(1)
    expect(terminals[0].disposed).toBe(false)
    expect(terminals[0].options.screenReaderMode).toBe(true)
    fakeState.snapshot.settings.terminalScreenReader = 'off'
    rerender(shell())
    expect(terminals[0].options.screenReaderMode).toBe(false)
  })

  it('in Automatic, follows the OS reporting a screen reader while the terminal is open', () => {
    fakeState.snapshot.settings.terminalScreenReader = 'auto'
    const { rerender } = render(shell())
    expect(terminals[0].options.screenReaderMode).toBe(false)
    fakeState.snapshot.screenReader = true
    rerender(shell())
    expect(terminals[0].options.screenReaderMode).toBe(true)
    fakeState.snapshot.screenReader = false
    rerender(shell())
    expect(terminals[0].options.screenReaderMode).toBe(false)
  })

  it('has a row on the Accessibility page that saves the choice', async () => {
    fakeState.snapshot.settings = { ...fakeState.snapshot.settings, terminalScreenReader: 'auto', terminalFontSize: 12, contentFontSize: 13, reduceMotion: 'auto' }
    fakeApi.updateSettings = vi.fn(async () => ({}))
    render(<AccessibilityPage />)
    const select = screen.getByRole('combobox', { name: 'Screen reader support' })
    expect((select as HTMLSelectElement).value).toBe('auto')
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Automatic', 'On', 'Off'])
    await userEvent.selectOptions(select, 'on')
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ terminalScreenReader: 'on' })
  })
})
