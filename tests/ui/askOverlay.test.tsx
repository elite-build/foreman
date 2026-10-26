// @vitest-environment jsdom
// Phase F3 of the accessibility plan: the Ask Foreman overlay. It runs on the real renderer store, with only the
// bridge to the main process stubbed, so the store's own `sendToAsk`, the `assistant-item` events and the overlay slot
// are what is under test. What a screen reader is told goes through `announce`, which is mocked to record it.
import '../domShims'

// The bridge to the main process, in place before the store module reads `window.foreman`.
const bridge = vi.hoisted(() => {
  const invoke: Record<string, ReturnType<typeof vi.fn>> = {}
  const events: { handler?: (event: unknown) => void } = {}
  const nothing = new Proxy({}, { get: () => () => undefined })
  ;(window as unknown as { foreman: unknown }).foreman = {
    invoke: new Proxy(invoke, { get: (target, name: string) => (target[name] ??= vi.fn(async () => undefined)) }),
    onEvent: (handler: (event: unknown) => void) => {
      events.handler = handler
      return () => undefined
    },
    send: nothing,
    browser: nothing
  }
  return { invoke, events }
})

import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskOverlay } from '../../src/renderer/src/components/assistant/AskOverlay'
import { Overlays } from '../../src/renderer/src/components/Overlays'
import { announce } from '../../src/renderer/src/announce'
import { matchShortcut, shortcutHint, SHORTCUTS, type ShortcutContext } from '../../src/renderer/src/shortcuts'
import { closeAsk, deleteAssistantThread, getState, initStore, loadAssistant, openOverlay, useStore } from '../../src/renderer/src/store'

vi.mock('../../src/renderer/src/announce', () => ({ announce: vi.fn() }))

