// @vitest-environment jsdom
// When the agent needs you, what you were writing stays (the composer audit's "needs you" cards, option A): the
// approval, question or plan docks above the message box as a decision card, and the message box stays mounted with
// its draft. Focus doesn't jump to the card: its arrival is announced, F6 reaches it, Ctrl+L goes back. Enter in the
// message box never answers it. Questions never send "(no answer)", and the plan's bar is folded into its card.
import './domShims'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useReducer } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../src/renderer/src/components/ChatView'
import { QuestionPanel } from '../src/renderer/src/components/ApprovalPanel'
import { matchShortcut, SHORTCUTS } from '../src/renderer/src/shortcuts'
import { announce } from '../src/renderer/src/announce'
import { fakeApi, fakeState, resetFake } from './rendererStore'

const live = vi.hoisted(() => ({ listeners: new Set<() => void>() }))

// The fake store, but live (a component renders again on each store event; some selectors build a new value each time,
// so it doesn't compare them), with the window's UI commands.
vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const { fakeState: state } = await import('./rendererStore')
  const subscribe = (listener: () => void) => {
    live.listeners.add(listener)
    return () => void live.listeners.delete(listener)
  }
  const own: Record<string, unknown> = {
    useStore: (selector: (s: typeof state) => unknown) => {
      const [, render] = useReducer((n: number) => n + 1, 0)
      useEffect(() => subscribe(render), [])
      return selector(state)
    },
    sendUiCommand: (command: string, workspaceId: string) => window.dispatchEvent(new CustomEvent('foreman:command', { detail: { command, workspaceId } })),
    onUiCommand: (handler: (command: string, workspaceId: string) => void) => {
      const listener = (e: Event) => handler((e as CustomEvent).detail.command, (e as CustomEvent).detail.workspaceId)
      window.addEventListener('foreman:command', listener)
      return () => window.removeEventListener('foreman:command', listener)
    }
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})
vi.mock('../src/renderer/src/announce', () => ({ announce: vi.fn() }))
vi.mock('../src/renderer/src/components/ChatSearch', () => ({ ChatSearch: () => null }))

const at = '2026-11-14T10:00:00.000Z'
const session = (over: Record<string, unknown> = {}) => ({ id: 's1', workspaceId: 'w1', agent: 'claude', status: 'running', turnId: 't1', queue: [], title: 'Login bug', createdAt: at, ...over }) as never
const workspace = { id: 'w1', name: 'lisbon', branch: 'fix-login-redirect', baseBranch: 'main', state: 'ready', path: '/w', repoId: 'r1' } as never
const tool = { kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: 'npm test -- session && git push origin fix-login-redirect' }, alternate: 'always-allow', alwaysRules: ['npm test:*'] }
const plan = { kind: 'plan', id: 'p1', sessionId: 's1', plan: '1. Keep the previous token until the new one is saved.\n2. Add tests.' }

const notify = () => act(() => live.listeners.forEach((l) => l()))
const arrive = (request: unknown) => {
  fakeState.approvals = [request]
  notify()
}
const command = (name: string) => act(() => void window.dispatchEvent(new CustomEvent('foreman:command', { detail: { command: name, workspaceId: 'w1' } })))
const messageBox = (root: HTMLElement) => root.querySelector<HTMLTextAreaElement>('.composer-box textarea')!