const done = new Date(Date.now() - 20 * 60_000).toISOString()
const workspace = (over: Record<string, unknown> = {}) => ({ id: 'w1', repoId: 'r1', name: 'api-fix', branch: 'api-fix', baseBranch: 'main', path: '/work/api-fix', state: 'ready', ...over })
const session = (over: Record<string, unknown> = {}) => ({ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm', status: 'idle', queue: [], createdAt: done, ...over })
const lastTurn = { outcome: 'completed', endedAt: done, additions: 3, deletions: 1 }

function snapshot(over: Record<string, unknown> = {}) {
  return {
    platform: 'win32',
    settings: { language: undefined, assistantEnabled: true, announce: 'my-chat', agentPrefs: {}, loadouts: [] },
    repos: [],
    repoSettings: {},
    workspaces: [workspace()],
    sessions: [session({ lastTurn })],
    catalog: { agents: {} },
    agentKeys: {},
    ...over
  }
}

const ready = { state: 'ready', agent: 'claude', model: 'm' }
const thread = (running: boolean) => ({ id: 'ask-1', title: 'ask', updatedAt: done, agent: 'claude', model: 'm', running })
const emit = (event: unknown) => act(() => void bridge.events.handler?.(event))
const item = (threadId: string, it: Record<string, unknown>) => emit({ type: 'assistant-item', threadId, item: it })
const running = (on: boolean) => emit({ type: 'assistant-threads', threads: [thread(on)] })
const assistantItem = (id: string, text: string, streaming = false) => ({ kind: 'assistant', id, turnId: 't1', text, streaming })
const userItem = { kind: 'user', id: 'u1', turnId: 't1', text: 'what did Codex do in docs', at: done }
const turnEnd = (id = 'e1', outcome = 'completed') => ({ kind: 'turn-end', id, turnId: 't1', outcome })
const COMMAND = 'foreman approve 3f9a1c2e-0000-4000-8000-000000000000'
const proposal = (state = 'pending', over: Record<string, unknown> = {}) => ({
  kind: 'tool',
  id: 'foreman-run:r1',
  turnId: 't1',
  name: 'foreman',
  status: 'running',
  input: { runId: 'r1', command: COMMAND, summary: 'approve the Bash call in api-fix', state, ...over }
})
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)

function Page() {
  const open = useStore((s) => s.overlay === 'ask')
  return (
    <>
      <button type="button">opener</button>
      {open && <AskOverlay />}
    </>
  )
}

/** The page with its opener focused, then the overlay opened the way the shortcut and the palette do it. */
async function open() {
  const view = render(<Page />)
  const opener = screen.getByRole('button', { name: 'opener' })
  opener.focus()
  act(() => openOverlay('ask'))
  const dialog = await screen.findByRole('dialog', { name: 'Ask Foreman' })
  return { ...view, opener, dialog }
}

async function seed(over: { snapshot?: Record<string, unknown>; gate?: Record<string, unknown>; chat?: unknown[]; approvals?: unknown[] } = {}) {
  bridge.invoke.getSnapshot = vi.fn(async () => snapshot(over.snapshot))
  bridge.invoke.pendingApprovals = vi.fn(async () => over.approvals ?? [])
  bridge.invoke.assistantState = vi.fn(async () => ({ gate: over.gate ?? ready, threads: [thread(false)] }))
  bridge.invoke.assistantSend = vi.fn(async () => ({ threadId: 'ask-1' }))
  bridge.invoke.assistantConfirmRun = vi.fn(async () => undefined)
  bridge.invoke.assistantCancelRun = vi.fn(async () => undefined)
  await initStore()
  await loadAssistant()
  if (over.chat) await emit({ type: 'chat-reset', sessionId: 's1', items: over.chat })
}

const spoken = () => vi.mocked(announce).mock.calls
const spokenFor = (key: string) => spoken().filter((call) => call[1] === key)
/** What aria-describedby points at, as a reader says it. */
const described = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
const field = () => screen.getByRole('textbox', { name: 'Ask a question' }) as HTMLInputElement

beforeEach(async () => {
  // The store outlives a test: forget the Ask thread, as deleting it from the assistant view does.
  bridge.invoke.assistantDeleteThread = vi.fn(async () => undefined)
  await deleteAssistantThread('ask-1')
  for (const key of Object.keys(bridge.invoke)) delete bridge.invoke[key]
  vi.mocked(announce).mockClear()
})
afterEach(() => {
  cleanup()
  closeAsk()
})

describe('opening', () => {
  it('is Ctrl+Alt+Space (Cmd+Option+K on macOS, since Cmd+Option+Space is Finder search), only with the assistant on, and the palette hints it', () => {
    const entry = SHORTCUTS.find((e) => e.id === 'assistant.ask')!
    expect(entry.keys).toEqual({ mac: 'mod+alt+KeyK', win: 'ctrl+alt+Space' })
    expect(matchShortcut({ code: 'Space', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }, 'win32')?.id).toBe('assistant.ask')
    expect(matchShortcut({ code: 'KeyK', ctrlKey: false, metaKey: true, altKey: true, shiftKey: false }, 'darwin')?.id).toBe('assistant.ask')
    const ctx = (assistantEnabled: boolean) => ({ snapshot: { settings: { assistantEnabled } } }) as unknown as ShortcutContext
    expect(entry.when!(ctx(true))).toBe(true)
    expect(entry.when!(ctx(false))).toBe(false)
    expect(shortcutHint('assistant.ask', 'win32')).toBe('Ctrl+Alt+Space')
    expect(shortcutHint('assistant.ask', 'darwin')).toBe('⌘⌥K')
  })

  it('opens from the shortcut, labelled Ask Foreman, with focus in the field; the chord again closes it', async () => {
    await seed()
    const entry = SHORTCUTS.find((e) => e.id === 'assistant.ask')!
    const run = () => act(() => entry.run!({ state: getState(), snapshot: getState().snapshot, actions: { openOverlay } } as unknown as ShortcutContext))
    render(<Page />)
    run()
    const dialog = await screen.findByRole('dialog', { name: 'Ask Foreman' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.contains(document.activeElement)).toBe(true)
    // As the scenario reads it: "Ask Foreman, dialog. Edit. Quick actions: ..."
    expect(document.activeElement).toBe(field())
    expect(within(dialog).getByRole('group', { name: 'Quick actions' })).toBeTruthy()
    run()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens from the command palette', async () => {
    await seed()
    const user = userEvent.setup()
    render(<Overlays />)
    act(() => openOverlay('palette'))
    await user.keyboard('Ask Foreman')
    await user.click(await screen.findByRole('option', { name: /Ask Foreman/ }))
    expect(await screen.findByRole('dialog', { name: 'Ask Foreman' })).toBeTruthy()
    expect(getState().overlay).toBe('ask')
  })

  it('Escape closes it and focus goes back to where it was', async () => {
    await seed()
    const user = userEvent.setup()
    const { opener } = await open()
    expect(document.activeElement).not.toBe(opener)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('marks its root with data-ask-overlay, and an Escape something else already handled leaves it open', async () => {
    await seed()
    const user = userEvent.setup()
    const { dialog } = await open()
    expect(dialog.hasAttribute('data-ask-overlay')).toBe(true)
    // Speech's capture-phase listener stops a playing utterance and prevents the default: that Escape is not ours.
    const stopSpeech = (e: KeyboardEvent) => e.key === 'Escape' && e.preventDefault()
    window.addEventListener('keydown', stopSpeech, true)
    await user.keyboard('{Escape}')
    window.removeEventListener('keydown', stopSpeech, true)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Tab stays inside the dialog', async () => {
    await seed()
    const user = userEvent.setup()
    const { dialog } = await open()
    for (let i = 0; i < 8; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })
})

describe('quick actions (no model turn)', () => {
  it('What needs me says the narrator\'s lead and each waiting request', async () => {
    const approval = { id: 'a1', kind: 'tool', sessionId: 's1', toolName: 'Bash', input: { command: 'npm test' } }
    await seed({ approvals: [approval] })
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'What needs me' }))
    const answer = screen.getByRole('article', { name: 'Answer' })
    expect(within(answer).getByText('1 thing needs you')).toBeTruthy()
    const line = within(answer).getByRole('listitem').textContent!
    expect(line).toContain('api-fix')
    expect(line).toContain('npm test')
    expect(spoken()).toEqual([[`1 thing needs you. ${sentence(line)}`, 'ask:answer']])
    expect(bridge.invoke.assistantSend).not.toHaveBeenCalled()
  })

  it('What needs me with nothing waiting says so', async () => {
    await seed()
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'What needs me' }))
    expect(spoken()).toEqual([['Nothing needs you.', 'ask:answer']])
    expect(screen.getByRole('article', { name: 'Answer' }).textContent).toContain('Nothing needs you')
    expect(bridge.invoke.assistantSend).not.toHaveBeenCalled()
  })

  it('What happened here is the workspace line and the chat\'s last turn sentence', async () => {
    await seed()
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'What happened here' }))
    const [summary, turn] = [...screen.getByRole('article', { name: 'Answer' }).querySelectorAll('.ask-text')].map((p) => p.textContent ?? '')
    expect(summary).toMatch(/^api-fix: Claude Code finished 20 minutes ago/)
    expect(turn).toMatch(/^Claude Code finished in api-fix/)
    expect(spoken()).toEqual([[`${sentence(summary)} ${sentence(turn)}`, 'ask:answer']])
    expect(bridge.invoke.assistantSend).not.toHaveBeenCalled()
  })

  it('What happened here without a workspace says there is none', async () => {
    await seed({ snapshot: { workspaces: [], sessions: [] } })
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'What happened here' }))
    expect(spoken()).toEqual([['No workspace is open.', 'ask:answer']])
  })

  it('Read the last reply shows the chat\'s last assistant message and says it as plain words', async () => {
    await seed({ chat: [userItem, assistantItem('a1', 'First answer.'), assistantItem('a2', 'The retry limit is now **5**.'), turnEnd()] })
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'Read the last reply' }))
    expect(screen.getByRole('article', { name: 'Answer' }).textContent).toContain('The retry limit is now **5**.')
    expect(spoken()).toEqual([['The retry limit is now 5.', 'ask:answer']])
    expect(bridge.invoke.assistantSend).not.toHaveBeenCalled()
  })

  it('Read the last reply cuts at 2000 characters with "..." and says where the rest is', async () => {
    await seed({ chat: [assistantItem('a1', `${'word '.repeat(600)}end`)] })
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'Read the last reply' }))
    const answer = screen.getByRole('article', { name: 'Answer' })
    const shown = answer.querySelector('.ask-text')!.textContent!
    expect(shown.endsWith('...')).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(2003)
    expect(shown).not.toContain('end')
    expect(answer.textContent).toContain('The full reply is in the chat.')
    expect(spoken()[0][0]).toContain('The full reply is in the chat.')
  })

  it('Read the last reply with no reply says so', async () => {
    await seed({ chat: [userItem] })
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'Read the last reply' }))
    expect(spoken()).toEqual([['There is no reply in this chat yet.', 'ask:answer']])
  })

  it('the overlay has no live region of its own: the announcer is the one channel', async () => {
    await seed()
    const user = userEvent.setup()
    const { dialog } = await open()
    await user.click(screen.getByRole('button', { name: 'What needs me' }))
    expect(dialog.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')).toHaveLength(0)
  })
})