beforeEach(() => {
  resetFake()
  vi.mocked(announce).mockClear()
  Object.assign(fakeState, { approvals: [], chats: { s1: [{ kind: 'user', id: 'u1', turnId: 't1', text: 'Fix the login redirect', at }] }, activeSession: { w1: 's1' }, chatJump: null })
  fakeState.snapshot.sessions = [session()]
  fakeState.snapshot.workspaces = [workspace]
  fakeApi.respondApproval = vi.fn(async () => undefined)
  fakeApi.sendMessage = vi.fn(async () => ({ kind: 'queued' }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('an approval that arrives while you type', () => {
  it('docks above the message box, which keeps your draft, and focus stays in it', async () => {
    const user = userEvent.setup()
    const { container } = render(<ChatView session={session()} workspace={workspace} active />)
    const box = messageBox(container)
    await user.type(box, 'Also keep returnTo')
    arrive(tool)
    const card = screen.getByRole('group', { name: 'Run 2 commands?' })
    expect(messageBox(container)).toBe(box)
    expect(box.value).toBe('Also keep returnTo')
    expect(document.activeElement).toBe(box)
    // Between the conversation and the box, not in its place.
    expect(card.closest('.decision-dock')).toBeTruthy()
    expect(card.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Said once, with the key that reaches it.
    expect(announce).toHaveBeenCalledWith('Claude Code needs you: Command. Press F6 to answer.', 'decision:a1')
    expect(within(card).getByText('F6')).toBeTruthy()
  })

  it('never answers from the message box: Enter there sends your message (queued while the agent waits)', async () => {
    const user = userEvent.setup()
    const { container } = render(<ChatView session={session()} workspace={workspace} active />)
    arrive(tool)
    await user.type(messageBox(container), 'Use rg instead{Enter}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    expect(fakeApi.sendMessage).toHaveBeenCalledWith('s1', 'Use rg instead', expect.anything())
  })

  it('is reached with F6 and left with Ctrl+L, and only then do its keys answer it', async () => {
    const user = userEvent.setup()
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const { container } = render(<ChatView session={session()} workspace={workspace} active />)
    arrive(tool)
    const f6 = matchShortcut({ code: 'F6', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, 'win32')
    expect(f6?.id).toBe('approval.focus')
    command('chat-needs-me')
    const card = screen.getByRole('group', { name: 'Run 2 commands?' })
    expect(document.activeElement).toBe(card)
    // A key in the moment it arrived answers nothing.
    await user.keyboard('{Escape}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    now.mockReturnValue(11_000)
    // Its command pushes, so Enter doesn't run it: nothing that leaves this computer has a key.
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('a1', { kind: 'tool', allow: false, alternate: false, message: undefined })
    command('focus-composer')
    expect(document.activeElement).toBe(messageBox(container))
  })

  it('says so when nothing waits', () => {
    render(<ChatView session={session()} workspace={workspace} active />)
    command('chat-needs-me')
    expect(announce).toHaveBeenCalledWith('Nothing needs you', 'chat:jump')
  })

  it('keys F6 to it in the registry, and Esc, not Backspace, declines', () => {
    const f6 = SHORTCUTS.find((s) => s.id === 'approval.focus')!
    expect(f6.keys.win).toBe('F6')
    expect(SHORTCUTS.find((s) => s.id === 'approval.no')?.keys.win).toBe('Escape')
  })
})

describe('the plan', () => {
  it('is one card above the box: Copy, Keep planning, Hand off and Approve plan, the main act last', async () => {
    const user = userEvent.setup()
    const { container } = render(<ChatView session={session({ status: 'idle' })} workspace={workspace} active />)
    arrive(plan)
    const card = screen.getByRole('group', { name: 'Plan ready for review' })
    expect(within(card).getAllByRole('button').map((b) => b.textContent?.replace(/\s*(Esc|Ctrl\+Enter|Enter)$/, ''))).toEqual(['Copy', 'Keep planning', 'Hand off', 'Approve plan'])
    expect(container.querySelector('.plan-bar')).toBeNull()
    expect(container.querySelector('.chat-scroll .plan-card')).toBeNull()
    expect(messageBox(container).placeholder).toBe('Or say what to change, and press Enter to keep planning')
    await user.click(within(card).getByRole('button', { name: /^Keep planning/ }))
    expect(document.activeElement).toBe(messageBox(container))
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    await user.click(within(card).getByRole('button', { name: /^Approve plan/ }))
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('p1', { kind: 'plan', approve: true, handOff: false })
  })
})

describe('questions', () => {
  const questions = {
    kind: 'question',
    id: 'q1',
    sessionId: 's1',
    questions: [
      { header: 'Expired token', question: 'What happens when the refresh token has expired?', options: [{ label: 'Sign out' }, { label: 'Keep the session' }, { label: 'Ask the server' }] },
      { header: 'Tests', question: 'Which tests should I add?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'End to end' }] }
    ]
  } as never

  it('names each tab by its header and marks it answered or not, and goes on with Next until every one has an answer', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={questions} />)
    const tabs = screen.getByRole('tablist', { name: 'Questions' })
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['not answered yet Expired token', 'not answered yet Tests'])
    // The card is named by the open question, its title; the count isn't said again.
    expect(screen.getByRole('group', { name: 'What happens when the refresh token has expired?' })).toBeTruthy()
    expect(screen.queryByText(/of 2 answered|2 questions/)).toBeNull()
    // A single choice is a radio list, so it reads as choose one; picking doesn't jump to the next question.
    await user.click(screen.getByRole('radio', { name: 'Sign out' }))
    expect(screen.getByRole('radio', { name: 'Sign out' })).toHaveProperty('checked', true)
    // An answered tab shows its answer.
    expect(within(tabs).getAllByRole('tab')[0].textContent).toBe('answered Expired token · Sign out')
    await user.click(screen.getByRole('button', { name: /^Next: Tests/ }))
    expect(screen.getByRole('group', { name: 'Which tests should I add?' })).toBeTruthy()
    expect(fakeApi.respondApproval).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'End to end' }))
    await user.click(screen.getByRole('button', { name: /^Send answers/ }))
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('q1', { kind: 'question', answers: { 'What happens when the refresh token has expired?': 'Sign out', 'Which tests should I add?': 'End to end' } })
    expect(JSON.stringify(vi.mocked(fakeApi.respondApproval).mock.calls)).not.toContain('(no answer)')
  })

  it('keys the options 1 to n and Other the next number, never 0, and never sends a question unanswered', async () => {
    const user = userEvent.setup()
    render(<QuestionPanel request={{ kind: 'question', id: 'q2', sessionId: 's1', questions: [{ header: 'Day', question: 'Which day?', options: [{ label: 'Tuesday' }, { label: 'Thursday' }] }] } as never} />)
    const card = screen.getByRole('group', { name: 'Which day?' })
    const send = screen.getByRole('button', { name: /^Send answer/ })
    expect(send).toHaveProperty('disabled', true)
    card.focus()
    await user.keyboard('2')
    expect(screen.getByRole('radio', { name: 'Thursday' })).toHaveProperty('checked', true)
    await user.keyboard('3')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Other: answer in your own words' }))
    card.focus()
    await user.keyboard('{Enter}')
    expect(fakeApi.respondApproval).toHaveBeenCalledWith('q2', { kind: 'question', answers: { 'Which day?': 'Thursday' } })
  })
})