describe('free text', () => {
  it('Enter sends it with the workspace and chat as context, and the thread is remembered', async () => {
    await seed()
    const user = userEvent.setup()
    await open()
    await user.type(field(), 'what did Codex do in docs{Enter}')
    expect(bridge.invoke.assistantSend).toHaveBeenCalledTimes(1)
    expect(bridge.invoke.assistantSend).toHaveBeenCalledWith(null, 'what did Codex do in docs', false, { workspaceId: 'w1', sessionId: 's1' })
    expect(getState().askThreadId).toBe('ask-1')
    expect(field().value).toBe('')
    // A second question goes on the same thread.
    await item('ask-1', turnEnd())
    await user.type(field(), 'and in api?{Enter}')
    expect(bridge.invoke.assistantSend).toHaveBeenLastCalledWith('ask-1', 'and in api?', false, { workspaceId: 'w1', sessionId: 's1' })
  })

  it('does not send an empty question, nor a second one while the first is being answered', async () => {
    await seed()
    const user = userEvent.setup()
    await open()
    await user.type(field(), '   {Enter}')
    expect(bridge.invoke.assistantSend).not.toHaveBeenCalled()
    await user.clear(field())
    await user.type(field(), 'first{Enter}')
    await running(true)
    await user.type(field(), 'second{Enter}')
    expect(bridge.invoke.assistantSend).toHaveBeenCalledTimes(1)
  })

  it('streams the answer into the article and says the final text once, when the turn ends', async () => {
    await seed()
    const user = userEvent.setup()
    await open()
    await user.type(field(), 'status?{Enter}')
    await running(true)
    const answer = screen.getByRole('article', { name: 'Answer' })
    expect(answer.getAttribute('aria-busy')).toBe('true')

    await item('ask-1', userItem)
    await item('ask-1', assistantItem('a1', 'Codex in docs fin', true))
    expect(answer.textContent).toContain('Codex in docs fin')
    // Partial text is shown, never said.
    expect(spoken()).toEqual([])

    const final = 'Codex in docs finished 20 minutes ago. No approvals waiting.'
    await item('ask-1', assistantItem('a1', final, false))
    expect(spoken()).toEqual([])
    await item('ask-1', turnEnd('e1'))
    await running(false)
    expect(answer.getAttribute('aria-busy')).toBeNull()
    expect(answer.textContent).toContain(final)
    expect(spoken()).toEqual([[final, 'ask:answer']])
    // Nothing else says it again.
    await item('ask-1', assistantItem('a1', final, false))
    expect(spoken()).toHaveLength(1)
    // The assistant view's unread dot is not lit by Ask answers.
    expect(getState().assistantUnread).toBe(false)
  })

  it('a failed turn is shown and said once, not as an alert', async () => {
    await seed()
    const user = userEvent.setup()
    const { dialog } = await open()
    await user.type(field(), 'status?{Enter}')
    await item('ask-1', userItem)
    await item('ask-1', { ...turnEnd('e1', 'error'), error: 'The agent is not signed in.' })
    expect(screen.getByRole('article', { name: 'Answer' }).textContent).toContain('The agent is not signed in.')
    expect(spoken()).toEqual([['The agent is not signed in.', 'ask:answer']])
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
  })

  it('an earlier answer on the thread is not shown or said again when the overlay reopens', async () => {
    await seed()
    const user = userEvent.setup()
    await open()
    await user.type(field(), 'status?{Enter}')
    await item('ask-1', userItem)
    await item('ask-1', assistantItem('a1', 'All quiet.'))
    await item('ask-1', turnEnd('e1'))
    expect(spoken()).toHaveLength(1)
    cleanup()
    closeAsk()
    vi.mocked(announce).mockClear()
    await open()
    expect(screen.queryByRole('article', { name: 'Answer' })).toBeNull()
    expect(spoken()).toEqual([])
  })
})

describe('a proposed command', () => {
  async function propose() {
    await seed()
    const user = userEvent.setup()
    const view = await open()
    await user.type(field(), 'approve the npm test call{Enter}')
    await running(true)
    await item('ask-1', userItem)
    await item('ask-1', proposal())
    return { user, ...view }
  }

  it('is the Run card inside the overlay, and its spoken line has the summary and the exact command', async () => {
    const { dialog } = await propose()
    const card = within(dialog).getByRole('group', { name: /^Proposed command: foreman approve 3f9a1c2e/ })
    expect(within(card).getByText(COMMAND)).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Run' })).toBeTruthy()
    expect(spokenFor('ask:proposal')).toEqual([[`Proposed: approve the Bash call in api-fix: ${COMMAND}. Run button.`, 'ask:proposal']])
    // A card that changes state does not say it again.
    await item('ask-1', proposal('running'))
    expect(spokenFor('ask:proposal')).toHaveLength(1)
  })

  it('the spoken line is just the command when the card has no summary', async () => {
    await seed()
    const user = userEvent.setup()
    await open()
    await user.type(field(), 'x{Enter}')
    await item('ask-1', proposal('pending', { summary: '', command: 'foreman status' }))
    expect(spokenFor('ask:proposal')).toEqual([['Proposed: foreman status. Run button.', 'ask:proposal']])
  })

  it('Enter in the field never runs it', async () => {
    const { user } = await propose()
    await user.type(field(), 'and now?{Enter}')
    expect(bridge.invoke.assistantConfirmRun).not.toHaveBeenCalled()
    expect(bridge.invoke.assistantCancelRun).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy()
  })

  it('Enter on the focused Run button runs it, and the result shows in the card', async () => {
    const { user, dialog } = await propose()
    field().focus()
    await user.tab()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Run' }))
    await user.keyboard('{Enter}')
    expect(bridge.invoke.assistantConfirmRun).toHaveBeenCalledWith('ask-1', 'r1')
    await item('ask-1', { ...proposal('done', { exitCode: 0 }), status: 'done', output: 'Approved.' })
    const card = within(dialog).getByRole('group', { name: /^Proposed command/ })
    expect(within(card).getByText('Exited 0')).toBeTruthy()
    expect(within(card).getByText('Approved.')).toBeTruthy()
  })

  it('Cancel on the card cancels and never runs', async () => {
    const { user, dialog } = await propose()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(bridge.invoke.assistantCancelRun).toHaveBeenCalledWith('ask-1', 'r1')
    expect(bridge.invoke.assistantConfirmRun).not.toHaveBeenCalled()
  })
})

describe('when the assistant cannot run', () => {
  it.each([
    [{ state: 'off' }, 'The assistant is off'],
    [{ state: 'privacy' }, 'Privacy mode is on'],
    [{ state: 'none' }, 'The assistant needs an AI agent'],
    [{ state: 'signed-out', agent: 'claude' }, 'Your default agent isn’t signed in'],
    [{ state: 'unsupported', agent: 'codex' }, 'Your default agent can’t run the assistant yet']
  ])('%o disables the field and gives the reason as its description; quick actions still work', async (gate, reason) => {
    await seed({ gate })
    const user = userEvent.setup()
    await open()
    expect(field().disabled).toBe(true)
    expect(described(field())).toBe(reason)
    await user.type(field(), 'hello{Enter}')
    expect(bridge.invoke.assistantSend).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'What needs me' }))
    expect(spoken()).toEqual([['Nothing needs you.', 'ask:answer']])
  })

  it('takes focus into the field once the check says it is ready', async () => {
    await seed({ gate: { state: 'checking' } })
    let answer: (value: unknown) => void = () => undefined
    bridge.invoke.assistantState = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    await open()
    expect(field().disabled).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    await act(async () => answer({ gate: ready, threads: [] }))
    expect(field().disabled).toBe(false)
    expect(document.activeElement).toBe(field())
  })
})
